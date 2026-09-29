import { realpath, stat } from 'fs/promises';
import { basename } from 'path';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import type { BookDockMetadata, ReadAlongPhase, StorytellerEffectiveTransport, StorytellerSettings } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { isUniqueViolation } from '../../common/utils/db-error.utils';
import { findSourceEpubProblem } from './storyteller-epub.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import type { UpdateBookMetadataDto } from '../book/dto/update-book-metadata.dto';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import { EpubService } from '../reader/epub/epub.service';
import type { StorytellerReadAlongPair } from './storyteller-read-along-status.service';
import type { StorytellerBookSummary, StorytellerRemoteSettings, StorytellerSession } from './storyteller-client.types';
import { StorytellerClientError, StorytellerClientService } from './storyteller-client.service';
import { describeError } from './storyteller-log.utils';
import { StorytellerReadAlongNotifierService, readAlongNotifyStage, type ReadAlongAttempt } from './storyteller-read-along-notifier.service';
import { storytellerConfig } from './storyteller.config';
import { canonicalPath, isPathWithinFolder, sharedAudioDirectory, toLocalPath, toRemotePath } from './storyteller-path.utils';
import { StorytellerReadAlongImportService } from './storyteller-read-along-import.service';
import { StorytellerRepository, type StorytellerAudioFile, type StorytellerSourceEpubFile } from './storyteller.repository';
import { StorytellerSettingsService, resolveStorytellerTargetFolder } from './storyteller-settings.service';

const MAX_CONCURRENT_BUILDS = 1;
const MAX_ERROR_CHARS = 500;
const WAIT_INITIAL_DELAY_MS = 10_000;
const WAIT_MAX_DELAY_MS = 60_000;
const WAIT_ERROR_CAP = 20;
const MEDIA_LINK_POLL_MS = 2_000;
const MEDIA_LINK_CEILING_MS = 120_000;
const TERMINAL_WRITE_RETRY_MS = 1_000;
const STALE_ALIGNED_POLL_CAP = 4;
const FOREIGN_KEY_VIOLATION = '23503';

const BUILD_EVENT = 'storyteller.read_along.build';
const WAIT_EVENT = 'storyteller.read_along.wait';
const COLLECT_EVENT = 'storyteller.read_along.collect';
const LINK_EVENT = 'storyteller.read_along.link';
const REGISTER_EVENT = 'storyteller.read_along.register';
const UPLOAD_EVENT = 'storyteller.read_along.upload';
const CLEANUP_EVENT = 'storyteller.read_along.cleanup';
// Its own event: a second [fail] under the build event would read as a second failed build.
const FAIL_WRITE_EVENT = 'storyteller.read_along.fail_write';
const STAMP_EVENT = 'storyteller.read_along.stamp_link';
const METADATA_EVENT = 'storyteller.read_along.metadata';
const REPROCESS_EVENT = 'storyteller.read_along.reprocess';
const SLOT_EVENT = 'storyteller.read_along.slot_release';
const MATCH_EXISTING_EVENT = 'storyteller.read_along.match_existing';
const UNMATCHED_EXISTING_MESSAGE = 'Storyteller already has a book for these files and it could not be matched; remove or import it in Storyteller';
const REFUSAL_PREFIX = /^Storyteller answered \d+: /;
const STALE_ALIGNED_MESSAGE =
  'Storyteller reports this book as aligned but no longer has its read-along file, and processing it again did not start; re-process the book in Storyteller, then generate again';

/** The provider's own words from a refused request, without the status wrapper the client adds. */
function storytellerRefusalText(refusal: StorytellerClientError): string {
  const body = refusal.message.replace(REFUSAL_PREFIX, '').trim();
  try {
    const parsed = JSON.parse(body) as unknown;
    const message = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).message : null;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {
    // Not JSON: the body is already plain text.
  }
  return body || refusal.message;
}

/**
 * Why a pinned shared-paths build cannot run, in the words of the guard that refused it. The pin
 * means "never push my files over the network", so an unusable configuration ends the build rather
 * than quietly uploading gigabytes the settings page reports as unavailable.
 */
const PINNED_SHARED_PATHS_PROBLEM: Record<string, string> = {
  no_path_mappings: 'no path mappings are configured',
  readaloud_not_custom_folder: 'its read-along location is not set to a custom folder',
  readaloud_folder_not_mapped: 'its read-along folder is not covered by a path mapping',
  readaloud_folder_inside_library:
    'its read-along folder is inside a library folder, where every read-along would be scanned with the audiobook tags Storyteller writes into it',
};

function pinnedSharedPathsMessage(reason: string | null): string {
  const problem = (reason === null ? null : PINNED_SHARED_PATHS_PROBLEM[reason]) ?? 'the shared-paths configuration is incomplete';
  return `Storyteller is set to use shared paths, but ${problem}`;
}

export const STORYTELLER_SLEEP = Symbol('STORYTELLER_SLEEP');
/** Resolves early, never rejects, when `signal` aborts: the caller checks the signal after waking. */
export type StorytellerSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

/**
 * A build slot its holder took before claiming the row, and hands to `runBuild` to release at the
 * end of the build. Releasing a second time frees nothing: the slot may since have been taken by
 * another reservation, and freeing that one would put two builds on a one-build instance.
 */
export interface StorytellerBuildSlot {
  readonly signal: AbortSignal;
  release(): void;
}

const CANCEL_TOO_LATE_MESSAGE = 'The read-along is being imported and can no longer be cancelled';

/** Raised inside a build whose slot was cancelled, and never persisted as a failure. */
class ReadAlongCancelledError extends Error {
  constructor() {
    super('The read-along build was cancelled');
    this.name = 'ReadAlongCancelledError';
  }
}

/** Storyteller reported the job cancelled: someone stopped it there, which ends the build as cancelled. */
class ReadAlongRemoteCancelledError extends Error {
  constructor() {
    super('The read-along job was cancelled in Storyteller');
    this.name = 'ReadAlongRemoteCancelledError';
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ReadAlongCancelledError();
}

export interface StorytellerRunBuildOptions {
  force?: boolean;
  targetLibraryId?: number;
  targetFolderId?: number;
  /** A previous output of the pair, replaced in place when the build can show it produced it. */
  oldOutputBookId?: number | null;
  /** Whether the previous output may be deleted when it could not be replaced in place; needs the delete permission. */
  removePreviousOutput?: boolean;
  /** Per-build override for the instance-wide `deleteRemoteAfterImport`. */
  cleanUpRemote?: boolean;
  /** The attempt its notification is keyed to; a build without one keys it to its own start. */
  attempt?: ReadAlongAttempt;
}

interface PreparedBuild {
  pair: StorytellerReadAlongPair;
  session: StorytellerSession;
  settings: StorytellerSettings;
  remoteSettings: StorytellerRemoteSettings;
  sourceEpub: StorytellerSourceEpubFile;
  audioFiles: StorytellerAudioFile[];
  targetLibraryId: number;
  targetFolderId: number;
  /** Every library folder on the instance, canonical, which Storyteller's staging folder must stay out of. */
  libraryFolderPaths: string[];
  /** Storyteller's custom read-aloud folder as this instance sees it, canonical; null when it has none mapped. */
  stagingFolder: string | null;
  transport: StorytellerEffectiveTransport;
  transportReason: string | null;
  signal: AbortSignal;
}

interface RegisteredBuild extends PreparedBuild {
  storytellerBookUuid: string;
  /**
   * True when Storyteller holds this pair by reference to files BookOrbit owns, which is what makes
   * the 409-at-process upload fallback safe and useful: replacing a book the caller named with
   * `useExistingUuid` would abandon the book the user chose, and replacing one Storyteller uploaded
   * would only orphan the gigabytes that upload pushed.
   */
  referenceImported: boolean;
  /**
   * True only for the upload route. Deleting a Storyteller book deletes the files attached to it,
   * so a book still referencing the user's library must never be deleted that way - and
   * `api-transfer` does not imply ownership, since the EPUB2 copy route leaves the audio referenced.
   */
  remoteOwnsAllSources: boolean;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type HeldBookMatch = { book: StorytellerBookSummary; matchedBy: 'ebook' | 'audio' | 'audio_directory'; path: string };

/** Expects canonical paths on both sides; ignores case because a false "inside" only costs a download. */
function isInsideAnyFolder(candidate: string, folderPaths: readonly string[]): boolean {
  return folderPaths.some((folderPath) => isPathWithinFolder(candidate, folderPath, { ignoreCase: true }));
}

function isForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === FOREIGN_KEY_VIOLATION) return true;
  return (error as { cause?: { code?: unknown } }).cause?.code === FOREIGN_KEY_VIOLATION;
}

