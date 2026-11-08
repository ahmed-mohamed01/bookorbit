import { Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import {
  BookConsolidationParticipants,
  type BookConsolidationParticipant,
  type ConsolidationTx,
} from '../book-consolidation/book-consolidation-participants';

const formatMatchColumn = sql`case when o.format = 'audiobook' then w.matched_audio_book_id else w.matched_ebook_book_id end`;

/**
 * Mirrors matchIdentityKeys. A title key is a hash SQL cannot rebuild, so that fallback relies on
 * work_id, which writeMatchOverride records on the rows of the work the answer was given on.
 */
const overrideAppliesToWork = sql`(
  o.work_id = w.id
  or exists (
    select 1 from author_catalog_source_works sw
    where sw.work_id = w.id and sw.source || ':' || sw.provider_work_id = o.identity_key
  )
)`;

@Injectable()
export class MonitoredBookConsolidationParticipant implements BookConsolidationParticipant, OnModuleInit {
  readonly name = 'monitored';

  constructor(private readonly participants: BookConsolidationParticipants) {}

  onModuleInit(): void {
    this.participants.register(this);
  }

  async moveBookRows(tx: ConsolidationTx, keptBookId: number, sourceBookId: number): Promise<void> {
    await this.dropKeptRejectionsOfSourceMatches(tx, keptBookId, sourceBookId);
    await this.repointWorks(tx, keptBookId, sourceBookId);
    await this.dropAnsweredPossibles(tx, keptBookId);
    await this.moveMatchOverrides(tx, keptBookId, sourceBookId);
  }

  /**
   * A rejection of the kept book must not survive on a work the source book owns. The merge says the
   * two are one book, and the rejection would otherwise unmatch that work at the next refresh.
   */
  private async dropKeptRejectionsOfSourceMatches(tx: ConsolidationTx, k: number, s: number): Promise<void> {
    await tx.execute(sql`
      delete from monitored_match_overrides o
      where o.book_id = ${k}
        and o.decision = 'reject'
        and exists (
          select 1 from author_catalog_works w
          where w.monitor_author_id = o.monitor_author_id
            and ${formatMatchColumn} = ${s}
            and ${overrideAppliesToWork}
        )
    `);
  }

  /** The foreign keys would null these, and a work with no match reads as unowned and can be grabbed again. */
  private async repointWorks(tx: ConsolidationTx, k: number, s: number): Promise<void> {
    await tx.execute(sql`
      update author_catalog_works set
        matched_book_id = case when matched_book_id = ${s} then ${k}::int else matched_book_id end,
        matched_ebook_book_id = case when matched_ebook_book_id = ${s} then ${k}::int else matched_ebook_book_id end,
        matched_audio_book_id = case when matched_audio_book_id = ${s} then ${k}::int else matched_audio_book_id end,
        possible_ebook_book_id = case when possible_ebook_book_id = ${s} then ${k}::int else possible_ebook_book_id end,
        possible_audio_book_id = case when possible_audio_book_id = ${s} then ${k}::int else possible_audio_book_id end
      where matched_book_id = ${s}
        or matched_ebook_book_id = ${s}
        or matched_audio_book_id = ${s}
        or possible_ebook_book_id = ${s}
        or possible_audio_book_id = ${s}
    `);
  }

  private async dropAnsweredPossibles(tx: ConsolidationTx, k: number): Promise<void> {
    await tx.execute(
      sql`update author_catalog_works set possible_ebook_book_id = null where possible_ebook_book_id = ${k} and matched_ebook_book_id = ${k}`,
    );
    await tx.execute(
      sql`update author_catalog_works set possible_audio_book_id = null where possible_audio_book_id = ${k} and matched_audio_book_id = ${k}`,
    );
  }

  /**
   * Runs after the works are repointed. A rejection stays behind when its work now matches the kept
   * book: moved, it would take that match away at the next refresh and leave the work unowned.
   */
  private async moveMatchOverrides(tx: ConsolidationTx, k: number, s: number): Promise<void> {
    await tx.execute(sql`
      update monitored_match_overrides o set book_id = ${k}
      where o.book_id = ${s}
        and not exists (
          select 1 from monitored_match_overrides kept
          where kept.monitor_author_id = o.monitor_author_id
            and kept.format = o.format
            and kept.identity_key = o.identity_key
            and kept.book_id = ${k}
        )
        and not (
          o.decision = 'reject' and exists (
            select 1 from author_catalog_works w
            where w.monitor_author_id = o.monitor_author_id
              and ${formatMatchColumn} = ${k}
              and ${overrideAppliesToWork}
          )
        )
    `);
  }
}
