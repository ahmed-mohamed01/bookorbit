import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import type {
  ReadAlongBlockReason,
  ReadAlongBuildResponse,
  ReadAlongCopySizes,
  ReadAlongStatus,
  ReadAlongStatusResponse,
  StorytellerExistingMatch,
  StorytellerExistingMatchesResponse,
  StorytellerSettings,
} from '@bookorbit/types';
import { NotificationType, Permission } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { findSourceEpubProblem } from './storyteller-epub.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import { UserService } from '../user/user.service';
import type { BuildReadAlongDto } from './dto';
import { describeError } from './storyteller-log.utils';
import { matchExistingBooks } from './storyteller-match.utils';
import { StorytellerReadAlongBuildService, type StorytellerBuildSlot, type StorytellerRunBuildOptions } from './storyteller-read-along-build.service';
import {
  StorytellerReadAlongNotifierService,
  readAlongAttempt,
  readAlongAttemptFromNotification,
  type ReadAlongAttempt,
} from './storyteller-read-along-notifier.service';
import { NotificationService } from '../notification/notification.service';
import { StorytellerSchemaBootstrapService } from './storyteller-schema-bootstrap.service';
import type { StorytellerQueuedRequest, StorytellerReadAlongBuild } from './schema/storyteller.schema';
import { StorytellerClientService } from './storyteller-client.service';
import type { StorytellerConnection } from './storyteller-client.types';
import {
  INTERRUPTED_BUILD_ERROR,
  INTERRUPTED_PREVIOUS_STATUS,
  StorytellerRepository,
  type StorytellerBookIdentity,
  type StorytellerInterruptedBuilds,
} from './storyteller.repository';
import { StorytellerSettingsService } from './storyteller-settings.service';

const REQUEST_EVENT = 'storyteller.read_along.request';
const EXISTING_EVENT = 'storyteller.read_along.find_existing';
const ATTACH_EVENT = 'storyteller.read_along.attach_existing';
const CANCEL_EVENT = 'storyteller.read_along.cancel';
const CANCEL_REMOTE_EVENT = 'storyteller.read_along.cancel_remote';
const QUEUE_EVENT = 'storyteller.read_along.queue';
const UNLOCK_EVENT = 'storyteller.read_along.unlock_notifications';
const REQUESTER_GONE_MESSAGE = 'the user who queued this build is no longer available';
const MAX_QUEUED_ERROR_CHARS = 2000;
const CANCEL_TOO_LATE_MESSAGE = 'The read-along is being imported and can no longer be cancelled';
// A cancelled build lets go of its slot once its current await returns; a Generate pressed right after
// the cancel waits this long for that before it is queued.
const CANCELLED_RELEASE_WAIT_MS = 30_000;
const FAILED_CHECK_TTL_MS = 10 * 60_000;
// The matcher surfaces the best few and the UI reads the first aligned one, so a wider page buys nothing.
const STORYTELLER_MATCH_PAGE_SIZE = 50;
type EditionLinkRow = NonNullable<Awaited<ReturnType<EditionLinkRepository['findLinkForBook']>>>;

type QueueRefusal = ReadAlongBlockReason | 'not_permitted';

// Storyteller being unusable says nothing about the rows waiting on it: they stay queued for a retry.
const TRANSIENT_QUEUE_REFUSALS: ReadonlySet<QueueRefusal> = new Set<QueueRefusal>(['unreachable', 'not_configured']);
const QUEUE_RETRY_MS = 5 * 60_000;

/** What a queued build that can no longer start records as its error, in the words the panel uses. */
const QUEUE_REFUSAL_MESSAGES: Record<QueueRefusal, string> = {
  not_permitted: 'you no longer have permission to build read-alongs',
  not_configured: "Storyteller isn't configured on this server.",
  unreachable: "The Storyteller server can't be reached.",
  busy: 'Storyteller is busy with another read-along.',
  no_pair: 'This book is no longer linked to the edition it was queued with.',
  no_epub: 'This pair has no EPUB to align.',
  source_epub_unreadable: "This book's EPUB file cannot be read, so Storyteller cannot align it.",
  no_audio: 'This pair has no audio to align.',
  no_target_library: 'No read-along library is configured in the Storyteller settings.',
  target_not_allowed: 'The user who queued this build has no access to the read-along library.',
  format_not_allowed: "The read-along library doesn't allow EPUB files.",
  previous_output_not_deletable: 'Replacing the existing read-along needs permission to delete books.',
};

type AdmissionRow = Pick<StorytellerReadAlongBuild, 'status' | 'targetLibraryId' | 'targetFolderId' | 'outputBookId'>;

interface AdmittedBuild {
  targetLibraryId: number;
  runTargetLibraryId: number | undefined;
  runTargetFolderId: number | undefined;
  previousOutputBookId: number | null;
}

function normalizeReadAlongStatus(status: string | undefined): ReadAlongStatus {
  return status === 'queued' || status === 'building' || status === 'ready' || status === 'failed' ? status : 'none';
}

/** Every member null: "not known here", never zero bytes. */
function unknownCopySizes(): ReadAlongCopySizes {
  return { epub: null, audio: null, readAlong: null };
}

export interface StorytellerReadAlongPair {
  textBookId: number;
  audioBookId: number;
  linkId: number | null;
  role: 'text' | 'audio' | 'readAlong' | 'self';
  link: EditionLinkRow | null;
}