/**
 * The linked editions' metadata as a book update, without the fields the read-along has locked.
 * Only what the ebook has is written: a field it lacks keeps whatever the read-along holds.
 */
function readAlongMetadataUpdate(metadata: BookDockMetadata, locked: ReadonlySet<string>): UpdateBookMetadataDto {
  const update: UpdateBookMetadataDto = {};
  const scalarKeys = ['title', 'subtitle', 'description', 'publisher', 'language', 'isbn10', 'isbn13'] as const;
  for (const key of scalarKeys) {
    if (metadata[key] != null && !locked.has(key)) update[key] = metadata[key] as string;
  }
  if (!locked.has('publishedYear')) {
    if (metadata.publishedDate != null) update.publishedDate = metadata.publishedDate;
    if (metadata.publishedYear != null) update.publishedYear = metadata.publishedYear;
  }
  // The pair is written together or not at all, as the lock service treats it.
  if (metadata.seriesName != null && !locked.has('seriesName') && !locked.has('seriesIndex')) {
    update.seriesName = metadata.seriesName;
    update.seriesIndex = metadata.seriesIndex ?? null;
  }
  if (metadata.authors?.length && !locked.has('authors')) update.authors = metadata.authors;
  if (metadata.genres?.length && !locked.has('genres')) update.genres = metadata.genres;
  if (metadata.narrators?.length && !locked.has('narrators')) update.audioMetadata = { narrators: metadata.narrators };
  return update;
}

function buildPairKey(pair: StorytellerReadAlongPair): string {
  return `${pair.textBookId}:${pair.audioBookId}`;
}

interface HeldSlot {
  controller: AbortController;
  /** Set once the collect begins: from there the read-along is written into a library and linked. */
  committed: boolean;
  released: Promise<void>;
}

@Injectable()
export class StorytellerReadAlongBuildService {
  private readonly logger = new Logger(StorytellerReadAlongBuildService.name);
  private readonly slots = new Map<string, HeldSlot>();
  private readonly releaseListeners: Array<() => void> = [];
  private readonly sleep: StorytellerSleep;

  constructor(
    @Inject(storytellerConfig.KEY) private readonly config: ConfigType<typeof storytellerConfig>,
    private readonly repo: StorytellerRepository,
    private readonly settingsService: StorytellerSettingsService,
    private readonly client: StorytellerClientService,
    private readonly editionLinks: EditionLinkRepository,
    private readonly bookService: BookService,
    private readonly libraryService: LibraryService,
    private readonly epubService: EpubService,
    private readonly importService: StorytellerReadAlongImportService,
    private readonly notifier: StorytellerReadAlongNotifierService,
    @Optional() @Inject(STORYTELLER_SLEEP) sleep?: StorytellerSleep,
  ) {
    this.sleep = sleep ?? defaultSleep;
  }

  /**
   * Takes the one build slot, or answers null when it is held. The check and the add run with no
   * await between them, as in reading-alignment, so two callers cannot both pass it: the holder goes
   * on to claim the build row, and a claim is what strips the uuid that is the only handle on a
   * Storyteller job the other caller may already have started.
   */
  tryReserve(pair: StorytellerReadAlongPair): StorytellerBuildSlot | null {
    const pairKey = buildPairKey(pair);
    if (this.slots.has(pairKey) || this.slots.size >= MAX_CONCURRENT_BUILDS) return null;
    let markReleased!: () => void;
    const held: HeldSlot = {
      controller: new AbortController(),
      committed: false,
      released: new Promise<void>((resolve) => {
        markReleased = resolve;
      }),
    };
    this.slots.set(pairKey, held);
    let open = true;
    return {
      signal: held.controller.signal,
      release: () => {
        if (!open) return;
        open = false;
        if (this.slots.get(pairKey) === held) this.slots.delete(pairKey);
        markReleased();
        this.notifySlotReleased();
      },
    };
  }

  /** Called once per release, after the slot is free: how the queue learns it can start the next build. */
  onSlotReleased(listener: () => void): void {
    this.releaseListeners.push(listener);
  }

  private notifySlotReleased(): void {
    for (const listener of this.releaseListeners) {
      try {
        listener();
      } catch (error) {
        const { errorClass, message } = describeError(error);
        this.logger.warn(`[${SLOT_EVENT}] [fail] errorClass=${errorClass} error="${sanitizeLogValue(message)}" - slot release listener failed`);
      }
    }
  }

  /**
   * Answers whether a build was in flight. A build already collecting is refused rather than
   * aborted: its read-along is being written into a library and linked, and stopping part way would
   * strand a book nothing points at.
   */
  cancel(pair: StorytellerReadAlongPair): boolean {
    const held = this.slots.get(buildPairKey(pair));
    if (!held) return false;
    if (held.committed) throw new ConflictException(CANCEL_TOO_LATE_MESSAGE);
    held.controller.abort();
    return true;
  }

  /**
   * Resolves once the cancelled builds standing in this pair's way let go of their slots: the pair's
   * own, or, with every slot taken, the cancelled ones holding them. At once when none is in the way.
   */
  whenReleased(pair: StorytellerReadAlongPair): Promise<void> {
    const own = this.slots.get(buildPairKey(pair));
    if (own) return own.controller.signal.aborted ? own.released : Promise.resolve();
    if (this.slots.size < MAX_CONCURRENT_BUILDS) return Promise.resolve();
    const cancelled = [...this.slots.values()].filter((held) => held.controller.signal.aborted);
    if (cancelled.length === 0) return Promise.resolve();
    return Promise.all(cancelled.map((held) => held.released)).then(() => undefined);
  }

  /**
   * `reserved` is the slot its caller took before claiming the row - a claim is only safe behind the
   * slot - and the build owns it from here, releasing it once, below.
   */
  async runBuild(
    buildId: number,
    pair: StorytellerReadAlongPair,
    user: RequestUser,
    options: StorytellerRunBuildOptions,
    reserved: StorytellerBuildSlot,
  ): Promise<void> {
    try {
      await this.executeBuild(buildId, pair, user, options, reserved.signal);
    } finally {
      reserved.release();
    }
  }

