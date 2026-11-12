import { ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import {
  BookConsolidationParticipants,
  type BookConsolidationParticipant,
  type ConsolidationTx,
} from '../book-consolidation/book-consolidation-participants';

@Injectable()
export class AudioConvertBookConsolidationParticipant implements BookConsolidationParticipant, OnModuleInit {
  readonly name = 'audio-convert';

  constructor(private readonly participants: BookConsolidationParticipants) {}

  onModuleInit(): void {
    this.participants.register(this);
  }

  /**
   * A conversion that is swapping files must finish first, so a running job blocks the merge. Jobs that
   * have not started are cancelled; finished jobs follow the book so their backups stay listed.
   */
  async moveBookRows(tx: ConsolidationTx, keptBookId: number, sourceBookId: number): Promise<void> {
    const running = await tx.execute(
      sql`select 1 from audio_convert_jobs where book_id in (${keptBookId}, ${sourceBookId}) and status = 'running' limit 1`,
    );
    if ((running as unknown as { rows: unknown[] }).rows.length > 0) {
      throw new ConflictException('A conversion to M4B is running for this book');
    }
    await tx.execute(sql`
      update audio_convert_jobs set status = 'cancelled', stage = null, finished_at = now(), updated_at = now()
      where book_id = ${sourceBookId} and status in ('waiting', 'queued')
    `);
    await tx.execute(sql`update audio_convert_jobs set book_id = ${keptBookId} where book_id = ${sourceBookId}`);
    await tx.execute(sql`
      insert into audio_convert_watch (book_id, last_seen_at)
      select ${keptBookId}, last_seen_at from audio_convert_watch where book_id = ${sourceBookId}
      on conflict (book_id) do nothing
    `);
  }
}
