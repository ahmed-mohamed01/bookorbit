import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import {
  BookConsolidationParticipants,
  type BookConsolidationParticipant,
  type ConsolidationTx,
} from '../book-consolidation/book-consolidation-participants';
import { audiobookshelfBookState } from './schema/audiobookshelf.schema';

@Injectable()
export class AudiobookshelfBookConsolidationParticipant implements BookConsolidationParticipant, OnModuleInit {
  readonly name = 'audiobookshelf';

  constructor(private readonly participants: BookConsolidationParticipants) {}

  onModuleInit(): void {
    this.participants.register(this);
  }

  /** Every row moves: a row is keyed by its ABS item, and two items may link to one book. */
  async moveBookRows(tx: ConsolidationTx, keptBookId: number, sourceBookId: number): Promise<void> {
    await tx.update(audiobookshelfBookState).set({ bookId: keptBookId }).where(eq(audiobookshelfBookState.bookId, sourceBookId));
  }
}