  private async executeBuild(
    buildId: number,
    pair: StorytellerReadAlongPair,
    user: RequestUser,
    options: StorytellerRunBuildOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    let phase: ReadAlongPhase = 'prepare';
    this.logger.log(
      `[${BUILD_EVENT}] [start] textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} buildId=${buildId} force=${options.force === true} - read-along build started`,
    );
    const attempt = options.attempt ?? { buildId, textBookId: pair.textBookId, stamp: startedAt };
    void this.notifier.started(user.id, attempt);

    try {
      throwIfCancelled(signal);
      const prepared = await this.prepare(buildId, pair, user, options, signal);
      throwIfCancelled(signal);

      phase = 'register';
      let registered = await this.register(buildId, prepared);
      throwIfCancelled(signal);

      phase = 'process';
      registered = await this.process(buildId, registered);
      throwIfCancelled(signal);

      phase = 'wait';
      await this.repo.updateBuild(buildId, { phase });
      void this.notifier.progress(user.id, attempt, readAlongNotifyStage(phase, null), null);
      const remoteBook = await this.waitForReadaloud(buildId, registered.session, registered.storytellerBookUuid, signal, (task, progress) => {
        void this.notifier.progress(user.id, attempt, readAlongNotifyStage('wait', task), progress);
      });

      phase = 'collect';
      this.commit(pair, signal);
      void this.notifier.progress(user.id, attempt, readAlongNotifyStage(phase, null), null);
      const oldOutputBookId = options.oldOutputBookId ?? null;
      // Read fresh, before attachToLink overwrites the column: `pair.link` is a request-time snapshot.
      const linkedReadAlongBookId = oldOutputBookId === null ? null : await this.findLinkedReadAlongBook(pair);
      const replaceRefusal =
        oldOutputBookId === null ? null : await this.previousOutputRefusal(buildId, pair, oldOutputBookId, linkedReadAlongBookId);
      const replaceBookId = oldOutputBookId !== null && replaceRefusal === null ? oldOutputBookId : null;
      const cleanUpRemote = options.cleanUpRemote ?? registered.settings.deleteRemoteAfterImport;
      const collected = await this.collect(buildId, pair, registered, remoteBook, user, replaceBookId, cleanUpRemote);

      phase = 'link';
      if (collected.replaced) await this.reapplyMetadataBestEffort(buildId, pair, collected.outputBookId, user);
      // The read-along is imported by now, so a link that cannot take it leaves a ready build that the
      // edition link attaches the next time the pair is read.
      const attached = await this.attachToLink(buildId, pair, collected.outputBookId, linkedReadAlongBookId);

      await this.writeReady(buildId, attached ? pair.linkId : null, {
        status: 'ready',
        phase,
        transport: collected.transport,
        outputBookId: collected.outputBookId,
        builtAt: new Date(),
        error: null,
      });
      void this.notifier.ready(user.id, attempt, collected.outputBookId, registered.targetLibraryId);
      // A rebuild that could not replace its previous output in place filed a new book; the old one
      // is dropped only once the new one is on disk and linked.
      if (oldOutputBookId !== null && !collected.replaced && attached && options.removePreviousOutput === true) {
        await this.removePreviousOutputBestEffort(
          buildId,
          pair,
          oldOutputBookId,
          collected.outputBookId,
          replaceRefusal,
          linkedReadAlongBookId,
          user,
        );
      }
      if (cleanUpRemote) {
        await this.cleanUpRemoteBestEffort(buildId, registered, remoteBook);
      }
      this.logger.log(
        `[${BUILD_EVENT}] [end] textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} buildId=${buildId} storytellerBookUuid=${registered.storytellerBookUuid} durationMs=${Date.now() - startedAt} transport=${collected.transport} outputBookId=${collected.outputBookId} replaced=${collected.replaced} linked=${attached} - read-along build completed`,
      );
    } catch (error) {
      if (error instanceof ReadAlongRemoteCancelledError) {
        await this.retireRemoteCancelledBuild(buildId, pair, user, attempt, phase, startedAt);
        return;
      }
      // Whatever was raised once the signal fired is the cancellation surfacing: the cancel path
      // owns the row from here, so nothing is written back to it.
      if (signal.aborted) {
        this.logger.log(
          `[${BUILD_EVENT}] [end] textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} buildId=${buildId} durationMs=${Date.now() - startedAt} step=${phase} outcome=cancelled - read-along build cancelled`,
        );
        return;
      }
      const { errorClass, message } = describeError(error);
      // Stored raw, only clipped: log escaping belongs at the log call site, not in the column.
      const persistedError = message.slice(0, MAX_ERROR_CHARS);
      // `storytellerBookUuid` is deliberately not written here: a uuid remembered by this method is
      // stale the moment the 409 fallback uploads a replacement.
      await this.persistTerminalFailure(buildId, phase, persistedError);
      void this.notifier.failed(user.id, attempt, persistedError);
      this.logger.error(
        `[${BUILD_EVENT}] [fail] textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} buildId=${buildId} durationMs=${Date.now() - startedAt} step=${phase} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along build failed`,
      );
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException(message);
    }
  }

