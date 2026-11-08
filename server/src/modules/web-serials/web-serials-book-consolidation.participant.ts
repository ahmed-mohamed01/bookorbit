import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import {
  BookConsolidationParticipants,
  type BookConsolidationParticipant,
  type ConsolidationTx,
} from '../book-consolidation/book-consolidation-participants';
import { webSerialImports, webSerialJobItems } from './schema/web-serials.schema';

@Injectable()
export class WebSerialsBookConsolidationParticipant implements BookConsolidationParticipant, OnModuleInit {
  readonly name = 'web-serials';

  constructor(private readonly participants: BookConsolidationParticipants) {}

  onModuleInit(): void {
    this.participants.register(this);
  }

  /** Neither table's unique key holds the book, so no row can collide. An item's timestamp stays the job's own history. */
  async moveBookRows(tx: ConsolidationTx, keptBookId: number, sourceBookId: number): Promise<void> {
    await tx.update(webSerialImports).set({ bookId: keptBookId }).where(eq(webSerialImports.bookId, sourceBookId));
    await tx
      .update(webSerialJobItems)
      .set({ bookId: keptBookId, updatedAt: sql`${webSerialJobItems.updatedAt}` })
      .where(eq(webSerialJobItems.bookId, sourceBookId));
  }
}
