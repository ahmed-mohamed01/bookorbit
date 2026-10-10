import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AudiobookshelfBookState,
  AudiobookshelfBookStatePage,
  AudiobookshelfBookSyncLink,
  AudiobookshelfBookSyncLive,
  AudiobookshelfDivergedReason,
  AudiobookshelfMatchMethod,
  AudiobookshelfReconcileDirection,
  AudiobookshelfSyncLinkStatus,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import { AudiobookshelfApiError, AudiobookshelfClientService, type AbsItemCover, type AbsMediaProgress } from './audiobookshelf-client.service';
import { AudiobookshelfProgressPushService } from './audiobookshelf-progress-push.service';
import { AudiobookshelfSyncCoordinatorService } from './audiobookshelf-sync-coordinator.service';
import { AUDIOBOOKSHELF_SYNC_PUSH_WAIT_MS, AudiobookshelfSyncService } from './audiobookshelf-sync.service';
import { parseAndNormalizeServerUrl } from './audiobookshelf-url.utils';
import { AudiobookshelfRepository, type AbsAudioProgressSnapshot, type AbsBookAccessScope, type AbsBookStateView } from './audiobookshelf.repository';
import { buildBookAccessScope, describeError, isAbsSyncConfigured } from './audiobookshelf-user.utils';
import type { ListAudiobookshelfBookStatesDto } from './dto';
import type { AudiobookshelfBookState as AudiobookshelfBookStateRow, AudiobookshelfUserSetting } from './schema/audiobookshelf.schema';

// A panel opening should not wait the full request timeout on a server that is down.
const AUDIOBOOKSHELF_LIVE_CHECK_TIMEOUT_MS = 4_000;
// Positions closer than this on the book clock are the same place: a player saves every few seconds
// and ABS rounds, so a smaller gap is noise rather than two different positions.
const AUDIOBOOKSHELF_DIVERGED_THRESHOLD_SECONDS = 60;

type SyncTargetState = AudiobookshelfBookStateRow & { bookId: number };

interface SyncTarget {
  settings: AudiobookshelfUserSetting;
  state: SyncTargetState;
}

interface LinkStatus {
  status: AudiobookshelfSyncLinkStatus;
  divergedReason: AudiobookshelfDivergedReason | null;
}

