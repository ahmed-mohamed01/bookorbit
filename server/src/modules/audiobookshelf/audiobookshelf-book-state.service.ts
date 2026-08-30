import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AudiobookshelfBookState, AudiobookshelfBookStatePage, AudiobookshelfMatchMethod } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { AudiobookshelfRepository, type AbsBookAccessScope, type AbsBookStateView } from './audiobookshelf.repository';
import { buildBookAccessScope } from './audiobookshelf-user.utils';
import type { ListAudiobookshelfBookStatesDto } from './dto';

@Injectable()
export class AudiobookshelfBookStateService {
  private readonly logger = new Logger(AudiobookshelfBookStateService.name);

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly bookService: BookService,
    private readonly libraryService: LibraryService,
  ) {}

  async list(user: RequestUser, dto: ListAudiobookshelfBookStatesDto): Promise<AudiobookshelfBookStatePage> {
    const page = dto.page ?? 0;
    const pageSize = dto.pageSize ?? 20;
    const scope = await buildBookAccessScope(user, this.libraryService);
    const { items, total } = await this.repo.listBookStates(user.id, scope, dto.bucket, page, pageSize, dto.q);
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