@Injectable()
export class StorytellerReadAlongStatusService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StorytellerReadAlongStatusService.name);
  private queueRunning = false;
  private queueRerun = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: StorytellerRepository,
    private readonly settingsService: StorytellerSettingsService,
    private readonly client: StorytellerClientService,
    private readonly buildService: StorytellerReadAlongBuildService,
    private readonly bookService: BookService,
    private readonly libraryService: LibraryService,
    private readonly editionLinks: EditionLinkRepository,
    private readonly userService: UserService,
    private readonly schemaBootstrap: StorytellerSchemaBootstrapService,
    private readonly notifier: StorytellerReadAlongNotifierService,
    private readonly notifications: NotificationService,
  ) {}

  async requestBuild(bookId: number, user: RequestUser, dto: BuildReadAlongDto): Promise<ReadAlongBuildResponse> {
    return this.requestBuildOnce(bookId, user, dto, false);
  }

  /** `retried`: the row moved under a queue insert once already, and this is the one fresh look it gets. */
  private async requestBuildOnce(bookId: number, user: RequestUser, dto: BuildReadAlongDto, retried: boolean): Promise<ReadAlongBuildResponse> {
    const startedAt = Date.now();
    this.logger.log(`[${REQUEST_EVENT}] [start] bookId=${bookId} userId=${user.id} force=${dto.force ?? false} - read-along build requested`);
    await this.bookService.verifyBookAccess(bookId, user);

    const settings = await this.settingsService.getSettings();
    let connection: StorytellerConnection | null;
    try {
      connection = await this.settingsService.getConnection();
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        this.logConfigurationFailure(bookId, user.id, startedAt, error);
        return { status: await this.statusOfExistingBuild(bookId, user), blocked: 'not_configured' };
      }
      throw error;
    }
    // Reported against the build actually on the row: clearing the stored password on a host change
    // is what puts a running build here, and 'none' would blank it until the next poll.
    if (!connection) {
      return this.blocked(await this.statusOfExistingBuild(bookId, user), 'not_configured', bookId, user.id, startedAt);
    }
    const pair = await this.resolvePair(bookId);
    if (!pair || !(await this.canAccessPair(pair, bookId, user))) return this.blocked('none', 'no_pair', bookId, user.id, startedAt);

    const existing = await this.repo.findBuildByPair(pair.textBookId, pair.audioBookId);
    const admission = await this.admit(bookId, pair, user, dto, settings, existing, startedAt);
    if ('blocked' in admission) return this.blocked(existing?.status, admission.blocked, bookId, user.id, startedAt);
    const { targetLibraryId, runTargetLibraryId, runTargetFolderId, previousOutputBookId } = admission.admitted;

    const existingOutput = existing?.outputBookId ? await this.editionLinks.findBookSummary(existing.outputBookId) : null;
    if (existing?.status === 'ready' && existingOutput && !dto.force) {
      // Unlinking and relinking inserts a fresh link row with no read-along member, and nothing else
      // goes looking for the build that already produced one.
      await this.attachExistingOutput(pair, existing, existingOutput.id, user);
      return this.blocked('ready', null, bookId, user.id, startedAt);
    }
    // A second Generate keeps the pair's place in line rather than sending it to the back.
    if (existing?.status === 'queued') {
      this.kickQueue();
      return this.blocked('queued', null, bookId, user.id, startedAt);
    }
    await this.awaitCancelledBuildRelease(pair);
    // First come, first served: with anything already waiting, a free slot belongs to the oldest
    // queued build, which the runner is about to start.
    const waiting = await this.repo.findOldestQueuedBuild();
    // Held from here, not merely checked: the uuid round trip below and the claim itself are both
    // awaits, and a second request crossing them claims the same slot and strips a row whose uuid is
    // the only handle on a Storyteller job the first one may already have started.
    const slot = waiting ? null : this.buildService.tryReserve(pair);
    if (!slot) {
      if (dto.useExistingUuid !== undefined) {
        await this.assertOfferedUuid(pair, dto.useExistingUuid, connection, bookId, user.id, startedAt);
      }
      const queued = await this.enqueue(pair, user, dto, admission.admitted, existing, bookId, startedAt);
      if (queued !== 'moved') return queued;
      // The row changed between the read and the insert (a build finished, or another request got
      // there first): read it again and decide afresh, once.
      const current = await this.repo.findBuildByPair(pair.textBookId, pair.audioBookId);
      if (current?.status === 'queued') {
        this.kickQueue();
        return this.blocked('queued', null, bookId, user.id, startedAt);
      }
      if (!retried) return this.requestBuildOnce(bookId, user, dto, true);
      return this.blocked(current?.status, null, bookId, user.id, startedAt);
    }

    let handedOff = false;
    try {
      if (dto.useExistingUuid !== undefined) {
        await this.assertOfferedUuid(pair, dto.useExistingUuid, connection, bookId, user.id, startedAt);
      }

      const { storytellerBookUuid, transport } = this.resumeTarget(dto, existing?.status, existing);
      const claimed = await this.repo.startBuild({
        textBookId: pair.textBookId,
        audioBookId: pair.audioBookId,
        storytellerBookUuid,
        transport,
        targetLibraryId,
        // Always passed, null included: an omitted folder keeps the row's, which may belong to
        // another library than the one this claim targets.
        targetFolderId: runTargetFolderId ?? null,
        requestedBy: user.id,
        queuedRequest: this.attemptRequest(dto, admission.admitted, existing?.status ?? null),
      });
      if (!claimed) {
        // A queued row belongs to the queue runner: the pair is answered as the queued build it is.
        const current = await this.repo.findBuildByPair(pair.textBookId, pair.audioBookId);
        if (current?.status === 'queued') {
          this.kickQueue();
          return this.blocked('queued', null, bookId, user.id, startedAt);
        }
        return this.blocked(current?.status ?? existing?.status, 'busy', bookId, user.id, startedAt);
      }
      // Cancelled between the reservation and the claim: the aborted build would never touch this
      // row, which would then read building until a restart and answer busy to every Generate.
      if (slot.signal.aborted) {
        await this.repo.retireCancelledBuild(claimed.id);
        return this.blocked('none', 'busy', bookId, user.id, startedAt);
      }

      this.launch(
        claimed.id,
        pair,
        user,
        {
          force: dto.force,
          targetLibraryId: runTargetLibraryId,
          targetFolderId: runTargetFolderId,
          oldOutputBookId: dto.force ? previousOutputBookId : null,
          cleanUpRemote: dto.cleanUpRemote,
          attempt: readAlongAttempt(claimed),
        },
        slot,
      );
      // The slot is that build's from here, and releasing it again would free whatever slot the next
      // build has since taken.
      handedOff = true;
    } finally {
      if (!handedOff) slot.release();
    }

    this.logger.log(
      `[${REQUEST_EVENT}] [end] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAt} status=building blocked=none - read-along build accepted`,
    );
    return { status: 'building', blocked: null };
  }

  /**
   * The checks a build has to pass before it may take the slot, shared by a Generate and by the queue
   * runner that starts a queued one later. `existing.status` is the status the resume and reuse
   * decisions read: for a queued row that is the status it had before it was queued.
   */
  private async admit(
    bookId: number,
    pair: StorytellerReadAlongPair,
    user: RequestUser,
    dto: BuildReadAlongDto,
    settings: StorytellerSettings,
    existing: AdmissionRow | undefined,
    startedAt: number,
  ): Promise<{ blocked: ReadAlongBlockReason } | { admitted: AdmittedBuild }> {
    const [sourceEpub, hasAudio] = await Promise.all([
      this.repo.findSourceEpubFile(pair.textBookId),
      this.repo.hasAudioContentFile(pair.audioBookId),
    ]);
    if (this.hasRecentFailedCheck(settings.lastCheckedAt, settings.lastCheck?.ok)) return { blocked: 'unreachable' };
    if (!sourceEpub) return { blocked: 'no_epub' };
    if (!hasAudio) return { blocked: 'no_audio' };

    // Checked on the click rather than on the five-second poll: it reads the archive's central
    // directory, and the answer cannot change while the file does not. A file Storyteller cannot
    // parse fails every import mode, so refusing here costs one seek instead of a build that runs
    // for hours and then reports the provider's own 500.
    const epubProblem = await findSourceEpubProblem(sourceEpub.absolutePath);
    if (epubProblem) {
      this.logger.warn(
        `[${REQUEST_EVENT}] [fail] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=UnreadableSourceEpub error="${sanitizeLogValue(epubProblem)}" path="${sanitizeLogValue(sourceEpub.absolutePath)}" - source epub cannot be read as an EPUB`,
      );
      return { blocked: 'source_epub_unreadable' };
    }

    // A retry or a rebuild with no destination in the request lands where the previous attempt did,
    // folder included, rather than wherever the settings point today.
    // Only a destination recorded in full is reused: an attempt that died in prepare has a library and
    // no folder, and the library alone sends the build to that library's lowest-id folder.
    const reusesDestination =
      dto.targetLibraryId === undefined &&
      dto.targetFolderId === undefined &&
      existing?.targetLibraryId != null &&
      existing.targetFolderId != null &&
      (existing.status === 'failed' || existing.status === 'cancelled' || existing.status === INTERRUPTED_PREVIOUS_STATUS || dto.force === true);
    const runTargetLibraryId = reusesDestination ? (existing?.targetLibraryId ?? undefined) : dto.targetLibraryId;
    const runTargetFolderId = reusesDestination ? (existing?.targetFolderId ?? undefined) : dto.targetFolderId;
    const targetLibraryId = runTargetLibraryId ?? settings.targetLibraryId;
    if (targetLibraryId == null) return { blocked: 'no_target_library' };

    try {
      await this.libraryService.verifyUserAccess(user.id, targetLibraryId, user.isSuperuser);
    } catch {
      return { blocked: 'target_not_allowed' };
    }
    let library: Awaited<ReturnType<LibraryService['findOne']>>;
    try {
      library = await this.libraryService.findOne(targetLibraryId);
    } catch (error) {
      if (error instanceof NotFoundException) return { blocked: 'target_not_allowed' };
      throw error;
    }
    if (library.type === 'podcasts') return { blocked: 'target_not_allowed' };
    if (library.allowedFormats.length > 0 && !library.allowedFormats.includes('epub')) return { blocked: 'format_not_allowed' };

    // `startBuild` clears the row's output column on every claim, so after a failed rebuild the
    // edition link is the only record of the book still on disk - and reading only the row orphans
    // that read-along, narration audio and all.
    // An interrupted attempt's own column names the output it was producing, never the one it replaces.
    const previousOutputBookId =
      existing?.status === INTERRUPTED_PREVIOUS_STATUS
        ? (pair.link?.readAlongBookId ?? null)
        : (existing?.outputBookId ?? pair.link?.readAlongBookId ?? null);

    // A forced build ends in bookService.deleteBooks() on whatever book the row names, and that only
    // checks read access - so the caller is held to the delete permission and to access to that book
    // for every row carrying an output id, including a 'failed' one, since `collect` writes the id
    // as soon as it knows it.
    //
    // A refusal is a block reason, never an exception: getStatus masks an output the caller cannot
    // open, and a POST about the text edition must not 404 over a book it only mentions.
    if (dto.force && previousOutputBookId != null) {
      const replaceable = this.canDeleteBooks(user) && (previousOutputBookId === bookId || (await this.canAccessBook(previousOutputBookId, user)));
      if (!replaceable) return { blocked: 'previous_output_not_deletable' };
    }
    return { admitted: { targetLibraryId, runTargetLibraryId, runTargetFolderId, previousOutputBookId } };
  }

  /**
   * A cancelled or failed build kept its Storyteller book for exactly this: resuming it rather than
   * importing the same paths again, which Storyteller refuses while it still holds them. A resumed
   * book keeps the transport that registered it: otherwise the claim clears the column and an
   * uploaded book would be collected from a shared folder it never writes to.
   *
   * A build a restart interrupted resumes its book even when forced: that book is the one the forced
   * attempt itself registered, and Storyteller may already be processing it.
   */
  private resumeTarget(
    dto: BuildReadAlongDto,
    priorStatus: string | null | undefined,
    existing: { storytellerBookUuid: string | null; transport: string | null } | undefined,
  ): { storytellerBookUuid: string | null; transport: string | null } {
    const interrupted = priorStatus === INTERRUPTED_PREVIOUS_STATUS;
    const resumable = interrupted || ((priorStatus === 'failed' || priorStatus === 'cancelled') && !dto.force);
    const resumeUuid = dto.useExistingUuid ?? (resumable ? (existing?.storytellerBookUuid ?? null) : null);
    const transport = resumeUuid !== null && resumeUuid === existing?.storytellerBookUuid ? existing.transport : null;
    return { storytellerBookUuid: resumeUuid, transport };
  }

  /** 'moved' when the row is no longer in the state the request read, and nothing was queued. */
  private async enqueue(
    pair: StorytellerReadAlongPair,
    user: RequestUser,
    dto: BuildReadAlongDto,
    admitted: AdmittedBuild,
    existing: StorytellerReadAlongBuild | undefined,
    bookId: number,
    startedAt: number,
  ): Promise<ReadAlongBuildResponse | 'moved'> {
    const queued = await this.repo.queueBuild(
      {
        textBookId: pair.textBookId,
        audioBookId: pair.audioBookId,
        requestedBy: user.id,
        queuedRequest: this.attemptRequest(dto, admitted, existing?.status ?? null),
      },
      existing?.status ?? null,
    );
    if (!queued) return 'moved';
    const position = queued.queuedAt ? (await this.repo.countQueuedBefore(queued.queuedAt, queued.id)) + 1 : 1;
    void this.notifier.queued(user.id, readAlongAttempt(queued), position);
    // The slot may have come free between the reservation that failed and this insert, with the
    // release that would have started this row already past.
    this.kickQueue();
    return this.blocked('queued', null, bookId, user.id, startedAt);
  }

  private attemptRequest(dto: BuildReadAlongDto, admitted: AdmittedBuild, previousStatus: string | null): StorytellerQueuedRequest {
    return {
      force: dto.force,
      targetLibraryId: admitted.runTargetLibraryId,
      targetFolderId: admitted.runTargetFolderId,
      cleanUpRemote: dto.cleanUpRemote,
      useExistingUuid: dto.useExistingUuid,
      previousStatus,
    };
  }

  private launch(
    buildId: number,
    pair: StorytellerReadAlongPair,
    user: RequestUser,
    options: StorytellerRunBuildOptions,
    slot: StorytellerBuildSlot,
  ): void {
    const startedAt = Date.now();
    const running = this.buildService.runBuild(buildId, pair, user, options, slot);
    void running.catch((error: unknown) => {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${REQUEST_EVENT}] [fail] buildId=${buildId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - background read-along build failed`,
      );
    });
  }

  onModuleInit(): void {
    this.buildService.onSlotReleased(() => this.kickQueue());
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * One pending retry at most: a queue held up by an unreachable or unconfigured Storyteller has no
   * slot release coming to wake it, so it looks again later, and only while rows are still waiting.
   */
  private armQueueRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kickQueue();
    }, QUEUE_RETRY_MS);
    this.retryTimer.unref();
  }

  /**
   * Queued rows survive a restart. Waits for the schema bootstrap, which re-queues the builds a restart
   * interrupted, tells their requesters where each one stands, and never holds up the boot itself.
   */
  onApplicationBootstrap(): void {
    void this.schemaBootstrap.ready.then(
      async (interrupted) => {
        await this.notifyInterruptedBuilds(interrupted);
        await this.unlockStaleReadAlongNotifications();
        this.kickQueue();
      },
      () => undefined,
    );
  }

  /**
   * Each on the notification its interrupted attempt already had. Sent before the queue starts, so a
   * re-queued build's queued message lands ahead of its own start on that one notification.
   */
  private async notifyInterruptedBuilds({ requeued, failed }: StorytellerInterruptedBuilds): Promise<void> {
    for (const row of failed) {
      if (row.requestedBy != null) void this.notifier.failed(row.requestedBy, readAlongAttempt(row), row.error ?? INTERRUPTED_BUILD_ERROR);
    }
    for (const row of requeued) {
      if (row.requestedBy == null) continue;
      const startedAt = Date.now();
      try {
        const position = row.queuedAt ? (await this.repo.countQueuedBefore(row.queuedAt, row.id)) + 1 : 1;
        void this.notifier.queued(row.requestedBy, readAlongAttempt(row), position);
      } catch (error) {
        const { errorClass, message } = describeError(error);
        this.logger.warn(
          `[${QUEUE_EVENT}] [fail] buildId=${row.id} requestedBy=${row.requestedBy} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - re-queued read-along build could not be announced`,
        );
      }
    }
  }

  private kickQueue(): void {
    void this.startNextQueuedBuild();
  }

  /**
   * Starts queued builds oldest first while a slot is free. One run at a time: a release that lands
   * while a run is in progress asks that run to look again instead of starting a second one.
   */
  async startNextQueuedBuild(): Promise<void> {
    if (this.queueRunning) {
      this.queueRerun = true;
      return;
    }
    this.queueRunning = true;
    try {
      do {
        this.queueRerun = false;
        await this.drainQueue();
      } while (this.queueRerun);
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(`[${QUEUE_EVENT}] [fail] errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along queue run failed`);
    } finally {
      this.queueRunning = false;
    }
    // Outside the run guard: a release landing during this sweep starts a run of its own.
    await this.unlockStaleReadAlongNotifications();
  }

  /**
   * A locked notification whose build is no longer queued or building would stay undismissable for
   * good: a build that ended without its outcome reaching the bell (a crash, a lost send, a deleted
   * row) is told as no longer tracked. The notifier writes it only while it is still locked, so an
   * outcome that lands meanwhile is never overwritten.
   */
  async unlockStaleReadAlongNotifications(): Promise<void> {
    const startedAt = Date.now();
    try {
      const locked = await this.notifications.findLockedByType(NotificationType.ReadAlongBuild);
      if (locked.length === 0) return;
      const candidates = locked
        .map((notification) => ({ notification, attempt: readAlongAttemptFromNotification(notification.groupKey, notification.meta) }))
        .filter((entry): entry is { notification: (typeof locked)[number]; attempt: ReadAlongAttempt } => entry.attempt !== null);
      const active = new Set(await this.repo.findActiveBuildIds([...new Set(candidates.map((entry) => entry.attempt.buildId))]));
      const stale = candidates.filter((entry) => !active.has(entry.attempt.buildId));
      for (const { notification, attempt } of stale) void this.notifier.untracked(notification.userId, attempt);
      if (stale.length > 0) {
        this.logger.log(
          `[${UNLOCK_EVENT}] [end] durationMs=${Date.now() - startedAt} locked=${locked.length} unlocked=${stale.length} - stale read-along notifications unlocked`,
        );
      }
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${UNLOCK_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - stale read-along notifications could not be unlocked`,
      );
    }
  }

  private async drainQueue(): Promise<void> {
    for (;;) {
      const row = await this.repo.findOldestQueuedBuild();
      if (!row) return;
      // Reserved before the checks: a Generate crossing them would otherwise take the slot out of turn.
      const slot = this.buildService.tryReserve({ textBookId: row.textBookId, audioBookId: row.audioBookId, linkId: null, role: 'text', link: null });
      if (!slot) return;
      const outcome = await this.startQueuedBuild(row, slot);
      if (outcome === 'started') return;
      if (outcome === 'deferred') {
        this.armQueueRetry();
        return;
      }
    }
  }

  /**
   * 'started' once the build runs on the slot; 'skipped' when the row was retired or had already left
   * the queue, and the next row may go; 'deferred' when Storyteller itself is unusable right now, which
   * no later row would get past either, so every row stays queued for the retry.
   */
  private async startQueuedBuild(row: StorytellerReadAlongBuild, slot: StorytellerBuildSlot): Promise<'started' | 'skipped' | 'deferred'> {
    const startedAt = Date.now();
    const request = row.queuedRequest ?? {};
    const requestedBy = row.requestedBy ?? 'none';
    let handedOff = false;
    try {
      const queueDepth = await this.repo.countQueuedBuilds();
      this.logger.log(
        `[${QUEUE_EVENT}] [start] buildId=${row.id} requestedBy=${requestedBy} queueDepth=${queueDepth} - queued read-along build starting`,
      );
      const user = row.requestedBy == null ? null : await this.userService.findByIdWithPermissions(row.requestedBy).catch(() => null);
      // Told to the requester's id even when inactive: the notification waits for them if they come back.
      if (!user || !user.active) return await this.failQueued(row, row.requestedBy, REQUESTER_GONE_MESSAGE, startedAt, 'requester_gone');

      const dto: BuildReadAlongDto = {
        force: request.force,
        targetLibraryId: request.targetLibraryId,
        targetFolderId: request.targetFolderId,
        cleanUpRemote: request.cleanUpRemote,
        useExistingUuid: request.useExistingUuid,
      };
      const checked = await this.checkQueuedBuild(row, user, dto, startedAt);
      if ('refused' in checked) {
        if (TRANSIENT_QUEUE_REFUSALS.has(checked.refused)) {
          this.logger.log(
            `[${QUEUE_EVENT}] [end] buildId=${row.id} requestedBy=${requestedBy} durationMs=${Date.now() - startedAt} outcome=deferred reason=${checked.refused} - queued read-along builds wait for Storyteller`,
          );
          return 'deferred';
        }
        return await this.failQueued(row, user.id, QUEUE_REFUSAL_MESSAGES[checked.refused], startedAt, checked.refused);
      }
      const { pair, connection, admitted } = checked;

      if (dto.useExistingUuid !== undefined) {
        try {
          await this.assertOfferedUuid(pair, dto.useExistingUuid, connection, row.textBookId, user.id, startedAt);
        } catch (error) {
          if (!(error instanceof HttpException)) throw error;
          return await this.failQueued(row, user.id, error.message, startedAt, 'uuid_not_offered');
        }
      }

      const { storytellerBookUuid, transport } = this.resumeTarget(dto, request.previousStatus, row);
      const claimed = await this.repo.claimQueuedBuild(row.id, {
        storytellerBookUuid,
        transport,
        targetLibraryId: admitted.targetLibraryId,
        targetFolderId: admitted.runTargetFolderId ?? null,
        // A collect a restart cut short already wrote its own output, which the resumed collect adopts.
        ...(request.previousStatus === INTERRUPTED_PREVIOUS_STATUS && row.outputBookId != null ? { outputBookId: row.outputBookId } : {}),
      });
      if (!claimed) {
        this.logger.log(
          `[${QUEUE_EVENT}] [end] buildId=${row.id} requestedBy=${requestedBy} durationMs=${Date.now() - startedAt} outcome=gone - queued read-along build left the queue before it started`,
        );
        return 'skipped';
      }
      if (slot.signal.aborted) {
        await this.repo.retireCancelledBuild(claimed.id);
        return 'skipped';
      }

      this.launch(
        claimed.id,
        pair,
        user,
        {
          force: dto.force,
          targetLibraryId: admitted.runTargetLibraryId,
          targetFolderId: admitted.runTargetFolderId,
          // Read at start, not at queue time: the link's read-along may have changed while the row waited.
          oldOutputBookId: dto.force ? admitted.previousOutputBookId : null,
          cleanUpRemote: dto.cleanUpRemote,
          attempt: readAlongAttempt(claimed),
        },
        slot,
      );
      handedOff = true;
      this.logger.log(
        `[${QUEUE_EVENT}] [end] buildId=${row.id} requestedBy=${requestedBy} durationMs=${Date.now() - startedAt} outcome=started - queued read-along build started`,
      );
      return 'started';
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${QUEUE_EVENT}] [fail] buildId=${row.id} requestedBy=${requestedBy} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - queued read-along build could not be started`,
      );
      // Retired rather than left queued: a row that throws every time would otherwise head the queue forever.
      const clipped = message.slice(0, MAX_QUEUED_ERROR_CHARS);
      const outcome = await this.repo.failQueuedBuild(row.id, clipped);
      if (outcome !== 'gone' && row.requestedBy != null) void this.notifier.failed(row.requestedBy, readAlongAttempt(row), clipped);
      return 'skipped';
    } finally {
      if (!handedOff) slot.release();
    }
  }

  /** The same gates as a Generate, answered for the user who queued the build. */
  private async checkQueuedBuild(
    row: StorytellerReadAlongBuild,
    user: RequestUser,
    dto: BuildReadAlongDto,
    startedAt: number,
  ): Promise<{ refused: QueueRefusal } | { pair: StorytellerReadAlongPair; connection: StorytellerConnection; admitted: AdmittedBuild }> {
    const bookId = row.textBookId;
    if (!this.canRequestBuild(user)) return { refused: 'not_permitted' };
    if (!(await this.canAccessBook(bookId, user))) return { refused: 'no_pair' };
    const settings = await this.settingsService.getSettings();
    let connection: StorytellerConnection | null;
    try {
      connection = await this.settingsService.getConnection();
    } catch (error) {
      if (error instanceof InternalServerErrorException) return { refused: 'not_configured' };
      throw error;
    }
    if (!connection) return { refused: 'not_configured' };
    // The pair may have been relinked while the row waited: a different counterpart is a different read-along.
    const pair = await this.resolvePair(bookId);
    if (!pair || pair.textBookId !== row.textBookId || pair.audioBookId !== row.audioBookId || !(await this.canAccessPair(pair, bookId, user))) {
      return { refused: 'no_pair' };
    }
    const priorStatus = row.queuedRequest?.previousStatus ?? undefined;
    const admission = await this.admit(bookId, pair, user, dto, settings, { ...row, status: priorStatus ?? 'none' }, startedAt);
    if ('blocked' in admission) return { refused: admission.blocked };
    return { pair, connection, admitted: admission.admitted };
  }

  private async failQueued(
    row: StorytellerReadAlongBuild,
    userId: number | null,
    error: string,
    startedAt: number,
    reason: string,
  ): Promise<'skipped'> {
    const outcome = await this.repo.failQueuedBuild(row.id, error);
    this.logger.log(
      `[${QUEUE_EVENT}] [end] buildId=${row.id} requestedBy=${row.requestedBy ?? 'none'} durationMs=${Date.now() - startedAt} outcome=${outcome} reason=${reason} - queued read-along build could not start`,
    );
    if (outcome !== 'gone' && userId !== null) void this.notifier.failed(userId, readAlongAttempt(row), error);
    return 'skipped';
  }

  /**
   * Stops a running build. It is not recorded as a failure to retry: a row that already holds a
   * Storyteller book is kept as cancelled, which status reads report as no build, and one that does
   * not is deleted.
   */
  /** `buildId` pins the cancel to one build: a notification's Cancel must not stop a later build of the pair. */
  async cancelBuild(bookId: number, user: RequestUser, buildId?: number): Promise<void> {
    await this.bookService.verifyBookAccess(bookId, user);
    const pair = await this.resolvePair(bookId);
    if (!pair || !(await this.canAccessPair(pair, bookId, user))) throw new NotFoundException('This book has no read-along pair');

    const startedAt = Date.now();
    this.logger.log(
      `[${CANCEL_EVENT}] [start] bookId=${bookId} userId=${user.id} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} - read-along build cancel started`,
    );
    try {
      const build = await this.repo.findBuildByPair(pair.textBookId, pair.audioBookId);
      if (buildId !== undefined && build?.id !== buildId) throw new NotFoundException('That read-along build is no longer running');
      // Collecting writes the read-along into a library and links it; stopping part way would strand
      // a book nothing points at.
      if (build?.status === 'building' && (build.phase === 'collect' || build.phase === 'link')) {
        throw new ConflictException(CANCEL_TOO_LATE_MESSAGE);
      }
      // Aborted whatever the row says: a build between its slot and its claim has no building row yet,
      // and a resumed build runs while the row still reads failed.
      const inFlight = this.buildService.cancel(pair);
      let retired = build;
      let row: 'kept' | 'deleted' | 'restored' | 'unchanged' = 'unchanged';
      if (build?.status === 'queued') {
        await this.cancelRequeuedRemoteJob(build);
        // A queued row has nothing running and nothing in Storyteller to stop, unless the runner claimed
        // it after the read above: then every queued-only statement misses and it is a building row.
        row = await this.repo.retireQueuedBuild(build.id);
        if (row === 'unchanged') {
          const current = await this.repo.findBuildByPair(pair.textBookId, pair.audioBookId);
          if (current?.id === build.id && current.status === 'building') {
            retired = current;
            row = await this.retireBuildingRow(current, pair);
          }
        }
      } else if (build?.status === 'building') {
        row = await this.retireBuildingRow(build, pair);
      }
      this.logger.log(
        `[${CANCEL_EVENT}] [end] bookId=${bookId} userId=${user.id} buildId=${build?.id ?? 'none'} durationMs=${Date.now() - startedAt} status=${retired?.status ?? 'none'} inFlight=${inFlight} row=${row} - read-along build cancel completed`,
      );
      if (retired && row !== 'unchanged') {
        const attempt = readAlongAttempt(retired);
        const requester = retired.requestedBy ?? user.id;
        void this.notifier.cancelled(requester, attempt);
        if (requester !== user.id) void this.notifier.cancelled(user.id, attempt);
      }
      this.kickQueue();
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.log(
          `[${CANCEL_EVENT}] [end] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAt} outcome=too_late - read-along build is past the point of cancelling`,
        );
        throw error;
      }
      if (error instanceof NotFoundException) {
        this.logger.log(
          `[${CANCEL_EVENT}] [end] bookId=${bookId} userId=${user.id} buildId=${buildId ?? 'none'} durationMs=${Date.now() - startedAt} outcome=not_current - the named read-along build is not the pair's current one`,
        );
        throw error;
      }
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${CANCEL_EVENT}] [fail] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along build cancel failed`,
      );
      throw error;
    }
  }

  /**
   * A row holding a Storyteller book is kept as cancelled rather than deleted, with the book left in
   * Storyteller: deleting a Storyteller book removes the source files a referenced book points at, and
   * the next Generate resumes that book instead of importing the same paths again.
   */
  private async retireBuildingRow(build: StorytellerReadAlongBuild, pair: StorytellerReadAlongPair): Promise<'kept' | 'deleted' | 'unchanged'> {
    // Collecting writes the read-along into a library and links it; stopping part way would strand a
    // book nothing points at.
    if (build.phase === 'collect' || build.phase === 'link') throw new ConflictException(CANCEL_TOO_LATE_MESSAGE);
    this.buildService.cancel(pair);
    if (build.storytellerBookUuid && (build.phase === 'process' || build.phase === 'wait')) {
      await this.cancelRemoteProcessingBestEffort(build.id, build.storytellerBookUuid);
    }
    return this.repo.retireCancelledBuild(build.id);
  }

  /**
   * A build a restart re-queued from process or wait still has its job running in Storyteller, which
   * nothing else would stop once the row is retired.
   */
  private async cancelRequeuedRemoteJob(build: StorytellerReadAlongBuild): Promise<void> {
    const interrupted = build.queuedRequest?.previousStatus === INTERRUPTED_PREVIOUS_STATUS;
    if (!interrupted || !build.storytellerBookUuid || (build.phase !== 'process' && build.phase !== 'wait')) return;
    await this.cancelRemoteProcessingBestEffort(build.id, build.storytellerBookUuid);
  }

  private async cancelRemoteProcessingBestEffort(buildId: number, uuid: string): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[${CANCEL_REMOTE_EVENT}] [start] buildId=${buildId} storytellerBookUuid=${uuid} - Storyteller processing stop started`);
    try {
      const connection = await this.settingsService.getConnection();
      if (connection) await this.client.createSession(connection).cancelProcessing(uuid);
      this.logger.log(
        `[${CANCEL_REMOTE_EVENT}] [end] buildId=${buildId} storytellerBookUuid=${uuid} durationMs=${Date.now() - startedAt} stopped=${connection !== null} - Storyteller processing stop completed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${CANCEL_REMOTE_EVENT}] [fail] buildId=${buildId} storytellerBookUuid=${uuid} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - Storyteller processing could not be stopped and may run to completion`,
      );
    }
  }

  private async awaitCancelledBuildRelease(pair: StorytellerReadAlongPair): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CANCELLED_RELEASE_WAIT_MS);
    });
    try {
      await Promise.race([this.buildService.whenReleased(pair), cap]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read-only but for one repair: a ready read-along whose link was dropped and made again is put
   * back on the new link, since nothing else goes looking for it until someone presses Generate.
   */
  /**
   * `counterpartId` names the edition an unlinked book is about to be linked with. A read-along built
   * for that pair before it was unlinked rejoins it on the next link, so it is reported as the pair's
   * build rather than offering to generate a second copy. Without such a build the unlinked answer is
   * unchanged.
   */
  async getStatus(bookId: number, user: RequestUser, counterpartId?: number): Promise<ReadAlongStatusResponse> {
    await this.bookService.verifyBookAccess(bookId, user);
    // Read once and threaded down: this route is polled against a twelve-hour build ceiling.
    const [settings, linkedPair] = await Promise.all([this.settingsService.getSettings(), this.resolvePair(bookId)]);
    let pair = linkedPair;
    let build = pair ? await this.repo.findBuildByPair(pair.textBookId, pair.audioBookId) : undefined;
    if (!pair && counterpartId !== undefined && counterpartId !== bookId) {
      const proposed = await this.proposedPair(bookId, counterpartId);
      const proposedBuild = proposed ? await this.repo.findBuildByPair(proposed.textBookId, proposed.audioBookId) : undefined;
      if (proposed && proposedBuild) {
        pair = proposed;
        build = proposedBuild;
      }
    }
    if (!pair) {
      build = await this.repo.findBuildByOutputBook(bookId);
      if (build) {
        pair = { textBookId: build.textBookId, audioBookId: build.audioBookId, linkId: null, role: 'readAlong', link: null };
      }
    }

    // Every field below the status exists for the generate control, which is LibraryUpload-gated on
    // both ends: a reader who could not act on it is told none of it and pays for none of its queries.
    const canBuild = this.canRequestBuild(user);

    // An unlinked book still reports the instance-level blockers, and a link with a member this
    // caller cannot open is not a link they have: it answers as if there were none.
    if (!pair || !(await this.canAccessPair(pair, bookId, user))) return this.emptyStatus(settings, null, user, canBuild);
    if (!build) return this.emptyStatus(settings, pair, user, canBuild);

    const outputBookId = build.outputBookId;
    const outputVisible = outputBookId == null || outputBookId === bookId || (await this.canAccessBook(outputBookId, user));
    const visibleOutputBookId = outputBookId != null && outputVisible ? outputBookId : null;
    // A running build renders phase, stage, transport and progress and nothing else: the sizes price
    // a choice offered only before a build, and the content probes answer a control not on screen.
    const building = build.status === 'building';
    // A queued row renders its place in line and a Cancel, and nothing about the build it replaces.
    const queued = build.status === 'queued';
    const active = building || queued;
    // A queued request keeps its destination in the request until the claim writes it to the row.
    // An interrupted build resumes where it was going, which the row records.
    const resumesDestination = queued && build.queuedRequest?.previousStatus === INTERRUPTED_PREVIOUS_STATUS && build.targetLibraryId != null;
    const rowLibraryId = queued && !resumesDestination ? (build.queuedRequest?.targetLibraryId ?? settings.targetLibraryId) : build.targetLibraryId;
    // One round trip for the tail of the response, against a 5-second poll.
    const [summary, remoteCopyBytes, targetLibrary, contentBlock, queuedAhead] = await Promise.all([
      visibleOutputBookId != null && !queued ? this.editionLinks.findBookSummary(visibleOutputBookId) : Promise.resolve(null),
      active ? Promise.resolve(unknownCopySizes()) : this.resolveCopySizes(pair, visibleOutputBookId),
      this.resolveTargetLibrary(rowLibraryId, user),
      canBuild ? this.getCheapBlockReason(pair, settings, !active) : Promise.resolve(null),
      queued && build.queuedAt ? this.repo.countQueuedBefore(build.queuedAt, build.id) : Promise.resolve(null),
    ]);
    // A ready build whose output was deleted is offered again; one the reader merely cannot open
    // stays ready with the book masked, or an admin-only library would invite duplicate builds.
    const outputHidden = outputBookId != null && !outputVisible;
    // A cancelled build is offered again like one whose output is gone; its row only keeps the
    // Storyteller book for the next Generate to resume.
    const status: ReadAlongStatus =
      build.status === 'cancelled' || (build.status === 'ready' && !summary && !outputHidden) ? 'none' : (build.status as ReadAlongStatus);
    const outputBook = status === 'none' ? null : summary;
    // The next Generate after a vanished output is a fresh build, which goes where the settings say.
    const destinationLibraryId = status === 'none' ? settings.targetLibraryId : rowLibraryId;
    const destination = status === 'none' ? await this.resolveTargetLibrary(destinationLibraryId, user) : targetLibrary;
    const blocked = canBuild ? (contentBlock ?? this.targetBlockReason(destinationLibraryId, destination)) : null;
    // Only a caller who could build writes on a poll: an ordinary reader's status read stays a read.
    if (canBuild && status === 'ready' && summary && this.lostReadAlongMember(pair, build.attachedLinkId)) {
      await this.attachExistingOutput(pair, build, summary.id, user);
    }

    const describesBuild = status !== 'none' && !queued;

    return {
      status,
      blocked,
      phase: describesBuild ? (build.phase as ReadAlongStatusResponse['phase']) : null,
      transport: queued ? null : (build.transport as ReadAlongStatusResponse['transport']),
      remoteTask: describesBuild ? build.remoteTask : null,
      remoteProgress: describesBuild ? build.remoteProgress : null,
      outputBook: outputBook ? { id: outputBook.id, title: outputBook.title } : null,
      targetLibraryId: destination.id,
      targetLibraryName: destination.name,
      remoteCopyBytes,
      // An instance setting behind ManageAppSettings: for anyone else it is configuration they cannot read.
      keepRemoteCopyByDefault: canBuild && !settings.deleteRemoteAfterImport,
      remoteCopyReclaimable: canBuild && this.remoteCopyReclaimable(settings, status === 'none' ? null : build.transport),
      // The stored error is the provider's own message: a library path, a host and port. This route
      // is ungated by design while the connection sits behind ManageAppSettings, so it is bounded by
      // the same build permission as its siblings above and by the library the build targets.
      // `status` still tells a reader without it that the build failed.
      error: describesBuild && canBuild && targetLibrary.allowed ? build.error : null,
      startedAt: queued ? null : (build.startedAt?.toISOString() ?? null),
      builtAt: queued ? null : (build.builtAt?.toISOString() ?? null),
      queuePosition: queuedAhead === null ? null : queuedAhead + 1,
    };
  }

  /**
   * A link this row was never attached to is a relink that lost the read-along. The link it was
   * attached to and that names no read-along was detached on purpose, from the read-along's own page,
   * and stays so.
   */
  private lostReadAlongMember(pair: StorytellerReadAlongPair, attachedLinkId: number | null): boolean {
    // Another read-along already on the link is the user's choice, not a gap to fill.
    if (pair.linkId === null || !pair.link || pair.link.readAlongBookId !== null) return false;
    return pair.linkId !== attachedLinkId;
  }

  /**
   * Over shared paths nothing is reclaimed: every file Storyteller's book points at is BookOrbit's,
   * so cleanup only drops a processing cache. A build that has run answers from the transport it
   * used; before one exists the last connection test is the only evidence, and an untested setup is
   * treated as reclaimable so the choice is offered rather than silently withheld.
   */
  private remoteCopyReclaimable(settings: StorytellerSettings, buildTransport: string | null): boolean {
    if (buildTransport !== null) return buildTransport !== 'shared-paths';
    return settings.lastCheck?.effectiveTransport !== 'shared-paths';
  }

  private async resolveCopySizes(pair: StorytellerReadAlongPair | null, outputBookId: number | null): Promise<ReadAlongCopySizes> {
    if (!pair) return unknownCopySizes();
    const [epub, audio, readAlong] = await Promise.all([
      this.repo.sumContentBytes(pair.textBookId),
      this.repo.sumContentBytes(pair.audioBookId),
      outputBookId ? this.repo.sumContentBytes(outputBookId) : Promise.resolve(null),
    ]);
    return { epub, audio, readAlong };
  }

  /**
   * The destination, masked for a caller `requestBuild` would refuse with `target_not_allowed`:
   * naming the admin-designated read-along library would hand its id to every reader.
   *
   * `allowed` is that same access answer, reused by the fields describing the build rather than paid
   * for twice on a five-second poll. A build whose library was deleted leaves nothing to check
   * against, so only a superuser still reads those fields, and the name is best effort.
   */
  private async resolveTargetLibrary(
    libraryId: number | null,
    user: RequestUser,
  ): Promise<{ id: number | null; name: string | null; allowed: boolean }> {
    if (libraryId == null) return { id: null, name: null, allowed: user.isSuperuser };
    if (!(await this.canAccessLibrary(libraryId, user))) return { id: null, name: null, allowed: false };
    const library = await this.libraryService.findOne(libraryId).catch(() => null);
    return { id: libraryId, name: library?.name ?? null, allowed: true };
  }

  private async canAccessLibrary(libraryId: number, user: RequestUser): Promise<boolean> {
    try {
      await this.libraryService.verifyUserAccess(user.id, libraryId, user.isSuperuser);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) return false;
      throw error;
    }
  }

  async findExisting(bookId: number, user: RequestUser): Promise<StorytellerExistingMatchesResponse> {
    const startedAt = Date.now();
    await this.bookService.verifyBookAccess(bookId, user);
    const pair = await this.resolvePair(bookId);
    if (!pair || !(await this.canAccessPair(pair, bookId, user))) return { matches: [] };
    const connection = await this.settingsService.getConnection();
    if (!connection) throw new BadRequestException('Storyteller is not configured');

    const identity = await this.repo.findBookTitleAndAuthors(pair.textBookId);
    if (!identity) return { matches: [] };

    this.logger.log(
      `[${EXISTING_EVENT}] [start] bookId=${bookId} userId=${user.id} textBookId=${pair.textBookId} - existing read-along lookup started`,
    );
    const matches = await this.matchRemoteBooks(identity, connection).catch((error: unknown) => {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${EXISTING_EVENT}] [fail] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - existing read-along lookup failed`,
      );
      throw error;
    });
    this.logger.log(
      `[${EXISTING_EVENT}] [end] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAt} matches=${matches.length} - existing read-along lookup completed`,
    );
    return { matches };
  }

  /** The candidate list for one pair: the only read-alongs it is ever offered. */
  private async matchRemoteBooks(identity: StorytellerBookIdentity, connection: StorytellerConnection): Promise<StorytellerExistingMatch[]> {
    const remoteBooks = await this.client
      .createSession(connection)
      // Bounded by what Storyteller's own book query takes: pulling a whole aligned library to find
      // one title is the one unbounded remote read this feature could make. A narrowing, not a gate
      // - a search the server cannot honour just returns more rows for the matcher to score.
      .listBooks({ alignedOnly: true, search: identity.title ?? undefined, limit: STORYTELLER_MATCH_PAGE_SIZE })
      .catch((error: unknown) => {
        if (error instanceof HttpException) throw error;
        // StorytellerClientError carries `status`, not `statusCode`, so the global filter cannot read
        // it: unmapped, an unreachable or 401'ing Storyteller surfaces as a bare 500.
        const message = error instanceof Error ? error.message : String(error);
        throw new BadGatewayException(message || 'Storyteller could not be reached');
      });

    return matchExistingBooks(
      {
        title: identity.title ?? '',
        authors: identity.authorNames,
        identifiers: [identity.isbn10, identity.isbn13, identity.asin].filter((value): value is string => value !== null),
      },
      remoteBooks,
    );
  }

  /**
   * A uuid the server would itself have offered for this pair, or nothing. Without this the popover's
   * matching is presentational: any LibraryUpload holder could POST the uuid of an unrelated aligned
   * book and have its read-along attached as this pair's third member.
   */
  private async assertOfferedUuid(
    pair: StorytellerReadAlongPair,
    uuid: string,
    connection: StorytellerConnection,
    bookId: number,
    userId: number,
    startedAt: number,
  ): Promise<void> {
    const identity = await this.repo.findBookTitleAndAuthors(pair.textBookId);
    const matches = identity ? await this.matchRemoteBooks(identity, connection) : [];
    if (matches.some((match) => match.uuid === uuid && match.aligned)) return;

    const refusal = new BadRequestException('That Storyteller book is not a match for this pair');
    const { errorClass, message } = describeError(refusal);
    this.logger.warn(
      `[${REQUEST_EVENT}] [fail] bookId=${bookId} userId=${userId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - unoffered Storyteller book refused`,
    );
    throw refusal;
  }

  /**
   * Re-attaches a read-along to a link that lost it, which is what an unlink and relink leaves
   * behind. One-sided: the link only ever gains the member it is missing.
   */
  private async attachExistingOutput(
    pair: StorytellerReadAlongPair,
    build: { id: number; attachedLinkId: number | null },
    outputBookId: number,
    user: RequestUser,
  ): Promise<void> {
    const buildId = build.id;
    if (pair.linkId === null) return;
    if (pair.link?.readAlongBookId === outputBookId) {
      // Already on the link but never recorded there (a row built before the stamp existed): without
      // the stamp a later detach on this link would be undone by the next status read.
      if (build.attachedLinkId !== pair.linkId) await this.stampAttachedLinkBestEffort(buildId, pair.linkId);
      return;
    }
    if (!(await this.canAccessBook(outputBookId, user))) return;

    const startedAt = Date.now();
    this.logger.log(
      `[${ATTACH_EVENT}] [start] linkId=${pair.linkId} buildId=${buildId} outputBookId=${outputBookId} userId=${user.id} - existing read-along re-attach started`,
    );
    try {
      const linked = await this.editionLinks.setReadAlongBook(pair.linkId, outputBookId);
      // Stamped so a later detach on this same link reads as deliberate and is left alone.
      if (linked !== undefined) await this.repo.updateBuild(buildId, { attachedLinkId: pair.linkId });
      this.logger.log(
        `[${ATTACH_EVENT}] [end] linkId=${pair.linkId} buildId=${buildId} outputBookId=${outputBookId} durationMs=${Date.now() - startedAt} attached=${linked !== undefined} - existing read-along re-attach completed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${ATTACH_EVENT}] [fail] linkId=${pair.linkId} buildId=${buildId} outputBookId=${outputBookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - existing read-along re-attach failed`,
      );
    }
  }

  private async stampAttachedLinkBestEffort(buildId: number, linkId: number): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.repo.updateBuild(buildId, { attachedLinkId: linkId });
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${ATTACH_EVENT}] [fail] linkId=${linkId} buildId=${buildId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - attached link could not be recorded`,
      );
    }
  }

  // The pair an unlinked book would form with `counterpartId`: one text and one audio edition, in
  // either order. Anything else is no pair, the same as an unlinked book.
  private async proposedPair(bookId: number, counterpartId: number): Promise<StorytellerReadAlongPair | null> {
    const [own, other] = await Promise.all([this.editionLinks.getBookModality(bookId), this.editionLinks.getBookModality(counterpartId)]);
    if (own === 'text' && other === 'audio') return { textBookId: bookId, audioBookId: counterpartId, linkId: null, role: 'text', link: null };
    if (own === 'audio' && other === 'text') return { textBookId: counterpartId, audioBookId: bookId, linkId: null, role: 'audio', link: null };
    return null;
  }

  async resolvePair(bookId: number): Promise<StorytellerReadAlongPair | null> {
    const link = await this.editionLinks.findLinkForBook(bookId);
    if (link) {
      const role = link.textBookId === bookId ? 'text' : link.audioBookId === bookId ? 'audio' : 'readAlong';
      return { textBookId: link.textBookId, audioBookId: link.audioBookId, linkId: link.id, role, link };
    }
    if ((await this.editionLinks.getBookModality(bookId)) === 'both') {
      return { textBookId: bookId, audioBookId: bookId, linkId: null, role: 'self', link: null };
    }
    return null;
  }

  // Reads no secret: "configured" is the three stored fields getConnection() checks, minus the
  // decrypt this path never needs. `probeContent` is false while a build runs, because the two file
  // probes answer a control the building row does not render.
  private async getCheapBlockReason(
    pair: StorytellerReadAlongPair | null,
    settings: StorytellerSettings,
    probeContent: boolean,
  ): Promise<ReadAlongBlockReason | null> {
    if (!settings.serverUrl || !settings.username || !settings.passwordConfigured) return 'not_configured';
    if (!pair) return settings.targetLibraryId == null ? 'no_target_library' : 'no_pair';
    if (probeContent) {
      const [epub, hasAudio] = await Promise.all([this.repo.findSourceEpubFile(pair.textBookId), this.repo.hasAudioContentFile(pair.audioBookId)]);
      if (!epub) return 'no_epub';
      if (!hasAudio) return 'no_audio';
    }
    if (settings.targetLibraryId == null) return 'no_target_library';
    return null;
  }

  /**
   * A destination the caller cannot build into stops every future build, so it outranks "this book
   * has no counterpart yet": the tick box on Link has to be disabled before the link is made.
   * `getCheapBlockReason` always answers something for an unlinked book, so without this the target
   * is never consulted there at all.
   */
  private emptyBlockReason(
    contentBlock: ReadAlongBlockReason | null,
    libraryId: number | null,
    targetLibrary: { allowed: boolean },
  ): ReadAlongBlockReason | null {
    const targetBlock = this.targetBlockReason(libraryId, targetLibrary);
    if (contentBlock === null || contentBlock === 'no_pair') return targetBlock ?? contentBlock;
    return contentBlock;
  }

  private targetBlockReason(libraryId: number | null, targetLibrary: { allowed: boolean }): ReadAlongBlockReason | null {
    return libraryId != null && !targetLibrary.allowed ? 'target_not_allowed' : null;
  }

  // The text/audio pair IS the read-along's subject, so access to both is required. Answered as a
  // boolean rather than thrown, because verifyBookAccess names the book it refuses and that book is
  // the counterpart, not the one asked about. The output member is not required: it lands in an
  // admin-designated library, and demanding access would 404 every non-admin.
  private async canAccessPair(pair: StorytellerReadAlongPair, requestedBookId: number, user: RequestUser): Promise<boolean> {
    const ids = new Set([pair.textBookId, pair.audioBookId]);
    ids.delete(requestedBookId);
    const access = await Promise.all([...ids].map((id) => this.canAccessBook(id, user)));
    return access.every((allowed) => allowed);
  }

  // False when the book is denied or filtered away; a transient failure still propagates.
  private async canAccessBook(bookId: number, user: RequestUser): Promise<boolean> {
    try {
      await this.bookService.verifyBookAccess(bookId, user);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) return false;
      throw error;
    }
  }

  // The status a blocked answer reports when the refusal comes before the build row was read. A pair
  // member the caller cannot open answers as no pair, or this describes a build against a book they
  // were never shown.
  private async statusOfExistingBuild(bookId: number, user: RequestUser): Promise<ReadAlongStatus> {
    const pair = await this.resolvePair(bookId);
    if (!pair || !(await this.canAccessPair(pair, bookId, user))) return 'none';
    const build = await this.repo.findBuildByPair(pair.textBookId, pair.audioBookId);
    return normalizeReadAlongStatus(build?.status);
  }

  private canDeleteBooks(user: RequestUser): boolean {
    return user.isSuperuser || user.permissions.includes(Permission.LibraryDeleteBooks);
  }

  // The same permission the build route is gated by, so the status route never describes a build to
  // a caller the build route would reject outright.
  private canRequestBuild(user: RequestUser): boolean {
    return user.isSuperuser || user.permissions.includes(Permission.LibraryUpload);
  }

  private hasRecentFailedCheck(lastCheckedAt: string | null, ok: boolean | undefined): boolean {
    if (ok !== false || !lastCheckedAt) return false;
    const checkedAt = Date.parse(lastCheckedAt);
    return Number.isFinite(checkedAt) && Date.now() - checkedAt < FAILED_CHECK_TTL_MS;
  }

  private blocked(
    status: string | undefined,
    blocked: ReadAlongBlockReason | null,
    bookId: number,
    userId: number,
    startedAt: number,
  ): ReadAlongBuildResponse {
    const normalizedStatus = normalizeReadAlongStatus(status);
    this.logger.log(
      `[${REQUEST_EVENT}] [end] bookId=${bookId} userId=${userId} durationMs=${Date.now() - startedAt} status=${normalizedStatus} blocked=${blocked ?? 'none'} - read-along build request completed`,
    );
    return { status: normalizedStatus, blocked };
  }

  private logConfigurationFailure(bookId: number, userId: number, startedAt: number, error: Error): void {
    const { errorClass, message } = describeError(error);
    this.logger.error(
      `[${REQUEST_EVENT}] [fail] bookId=${bookId} userId=${userId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - stored Storyteller connection could not be read`,
    );
  }

  // Returned whenever no build row exists, which is when the popover shows the destination, the
  // keep-a-copy choice and its sizes - all three from the instance settings and this pair, or the
  // form pre-fills a default the build then contradicts.
  private async emptyStatus(
    settings: StorytellerSettings,
    pair: StorytellerReadAlongPair | null,
    user: RequestUser,
    canBuild: boolean,
  ): Promise<ReadAlongStatusResponse> {
    const [contentBlock, remoteCopyBytes, targetLibrary] = await Promise.all([
      canBuild ? this.getCheapBlockReason(pair, settings, true) : Promise.resolve(null),
      this.resolveCopySizes(pair, null),
      this.resolveTargetLibrary(settings.targetLibraryId, user),
    ]);
    return {
      status: 'none',
      blocked: canBuild ? this.emptyBlockReason(contentBlock, settings.targetLibraryId, targetLibrary) : null,
      phase: null,
      transport: null,
      remoteTask: null,
      remoteProgress: null,
      outputBook: null,
      targetLibraryId: targetLibrary.id,
      targetLibraryName: targetLibrary.name,
      remoteCopyBytes,
      keepRemoteCopyByDefault: canBuild && !settings.deleteRemoteAfterImport,
      remoteCopyReclaimable: canBuild && this.remoteCopyReclaimable(settings, null),
      error: null,
      startedAt: null,
      builtAt: null,
      queuePosition: null,
    };
  }
}