@Injectable()
export class AudiobookshelfBookStateService {
  private readonly logger = new Logger(AudiobookshelfBookStateService.name);

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly bookService: BookService,
    private readonly libraryService: LibraryService,
    private readonly editionLinks: EditionLinkRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly syncService: AudiobookshelfSyncService,
    private readonly progressPush: AudiobookshelfProgressPushService,
    private readonly coordinator: AudiobookshelfSyncCoordinatorService,
  ) {}

  /** A small cover for an item matched to one of the user's books, fetched with the user's ABS token. */
  async getCoverThumbnail(user: RequestUser, absLibraryItemId: string, width: number): Promise<AbsItemCover> {
    const target = await this.findItemSyncTarget(user, absLibraryItemId);

    let cover: AbsItemCover | null;
    try {
      cover = await this.client.getItemCover(user.id, target.settings.serverUrl, target.settings.apiToken, absLibraryItemId, width);
    } catch (error) {
      if (error instanceof AudiobookshelfApiError) throw new BadGatewayException('Audiobookshelf cover unavailable');
      throw error;
    }
    if (!cover) throw new NotFoundException('Audiobookshelf item has no cover');
    return cover;
  }

  /**
   * The Audiobookshelf item a book's position syncs with, given the audiobook or a book linked to it.
   * Only the audiobook is ever matched in Audiobookshelf, so its linked editions reach the item through it.
   */
  async findPositionSyncLink(user: RequestUser, bookId: number): Promise<AudiobookshelfBookSyncLink | null> {
    const settings = await this.repo.findSettings(user.id);
    if (!settings || !isAbsSyncConfigured(settings)) return null;

    await this.bookService.verifyBookAccess(bookId, user);
    const direct = await this.usableLinkState(user, settings, await this.repo.findBookStateByBookId(user.id, bookId));
    if (direct && this.pausedReasonFor(settings, direct) === null) return this.toSyncLink(settings, direct);

    const link = await this.editionLinks.findLinkForBook(bookId);
    const linked =
      link && link.audioBookId !== bookId
        ? await this.usableLinkState(user, settings, await this.repo.findBookStateByBookId(user.id, link.audioBookId))
        : null;
    const state = linked ?? direct;
    return state ? this.toSyncLink(settings, state) : null;
  }

  private async usableLinkState(
    user: RequestUser,
    settings: AudiobookshelfUserSetting,
    state: AudiobookshelfBookStateRow | undefined,
  ): Promise<SyncTargetState | null> {
    if (
      !state ||
      state.bookId == null ||
      state.matchError != null ||
      state.manualUnlinked ||
      (state.absLibraryId && (settings.excludedLibraryIds ?? []).includes(state.absLibraryId)) ||
      !(await this.canAccessBook(user, state.bookId))
    ) {
      return null;
    }
    return state as SyncTargetState;
  }

  private pausedReasonFor(settings: AudiobookshelfUserSetting, state: AudiobookshelfBookStateRow): AudiobookshelfBookSyncLink['pausedReason'] {
    return state.needsReview
      ? 'needs_review'
      : state.syncExcluded
        ? 'excluded'
        : !(settings.syncPosition || settings.pushPosition)
          ? 'position_sync_off'
          : null;
  }

  private toSyncLink(settings: AudiobookshelfUserSetting, state: SyncTargetState): AudiobookshelfBookSyncLink {
    const pausedReason = this.pausedReasonFor(settings, state);
    const normalizedServer = parseAndNormalizeServerUrl(settings.serverUrl);
    return {
      audioBookId: state.bookId,
      absLibraryItemId: state.absLibraryItemId,
      title: state.absTitle,
      authorName: state.absAuthorName,
      libraryName: state.absLibraryName,
      direction: settings.syncPosition && settings.pushPosition ? 'two_way' : settings.syncPosition ? 'from_abs' : 'to_abs',
      syncing: pausedReason === null,
      pausedReason,
      webUrl: normalizedServer ? `${normalizedServer}/item/${encodeURIComponent(state.absLibraryItemId)}` : null,
    };
  }

  /** Audiobookshelf's own progress for a matched item and whether anything is waiting to sync. */
  async getLiveSyncStatus(user: RequestUser, absLibraryItemId: string): Promise<AudiobookshelfBookSyncLive> {
    return this.liveStatusFor(user.id, await this.findItemSyncTarget(user, absLibraryItemId));
  }

  /**
   * The user's explicit answer to a diverged or waiting position: pull takes Audiobookshelf's position
   * and push sends BookOrbit's, each bypassing the automatic newest-wins rules but no safety guard.
   */
  async reconcile(user: RequestUser, absLibraryItemId: string, direction: AudiobookshelfReconcileDirection): Promise<AudiobookshelfBookSyncLive> {
    const target = await this.findItemSyncTarget(user, absLibraryItemId);
    const { bookId } = target.state;
    const logIds = `userId=${user.id} bookId=${bookId} absItemId="${sanitizeLogValue(absLibraryItemId)}" direction=${direction}`;
    const startedAt = Date.now();
    this.logger.log(`[abs.reconcile] [start] ${logIds} - reconcile started`);

    try {
      const { applied, reason } = direction === 'pull' ? await this.reconcilePull(user, target) : await this.reconcilePush(user.id, absLibraryItemId);
      this.logger.log(
        `[abs.reconcile] [end] ${logIds} durationMs=${Date.now() - startedAt} applied=${applied} reason=${reason} - reconcile completed`,
      );
    } catch (error) {
      const { errorClass, error: message } = describeError(error);
      this.logger.warn(
        `[abs.reconcile] [fail] ${logIds} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - reconcile failed`,
      );
      throw error;
    }

    return this.liveStatusFor(user.id, await this.findItemSyncTarget(user, absLibraryItemId));
  }

  private async reconcilePull(user: RequestUser, target: SyncTarget): Promise<{ applied: boolean; reason: string }> {
    if (!(await this.coordinator.acquireSync(user.id, AUDIOBOOKSHELF_SYNC_PUSH_WAIT_MS))) {
      throw new ConflictException('An Audiobookshelf sync is already running');
    }
    try {
      const { settings, state } = target;
      let remote: AbsMediaProgress | null;
      try {
        remote = await this.client.getMediaProgress(user.id, settings.serverUrl, settings.apiToken, state.absLibraryItemId);
      } catch (error) {
        if (error instanceof AudiobookshelfApiError) throw new BadGatewayException('Audiobookshelf progress unavailable');
        throw error;
      }
      if (!remote) return { applied: false, reason: 'no_remote_progress' };
      return await this.syncService.pullPositionNow(user, state, remote);
    } finally {
      this.coordinator.endSync(user.id);
    }
  }

  private async reconcilePush(userId: number, absLibraryItemId: string): Promise<{ applied: boolean; reason: string }> {
    if (!this.coordinator.tryStartPush(userId)) {
      throw new ConflictException('An Audiobookshelf sync or position push is already running');
    }
    try {
      const { outcome, reason } = await this.progressPush.pushPositionNow(userId, absLibraryItemId);
      if (outcome === 'unreachable' || outcome === 'failed') throw new BadGatewayException('Audiobookshelf position push failed');
      return { applied: outcome === 'pushed', reason };
    } finally {
      this.coordinator.endPush(userId);
    }
  }

  private async liveStatusFor(userId: number, { settings, state }: SyncTarget): Promise<AudiobookshelfBookSyncLive> {
    let reachable = true;
    const [remote, local] = await Promise.all([
      this.client
        .getMediaProgress(userId, settings.serverUrl, settings.apiToken, state.absLibraryItemId, AUDIOBOOKSHELF_LIVE_CHECK_TIMEOUT_MS)
        .catch((error: unknown) => {
          if (!(error instanceof AudiobookshelfApiError)) throw error;
          reachable = false;
          return null;
        }),
      this.repo.findAudioProgress(userId, state.bookId),
    ]);

    const link: LinkStatus = reachable ? await this.syncLinkStatus(settings, state, remote, local) : { status: 'unreachable', divergedReason: null };
    return {
      status: link.status,
      progress: remote
        ? { percentage: Math.max(0, Math.min(100, remote.progress * 100)), isFinished: remote.isFinished, lastUpdate: remote.lastUpdate }
        : null,
      local: local ? { percentage: Math.max(0, Math.min(100, local.percentage)), capturedAt: local.capturedAt.toISOString() } : null,
      divergedReason: link.divergedReason,
    };
  }

  private async syncLinkStatus(
    settings: AudiobookshelfUserSetting,
    state: SyncTargetState,
    remote: AbsMediaProgress | null,
    local: AbsAudioProgressSnapshot | undefined,
  ): Promise<LinkStatus> {
    const watermark = state.lastSyncedPositionAbsUpdate ?? 0;
    const absMovedSinceSync = remote !== null && remote.lastUpdate > watermark;
    // Every pull attempt stamps the row (lastSyncedAt, or updatedAt with syncError on a throw).
    const lastAttemptAt = state.syncError ? state.updatedAt : state.lastSyncedAt;

    if (settings.pushPosition && state.pushPendingAt) {
      // Mirrors the push decision: nothing new locally means nothing to send, and when both sides
      // moved the newer timestamp wins, so an ABS position newer than ours will be pulled instead.
      const localUnchanged = !local || (state.lastSyncedProgressAt !== null && local.updatedAt.getTime() === state.lastSyncedProgressAt.getTime());
      const absWins = absMovedSinceSync && local !== undefined && remote.lastUpdate > local.capturedAt.getTime();
      if (!localUnchanged && !absWins) return { status: 'sending', divergedReason: null };
    }

    // The pull leaves the watermark behind for positions it refuses for good (no audio files, a
    // duration mismatch, an unresolvable position), so a lagging watermark alone would read as
    // receiving forever; once an attempt has run since ABS changed, the lag is not closing.
    const pullPending = settings.syncPosition && absMovedSinceSync && !(lastAttemptAt && lastAttemptAt.getTime() >= remote.lastUpdate);
    if (pullPending) return { status: 'receiving', divergedReason: null };

    if (!remote || !local || !(await this.positionsDiverge(state.bookId, remote, local))) return { status: 'synced', divergedReason: null };

    const localNewer = local.capturedAt.getTime() > remote.lastUpdate;
    const pullRefused = remote.lastUpdate > local.capturedAt.getTime() && lastAttemptAt !== null && lastAttemptAt.getTime() >= remote.lastUpdate;
    const divergedReason: AudiobookshelfDivergedReason = localNewer && !settings.pushPosition ? 'push_off' : pullRefused ? 'pull_refused' : 'stale';
    return { status: 'diverged', divergedReason };
  }

  /** Compares both positions on the audiobook's own clock; no comparison is possible without a resolvable local position. */
  private async positionsDiverge(bookId: number, remote: AbsMediaProgress, local: AbsAudioProgressSnapshot): Promise<boolean> {
    if (!Number.isFinite(remote.currentTime)) return false;
    const position = await this.bookService.resolveAudiobookPositionForExternalSync(bookId, local.currentFileId, local.positionSeconds);
    if (!position) return false;
    return Math.abs(position.audioSeconds - remote.currentTime) > AUDIOBOOKSHELF_DIVERGED_THRESHOLD_SECONDS;
  }

  private async findItemSyncTarget(user: RequestUser, absLibraryItemId: string): Promise<SyncTarget> {
    const target = await this.findSyncTarget(user, () => this.repo.findBookStateRow(user.id, absLibraryItemId));
    if (!target) throw new NotFoundException('Audiobookshelf item not found');
    return target;
  }

  /** The configured settings and a sync-eligible, accessible matched row, or null when the item is not position-synced. */
  private async findSyncTarget(
    user: RequestUser,
    locate: (settings: AudiobookshelfUserSetting) => Promise<AudiobookshelfBookStateRow | undefined>,
  ): Promise<SyncTarget | null> {
    const settings = await this.repo.findSettings(user.id);
    if (!settings || !isAbsSyncConfigured(settings) || !(settings.syncPosition || settings.pushPosition)) return null;
    const state = await locate(settings);
    if (!state || !this.isSyncEligible(settings, state)) return null;
    if (!(await this.canAccessBook(user, state.bookId))) return null;
    return { settings, state };
  }

  /** The same row eligibility the pull applies in findSyncableBookStatesByAbsItemIds. */
  private isSyncEligible(settings: AudiobookshelfUserSetting, state: AudiobookshelfBookStateRow): state is SyncTargetState {
    return (
      state.bookId != null &&
      !state.needsReview &&
      state.matchError == null &&
      !state.syncExcluded &&
      !state.manualUnlinked &&
      !(state.absLibraryId && (settings.excludedLibraryIds ?? []).includes(state.absLibraryId))
    );
  }

  private async canAccessBook(user: RequestUser, bookId: number): Promise<boolean> {
    try {
      await this.bookService.verifyBookAccess(bookId, user);
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  }

  async list(user: RequestUser, dto: ListAudiobookshelfBookStatesDto): Promise<AudiobookshelfBookStatePage> {
    const page = dto.page ?? 0;
    const pageSize = dto.pageSize ?? 20;
    const [scope, settings] = await Promise.all([buildBookAccessScope(user, this.libraryService), this.repo.findSettings(user.id)]);
    const { items, total } = await this.repo.listBookStates(user.id, scope, dto.bucket, page, pageSize, dto.q, settings?.excludedLibraryIds ?? []);
    return { items: items.map((item) => this.toApi(item)), total, page, pageSize };
  }

  async confirm(user: RequestUser, absLibraryItemId: string): Promise<AudiobookshelfBookState> {
    const scope = await buildBookAccessScope(user, this.libraryService);
    const scoped = await this.repo.findBookStateView(user.id, absLibraryItemId, scope);
    if (!scoped) throw new NotFoundException('Audiobookshelf item not found');
    if (scoped.bookId == null || !scoped.needsReview) {
      throw new BadRequestException('This Audiobookshelf item is not awaiting review');
    }

    await this.repo.updateBookState(user.id, scoped.absLibraryItemId, { needsReview: false, matchError: null, manualUnlinked: false });
    this.logger.log(`[abs.confirm_match] [end] userId=${user.id} bookId=${scoped.bookId} - review match confirmed`);
    return this.viewOrThrow(user.id, scoped.absLibraryItemId, scope);
  }

  async link(user: RequestUser, absLibraryItemId: string, bookId: number): Promise<AudiobookshelfBookState> {
    await this.bookService.verifyBookAccess(bookId, user);
    const row = await this.repo.findBookStateRow(user.id, absLibraryItemId);
    if (!row) throw new NotFoundException('Audiobookshelf item not found');
    const scope = await buildBookAccessScope(user, this.libraryService);
    await this.assertCurrentStateInScope(user.id, absLibraryItemId, row.bookId, scope);

    await this.repo.updateBookState(user.id, absLibraryItemId, {
      bookId,
      matchMethod: 'manual',
      matchConfidence: null,
      needsReview: false,
      matchError: null,
      manualUnlinked: false,
      lastMatchAttemptAt: new Date(),
    });
    this.logger.log(`[abs.manual_link] [end] userId=${user.id} bookId=${bookId} - manual link set`);
    return this.viewOrThrow(user.id, absLibraryItemId, scope);
  }

  async unlink(user: RequestUser, absLibraryItemId: string): Promise<AudiobookshelfBookState> {
    const row = await this.repo.findBookStateRow(user.id, absLibraryItemId);
    if (!row) throw new NotFoundException('Audiobookshelf item not found');
    const scope = await buildBookAccessScope(user, this.libraryService);
    await this.assertCurrentStateInScope(user.id, absLibraryItemId, row.bookId, scope);

    await this.repo.updateBookState(user.id, absLibraryItemId, {
      bookId: null,
      matchMethod: null,
      matchConfidence: null,
      needsReview: false,
      matchError: null,
      manualUnlinked: true,
      lastMatchAttemptAt: new Date(),
    });
    this.logger.log(`[abs.unlink] [end] userId=${user.id} previousBookId=${row.bookId ?? 'null'} - link cleared`);
    return this.viewOrThrow(user.id, absLibraryItemId, scope);
  }

  async setExclusion(user: RequestUser, absLibraryItemId: string, syncExcluded: boolean): Promise<AudiobookshelfBookState> {
    const row = await this.repo.findBookStateRow(user.id, absLibraryItemId);
    if (!row) throw new NotFoundException('Audiobookshelf item not found');
    const scope = await buildBookAccessScope(user, this.libraryService);
    await this.assertCurrentStateInScope(user.id, absLibraryItemId, row.bookId, scope);

    await this.repo.updateBookState(user.id, absLibraryItemId, { syncExcluded });
    return this.viewOrThrow(user.id, absLibraryItemId, scope);
  }

  private async assertCurrentStateInScope(
    userId: number,
    absLibraryItemId: string,
    bookId: number | null | undefined,
    scope: AbsBookAccessScope,
  ): Promise<void> {
    if (bookId == null) return;
    const view = await this.repo.findBookStateView(userId, absLibraryItemId, scope);
    if (!view) throw new NotFoundException('Audiobookshelf item not found');
  }

  private async viewOrThrow(userId: number, absLibraryItemId: string, scope: AbsBookAccessScope): Promise<AudiobookshelfBookState> {
    const view = await this.repo.findBookStateView(userId, absLibraryItemId, scope);
    if (!view) throw new NotFoundException('Audiobookshelf item not found');
    return this.toApi(view);
  }

  private toApi(view: AbsBookStateView): AudiobookshelfBookState {
    return {
      absLibraryItemId: view.absLibraryItemId,
      absTitle: view.absTitle ?? '',
      absAuthorName: view.absAuthorName,
      absSeriesName: view.absSeriesName,
      absLibraryName: view.absLibraryName,
      absPath: view.absPath,
      bookId: view.bookId,
      bookTitle: view.bookTitle,
      bookAuthorName: view.bookAuthorName,
      bookSeriesName: view.bookSeriesName,
      bookLibraryName: view.bookLibraryName,
      bookFolderPath: view.bookFolderPath,
      matchMethod: view.matchMethod as AudiobookshelfMatchMethod | null,
      matchConfidence: view.matchConfidence,
      needsReview: view.needsReview,
      matchError: view.matchError,
      syncExcluded: view.syncExcluded,
      syncError: view.syncError,
      lastSyncedAt: view.lastSyncedAt?.toISOString() ?? null,
    };
  }
}
