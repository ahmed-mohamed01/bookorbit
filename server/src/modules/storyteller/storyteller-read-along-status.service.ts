import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
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
import { Permission } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { findSourceEpubProblem } from './storyteller-epub.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import type { BuildReadAlongDto } from './dto';
import { describeError } from './storyteller-log.utils';
import { matchExistingBooks } from './storyteller-match.utils';
import { StorytellerReadAlongBuildService } from './storyteller-read-along-build.service';
import { StorytellerClientService } from './storyteller-client.service';
import type { StorytellerConnection } from './storyteller-client.types';
import { StorytellerRepository, type StorytellerBookIdentity } from './storyteller.repository';
import { StorytellerSettingsService } from './storyteller-settings.service';

const REQUEST_EVENT = 'storyteller.read_along.request';
const EXISTING_EVENT = 'storyteller.read_along.find_existing';
const ATTACH_EVENT = 'storyteller.read_along.attach_existing';
const FAILED_CHECK_TTL_MS = 10 * 60_000;
// The matcher surfaces the best few and the UI reads the first aligned one, so a wider page buys nothing.
const STORYTELLER_MATCH_PAGE_SIZE = 50;
type EditionLinkRow = NonNullable<Awaited<ReturnType<EditionLinkRepository['findLinkForBook']>>>;