  /**
   * Written as the local cancel writes it, so the row keeps its Storyteller book and the next Generate
   * resumes it, and Storyteller restarts processing on that same book.
   */
  private async retireRemoteCancelledBuild(
    buildId: number,
    pair: StorytellerReadAlongPair,
    user: RequestUser,
    attempt: ReadAlongAttempt,
    phase: ReadAlongPhase,
    startedAt: number,
  ): Promise<void> {
    let row: Awaited<ReturnType<StorytellerRepository['retireCancelledBuild']>>;
    try {
      row = await this.repo.retireCancelledBuild(buildId);
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${FAIL_WRITE_EVENT}] [fail] buildId=${buildId} step=${phase} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - the remotely cancelled build row could not be retired and stays building until the next restart`,
      );
      return;
    }
    void this.notifier.cancelled(user.id, attempt);
    this.logger.log(
      `[${BUILD_EVENT}] [end] textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} buildId=${buildId} durationMs=${Date.now() - startedAt} step=${phase} outcome=cancelled_remote row=${row} - read-along build cancelled in Storyteller`,
    );
  }

  /**
   * The ready write carries the link the read-along was attached to, so a later detach on that link
   * is not undone by a re-attach. The link can be deleted between the attach and this write; the
   * stamp's foreign key then refuses the row, which is written again without it rather than failing
   * a build whose read-along is already filed.
   */
  private async writeReady(
    buildId: number,
    attachedLinkId: number | null,
    values: Parameters<StorytellerRepository['updateBuild']>[1],
  ): Promise<void> {
    if (attachedLinkId === null) {
      await this.repo.updateBuild(buildId, values);
      return;
    }
    const startedAt = Date.now();
    try {
      await this.repo.updateBuild(buildId, { ...values, attachedLinkId });
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${STAMP_EVENT}] [fail] buildId=${buildId} linkId=${attachedLinkId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - attached link could not be recorded`,
      );
      await this.repo.updateBuild(buildId, values);
    }
  }

  /**
   * A rebuild replaced only the file under the existing book, so the book still carries whatever it
   * was filed with; read-alongs filed before the Book Dock kept Storyteller's audio-tag title. This
   * writes the linked editions' metadata again, as the first filing does, through the same save a
   * manual edit takes (file write and rename follow the library's own settings). Never fatal.
   */
  private async reapplyMetadataBestEffort(buildId: number, pair: StorytellerReadAlongPair, bookId: number, user: RequestUser): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[${METADATA_EVENT}] [start] buildId=${buildId} outputBookId=${bookId} - read-along metadata refresh started`);
    try {
      const [metadata, locked] = await Promise.all([
        this.repo.findReadAlongMetadata(pair.textBookId, pair.audioBookId),
        this.repo.findLockedMetadataFields(bookId),
      ]);
      const update = readAlongMetadataUpdate(metadata ?? {}, new Set(locked));
      const fields = Object.keys(update).length;
      if (fields > 0) await this.bookService.updateMetadata(bookId, update, user);
      this.logger.log(
        `[${METADATA_EVENT}] [end] buildId=${buildId} outputBookId=${bookId} durationMs=${Date.now() - startedAt} fields=${fields} lockedFields=${locked.length} - read-along metadata refresh completed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${METADATA_EVENT}] [fail] buildId=${buildId} outputBookId=${bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along metadata refresh failed`,
      );
    }
  }

  private commit(pair: StorytellerReadAlongPair, signal: AbortSignal): void {
    throwIfCancelled(signal);
    const held = this.slots.get(buildPairKey(pair));
    if (held?.controller.signal === signal) held.committed = true;
  }

  /**
   * A dropped terminal write leaves every future request for this pair answering `busy` until a
   * restart runs `requeueInterruptedBuilds`, so the retry drops `phase` and keeps only the two columns
   * that unwedge the row. A write that fails twice is logged: it is the operator's only warning.
   */
  private async persistTerminalFailure(buildId: number, phase: ReadAlongPhase, error: string): Promise<void> {
    try {
      await this.repo.updateBuild(buildId, { status: 'failed', phase, error });
      return;
    } catch {
      await this.sleep(TERMINAL_WRITE_RETRY_MS);
    }
    try {
      await this.repo.updateBuild(buildId, { status: 'failed', error });
    } catch (retryError) {
      const { errorClass, message } = describeError(retryError);
      this.logger.error(
        `[${FAIL_WRITE_EVENT}] [fail] buildId=${buildId} step=${phase} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - the build row could not be failed and stays building until the next restart`,
      );
    }
  }

  private async prepare(
    buildId: number,
    pair: StorytellerReadAlongPair,
    user: RequestUser,
    options: StorytellerRunBuildOptions,
    signal: AbortSignal,
  ): Promise<PreparedBuild> {
    await this.repo.updateBuild(buildId, { phase: 'prepare' });
    const connection = await this.settingsService.getConnection();
    throwIfCancelled(signal);
    if (!connection) throw new BadRequestException('Storyteller is not configured');

    const settings = await this.settingsService.getSettings();
    throwIfCancelled(signal);
    const targetLibraryId = options.targetLibraryId ?? settings.targetLibraryId;
    if (targetLibraryId == null) throw new BadRequestException('A target read-along library is required');

    await this.libraryService.verifyUserAccess(user.id, targetLibraryId, user.isSuperuser);
    const library = await this.libraryService.findOne(targetLibraryId);
    if (library.type === 'podcasts') throw new BadRequestException('The target library cannot be a podcast library');
    if (library.allowedFormats.length > 0 && !library.allowedFormats.includes('epub')) {
      throw new BadRequestException('The target library does not allow epub files');
    }
    const folders = await this.repo.findLibraryFolders(targetLibraryId);
    const configuredFolderId = options.targetLibraryId === undefined ? settings.targetFolderId : null;
    const requestedFolderId = options.targetFolderId ?? configuredFolderId;
    const folder = resolveStorytellerTargetFolder(folders, requestedFolderId);
    if (!folder) throw new BadRequestException('The target library has no usable folder');
    throwIfCancelled(signal);

    const [sourceEpub, audioFiles] = await Promise.all([this.repo.findSourceEpubFile(pair.textBookId), this.repo.findAudioFiles(pair.audioBookId)]);
    if (!sourceEpub) throw new BadRequestException('The text edition has no EPUB file');
    // Guarded again here because a build can be resumed long after the request that checked it, and
    // because the message names the file: the provider's own answer for this is a bare 500.
    const epubProblem = await findSourceEpubProblem(sourceEpub.absolutePath);
    if (epubProblem) {
      throw new BadRequestException(
        `${basename(sourceEpub.absolutePath)} cannot be read as an EPUB (${epubProblem === 'missing_container' ? 'no META-INF/container.xml' : 'not a readable archive'}), so Storyteller cannot align it`,
      );
    }
    const malformed = await this.findMalformedContent(sourceEpub.absolutePath);
    if (malformed) {
      throw new BadRequestException(
        `${basename(sourceEpub.absolutePath)} has malformed content (${malformed.href}: ${malformed.message}), so it cannot be aligned; repair the file`,
      );
    }
    if (audioFiles.length === 0) throw new BadRequestException('The audio edition has no audio files');

    const session = this.client.createSession(connection);
    const [[, remoteSettings], storedFolderPaths] = await Promise.all([
      Promise.all([session.getServerInfo(), session.getSettings()]),
      this.repo.findAllLibraryFolderPaths(),
    ]);
    const [libraryFolderPaths, stagingFolder] = await Promise.all([
      Promise.all(storedFolderPaths.map(canonicalPath)),
      this.resolveStagingFolder(settings, remoteSettings),
    ]);
    throwIfCancelled(signal);
    const selected = this.selectTransport(settings, remoteSettings, stagingFolder, libraryFolderPaths);
    if (settings.transport === 'shared-paths' && selected.transport !== 'shared-paths') {
      throw new BadRequestException(pinnedSharedPathsMessage(selected.reason));
    }

    throwIfCancelled(signal);
    // `transport` is deliberately not persisted here: on a resumed build this would overwrite the
    // transport that actually created the Storyteller book. Register owns that column.
    await this.repo.updateBuild(buildId, {
      phase: 'prepare',
      targetLibraryId,
      targetFolderId: folder.id,
    });
    return {
      pair,
      session,
      settings,
      remoteSettings,
      sourceEpub,
      audioFiles,
      targetLibraryId,
      targetFolderId: folder.id,
      libraryFolderPaths,
      stagingFolder,
      transport: selected.transport,
      transportReason: selected.reason,
      signal,
    };
  }

  /**
   * Shared paths hand Storyteller the sources by reference, and it then writes the read-along into
   * its custom folder whatever this build intends. That folder is a staging area BookOrbit files
   * from, so it has to be one this instance can read and no library scans: a scan would index the
   * file with the audiobook tags Storyteller stamps over the ebook's title and authors.
   */
  private selectTransport(
    settings: StorytellerSettings,
    remoteSettings: StorytellerRemoteSettings,
    stagingFolder: string | null,
    libraryFolderPaths: readonly string[],
  ): { transport: StorytellerEffectiveTransport; reason: string | null } {
    if (settings.transport === 'api-transfer') return { transport: 'api-transfer', reason: null };
    if (settings.pathMappings.length === 0) return { transport: 'api-transfer', reason: 'no_path_mappings' };
    if (remoteSettings.readaloudLocationType !== 'CUSTOM_FOLDER' || !remoteSettings.readaloudLocation) {
      return { transport: 'api-transfer', reason: 'readaloud_not_custom_folder' };
    }
    if (stagingFolder === null) return { transport: 'api-transfer', reason: 'readaloud_folder_not_mapped' };
    if (isInsideAnyFolder(stagingFolder, libraryFolderPaths)) {
      return { transport: 'api-transfer', reason: 'readaloud_folder_inside_library' };
    }
    return { transport: 'shared-paths', reason: null };
  }

  private async resolveStagingFolder(settings: StorytellerSettings, remoteSettings: StorytellerRemoteSettings): Promise<string | null> {
    if (remoteSettings.readaloudLocationType !== 'CUSTOM_FOLDER' || !remoteSettings.readaloudLocation) return null;
    const localPath = toLocalPath(remoteSettings.readaloudLocation, settings.pathMappings);
    return localPath === null ? null : canonicalPath(localPath);
  }

  private async findMalformedContent(epubPath: string): Promise<{ href: string; message: string } | null> {
    try {
      return await this.epubService.findMalformedSpineItem(epubPath);
    } catch (error) {
      // The container check above passed, so this is a package (OPF) the reader cannot parse either.
      const { message } = describeError(error);
      throw new BadRequestException(`${basename(epubPath)} cannot be read as an EPUB (${message}), so Storyteller cannot align it`);
    }
  }

  private async register(buildId: number, prepared: PreparedBuild): Promise<RegisteredBuild> {
    const startedAt = Date.now();
    this.logger.log(
      `[${REGISTER_EVENT}] [start] buildId=${buildId} transport=${prepared.transport} transportReason=${prepared.transportReason ?? 'configured'} - Storyteller registration started`,
    );
    try {
      const { registered, mode } = await this.registerWithStoryteller(buildId, prepared);
      this.logger.log(
        `[${REGISTER_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} mode=${mode} outcome=${mode === 'reused_existing' ? 'reused_existing' : 'registered'} transport=${registered.transport} storytellerBookUuid=${registered.storytellerBookUuid} remoteOwnsAllSources=${registered.remoteOwnsAllSources} - Storyteller registration completed`,
      );
      return registered;
    } catch (error) {
      if (prepared.signal.aborted) {
        this.logger.log(
          `[${REGISTER_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} outcome=cancelled - Storyteller registration cancelled`,
        );
        throw error;
      }
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${REGISTER_EVENT}] [fail] buildId=${buildId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - Storyteller registration failed`,
      );
      throw error;
    }
  }

  private async registerWithStoryteller(buildId: number, prepared: PreparedBuild): Promise<{ registered: RegisteredBuild; mode: string }> {
    await this.repo.updateBuild(buildId, { phase: 'register' });
    const current = await this.repo.findBuildByPair(prepared.pair.textBookId, prepared.pair.audioBookId);
    let storytellerBookUuid = current?.storytellerBookUuid ?? null;
    if (storytellerBookUuid && !(await prepared.session.getBook(storytellerBookUuid))) {
      storytellerBookUuid = null;
      await this.repo.updateBuild(buildId, { storytellerBookUuid: null });
    }
    if (storytellerBookUuid) {
      // Reuse the transport that registered this book: an uploaded book keeps its read-aloud inside
      // Storyteller. Ownership is not on the row, so a resumed build only has its cache cleared.
      const registeredTransport = (current?.transport as StorytellerEffectiveTransport | null) ?? null;
      const registered: RegisteredBuild = {
        ...prepared,
        transport: registeredTransport ?? prepared.transport,
        remoteOwnsAllSources: false,
        // The transport column records how the read-along was fetched, not how the sources got
        // there: the collect phase rewrites it, so a reference-imported row can read api-transfer.
        // A caller-chosen uuid leaves the column null, and an instance that cannot share paths at
        // all had nothing to reference, so both of those can only be replaced by abandoning a book
        // this build must keep.
        referenceImported: registeredTransport !== null && (registeredTransport === 'shared-paths' || prepared.transport === 'shared-paths'),
        storytellerBookUuid,
      };
      return { registered, mode: 'reused' };
    }

    const collectionUuid = prepared.settings.collectionName ? await prepared.session.ensureCollection(prepared.settings.collectionName) : null;
    if (prepared.transport === 'api-transfer') {
      return { registered: await this.registerByUpload(buildId, prepared, collectionUuid), mode: 'upload' };
    }

    const epubPath = toRemotePath(prepared.sourceEpub.absolutePath, prepared.settings.pathMappings);
    const audioPaths = prepared.audioFiles.map((file) => toRemotePath(file.absolutePath, prepared.settings.pathMappings));
    if (epubPath === null || audioPaths.some((path) => path === null)) {
      throw new BadRequestException('A source file path is not mapped for Storyteller');
    }

    const mappedAudioPaths = audioPaths as string[];
    // Checked before any import: Storyteller refuses paths it already holds, but an EPUB2 pair's held
    // ebook is Storyteller's own copy, so the ebook import would succeed and make a second book first.
    const existing = await this.findExistingReference(buildId, prepared, { epubPath, audioPaths: mappedAudioPaths });
    if (existing) return { registered: existing, mode: 'reused_existing' };

    // One side at a time, then merged: a single request gives both candidates the same uuid hint and
    // drops the loser's half. Storyteller pairs automatically only within one upload or folder.
    let ebook: { uuid: string; copied: boolean } | null;
    try {
      ebook = await this.importEbook(prepared, epubPath, collectionUuid);
    } catch (error) {
      if (!(error instanceof StorytellerClientError) || error.status !== 405) throw error;
      return { registered: await this.adoptExistingReference(buildId, prepared, { epubPath }, error), mode: 'reused_existing' };
    }
    if (ebook === null) {
      return { registered: await this.registerByUpload(buildId, prepared, collectionUuid, 'epub2_not_importable'), mode: 'upload' };
    }

    let audio: Awaited<ReturnType<StorytellerSession['importByReference']>>;
    try {
      audio = await prepared.session.importByReference({
        paths: mappedAudioPaths,
        importMode: 'reference',
        ...(collectionUuid ? { collectionUuid } : {}),
      });
    } catch (error) {
      if (!(error instanceof StorytellerClientError) || error.status !== 405) throw error;
      const registered = await this.adoptExistingReference(buildId, prepared, { audioPaths: mappedAudioPaths, excludeUuid: ebook.uuid }, error);
      if (ebook.copied) await this.deleteCopiedEbookBestEffort(buildId, prepared.session, ebook.uuid);
      return { registered, mode: 'reused_existing' };
    }
    if (audio.kind === 'epub2_detected') {
      return { registered: await this.registerByUpload(buildId, prepared, collectionUuid, 'audio_import_failed'), mode: 'upload' };
    }

    const merged = await prepared.session.mergeBooks([ebook.uuid, audio.uuid]);
    // A copied ebook keeps its read-along internal; the audio is still the user's file, so
    // Storyteller does not own this book outright.
    const transport: StorytellerEffectiveTransport = ebook.copied ? 'api-transfer' : 'shared-paths';
    await this.repo.updateBuild(buildId, { transport, storytellerBookUuid: merged.uuid });
    const registered: RegisteredBuild = {
      ...prepared,
      transport,
      remoteOwnsAllSources: false,
      // A copied ebook still leaves the audio referenced, and a missing audio reference is exactly
      // what the 409 reports.
      referenceImported: true,
      storytellerBookUuid: merged.uuid,
    };
    return { registered, mode: ebook.copied ? 'copy' : 'reference' };
  }

  /**
   * The one Storyteller book already holding this pair's files: its ebook at the mapped EPUB path, or
   * its audio at any of the mapped audio paths or at the folder holding them. Null when none does; more than one is
   * refused rather than guessed. The whole catalogue is read because Storyteller offers no lookup by path.
   */
  private async findExistingReference(
    buildId: number,
    prepared: PreparedBuild,
    paths: { epubPath: string; audioPaths: string[] },
  ): Promise<RegisteredBuild | null> {
    const startedAt = Date.now();
    this.logger.log(
      `[${MATCH_EXISTING_EVENT}] [start] buildId=${buildId} path="${sanitizeLogValue(paths.epubPath)}" audioFiles=${paths.audioPaths.length} check=before_import - existing Storyteller book lookup started`,
    );
    try {
      const matches = this.matchHeldBooks(await prepared.session.listBooks(), paths);
      if (matches.length > 1) throw new ConflictException(UNMATCHED_EXISTING_MESSAGE);
      if (matches.length === 0) {
        this.logger.log(
          `[${MATCH_EXISTING_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} matches=0 check=before_import - no Storyteller book holds these files`,
        );
        return null;
      }
      return await this.adoptBook(buildId, prepared, matches[0]!, startedAt);
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${MATCH_EXISTING_EVENT}] [fail] buildId=${buildId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" check=before_import - existing Storyteller book could not be matched`,
      );
      throw error;
    }
  }

  private matchHeldBooks(
    books: StorytellerBookSummary[],
    paths: { epubPath?: string; audioPaths?: string[]; excludeUuid?: string },
  ): HeldBookMatch[] {
    const audio = new Set(paths.audioPaths ?? []);
    // A reference import records the audio folder rather than a file, and the list omits the per-file manifest.
    const audioDirectory = sharedAudioDirectory(paths.audioPaths ?? []);
    const matches: HeldBookMatch[] = [];
    for (const book of books) {
      if (book.uuid === paths.excludeUuid) continue;
      if (paths.epubPath !== undefined && book.ebookPath === paths.epubPath) {
        matches.push({ book, matchedBy: 'ebook', path: paths.epubPath });
        continue;
      }
      const heldAudio = book.audiobookPaths.find((path) => audio.has(path));
      if (heldAudio !== undefined) {
        matches.push({ book, matchedBy: 'audio', path: heldAudio });
        continue;
      }
      if (audioDirectory !== null && book.audiobookPaths.includes(audioDirectory)) {
        matches.push({ book, matchedBy: 'audio_directory', path: audioDirectory });
      }
    }
    return matches;
  }

  /** Held exactly like a remembered book: never owned outright, and reference-imported. */
  private async adoptBook(buildId: number, prepared: PreparedBuild, match: HeldBookMatch, startedAt: number): Promise<RegisteredBuild> {
    const storytellerBookUuid = match.book.uuid;
    await this.repo.updateBuild(buildId, { transport: 'shared-paths', storytellerBookUuid });
    this.logger.log(
      `[${MATCH_EXISTING_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} matches=1 matchedBy=${match.matchedBy} path="${sanitizeLogValue(match.path)}" storytellerBookUuid=${storytellerBookUuid} outcome=reused_existing - existing Storyteller book matched`,
    );
    return { ...prepared, transport: 'shared-paths', remoteOwnsAllSources: false, referenceImported: true, storytellerBookUuid };
  }

  /**
   * Storyteller answers 405 to an import of paths it already holds, which is what a cancelled or
   * forgotten build leaves behind, but also to any file it cannot make a book from. The book holding
   * exactly the paths just offered is this pair's, so it is taken over as if this import had created
   * it; anything less certain is refused rather than guessed. The whole catalogue is read because
   * Storyteller offers no lookup by path, and this runs only on that refusal.
   */
  private async adoptExistingReference(
    buildId: number,
    prepared: PreparedBuild,
    paths: { epubPath?: string; audioPaths?: string[]; excludeUuid?: string },
    refusal: StorytellerClientError,
  ): Promise<RegisteredBuild> {
    const startedAt = Date.now();
    const offered = paths.epubPath ?? paths.audioPaths?.[0] ?? '';
    this.logger.log(
      `[${MATCH_EXISTING_EVENT}] [start] buildId=${buildId} path="${sanitizeLogValue(offered)}" refusal="${sanitizeLogValue(refusal.message)}" - existing Storyteller book lookup started`,
    );
    try {
      const matches = this.matchHeldBooks(await prepared.session.listBooks(), paths);
      if (matches.length > 1) throw new ConflictException(UNMATCHED_EXISTING_MESSAGE);
      if (matches.length === 0) {
        throw new BadGatewayException(
          `Storyteller could not create a book from these files (${storytellerRefusalText(refusal)}). If the book already exists there, remove or import it in Storyteller; otherwise the EPUB may be unreadable by Storyteller, check its log`,
        );
      }
      return await this.adoptBook(buildId, prepared, matches[0]!, startedAt);
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${MATCH_EXISTING_EVENT}] [fail] buildId=${buildId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - existing Storyteller book could not be matched`,
      );
      throw error;
    }
  }

  private async deleteCopiedEbookBestEffort(buildId: number, session: StorytellerSession, uuid: string): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[${CLEANUP_EVENT}] [start] buildId=${buildId} storytellerBookUuid=${uuid} target=copied_ebook - Storyteller cleanup started`);
    try {
      // Copy-imported and never merged: its only file is Storyteller's internal copy, so no library file is touched.
      await session.deleteBook(uuid, { preventReImport: true });
      this.logger.log(
        `[${CLEANUP_EVENT}] [end] buildId=${buildId} storytellerBookUuid=${uuid} target=copied_ebook durationMs=${Date.now() - startedAt} - Storyteller cleanup completed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${CLEANUP_EVENT}] [fail] buildId=${buildId} storytellerBookUuid=${uuid} target=copied_ebook durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - copied ebook could not be removed from Storyteller`,
      );
    }
  }

  /**
   * An EPUB2 has to be upgraded before it can carry media overlays, and every strategy Storyteller
   * offers for a referenced book writes into the source library - so the retry uses `copy`, which
   * upgrades Storyteller's own copy off the shared mount. The audio stays referenced.
   */
  private async importEbook(
    prepared: PreparedBuild,
    epubPath: string,
    collectionUuid: string | null,
  ): Promise<{ uuid: string; copied: boolean } | null> {
    const referenced = await prepared.session.importByReference({
      paths: [epubPath],
      importMode: 'reference',
      ...(collectionUuid ? { collectionUuid } : {}),
    });
    if (referenced.kind === 'created') return { uuid: referenced.uuid, copied: false };

    const copied = await prepared.session.importByReference({
      paths: [epubPath],
      importMode: 'copy',
      ...(collectionUuid ? { collectionUuid } : {}),
    });
    return copied.kind === 'created' ? { uuid: copied.uuid, copied: true } : null;
  }

  /**
   * The transport is persisted with the uuid the upload produced, never before it: the 409 fallback
   * in `process` only fires for a row that still says `shared-paths`, so writing `api-transfer` up
   * front and then failing would stop a retry ever taking the fallback again.
   */
  private async registerByUpload(
    buildId: number,
    prepared: PreparedBuild,
    collectionUuid: string | null,
    fallbackReason?: string,
  ): Promise<RegisteredBuild> {
    const startedAt = Date.now();
    this.logger.log(
      `[${UPLOAD_EVENT}] [start] buildId=${buildId} reason=${fallbackReason ?? 'configured'} audioFiles=${prepared.audioFiles.length} - upload to Storyteller started`,
    );
    try {
      const uploaded = await prepared.session.uploadBook({
        epubPath: prepared.sourceEpub.absolutePath,
        audioPaths: prepared.audioFiles.map((file) => file.absolutePath),
        ...(collectionUuid ? { collectionUuid } : {}),
        signal: prepared.signal,
      });
      await this.repo.updateBuild(buildId, { transport: 'api-transfer', storytellerBookUuid: uploaded.uuid });
      this.logger.log(
        `[${UPLOAD_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} storytellerBookUuid=${uploaded.uuid} - upload to Storyteller completed`,
      );
      return { ...prepared, transport: 'api-transfer', remoteOwnsAllSources: true, referenceImported: false, storytellerBookUuid: uploaded.uuid };
    } catch (error) {
      if (prepared.signal.aborted) {
        this.logger.log(
          `[${UPLOAD_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} outcome=cancelled - upload to Storyteller cancelled`,
        );
        throw error;
      }
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${UPLOAD_EVENT}] [fail] buildId=${buildId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - upload to Storyteller failed`,
      );
      throw error;
    }
  }

  private async process(buildId: number, registered: RegisteredBuild): Promise<RegisteredBuild> {
    await this.repo.updateBuild(buildId, { phase: 'process' });
    try {
      await this.processWhenMediaAttached(buildId, registered);
      return registered;
    } catch (error) {
      // 409 means Storyteller holds only part of the pair, which it can do when the two halves were
      // referenced from different folders. The partial book is left alone, not deleted: deleting a
      // referenced book asks Storyteller to delete source files BookOrbit does not own.
      if (!registered.referenceImported || !(error instanceof StorytellerClientError) || error.status !== 409) throw error;
      const collectionUuid = registered.settings.collectionName
        ? await registered.session.ensureCollection(registered.settings.collectionName)
        : null;
      const uploaded = await this.registerByUpload(buildId, registered, collectionUuid, 'incomplete_reference_import');
      await this.repo.updateBuild(buildId, { phase: 'process' });
      // A TUS transfer that has just finalised has not attached its tracks yet, and a many-track
      // audiobook is exactly what produced the 409.
      await this.processWhenMediaAttached(buildId, uploaded);
      return uploaded;
    }
  }

  private async processWhenMediaAttached(buildId: number, registered: RegisteredBuild): Promise<void> {
    const book = await this.awaitBothMedia(registered);
    throwIfCancelled(registered.signal);
    if (!book) throw new BadGatewayException('The Storyteller book disappeared before processing');
    if (book.processing.state === 'running') return;
    const startedAt = Date.now();
    if (book.aligned) {
      // A reference import keeps its aligned book after a collect took the staged file away, and an
      // aligned book is never processed on its own: without this the wait polls to its ceiling.
      if (await registered.session.readaloudAvailable(registered.storytellerBookUuid)) return;
      this.logger.warn(
        `[${REPROCESS_EVENT}] [start] buildId=${buildId} storytellerBookUuid=${registered.storytellerBookUuid} reason=readaloud_missing - aligned Storyteller book has no read-along file, processing it again`,
      );
    }
    await registered.session.process(registered.storytellerBookUuid);
    if (book.aligned) {
      this.logger.log(
        `[${REPROCESS_EVENT}] [end] buildId=${buildId} storytellerBookUuid=${registered.storytellerBookUuid} durationMs=${Date.now() - startedAt} - Storyteller processing requested again`,
      );
    }
    // A cancel that reached Storyteller before this POST found nothing to stop, so the job this POST
    // started would otherwise run to completion.
    if (registered.signal.aborted) {
      await registered.session.cancelProcessing(registered.storytellerBookUuid).catch(() => undefined);
      throwIfCancelled(registered.signal);
    }
  }

  /**
   * Storyteller links media as it ingests each candidate, so a returned import does not mean both
   * halves are attached. Processing before then is rejected as "both ebook and audiobook must be
   * present" - indistinguishable from the pair genuinely failing to reconcile - so waiting first is
   * what lets a slow ingest proceed while a broken one still falls back to uploading.
   *
   * A book Storyteller no longer has ends the wait; anything else is transport trouble and gets a
   * retry budget, because one 503 must not discard an upload that just pushed gigabytes.
   */
  private async awaitBothMedia(registered: RegisteredBuild): Promise<StorytellerBookSummary | null> {
    const deadline = Date.now() + MEDIA_LINK_CEILING_MS;
    let book: StorytellerBookSummary | null = null;
    let consecutiveErrors = 0;

    for (;;) {
      try {
        book = await registered.session.getBook(registered.storytellerBookUuid);
        consecutiveErrors = 0;
        if (!book || book.aligned || (book.hasEbook && book.hasAudiobook)) return book;
      } catch (error) {
        throwIfCancelled(registered.signal);
        consecutiveErrors += 1;
        if (consecutiveErrors >= WAIT_ERROR_CAP) {
          throw new ServiceUnavailableException('Storyteller book reads failed 20 times in a row while its media links were attaching', {
            cause: error,
          });
        }
      }
      throwIfCancelled(registered.signal);
      if (Date.now() >= deadline) {
        // A null `book` here means every read threw: the ceiling went on an unreachable
        // Storyteller, not on a book that never linked.
        if (!book) {
          throw new ServiceUnavailableException('Storyteller could not be read while the media links were attaching');
        }
        return book;
      }
      await this.sleep(MEDIA_LINK_POLL_MS, registered.signal);
      throwIfCancelled(registered.signal);
    }
  }

  private async waitForReadaloud(
    buildId: number,
    session: StorytellerSession,
    uuid: string,
    signal: AbortSignal,
    onProgress: (task: string | null, progress: number | null) => void,
  ): Promise<StorytellerBookSummary> {
    const startedAt = Date.now();
    let polls = 0;
    let delayMs = WAIT_INITIAL_DELAY_MS;
    let consecutiveErrors = 0;
    let staleAlignedPolls = 0;

    try {
      while (Date.now() - startedAt < this.config.waitCeilingMs) {
        polls += 1;
        try {
          const book = await session.getBook(uuid);
          throwIfCancelled(signal);
          if (!book) throw new BadGatewayException('The Storyteller book disappeared while processing');
          await this.repo.updateBuild(buildId, {
            phase: 'wait',
            remoteTask: book.processing.task,
            remoteProgress: book.processing.progress,
          });
          throwIfCancelled(signal);
          onProgress(book.processing.task, book.processing.progress);
          // Availability first: a reported failure only counts when nothing is there to fetch.
          // Storyteller can drop or halt the job row around a restart and the job record wins in
          // `normalizeProcessing`, so failing on it ends a build whose file is ready and no retry
          // recovers it - an aligned book is never re-processed.
          const available = await session.readaloudAvailable(uuid);
          throwIfCancelled(signal);
          if (available) {
            const finished = (await this.refetchFinishedBook(session, uuid)) ?? book;
            this.logger.log(
              `[${WAIT_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} polls=${polls} readaloudPathReported=${finished.readaloudPath !== null} - read-along became available`,
            );
            return finished;
          }
          if (book.processing.state === 'cancelled') throw new ReadAlongRemoteCancelledError();
          if (book.processing.state === 'failed') {
            throw new BadGatewayException(book.processing.error || 'Storyteller processing failed');
          }
          // Aligned with no file and no job: nothing on the server will change that, so a few polls
          // of grace for the re-process to show up, never the whole ceiling.
          staleAlignedPolls = book.aligned && book.processing.state !== 'running' ? staleAlignedPolls + 1 : 0;
          if (staleAlignedPolls >= STALE_ALIGNED_POLL_CAP) throw new BadGatewayException(STALE_ALIGNED_MESSAGE);
          consecutiveErrors = 0;
        } catch (error) {
          // The two BadGateways thrown in here - a book Storyteller no longer has, and a failure it
          // reported - are answers, not transport trouble: retrying either burns the whole wait
          // window on a result that cannot change. Everything else gets the retry budget.
          if (error instanceof BadGatewayException || error instanceof ReadAlongRemoteCancelledError) throw error;
          throwIfCancelled(signal);
          consecutiveErrors += 1;
          if (consecutiveErrors >= WAIT_ERROR_CAP) {
            throw new ServiceUnavailableException('Storyteller read-along availability checks failed 20 times in a row', { cause: error });
          }
        }

        const remaining = this.config.waitCeilingMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        await this.sleep(Math.min(delayMs, remaining), signal);
        throwIfCancelled(signal);
        delayMs = Math.min(delayMs * 2, WAIT_MAX_DELAY_MS);
      }
      throw new ServiceUnavailableException('Storyteller did not finish within the wait ceiling');
    } catch (error) {
      if (error instanceof ReadAlongCancelledError) {
        this.logger.log(
          `[${WAIT_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} polls=${polls} outcome=cancelled - waiting for read-along cancelled`,
        );
        throw error;
      }
      if (error instanceof ReadAlongRemoteCancelledError) {
        this.logger.log(
          `[${WAIT_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} polls=${polls} outcome=cancelled_remote - read-along job cancelled in Storyteller`,
        );
        throw error;
      }
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${WAIT_EVENT}] [fail] buildId=${buildId} durationMs=${Date.now() - startedAt} polls=${polls} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - waiting for read-along failed`,
      );
      throw error;
    }
  }

  /**
   * The snapshot the loop polled with predates the read-along, so its `readaloudPath` is empty and
   * collection would fall back to the remembered transport instead of the path Storyteller actually
   * wrote to. A failed re-read is not worth losing a finished build over.
   */
  private async refetchFinishedBook(session: StorytellerSession, uuid: string): Promise<StorytellerBookSummary | null> {
    try {
      return await session.getBook(uuid);
    } catch {
      return null;
    }
  }

  private async collect(
    buildId: number,
    pair: StorytellerReadAlongPair,
    registered: RegisteredBuild,
    remoteBook: StorytellerBookSummary,
    user: RequestUser,
    replaceBookId: number | null,
    cleanUpRemote: boolean,
  ): Promise<{ outputBookId: number; transport: StorytellerEffectiveTransport; replaced: boolean }> {
    const startedAt = Date.now();
    this.logger.log(
      `[${COLLECT_EVENT}] [start] buildId=${buildId} transport=${registered.transport} replaceBookId=${replaceBookId ?? 'none'} - read-along collection started`,
    );
    try {
      // Persisted on entry, or a download running for minutes reports as the wait phase with stale progress.
      await this.repo.updateBuild(buildId, { phase: 'collect' });
      const stagedPath = await this.findStagedReadaloud(registered, remoteBook);
      // Where the file is decides how to collect it, not how the book was registered.
      const transport: StorytellerEffectiveTransport = stagedPath === null ? 'api-transfer' : 'shared-paths';
      if (transport !== registered.transport) await this.repo.updateBuild(buildId, { transport });

      const imported = await this.importService.importReadAlong({
        buildId,
        textBookId: pair.textBookId,
        audioBookId: pair.audioBookId,
        userId: user.id,
        session: registered.session,
        storytellerBookUuid: registered.storytellerBookUuid,
        stagedPath,
        consumeStaged: cleanUpRemote,
        targetLibraryId: registered.targetLibraryId,
        targetFolderId: registered.targetFolderId,
        replaceBookId,
      });

      // Written with the phase in one statement: a restart from here finds a filed read-along the
      // boot settle turns ready, where a row still in collect would be resumed and filed a second time.
      await this.repo.updateBuild(buildId, { outputBookId: imported.outputBookId, phase: 'link' });

      this.logger.log(
        `[${COLLECT_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} transport=${transport} outputBookId=${imported.outputBookId} replaced=${imported.replaced} - read-along collection completed`,
      );
      return { outputBookId: imported.outputBookId, transport, replaced: imported.replaced };
    } catch (error) {
      if (registered.signal.aborted) {
        this.logger.log(
          `[${COLLECT_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} outcome=cancelled - read-along collection cancelled`,
        );
        throw error;
      }
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${COLLECT_EVENT}] [fail] buildId=${buildId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along collection failed`,
      );
      throw error;
    }
  }

  /**
   * Storyteller's own output, taken only from inside its configured staging folder and never from a
   * library folder, compared by real path: with cleanup on, the file returned here is unlinked, and a
   * symlink or a second spelling must not make a library file look staged. Anything else is
   * downloaded instead.
   */
  private async findStagedReadaloud(registered: RegisteredBuild, remoteBook: StorytellerBookSummary): Promise<string | null> {
    if (!remoteBook.readaloudPath || registered.stagingFolder === null) return null;
    const localPath = toLocalPath(remoteBook.readaloudPath, registered.settings.pathMappings);
    if (localPath === null) return null;
    const stagedPath = await realpath(localPath).catch(() => null);
    if (stagedPath === null || !isPathWithinFolder(stagedPath, registered.stagingFolder)) return null;
    if (isInsideAnyFolder(stagedPath, registered.libraryFolderPaths)) return null;
    return (await this.fileExists(stagedPath)) ? stagedPath : null;
  }

  private fileExists(path: string): Promise<boolean> {
    return stat(path).then(
      (info) => info.isFile(),
      () => false,
    );
  }

  /**
   * Reclaims Storyteller's disk once BookOrbit holds the read-along. Deleting a Storyteller book
   * deletes the files attached to it, so the whole book only goes when Storyteller owns every source
   * (an upload, and nothing else) and its read-along is not inside a library folder, where the
   * deletion would take a file BookOrbit scans. Anything else drops only the processing cache and
   * leaves the book alone.
   */
  private async cleanUpRemoteBestEffort(buildId: number, registered: RegisteredBuild, remoteBook: StorytellerBookSummary): Promise<void> {
    const startedAt = Date.now();
    const localPath = remoteBook.readaloudPath ? toLocalPath(remoteBook.readaloudPath, registered.settings.pathMappings) : null;
    const readaloudPath = localPath === null ? null : await canonicalPath(localPath);
    const removesBook =
      registered.remoteOwnsAllSources && !(readaloudPath !== null && isInsideAnyFolder(readaloudPath, registered.libraryFolderPaths));
    const target = removesBook ? 'remote_book' : 'remote_cache';
    this.logger.log(
      `[${CLEANUP_EVENT}] [start] buildId=${buildId} storytellerBookUuid=${registered.storytellerBookUuid} target=${target} - Storyteller cleanup started`,
    );
    try {
      if (removesBook) {
        await registered.session.deleteBook(registered.storytellerBookUuid, { preventReImport: true });
      } else {
        await registered.session.deleteCache(registered.storytellerBookUuid);
      }
      this.logger.log(
        `[${CLEANUP_EVENT}] [end] buildId=${buildId} storytellerBookUuid=${registered.storytellerBookUuid} target=${target} durationMs=${Date.now() - startedAt} - Storyteller cleanup completed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${CLEANUP_EVENT}] [fail] buildId=${buildId} storytellerBookUuid=${registered.storytellerBookUuid} target=${target} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - Storyteller cleanup failed`,
      );
    }
  }

  /**
   * `BookService.deleteBooks` removes every file the book owns from disk, so this only runs on a book
   * this build showed it produced before collecting, and for a linked pair only one its link named:
   * a detached read-along the rebuild could not replace stays. The refusal is deliberately one-sided:
   * a stale read-along costs disk, the wrong book costs data.
   */
  private async removePreviousOutputBestEffort(
    buildId: number,
    pair: StorytellerReadAlongPair,
    outputBookId: number,
    newOutputBookId: number,
    replaceRefusal: string | null,
    linkedReadAlongBookId: number | null,
    user: RequestUser,
  ): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(
      `[${CLEANUP_EVENT}] [start] buildId=${buildId} outputBookId=${outputBookId} target=previous_output - previous read-along removal started`,
    );
    try {
      const refusal =
        outputBookId === newOutputBookId
          ? 'the rebuild resolved to the same book'
          : (replaceRefusal ??
            (pair.linkId !== null && linkedReadAlongBookId !== outputBookId ? 'the edition link does not name this read-along book' : null));
      if (refusal !== null) {
        this.logger.warn(
          `[${CLEANUP_EVENT}] [end] buildId=${buildId} outputBookId=${outputBookId} target=previous_output durationMs=${Date.now() - startedAt} removed=false reason="${sanitizeLogValue(refusal)}" - previous read-along removal refused`,
        );
        return;
      }
      await this.bookService.deleteBooks([outputBookId], user);
      this.logger.log(
        `[${CLEANUP_EVENT}] [end] buildId=${buildId} outputBookId=${outputBookId} target=previous_output durationMs=${Date.now() - startedAt} removed=true - previous read-along removed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${CLEANUP_EVENT}] [fail] buildId=${buildId} outputBookId=${outputBookId} target=previous_output durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - previous read-along removal failed`,
      );
    }
  }

  /**
   * Why a rebuild may not touch its previous output, or null when it may. The pair's own build row
   * naming the book is proof enough: a claim keeps the previous output on the row until the new one
   * is recorded, so a read-along detached from the link is still replaced in place when Rebuild is
   * pressed. Without that record, the link has to name the book.
   */
  private async previousOutputRefusal(
    buildId: number,
    pair: StorytellerReadAlongPair,
    outputBookId: number,
    linkedReadAlongBookId: number | null,
  ): Promise<string | null> {
    if (outputBookId === pair.textBookId || outputBookId === pair.audioBookId) {
      return 'the book is the pair own text or audio edition';
    }
    const owningBuild = await this.repo.findBuildByOutputBook(outputBookId);
    if (owningBuild && owningBuild.id !== buildId) return `the book is read-along build ${owningBuild.id} output`;
    if (owningBuild) return null;
    // A self-pair has no link: nothing contradicts the request, and no other build owns the book.
    if (pair.linkId !== null && linkedReadAlongBookId !== outputBookId) {
      return 'the edition link does not name this read-along book';
    }
    return null;
  }

  /** Best effort: a failed read refuses the removal rather than failing a build that already produced its output. */
  private async findLinkedReadAlongBook(pair: StorytellerReadAlongPair): Promise<number | null> {
    if (pair.linkId === null) return null;
    const link = await this.editionLinks.findLinkForBook(pair.textBookId).catch(() => undefined);
    return link?.id === pair.linkId ? link.readAlongBookId : null;
  }

  /**
   * Puts the imported read-along on the pair's link. Never fails the build: the book is already in the
   * library, so a link that cannot take it is logged and left for the edition link's own attach.
   * Answers whether the read-along is where the build leaves it, which a self-pair always is.
   * `replacing` is the read-along the link named before the collect: a rebuild that filed a new book
   * takes the link over from it, and any other read-along the link gained since is left alone.
   */
  private async attachToLink(buildId: number, pair: StorytellerReadAlongPair, outputBookId: number, replacing: number | null): Promise<boolean> {
    const startedAt = Date.now();
    this.logger.log(`[${LINK_EVENT}] [start] buildId=${buildId} linkId=${pair.linkId ?? 'none'} outputBookId=${outputBookId} - link update started`);
    if (pair.linkId === null) {
      this.logger.log(`[${LINK_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} linked=false - self-pair has no edition link`);
      return true;
    }

    try {
      const linked = await this.editionLinks.setReadAlongBook(pair.linkId, outputBookId, replacing);
      if (!linked) throw new ConflictException('The read-along could not be attached to the link; the imported book was kept');
      this.logger.log(
        `[${LINK_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} linked=true outputBookId=${outputBookId} - link update completed`,
      );
      return true;
    } catch (error) {
      const mapped = isUniqueViolation(error)
        ? new ConflictException('The read-along could not be attached to the link; the imported book was kept')
        : error;
      const { errorClass, message } = describeError(mapped);
      this.logger.error(
        `[${LINK_EVENT}] [fail] buildId=${buildId} linkId=${pair.linkId} outputBookId=${outputBookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - link update failed, the read-along stays ready for a later attach`,
      );
      return false;
    }
  }
}
