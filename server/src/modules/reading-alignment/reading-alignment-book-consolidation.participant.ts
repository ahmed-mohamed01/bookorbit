import { Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import {
  BookConsolidationParticipants,
  type BookConsolidationParticipant,
  type ConsolidationTx,
} from '../book-consolidation/book-consolidation-participants';

@Injectable()
export class ReadingAlignmentBookConsolidationParticipant implements BookConsolidationParticipant, OnModuleInit {
  readonly name = 'reading-alignment';

  constructor(private readonly participants: BookConsolidationParticipants) {}

  onModuleInit(): void {
    this.participants.register(this);
  }

  /**
   * Stored content hashes are checked on every read, so a moved row over changed files reads as stale.
   * Several source rows can land on one pair, such as (s, s) and (s, k): one moves, a ready build first,
   * because a second row on the pair would break the unique key. Rows left behind cascade with the book.
   */
  async moveBookRows(tx: ConsolidationTx, keptBookId: number, sourceBookId: number): Promise<void> {
    const k = keptBookId;
    const s = sourceBookId;
    await tx.execute(sql`
      update audiobook_alignment a set
        text_book_id = case when a.text_book_id = ${s} then ${k}::int else a.text_book_id end,
        audio_book_id = case when a.audio_book_id = ${s} then ${k}::int else a.audio_book_id end,
        updated_at = now()
      where a.id in (
        select distinct on (c.new_text, c.new_audio) c.id
        from (
          select id, status, built_at,
            case when text_book_id = ${s} then ${k}::int else text_book_id end as new_text,
            case when audio_book_id = ${s} then ${k}::int else audio_book_id end as new_audio
          from audiobook_alignment
          where text_book_id = ${s} or audio_book_id = ${s}
        ) c
        where not exists (
          select 1 from audiobook_alignment kept where kept.text_book_id = c.new_text and kept.audio_book_id = c.new_audio
        )
        order by c.new_text, c.new_audio, (c.status = 'ready') desc, c.built_at desc nulls last, c.id
      )
    `);
  }
}
