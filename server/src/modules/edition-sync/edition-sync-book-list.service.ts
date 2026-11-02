import { Injectable, Logger } from '@nestjs/common';
import { EDITION_SYNC_BOOK_LIST_PAGE_SIZE, type EditionSyncBookListQuery, type EditionSyncBookListResponse } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { BookCoverStore } from '../book-cover-store/book-cover-store.service';
import { EditionSyncSettingsService } from './edition-sync-settings.service';
import { EditionSyncRepository } from './edition-sync.repository';

const SLOW_LIST_BOOKS_MS = 1_000;

@Injectable()
export class EditionSyncBookListService {
  private readonly logger = new Logger(EditionSyncBookListService.name);

  constructor(
    private readonly repo: EditionSyncRepository,
    private readonly settings: EditionSyncSettingsService,
    private readonly coverStore: BookCoverStore,
  ) {}

  async list(user: RequestUser, query: EditionSyncBookListQuery): Promise<EditionSyncBookListResponse> {
    const settings = await this.settings.getSettings(user);
    const page = query.page ?? 1;
    const filter = query.filter ?? 'all';
    const empty = { all: 0, problems: 0, queued: 0, synced: 0, off: 0 };
    if (settings.disabledReason === 'server_disabled') {
      return { items: [], counts: empty, total: 0, page, pageSize: EDITION_SYNC_BOOK_LIST_PAGE_SIZE, disabledReason: settings.disabledReason };
    }
    const startedAt = Date.now();
    const result = await this.repo.listBooks(user, settings, filter, query.q, page);
    const faces = await this.coverStore.facesFor(result.items.map((row) => row.bookId));
    const items = result.items.map((row) => ({
      ...row,
      indexedAt: row.indexedAt === null ? null : new Date(row.indexedAt).toISOString(),
      coverVersion: faces.get(row.bookId)?.coverVersion ?? null,
      canRunNow: row.status === 'queued' || row.status === 'stale',
      canRetry: row.status === 'failed',
    }));
    const counts = result.counts ?? empty;
    const durationMs = Date.now() - startedAt;
    if (durationMs > SLOW_LIST_BOOKS_MS) {
      this.logger.warn(
        `[edition_sync.list_books] [end] userId=${user.id} filter=${filter} page=${page} durationMs=${durationMs} total=${counts[filter]} - slow book list`,
      );
    }
    return { items, counts, total: counts[filter], page, pageSize: EDITION_SYNC_BOOK_LIST_PAGE_SIZE, disabledReason: settings.disabledReason };
  }
}