function normalizeReadAlongStatus(status: string | undefined): ReadAlongStatus {
  return status === 'building' || status === 'ready' || status === 'failed' ? status : 'none';
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
export class StorytellerReadAlongStatusService {
  private readonly logger = new Logger(StorytellerReadAlongStatusService.name);

  constructor(
    private readonly repo: StorytellerRepository,
    private readonly settingsService: StorytellerSettingsService,
    private readonly client: StorytellerClientService,
    private readonly buildService: StorytellerReadAlongBuildService,
    private readonly bookService: BookService,
    private readonly libraryService: LibraryService,
    private readonly editionLinks: EditionLinkRepository,
  ) {}

  async requestBuild(bookId: number, user: RequestUser, dto: BuildReadAlongDto): Promise<ReadAlongBuildResponse> {
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

    const [sourceEpub, hasAudio, existing] = await Promise.all([
      this.repo.findSourceEpubFile(pair.textBookId),
      this.repo.hasAudioContentFile(pair.audioBookId),
      this.repo.findBuildByPair(pair.textBookId, pair.audioBookId),
    ]);
    // Only once the build row is in hand, or the UI swaps a running build for "none" when a check fails.
    if (this.hasRecentFailedCheck(settings.lastCheckedAt, settings.lastCheck?.ok)) {
      return this.blocked(existing?.status, 'unreachable', bookId, user.id, startedAt);
    }
    if (!sourceEpub) return this.blocked(existing?.status, 'no_epub', bookId, user.id, startedAt);
    if (!hasAudio) return this.blocked(existing?.status, 'no_audio', bookId, user.id, startedAt);

    // Checked on the click rather than on the five-second poll: it reads the archive's central
    // directory, and the answer cannot change while the file does not. A file Storyteller cannot
    // parse fails every import mode, so refusing here costs one seek instead of a build that runs
    // for hours and then reports the provider's own 500.
    const epubProblem = await findSourceEpubProblem(sourceEpub.absolutePath);
    if (epubProblem) {
      this.logger.warn(
        `[${REQUEST_EVENT}] [fail] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=UnreadableSourceEpub error="${sanitizeLogValue(epubProblem)}" path="${sanitizeLogValue(sourceEpub.absolutePath)}" - source epub cannot be read as an EPUB`,
      );
      return this.blocked(existing?.status, 'source_epub_unreadable', bookId, user.id, startedAt);
    }

    const targetLibraryId = dto.targetLibraryId ?? settings.targetLibraryId;
    if (targetLibraryId == null) return this.blocked(existing?.status, 'no_target_library', bookId, user.id, startedAt);

    let library: Awaited<ReturnType<LibraryService['findOne']>>;
    try {
      await this.libraryService.verifyUserAccess(user.id, targetLibraryId, user.isSuperuser);
    } catch {
      return this.blocked(existing?.status, 'target_not_allowed', bookId, user.id, startedAt);
    }
    try {
      library = await this.libraryService.findOne(targetLibraryId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        return this.blocked(existing?.status, 'target_not_allowed', bookId, user.id, startedAt);
      }
      throw error;
    }
    if (library.type === 'podcasts') return this.blocked(existing?.status, 'target_not_allowed', bookId, user.id, startedAt);
    if (library.allowedFormats.length > 0 && !library.allowedFormats.includes('epub')) {
      return this.blocked(existing?.status, 'format_not_allowed', bookId, user.id, startedAt);
    }

    // `startBuild` clears the row's output column on every claim, so after a failed rebuild the
    // edition link is the only record of the book still on disk - and reading only the row orphans
    // that read-along, narration audio and all.
    const previousOutputBookId = existing?.outputBookId ?? pair.link?.readAlongBookId ?? null;

    // A forced build ends in bookService.deleteBooks() on whatever book the row names, and that only
    // checks read access - so the caller is held to the delete permission and to access to that book
    // for every row carrying an output id, including a 'failed' one, since `collect` writes the id
    // as soon as it knows it.
    //
    // A refusal is a block reason, never an exception: getStatus masks an output the caller cannot
    // open, and a POST about the text edition must not 404 over a book it only mentions.
    if (dto.force && previousOutputBookId != null) {
      const replaceable = this.canDeleteBooks(user) && (previousOutputBookId === bookId || (await this.canAccessBook(previousOutputBookId, user)));
      if (!replaceable) return this.blocked(existing?.status, 'previous_output_not_deletable', bookId, user.id, startedAt);
    }
    const existingOutput = existing?.outputBookId ? await this.editionLinks.findBookSummary(existing.outputBookId) : null;
    if (existing?.status === 'ready' && existingOutput && !dto.force) {
      // Unlinking and relinking inserts a fresh link row with no read-along member, and nothing else
      // goes looking for the build that already produced one.
      await this.attachExistingOutput(pair, existingOutput.id, user);
      return this.blocked('ready', null, bookId, user.id, startedAt);
    }
    // Held from here, not merely checked: the uuid round trip below and the claim itself are both
    // awaits, and a second request crossing them claims the same slot and strips a row whose uuid is
    // the only handle on a Storyteller job the first one may already have started.
    const slot = this.buildService.tryReserve(pair);
    if (!slot) return this.blocked(existing?.status, 'busy', bookId, user.id, startedAt);

    let handedOff = false;
    try {
      if (dto.useExistingUuid !== undefined) {
        await this.assertOfferedUuid(pair, dto.useExistingUuid, connection, bookId, user.id, startedAt);
      }

      const resumeUuid = dto.useExistingUuid ?? (!dto.force && existing?.status === 'failed' ? existing.storytellerBookUuid : null);
      // A resumed book keeps the transport that registered it: otherwise the claim clears the column
      // and an uploaded book would be collected from a shared folder it never writes to.
      const resumeTransport = resumeUuid !== null && resumeUuid === existing?.storytellerBookUuid ? existing.transport : null;
      const claimed = await this.repo.startBuild({
        textBookId: pair.textBookId,
        audioBookId: pair.audioBookId,
        storytellerBookUuid: resumeUuid,
        transport: resumeTransport,
        targetLibraryId,
      });
      if (!claimed) return this.blocked(existing?.status, 'busy', bookId, user.id, startedAt);

      const running = this.buildService.runBuild(
        claimed.id,
        pair,
        user,
        {
          force: dto.force,
          targetLibraryId: dto.targetLibraryId,
          targetFolderId: dto.targetFolderId,
          oldOutputBookId: dto.force ? previousOutputBookId : null,
          cleanUpRemote: dto.cleanUpRemote,
        },
        slot,
      );
      // The slot is that build's from here, and releasing it again would free whatever slot the next
      // build has since taken.
      handedOff = true;
      void running.catch((error: unknown) => {
        const { errorClass, message } = describeError(error);
        this.logger.error(
          `[${REQUEST_EVENT}] [fail] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - background read-along build failed`,
        );
      });
    } finally {
      if (!handedOff) slot.release();
    }

    this.logger.log(
      `[${REQUEST_EVENT}] [end] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAt} status=building blocked=none - read-along build accepted`,
    );
    return { status: 'building', blocked: null };
  }

  /** Read-only: the client polls this every few seconds, so it must never write. */
  async getStatus(bookId: number, user: RequestUser): Promise<ReadAlongStatusResponse> {
    await this.bookService.verifyBookAccess(bookId, user);
    // Read once and threaded down: this route is polled against a twelve-hour build ceiling.
    const [settings, linkedPair] = await Promise.all([this.settingsService.getSettings(), this.resolvePair(bookId)]);
    let pair = linkedPair;
    let build = pair ? await this.repo.findBuildByPair(pair.textBookId, pair.audioBookId) : undefined;
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
    // One round trip for the tail of the response, against a 5-second poll.
    const [summary, remoteCopyBytes, targetLibrary, contentBlock] = await Promise.all([
      visibleOutputBookId != null ? this.editionLinks.findBookSummary(visibleOutputBookId) : Promise.resolve(null),
      building ? Promise.resolve(unknownCopySizes()) : this.resolveCopySizes(pair, visibleOutputBookId),
      this.resolveTargetLibrary(build.targetLibraryId, user),
      canBuild ? this.getCheapBlockReason(pair, settings, !building) : Promise.resolve(null),
    ]);
    const blocked = canBuild ? (contentBlock ?? this.targetBlockReason(build.targetLibraryId, targetLibrary)) : null;
    // A ready build whose output was deleted is offered again; one the reader merely cannot open
    // stays ready with the book masked, or an admin-only library would invite duplicate builds.
    const outputHidden = outputBookId != null && !outputVisible;
    const status: ReadAlongStatus = build.status === 'ready' && !summary && !outputHidden ? 'none' : (build.status as ReadAlongStatus);
    const outputBook = status === 'none' ? null : summary;

    return {
      status,
      blocked,
      phase: build.phase as ReadAlongStatusResponse['phase'],
      transport: build.transport as ReadAlongStatusResponse['transport'],
      remoteTask: build.remoteTask,
      remoteProgress: build.remoteProgress,
      outputBook: outputBook ? { id: outputBook.id, title: outputBook.title } : null,
      targetLibraryId: targetLibrary.id,
      targetLibraryName: targetLibrary.name,
      remoteCopyBytes,
      // An instance setting behind ManageAppSettings: for anyone else it is configuration they cannot read.
      keepRemoteCopyByDefault: canBuild && !settings.deleteRemoteAfterImport,
      remoteCopyReclaimable: canBuild && this.remoteCopyReclaimable(settings, build.transport),
      // The stored error is the provider's own message: a library path, a host and port. This route
      // is ungated by design while the connection sits behind ManageAppSettings, so it is bounded by
      // the same build permission as its siblings above and by the library the build targets.
      // `status` still tells a reader without it that the build failed.
      error: canBuild && targetLibrary.allowed ? build.error : null,
      startedAt: build.startedAt?.toISOString() ?? null,
      builtAt: build.builtAt?.toISOString() ?? null,
    };
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
  private async attachExistingOutput(pair: StorytellerReadAlongPair, outputBookId: number, user: RequestUser): Promise<void> {
    if (pair.linkId === null || pair.link?.readAlongBookId === outputBookId) return;
    if (!(await this.canAccessBook(outputBookId, user))) return;

    const startedAt = Date.now();
    this.logger.log(
      `[${ATTACH_EVENT}] [start] linkId=${pair.linkId} outputBookId=${outputBookId} userId=${user.id} - existing read-along re-attach started`,
    );
    try {
      const linked = await this.editionLinks.setReadAlongBook(pair.linkId, outputBookId);
      this.logger.log(
        `[${ATTACH_EVENT}] [end] linkId=${pair.linkId} outputBookId=${outputBookId} durationMs=${Date.now() - startedAt} attached=${linked !== undefined} - existing read-along re-attach completed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${ATTACH_EVENT}] [fail] linkId=${pair.linkId} outputBookId=${outputBookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - existing read-along re-attach failed`,
      );
    }
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
    };
  }
}
