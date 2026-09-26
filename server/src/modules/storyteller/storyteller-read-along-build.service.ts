import { rm, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
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

import type { ReadAlongPhase, StorytellerEffectiveTransport, StorytellerSettings } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { isUniqueViolation } from '../../common/utils/db-error.utils';
import { findSourceEpubProblem } from './storyteller-epub.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import { ScannerService } from '../scanner/scanner.service';
import type { StorytellerReadAlongPair } from './storyteller-read-along-status.service';
import type { StorytellerBookSummary, StorytellerRemoteSettings, StorytellerSession } from './storyteller-client.types';
import { StorytellerClientError, StorytellerClientService } from './storyteller-client.service';
import { describeError } from './storyteller-log.utils';
import { storytellerConfig } from './storyteller.config';
import { expectedCustomFolderOutputPath, storytellerSafeFilepathSegment, toLocalPath, toRemotePath } from './storyteller-path.utils';
import {
  StorytellerRepository,
  type StorytellerAudioFile,
  type StorytellerBookFileLocation,
  type StorytellerSourceEpubFile,
} from './storyteller.repository';
import { StorytellerSettingsService, resolveStorytellerTargetFolder } from './storyteller-settings.service';

const MAX_CONCURRENT_BUILDS = 1;
const MAX_ERROR_CHARS = 500;
const WAIT_INITIAL_DELAY_MS = 10_000;
const WAIT_MAX_DELAY_MS = 60_000;
const WAIT_ERROR_CAP = 20;
const MEDIA_LINK_POLL_MS = 2_000;
const MEDIA_LINK_CEILING_MS = 120_000;
const COLLECT_POLL_MS = 15_000;
const COLLECT_RESCAN_MS = 5 * 60_000;
const COLLECT_CEILING_MS = 15 * 60_000;
const TERMINAL_WRITE_RETRY_MS = 1_000;

const BUILD_EVENT = 'storyteller.read_along.build';
const WAIT_EVENT = 'storyteller.read_along.wait';
const COLLECT_EVENT = 'storyteller.read_along.collect';
// Sub-operations of a collect get their own event: nested, they would be unmatched [start]/[end] lines.
const ADOPT_EVENT = 'storyteller.read_along.adopt';
const ORPHAN_EVENT = 'storyteller.read_along.clear_orphan';
const CLAIM_EVENT = 'storyteller.read_along.claim';
const LINK_EVENT = 'storyteller.read_along.link';
const REGISTER_EVENT = 'storyteller.read_along.register';
const UPLOAD_EVENT = 'storyteller.read_along.upload';
const CLEANUP_EVENT = 'storyteller.read_along.cleanup';
// Its own event: a second [fail] under the build event would read as a second failed build.
const FAIL_WRITE_EVENT = 'storyteller.read_along.fail_write';
const OVERWRITE_EVENT = 'storyteller.read_along.overwrite';

/**
 * Why a pinned shared-paths build cannot run, in the words of the guard that refused it. The pin
 * means "never push my files over the network", so an unusable configuration ends the build rather
 * than quietly uploading gigabytes the settings page reports as unavailable.
 */
const PINNED_SHARED_PATHS_PROBLEM: Record<string, string> = {
  no_path_mappings: 'no path mappings are configured',
  target_folder_not_mapped: 'the target folder is not covered by a path mapping',
  readaloud_not_custom_folder: 'its read-along location is not set to a custom folder',
  readaloud_folder_outside_target: 'its read-along folder is outside the target folder',
  readaloud_folder_not_its_own_book: 'the read-along would not become its own book in the target library',
};

function pinnedSharedPathsMessage(reason: string | null): string {
  const problem = (reason === null ? null : PINNED_SHARED_PATHS_PROBLEM[reason]) ?? 'the shared-paths configuration is incomplete';
  return `Storyteller is set to use shared paths, but ${problem}`;
}

export const STORYTELLER_SLEEP = Symbol('STORYTELLER_SLEEP');
export type StorytellerSleep = (milliseconds: number) => Promise<void>;

/**
 * A build slot its holder took before claiming the row, and hands to `runBuild` to release at the
 * end of the build. Releasing a second time frees nothing: the slot may since have been taken by
 * another reservation, and freeing that one would put two builds on a one-build instance.
 */
export interface StorytellerBuildSlot {
  release(): void;
}

export interface StorytellerRunBuildOptions {
  force?: boolean;
  targetLibraryId?: number;
  targetFolderId?: number;
  oldOutputBookId?: number | null;
  /** Per-build override for the instance-wide `deleteRemoteAfterImport`. */
  cleanUpRemote?: boolean;
}

interface PreparedBuild {
  pair: StorytellerReadAlongPair;
  session: StorytellerSession;
  settings: StorytellerSettings;
  remoteSettings: StorytellerRemoteSettings;
  sourceEpub: StorytellerSourceEpubFile;
  audioFiles: StorytellerAudioFile[];
  targetLibraryId: number;
  targetFolderPath: string;
  organizationMode: string;
  transport: StorytellerEffectiveTransport;
  transportReason: string | null;
  outputWouldCollide: boolean;
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

/**
 * What sits at a collected path: the book this build claimed, or the book that refused it and why.
 * Both are null when nothing was ever indexed there, which is the plain timeout and not an overwrite.
 */
interface CollectedFile {
  outputBookId: number | null;
  refusal: { bookId: number; reason: string } | null;
}

const NOTHING_COLLECTED: CollectedFile = { outputBookId: null, refusal: null };

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withoutTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, '');
}

