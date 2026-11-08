import { Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import {
  BookConsolidationParticipants,
  type BookConsolidationParticipant,
  type ConsolidationTx,
} from '../book-consolidation/book-consolidation-participants';

@Injectable()
export class EditionSyncBookConsolidationParticipant implements BookConsolidationParticipant, OnModuleInit {
  readonly name = 'edition-sync';

  constructor(private readonly participants: BookConsolidationParticipants) {}

  onModuleInit(): void {
    this.participants.register(this);
  }

  async moveBookRows(tx: ConsolidationTx, keptBookId: number, sourceBookId: number): Promise<void> {
    await this.moveOverrides(tx, keptBookId, sourceBookId);
    await this.moveIndexRow(tx, keptBookId, sourceBookId);
  }

  private async moveOverrides(tx: ConsolidationTx, k: number, s: number): Promise<void> {
    await tx.execute(sql`
      update edition_sync_book_overrides o set book_id = ${k}
      where o.book_id = ${s}
        and not exists (select 1 from edition_sync_book_overrides kept where kept.user_id = o.user_id and kept.book_id = ${k})
    `);
  }

  /**
   * The index and its provenance both name the source book, so it can never validate on the kept
   * book: the row moves as stale, which queues a rebuild, in the form the book_files trigger writes.
   */
  private async moveIndexRow(tx: ConsolidationTx, k: number, s: number): Promise<void> {
    await tx.execute(sql`
      update edition_sync_book_index set
        book_id = ${k},
        status = 'stale',
        stage = null,
        progress = null,
        files_changed_at = now(),
        invalidated_at = now(),
        invalidated_reason = 'files_changed',
        attempt_count = 0,
        retry_requested = false,
        updated_at = now()
      where book_id = ${s}
        and not exists (select 1 from edition_sync_book_index kept where kept.book_id = ${k})
    `);
  }
}
