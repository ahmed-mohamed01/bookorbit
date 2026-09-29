import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AudiobookshelfBookState,
  AudiobookshelfBookStatePage,
  AudiobookshelfBookSyncLink,
  AudiobookshelfBookSyncLive,
  AudiobookshelfMatchMethod,
  AudiobookshelfSyncLinkStatus,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from '../edition-link/edition-link.repository';
import { LibraryService } from '../library/library.service';
import { AudiobookshelfApiError, AudiobookshelfClientService, type AbsItemCover, type AbsMediaProgress } from './audiobookshelf-client.service';
import { parseAndNormalizeServerUrl } from './audiobookshelf-url.utils';
import { AudiobookshelfRepository, type AbsBookAccessScope, type AbsBookStateView } from './audiobookshelf.repository';
import { buildBookAccessScope, isAbsSyncConfigured } from './audiobookshelf-user.utils';
import type { ListAudiobookshelfBookStatesDto } from './dto';
import type { AudiobookshelfBookState as AudiobookshelfBookStateRow, AudiobookshelfUserSetting } from './schema/audiobookshelf.schema';

// A panel opening should not wait the full request timeout on a server that is down.
const AUDIOBOOKSHELF_LIVE_CHECK_TIMEOUT_MS = 4_000;

type SyncTargetState = AudiobookshelfBookStateRow & { bookId: number };

interface SyncTarget {
  settings: AudiobookshelfUserSetting;
  state: SyncTargetState;
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
    const target = await this.findSyncTarget(user, async (settings) => {
      await this.bookService.verifyBookAccess(bookId, user);
      const direct = await this.repo.findBookStateByBookId(user.id, bookId);
      if (direct && this.isSyncEligible(settings, direct)) return direct;
      const link = await this.editionLinks.findLinkForBook(bookId);
      if (!link || link.audioBookId === bookId) return undefined;
      return this.repo.findBookStateByBookId(user.id, link.audioBookId);
    });
    if (!target) return null;

    const { settings, state } = target;
    const normalizedServer = parseAndNormalizeServerUrl(settings.serverUrl);
    return {
      audioBookId: state.bookId,
      absLibraryItemId: state.absLibraryItemId,
      title: state.absTitle,
      authorName: state.absAuthorName,
      libraryName: state.absLibraryName,
      direction: settings.syncPosition && settings.pushPosition ? 'two_way' : settings.syncPosition ? 'from_abs' : 'to_abs',
      webUrl: normalizedServer ? `${normalizedServer}/item/${encodeURIComponent(state.absLibraryItemId)}` : null,
    };
  }

  /** Audiobookshelf's own progress for a matched item and whether anything is waiting to sync. */
  async getLiveSyncStatus(user: RequestUser, absLibraryItemId: string): Promise<AudiobookshelfBookSyncLive> {
    const { settings, state } = await this.findItemSyncTarget(user, absLibraryItemId);

    let remote: AbsMediaProgress | null = null;
    let reachable = true;
    try {
      remote = await this.client.getMediaProgress(
        user.id,
        settings.serverUrl,
        settings.apiToken,
        absLibraryItemId,
        AUDIOBOOKSHELF_LIVE_CHECK_TIMEOUT_MS,
      );
    } catch (error) {
      if (!(error instanceof AudiobookshelfApiError)) throw error;
      reachable = false;
    }

    return {
      status: reachable ? await this.syncLinkStatus(user.id, settings, state, remote) : 'unreachable',
      progress: remote
        ? { percentage: Math.max(0, Math.min(100, remote.progress * 100)), isFinished: remote.isFinished, lastUpdate: remote.lastUpdate }
        : null,
    };
  }

  private async syncLinkStatus(
    userId: number,
    settings: AudiobookshelfUserSetting,
    state: SyncTargetState,
    remote: AbsMediaProgress | null,
  ): Promise<AudiobookshelfSyncLinkStatus> {
    const watermark = state.lastSyncedPositionAbsUpdate ?? 0;
    const absMovedSinceSync = remote !== null && remote.lastUpdate > watermark;

    if (settings.pushPosition && state.pushPendingAt) {
      // Mirrors the push decision: nothing new locally means nothing to send, and when both sides
      // moved the newer timestamp wins, so an ABS position newer than ours will be pulled instead.
      const local = await this.repo.findAudioProgress(userId, state.bookId);
      const localUnchanged = !local || (state.lastSyncedProgressAt !== null && local.updatedAt.getTime() === state.lastSyncedProgressAt.getTime());
      const absWins = absMovedSinceSync && local !== undefined && remote.lastUpdate > local.capturedAt.getTime();
      if (!localUnchanged && !absWins) return 'sending';
    }

    if (!settings.syncPosition || !absMovedSinceSync) return 'synced';
    // The pull leaves the watermark behind for positions it refuses for good (no audio files, a
    // duration mismatch, an unresolvable position), so a lagging watermark alone would read as
    // receiving forever. Every pull attempt stamps the row (lastSyncedAt, or updatedAt with
    // syncError on a throw); once an attempt has run since ABS changed, the lag is not closing.
    const lastAttemptAt = state.syncError ? state.updatedAt : state.lastSyncedAt;
    return lastAttemptAt && lastAttemptAt.getTime() >= remote.lastUpdate ? 'synced' : 'receiving';
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