function pathIsWithinFolder(candidate: string, folderPath: string): boolean {
  const folder = withoutTrailingSlashes(folderPath);
  return candidate === folder || candidate.startsWith(`${folder}/`);
}

/** Enough of the Storyteller book id to tell two outputs of one pair apart without burying the title. */
const REMOTE_KEY_CHARS = 8;

function remoteOutputKey(storytellerBookUuid: string): string {
  return storytellerSafeFilepathSegment(storytellerBookUuid).slice(0, REMOTE_KEY_CHARS) || 'unknown';
}

function buildPairKey(pair: StorytellerReadAlongPair): string {
  return `${pair.textBookId}:${pair.audioBookId}`;
}

@Injectable()
export class StorytellerReadAlongBuildService {
  private readonly logger = new Logger(StorytellerReadAlongBuildService.name);
  private readonly building = new Set<string>();
  private readonly sleep: StorytellerSleep;

  constructor(
    @Inject(storytellerConfig.KEY) private readonly config: ConfigType<typeof storytellerConfig>,
    private readonly repo: StorytellerRepository,
    private readonly settingsService: StorytellerSettingsService,
    private readonly client: StorytellerClientService,
    private readonly editionLinks: EditionLinkRepository,
    private readonly bookService: BookService,
    private readonly libraryService: LibraryService,
    private readonly scannerService: ScannerService,
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
    if (this.building.has(pairKey) || this.building.size >= MAX_CONCURRENT_BUILDS) return null;
    this.building.add(pairKey);
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        this.building.delete(pairKey);
      },
    };
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
      await this.executeBuild(buildId, pair, user, options);
    } finally {
      reserved.release();
    }
  }

  private async executeBuild(buildId: number, pair: StorytellerReadAlongPair, user: RequestUser, options: StorytellerRunBuildOptions): Promise<void> {
    const startedAt = Date.now();
    let phase: ReadAlongPhase = 'prepare';
    this.logger.log(
      `[${BUILD_EVENT}] [start] textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} buildId=${buildId} force=${options.force === true} - read-along build started`,
    );

    try {
      const prepared = await this.prepare(buildId, pair, user, options);

      phase = 'register';
      let registered = await this.register(buildId, prepared);

      phase = 'process';
      registered = await this.process(buildId, registered);

      phase = 'wait';
      await this.repo.updateBuild(buildId, { phase });
      const remoteBook = await this.waitForReadaloud(buildId, registered.session, registered.storytellerBookUuid);

      phase = 'collect';
      const collected = await this.collect(buildId, pair, registered, remoteBook, options);

      phase = 'link';
      const oldOutputBookId = options.force === true ? (options.oldOutputBookId ?? null) : null;
      // Read fresh, before attachToLink overwrites the column: `pair.link` is a request-time snapshot.
      const linkedReadAlongBookId = oldOutputBookId === null ? null : await this.findLinkedReadAlongBook(pair);
      await this.attachToLink(buildId, pair, collected.outputBookId);

      await this.repo.updateBuild(buildId, {
        status: 'ready',
        phase,
        transport: collected.transport,
        outputBookId: collected.outputBookId,
        builtAt: new Date(),
        error: null,
      });
      // Dropped only once the replacement is on disk and linked: a build can sit in the wait loop for hours.
      if (oldOutputBookId !== null) {
        await this.removePreviousOutputBestEffort(buildId, pair, oldOutputBookId, collected.outputBookId, linkedReadAlongBookId, user);
      }
      const cleanUpRemote = options.cleanUpRemote ?? registered.settings.deleteRemoteAfterImport;
      if (cleanUpRemote) {
        await this.cleanUpRemoteBestEffort(buildId, registered, collected.remoteReadaloudIsLocal);
      }
      this.logger.log(
        `[${BUILD_EVENT}] [end] textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} buildId=${buildId} durationMs=${Date.now() - startedAt} transport=${collected.transport} outputBookId=${collected.outputBookId} storytellerBookUuid=${registered.storytellerBookUuid} - read-along build completed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      // Stored raw, only clipped: log escaping belongs at the log call site, not in the column.
      const persistedError = message.slice(0, MAX_ERROR_CHARS);
      // `storytellerBookUuid` is deliberately not written here: a uuid remembered by this method is
      // stale the moment the 409 fallback uploads a replacement.
      await this.persistTerminalFailure(buildId, phase, persistedError);
      this.logger.error(
        `[${BUILD_EVENT}] [fail] textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} buildId=${buildId} durationMs=${Date.now() - startedAt} step=${phase} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along build failed`,
      );
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException(message);
    }
  }

  /**
   * A dropped terminal write leaves every future request for this pair answering `busy` until a
   * restart runs `failInterruptedBuilds`, so the retry drops `phase` and keeps only the two columns
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
  ): Promise<PreparedBuild> {
    await this.repo.updateBuild(buildId, { phase: 'prepare' });
    const connection = await this.settingsService.getConnection();
    if (!connection) throw new BadRequestException('Storyteller is not configured');

    const settings = await this.settingsService.getSettings();
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
    if (audioFiles.length === 0) throw new BadRequestException('The audio edition has no audio files');

    const session = this.client.createSession(connection);
    const [, remoteSettings] = await Promise.all([session.getServerInfo(), session.getSettings()]);
    const selected = this.selectTransport(settings, remoteSettings, folder.path, library.organizationMode);
    if (settings.transport === 'shared-paths' && selected.transport !== 'shared-paths') {
      throw new BadRequestException(pinnedSharedPathsMessage(selected.reason));
    }
    const collisionStartedAt = Date.now();
    const collision = (await this.mightWriteToReadaloudFolder(pair, remoteSettings, selected.transport))
      ? await this.findPredictedOutputCollision(buildId, pair, targetLibraryId, settings, remoteSettings.readaloudLocation)
      : null;
    if (collision !== null) {
      const durationMs = Date.now() - collisionStartedAt;
      if (settings.transport === 'shared-paths') {
        const refused = new ConflictException(
          `Storyteller would write this read-along at ${collision.path}, which belongs to book ${collision.bookId}`,
        );
        const { errorClass, message } = describeError(refused);
        this.logger.warn(
          `[${OVERWRITE_EVENT}] [fail] buildId=${buildId} textBookId=${pair.textBookId} ownerBookId=${collision.bookId} path="${sanitizeLogValue(collision.path)}" durationMs=${durationMs} reason="${sanitizeLogValue(collision.reason)}" errorClass=${errorClass} error="${sanitizeLogValue(message)}" - shared paths would write this read-along over another book file`,
        );
        throw refused;
      }
      this.logger.warn(
        `[${OVERWRITE_EVENT}] [end] buildId=${buildId} textBookId=${pair.textBookId} ownerBookId=${collision.bookId} path="${sanitizeLogValue(collision.path)}" durationMs=${durationMs} reason="${sanitizeLogValue(collision.reason)}" overwritten=false transport=api-transfer - shared paths would have written this read-along over another book file`,
      );
    }
    const transport = collision === null ? selected.transport : 'api-transfer';
    const transportReason = collision === null ? selected.reason : 'readaloud_path_owned_by_another_book';

    // `transport` is deliberately not persisted here: on a resumed build this would overwrite the
    // transport that actually created the Storyteller book. Register owns that column.
    await this.repo.updateBuild(buildId, {
      phase: 'prepare',
      targetLibraryId,
    });
    return {
      pair,
      session,
      settings,
      remoteSettings,
      sourceEpub,
      audioFiles,
      targetLibraryId,
      targetFolderPath: folder.path,
      organizationMode: library.organizationMode,
      transport,
      transportReason,
      outputWouldCollide: collision !== null,
    };
  }

  private selectTransport(
    settings: StorytellerSettings,
    remoteSettings: StorytellerRemoteSettings,
    targetFolderPath: string,
    organizationMode: string,
  ): { transport: StorytellerEffectiveTransport; reason: string | null } {
    if (settings.transport === 'api-transfer') return { transport: 'api-transfer', reason: null };
    if (settings.pathMappings.length === 0) return { transport: 'api-transfer', reason: 'no_path_mappings' };
    if (!toRemotePath(targetFolderPath, settings.pathMappings)) return { transport: 'api-transfer', reason: 'target_folder_not_mapped' };
    if (remoteSettings.readaloudLocationType !== 'CUSTOM_FOLDER' || !remoteSettings.readaloudLocation) {
      return { transport: 'api-transfer', reason: 'readaloud_not_custom_folder' };
    }
    const localReadaloudPath = toLocalPath(remoteSettings.readaloudLocation, settings.pathMappings);
    if (!localReadaloudPath || !pathIsWithinFolder(localReadaloudPath, targetFolderPath)) {
      return { transport: 'api-transfer', reason: 'readaloud_folder_outside_target' };
    }
    if (!this.readAlongBecomesItsOwnBook(localReadaloudPath, targetFolderPath, organizationMode)) {
      return { transport: 'api-transfer', reason: 'readaloud_folder_not_its_own_book' };
    }
    return { transport: 'shared-paths', reason: null };
  }

  /**
   * Shared paths need the read-along to become its own book. The scanner gives every root-level file
   * its own book whatever the organization mode, but one folder deeper a `book_per_folder` library
   * folds the whole subfolder into one book - which a later rebuild would delete entire.
   *
   * `folderPath` is the folder the read-along file itself lands in, not the library folder.
   */
  private readAlongBecomesItsOwnBook(folderPath: string, targetFolderPath: string, organizationMode: string): boolean {
    if (organizationMode === 'book_per_file') return true;
    return withoutTrailingSlashes(folderPath) === withoutTrailingSlashes(targetFolderPath);
  }

  /**
   * Whether this build can end up processing a book Storyteller holds by reference, which is what
   * makes it write into the one global read-along folder. The transport this run selected settles
   * that only for a registration this run makes: `register` reinstates the transport stored with a
   * remembered book, so a run selecting api-transfer still processes a reference import whose
   * output lands in that folder.
   */
  private async mightWriteToReadaloudFolder(
    pair: StorytellerReadAlongPair,
    remoteSettings: StorytellerRemoteSettings,
    selectedTransport: StorytellerEffectiveTransport,
  ): Promise<boolean> {
    if (remoteSettings.readaloudLocationType !== 'CUSTOM_FOLDER' || !remoteSettings.readaloudLocation) return false;
    if (selectedTransport === 'shared-paths') return true;
    const current = await this.repo.findBuildByPair(pair.textBookId, pair.audioBookId);
    return current?.storytellerBookUuid != null && current.transport === 'shared-paths';
  }

  /**
   * `readaloudLocation` is one global Storyteller setting and BookOrbit does not choose the filename,
   * so every shared-paths build writes `<folder>/<title>.epub` with no discriminator. Two books whose
   * titles sanitize alike land on one path, and by the time the collect refuses to claim the file the
   * other book's read-along has already been overwritten.
   *
   * Best effort only: it guesses with BookOrbit's own title, which is user-edited and
   * provider-refreshed and need not be the one Storyteller reads out of the EPUB. Missing a real
   * collision leaves the overwrite to the post-hoc warning; predicting one that never happens
   * refuses a pinned build, or uploads a pair that could have been shared.
   */
  private async findPredictedOutputCollision(
    buildId: number,
    pair: StorytellerReadAlongPair,
    targetLibraryId: number,
    settings: StorytellerSettings,
    readaloudLocation: string | null,
  ): Promise<{ path: string; bookId: number; reason: string } | null> {
    const identity = await this.repo.findBookTitleAndAuthors(pair.textBookId);
    const predictedPath = toLocalPath(expectedCustomFolderOutputPath(readaloudLocation, identity?.title || 'Read-along'), settings.pathMappings);
    if (!predictedPath) return null;
    const located = await this.repo.findBookFileByAbsolutePath(predictedPath);
    if (!located) return null;
    const reason = await this.collectedBookRefusal(buildId, pair, targetLibraryId, located, predictedPath);
    return reason === null ? null : { path: predictedPath, bookId: located.bookId, reason };
  }

  private async register(buildId: number, prepared: PreparedBuild): Promise<RegisteredBuild> {
    const startedAt = Date.now();
    this.logger.log(
      `[${REGISTER_EVENT}] [start] buildId=${buildId} transport=${prepared.transport} transportReason=${prepared.transportReason ?? 'configured'} - Storyteller registration started`,
    );
    try {
      const { registered, mode } = await this.registerWithStoryteller(buildId, prepared);
      this.logger.log(
        `[${REGISTER_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} mode=${mode} transport=${registered.transport} storytellerBookUuid=${registered.storytellerBookUuid} remoteOwnsAllSources=${registered.remoteOwnsAllSources} - Storyteller registration completed`,
      );
      return registered;
    } catch (error) {
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
    // A predicted collision is what makes the remembered book unusable rather than the transport:
    // processing it again writes the read-along to the colliding path whatever this build intended,
    // so the book is abandoned - never deleted, it holds the user's own files - and the pair is
    // uploaded instead, under a filename carrying its own discriminators.
    if (storytellerBookUuid && (prepared.outputWouldCollide || !(await prepared.session.getBook(storytellerBookUuid)))) {
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

    // One side at a time, then merged: a single request gives both candidates the same uuid hint and
    // drops the loser's half. Storyteller pairs automatically only within one upload or folder.
    const ebook = await this.importEbook(prepared, epubPath, collectionUuid);
    if (ebook === null) {
      return { registered: await this.registerByUpload(buildId, prepared, collectionUuid, 'epub2_not_importable'), mode: 'upload' };
    }

    const audio = await prepared.session.importByReference({
      paths: audioPaths as string[],
      importMode: 'reference',
      ...(collectionUuid ? { collectionUuid } : {}),
    });
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
      });
      await this.repo.updateBuild(buildId, { transport: 'api-transfer', storytellerBookUuid: uploaded.uuid });
      this.logger.log(
        `[${UPLOAD_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} storytellerBookUuid=${uploaded.uuid} - upload to Storyteller completed`,
      );
      return { ...prepared, transport: 'api-transfer', remoteOwnsAllSources: true, referenceImported: false, storytellerBookUuid: uploaded.uuid };
    } catch (error) {
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
      await this.processWhenMediaAttached(registered);
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
      await this.processWhenMediaAttached(uploaded);
      return uploaded;
    }
  }

  private async processWhenMediaAttached(registered: RegisteredBuild): Promise<void> {
    const book = await this.awaitBothMedia(registered);
    if (!book) throw new BadGatewayException('The Storyteller book disappeared before processing');
    if (book.aligned || book.processing.state === 'running') return;
    await registered.session.process(registered.storytellerBookUuid);
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
        consecutiveErrors += 1;
        if (consecutiveErrors >= WAIT_ERROR_CAP) {
          throw new ServiceUnavailableException('Storyteller book reads failed 20 times in a row while its media links were attaching', {
            cause: error,
          });
        }
      }
      if (Date.now() >= deadline) {
        // A null `book` here means every read threw: the ceiling went on an unreachable
        // Storyteller, not on a book that never linked.
        if (!book) {
          throw new ServiceUnavailableException('Storyteller could not be read while the media links were attaching');
        }
        return book;
      }
      await this.sleep(MEDIA_LINK_POLL_MS);
    }
  }

  private async waitForReadaloud(buildId: number, session: StorytellerSession, uuid: string): Promise<StorytellerBookSummary> {
    const startedAt = Date.now();
    let polls = 0;
    let delayMs = WAIT_INITIAL_DELAY_MS;
    let consecutiveErrors = 0;

    try {
      while (Date.now() - startedAt < this.config.waitCeilingMs) {
        polls += 1;
        try {
          const book = await session.getBook(uuid);
          if (!book) throw new BadGatewayException('The Storyteller book disappeared while processing');
          await this.repo.updateBuild(buildId, {
            phase: 'wait',
            remoteTask: book.processing.task,
            remoteProgress: book.processing.progress,
          });
          // Availability first: a reported failure only counts when nothing is there to fetch.
          // Storyteller can drop or halt the job row around a restart and the job record wins in
          // `normalizeProcessing`, so failing on it ends a build whose file is ready and no retry
          // recovers it - an aligned book is never re-processed.
          if (await session.readaloudAvailable(uuid)) {
            const finished = (await this.refetchFinishedBook(session, uuid)) ?? book;
            this.logger.log(
              `[${WAIT_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} polls=${polls} readaloudPathReported=${finished.readaloudPath !== null} - read-along became available`,
            );
            return finished;
          }
          if (book.processing.state === 'failed') {
            throw new BadGatewayException(book.processing.error || 'Storyteller processing failed');
          }
          consecutiveErrors = 0;
        } catch (error) {
          // The two BadGateways thrown in here - a book Storyteller no longer has, and a failure it
          // reported - are answers, not transport trouble: retrying either burns the whole wait
          // window on a result that cannot change. Everything else gets the retry budget.
          if (error instanceof BadGatewayException) throw error;
          consecutiveErrors += 1;
          if (consecutiveErrors >= WAIT_ERROR_CAP) {
            throw new ServiceUnavailableException('Storyteller read-along availability checks failed 20 times in a row', { cause: error });
          }
        }

        const remaining = this.config.waitCeilingMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        await this.sleep(Math.min(delayMs, remaining));
        delayMs = Math.min(delayMs * 2, WAIT_MAX_DELAY_MS);
      }
      throw new ServiceUnavailableException('Storyteller did not finish within the wait ceiling');
    } catch (error) {
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
    options: StorytellerRunBuildOptions,
  ): Promise<{ outputBookId: number; transport: StorytellerEffectiveTransport; remoteReadaloudIsLocal: boolean }> {
    const startedAt = Date.now();
    this.logger.log(`[${COLLECT_EVENT}] [start] buildId=${buildId} transport=${registered.transport} - read-along collection started`);
    try {
      // Persisted on entry, or a download running for minutes reports as the wait phase with stale progress.
      await this.repo.updateBuild(buildId, { phase: 'collect' });
      let outputBookId: number | null = null;
      const identity = await this.repo.findBookTitleAndAuthors(pair.textBookId);
      const title = remoteBook.title || identity?.title || 'Read-along';
      // Where the file is decides how to collect it, not how the book was registered: trusting a
      // remembered transport means waiting out the whole collect window for a file that was never
      // going to appear.
      let transport: StorytellerEffectiveTransport = this.readaloudIsInTargetFolder(registered, remoteBook) ? 'shared-paths' : 'api-transfer';
      if (transport !== registered.transport) await this.repo.updateBuild(buildId, { transport });
      if (transport === 'shared-paths') {
        outputBookId = await this.collectFromSharedPath(buildId, pair, registered, title, remoteBook);
        if (outputBookId === null) {
          transport = 'api-transfer';
          await this.repo.updateBuild(buildId, { transport });
        }
      }
      if (outputBookId === null) {
        outputBookId = await this.collectByTransfer(buildId, pair, registered, title, options);
      }
      if (outputBookId === null) {
        throw new BadGatewayException('The read-along was collected but never appeared in the read-along library');
      }

      // Recorded as soon as it is known: attaching to the link can fail, and its error says the book
      // was kept without the row saying which book.
      await this.repo.updateBuild(buildId, { outputBookId });

      this.logger.log(
        `[${COLLECT_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} transport=${transport} outputBookId=${outputBookId} - read-along collection completed`,
      );
      return { outputBookId, transport, remoteReadaloudIsLocal: this.readaloudIsLocallyVisible(registered, remoteBook) };
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${COLLECT_EVENT}] [fail] buildId=${buildId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - read-along collection failed`,
      );
      throw error;
    }
  }

  /**
   * Whether Storyteller's read-along file sits somewhere this instance can see, which is the
   * question remote cleanup asks and is not the transport: the transport records how BookOrbit got
   * its copy, and `collect` downgrades it to api-transfer whenever a shared-path collect is refused
   * - a file left exactly where it was.
   */
  private readaloudIsLocallyVisible(registered: RegisteredBuild, remoteBook: StorytellerBookSummary): boolean {
    // An unreported path reads as "not in a library": `removesBook` ANDs this with
    // `remoteOwnsAllSources`, which only a pure upload sets, and Storyteller keeps an uploaded
    // book's read-along in its own assets whatever CUSTOM_FOLDER says.
    // Being covered by a path mapping is not the test - a broad mapping rewrites Storyteller's own
    // asset directory too - so this asks the library-folder question the collect asks.
    if (!remoteBook.readaloudPath) return false;
    const local = toLocalPath(remoteBook.readaloudPath, registered.settings.pathMappings);
    return local !== null && pathIsWithinFolder(local, registered.targetFolderPath);
  }

  private readaloudIsInTargetFolder(registered: RegisteredBuild, remoteBook: StorytellerBookSummary): boolean {
    if (!remoteBook.readaloudPath) return registered.transport === 'shared-paths';
    const localPath = toLocalPath(remoteBook.readaloudPath, registered.settings.pathMappings);
    return localPath !== null && pathIsWithinFolder(localPath, registered.targetFolderPath);
  }

  private async collectFromSharedPath(
    buildId: number,
    pair: StorytellerReadAlongPair,
    registered: RegisteredBuild,
    title: string,
    remoteBook: StorytellerBookSummary,
  ): Promise<number | null> {
    const startedAt = Date.now();
    // Storyteller's reported path wins over one derived from the title: the expected-path helper is
    // a port of its sanitizer, and a port can drift.
    const remoteOutputPath = remoteBook.readaloudPath ?? expectedCustomFolderOutputPath(registered.remoteSettings.readaloudLocation, title);
    const localOutputPath = toLocalPath(remoteOutputPath, registered.settings.pathMappings);
    if (!localOutputPath || !pathIsWithinFolder(localOutputPath, registered.targetFolderPath)) return null;
    // Inside the folder is not enough: claiming a file the scan folded into a subfolder's single
    // book would take every other read-along in that folder with it on the next rebuild.
    if (!this.readAlongBecomesItsOwnBook(dirname(localOutputPath), registered.targetFolderPath, registered.organizationMode)) return null;
    const collected = await this.awaitScannedFile(buildId, pair, registered.targetLibraryId, localOutputPath);
    if (collected.refusal !== null) this.warnReadAlongWasOverwritten(buildId, pair, collected.refusal, localOutputPath, startedAt);
    return collected.outputBookId;
  }

  /**
   * A refused claim at the shared path means Storyteller wrote over a file another book owns: the
   * build recovers by downloading its own copy, while that book keeps a row pointing at an alignment
   * of a different book entirely. The claim refusal alone does not say a file was destroyed.
   *
   * Nothing is thrown, so the conflict the pre-flight guard would have raised for this same path is
   * built here only to name the `[fail]` line's error class and message.
   */
  private warnReadAlongWasOverwritten(
    buildId: number,
    pair: StorytellerReadAlongPair,
    refusal: { bookId: number; reason: string },
    localOutputPath: string,
    startedAt: number,
  ): void {
    const overwrote = new ConflictException(`Storyteller wrote this read-along at ${localOutputPath}, which belongs to book ${refusal.bookId}`);
    const { errorClass, message } = describeError(overwrote);
    this.logger.warn(
      `[${OVERWRITE_EVENT}] [fail] buildId=${buildId} textBookId=${pair.textBookId} ownerBookId=${refusal.bookId} path="${sanitizeLogValue(localOutputPath)}" durationMs=${Date.now() - startedAt} reason="${sanitizeLogValue(refusal.reason)}" errorClass=${errorClass} error="${sanitizeLogValue(message)}" - Storyteller wrote this read-along over another book file`,
    );
  }

  /**
   * Waits for the library scan to index a file already on disk, whichever route put it there.
   *
   * A rejected candidate ends the wait - polling will not change which row owns the path - and reads
   * as a miss, so the shared-paths route can fall back to a download.
   *
   * The one recovery rescan is spent only on a scan that was actually accepted: a scan already in
   * flight swallows the request and has usually walked the folder before the file was written.
   */
  private async awaitScannedFile(
    buildId: number,
    pair: StorytellerReadAlongPair,
    libraryId: number,
    localOutputPath: string,
  ): Promise<CollectedFile> {
    await this.startScanIgnoringConflict(libraryId);

    const startedAt = Date.now();
    let rescanned = false;
    while (Date.now() - startedAt < COLLECT_CEILING_MS) {
      const found = await this.repo.findBookFileByAbsolutePath(localOutputPath);
      if (found) return this.claimCollectedBook(buildId, pair, libraryId, found, localOutputPath);
      const elapsed = Date.now() - startedAt;
      if (!rescanned && elapsed >= COLLECT_RESCAN_MS) {
        rescanned = await this.startScanIgnoringConflict(libraryId);
      }
      await this.sleep(Math.min(COLLECT_POLL_MS, COLLECT_CEILING_MS - elapsed));
    }
    return NOTHING_COLLECTED;
  }

  /** True when a scan was accepted; false when one was already running and this request was refused. */
  private async startScanIgnoringConflict(libraryId: number): Promise<boolean> {
    try {
      await this.scannerService.startScan(libraryId, 'manual');
      return true;
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      return false;
    }
  }

  /**
   * Downloads into the library folder and lets the scanner index it, rather than using the web
   * upload pipeline: that pipeline caps every file at the browser upload limit a read-along carrying
   * narration audio routinely exceeds, and this leaves one way a read-along is ever collected. The
   * download is atomic, so no scan can catch a half-written book.
   */
  private async collectByTransfer(
    buildId: number,
    pair: StorytellerReadAlongPair,
    registered: RegisteredBuild,
    title: string,
    options: StorytellerRunBuildOptions,
  ): Promise<number | null> {
    // Two discriminators: the build id keeps two pairs sharing a title apart, and the Storyteller
    // book keeps two outputs of the same pair apart - a pair keeps one build row for life, so the id
    // alone is constant forever and a rebuild would land on top of the output it replaces.
    const suffix = ` (read-along ${buildId}-${remoteOutputKey(registered.storytellerBookUuid)}).epub`;
    const safeTitle = storytellerSafeFilepathSegment(title) || 'Read-along';
    const destination = join(registered.targetFolderPath, storytellerSafeFilepathSegment(safeTitle, suffix));

    const adopted = await this.adoptOrClearDestination(buildId, pair, registered.targetLibraryId, destination, options);
    if (adopted !== null) return adopted;

    await registered.session.downloadReadaloud(registered.storytellerBookUuid, destination);
    return (await this.awaitScannedFile(buildId, pair, registered.targetLibraryId, destination)).outputBookId;
  }

  /**
   * Lets a retry converge on what its own previous attempt left behind: the filename names the
   * Storyteller book, a retry resumes that same book, so anything at that exact path came from an
   * earlier attempt at this same output. Without this the download - published with a hard link, so
   * EEXIST rather than an overwrite - can never succeed again.
   *
   * Adoption belongs to a retry and nothing else. A rebuild registers a new Storyteller book and so
   * a new filename, and an occupied path means something it cannot account for: a reason to refuse,
   * never a reason to clear the path.
   */
  private async adoptOrClearDestination(
    buildId: number,
    pair: StorytellerReadAlongPair,
    targetLibraryId: number,
    destination: string,
    options: StorytellerRunBuildOptions,
  ): Promise<number | null> {
    if (!(await this.fileExists(destination))) return null;
    const startedAt = Date.now();
    this.logger.log(
      `[${ADOPT_EVENT}] [start] buildId=${buildId} path="${sanitizeLogValue(destination)}" force=${options.force === true} - occupied download destination inspected`,
    );

    if (options.force === true) {
      const refused = new ConflictException('A rebuild cannot adopt or clear a download destination that is already occupied');
      const { errorClass, message } = describeError(refused);
      this.logger.warn(
        `[${ADOPT_EVENT}] [fail] buildId=${buildId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - the download destination could not be adopted`,
      );
      throw refused;
    }

    const owner = await this.repo.findBookFileByAbsolutePath(destination);
    if (!owner) {
      await this.removeOrphanedDownload(buildId, destination);
      this.logger.log(
        `[${ADOPT_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} adopted=false cleared=true - an orphaned download was cleared`,
      );
      return null;
    }

    const claimed = await this.claimCollectedBook(buildId, pair, targetLibraryId, owner, destination);
    if (claimed.outputBookId === null) {
      const refused = new ConflictException('A book this read-along build did not produce already owns the download destination');
      const { errorClass, message } = describeError(refused);
      this.logger.warn(
        `[${ADOPT_EVENT}] [fail] buildId=${buildId} candidateBookId=${owner.bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - the download destination could not be adopted`,
      );
      throw refused;
    }
    this.logger.log(
      `[${ADOPT_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} outputBookId=${claimed.outputBookId} adopted=true - a previous attempt's read-along was adopted`,
    );
    return claimed.outputBookId;
  }

  private async removeOrphanedDownload(buildId: number, destination: string): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[${ORPHAN_EVENT}] [start] buildId=${buildId} path="${sanitizeLogValue(destination)}" - orphaned read-along removal started`);
    try {
      await rm(destination, { force: true });
      this.logger.log(
        `[${ORPHAN_EVENT}] [end] buildId=${buildId} path="${sanitizeLogValue(destination)}" durationMs=${Date.now() - startedAt} - orphaned read-along removed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${ORPHAN_EVENT}] [fail] buildId=${buildId} path="${sanitizeLogValue(destination)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - orphaned read-along removal failed`,
      );
      throw error;
    }
  }

  private fileExists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  /**
   * A path can be owned by a book this build never produced - the shared-paths route collects a flat
   * `<title>.epub` with no discriminator - and adopting one makes the user's own book this build's
   * output, which a later force rebuild deletes, files and all.
   *
   * The library is checked first because it is the one thing the path cannot tell you:
   * `book_files.absolute_path` is unique instance-wide while libraries may cover overlapping
   * folders, so another library's scan can index the file first and, in `book_per_folder`, own the
   * folder-book for the entire read-along directory - which every later refusal here would pass.
   */
  private async claimCollectedBook(
    buildId: number,
    pair: StorytellerReadAlongPair,
    targetLibraryId: number,
    located: StorytellerBookFileLocation,
    collectedPath: string,
  ): Promise<CollectedFile> {
    const startedAt = Date.now();
    const bookId = located.bookId;
    this.logger.log(
      `[${CLAIM_EVENT}] [start] buildId=${buildId} candidateBookId=${bookId} candidateLibraryId=${located.libraryId} targetLibraryId=${targetLibraryId} - collected book inspected`,
    );

    const reason = await this.collectedBookRefusal(buildId, pair, targetLibraryId, located, collectedPath);
    if (reason === null) {
      this.logger.log(
        `[${CLAIM_EVENT}] [end] buildId=${buildId} candidateBookId=${bookId} durationMs=${Date.now() - startedAt} claimed=true - collected book claimed as this build output`,
      );
      return { outputBookId: bookId, refusal: null };
    }
    this.logger.warn(
      `[${CLAIM_EVENT}] [end] buildId=${buildId} candidateBookId=${bookId} durationMs=${Date.now() - startedAt} claimed=false reason="${sanitizeLogValue(reason)}" - collected book is not this build output`,
    );
    return { outputBookId: null, refusal: { bookId, reason } };
  }

  /** Why a book at a read-along path is not this build's output, or null when it is. */
  private async collectedBookRefusal(
    buildId: number,
    pair: StorytellerReadAlongPair,
    targetLibraryId: number,
    located: StorytellerBookFileLocation,
    collectedPath: string,
  ): Promise<string | null> {
    const bookId = located.bookId;
    if (located.libraryId !== targetLibraryId) {
      return `the book belongs to library ${located.libraryId}, not the library this build wrote to`;
    }
    if (bookId === pair.textBookId || bookId === pair.audioBookId) return 'the book is the pair own text or audio edition';
    const owningBuild = await this.repo.findBuildByOutputBook(bookId);
    if (owningBuild && owningBuild.id !== buildId) return `the book is read-along build ${owningBuild.id} output`;
    // A book can pass every check above and still be the user's. A read-along this build produced
    // is exactly one file, so anything else it owns says it is not that book.
    if (await this.repo.hasContentFileOtherThan(bookId, collectedPath)) return 'the book holds content files this build did not produce';
    return null;
  }

  /**
   * Reclaims Storyteller's disk once BookOrbit holds the read-along. Deleting a Storyteller book
   * deletes the files attached to it, so the whole book only goes when Storyteller owns every source
   * (an upload, and nothing else) and its read-along is not somewhere this instance can see.
   * Anything else drops only the processing cache and leaves the book alone.
   */
  private async cleanUpRemoteBestEffort(buildId: number, registered: RegisteredBuild, remoteReadaloudIsLocal: boolean): Promise<void> {
    const startedAt = Date.now();
    const removesBook = registered.remoteOwnsAllSources && !remoteReadaloudIsLocal;
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
   * this build can show it produced. The refusal is deliberately one-sided: a stale read-along costs
   * disk, the wrong book costs data.
   */
  private async removePreviousOutputBestEffort(
    buildId: number,
    pair: StorytellerReadAlongPair,
    outputBookId: number,
    newOutputBookId: number,
    linkedReadAlongBookId: number | null,
    user: RequestUser,
  ): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(
      `[${CLEANUP_EVENT}] [start] buildId=${buildId} outputBookId=${outputBookId} target=previous_output - previous read-along removal started`,
    );
    const refusal = await this.previousOutputRefusal(buildId, pair, outputBookId, newOutputBookId, linkedReadAlongBookId);
    if (refusal !== null) {
      this.logger.warn(
        `[${CLEANUP_EVENT}] [end] buildId=${buildId} outputBookId=${outputBookId} target=previous_output durationMs=${Date.now() - startedAt} removed=false reason="${sanitizeLogValue(refusal)}" - previous read-along removal refused`,
      );
      return;
    }

    try {
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

  private async previousOutputRefusal(
    buildId: number,
    pair: StorytellerReadAlongPair,
    outputBookId: number,
    newOutputBookId: number,
    linkedReadAlongBookId: number | null,
  ): Promise<string | null> {
    // A shared-path rebuild overwrites the old file in place, so there is nothing to remove.
    if (outputBookId === newOutputBookId) return 'the rebuild resolved to the same book';
    if (outputBookId === pair.textBookId || outputBookId === pair.audioBookId) {
      return 'the book is the pair own text or audio edition';
    }
    // The link has to name this book, not merely fail to contradict it: it is the one record of a
    // previous output that survives a build claim, and the record the user edits - detaching keeps
    // the book and clears this column. A self-pair has no link and falls to the build-row check.
    if (pair.linkId !== null && linkedReadAlongBookId !== outputBookId) {
      return 'the edition link does not name this read-along book';
    }
    const owningBuild = await this.repo.findBuildByOutputBook(outputBookId);
    if (owningBuild && owningBuild.id !== buildId) return `the book is read-along build ${owningBuild.id} output`;
    return null;
  }

  /** Best effort: a failed read refuses the removal rather than failing a build that already produced its output. */
  private async findLinkedReadAlongBook(pair: StorytellerReadAlongPair): Promise<number | null> {
    if (pair.linkId === null) return null;
    const link = await this.editionLinks.findLinkForBook(pair.textBookId).catch(() => undefined);
    return link?.id === pair.linkId ? link.readAlongBookId : null;
  }

  private async attachToLink(buildId: number, pair: StorytellerReadAlongPair, outputBookId: number): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[${LINK_EVENT}] [start] buildId=${buildId} linkId=${pair.linkId ?? 'none'} outputBookId=${outputBookId} - link update started`);
    if (pair.linkId === null) {
      this.logger.log(`[${LINK_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} linked=false - self-pair has no edition link`);
      return;
    }

    try {
      const linked = await this.editionLinks.setReadAlongBook(pair.linkId, outputBookId);
      if (!linked) throw new ConflictException('The read-along could not be attached to the link; the imported book was kept');
      this.logger.log(
        `[${LINK_EVENT}] [end] buildId=${buildId} durationMs=${Date.now() - startedAt} linked=true outputBookId=${outputBookId} - link update completed`,
      );
    } catch (error) {
      const mapped = isUniqueViolation(error)
        ? new ConflictException('The read-along could not be attached to the link; the imported book was kept')
        : error;
      const { errorClass, message } = describeError(mapped);
      this.logger.error(
        `[${LINK_EVENT}] [fail] buildId=${buildId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - link update failed`,
      );
      throw mapped;
    }
  }
}
