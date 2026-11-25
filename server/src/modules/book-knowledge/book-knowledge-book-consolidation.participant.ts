import { Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  BookConsolidationParticipants,
  type BookConsolidationParticipant,
  type ConsolidationTx,
} from '../book-consolidation/book-consolidation-participants';
@Injectable()
export class BookKnowledgeBookConsolidationParticipant implements BookConsolidationParticipant, OnModuleInit {
  readonly name = 'book-knowledge';
  constructor(private readonly participants: BookConsolidationParticipants) {}
  onModuleInit() {
    this.participants.register(this);
  }
  async moveBookRows(tx: ConsolidationTx, _keptBookId: number, sourceBookId: number) {
    await tx.execute(sql`DELETE FROM book_knowledge_cards WHERE book_id = ${sourceBookId}`);
    await tx.execute(sql`DELETE FROM book_knowledge_kind_reviews WHERE book_id = ${sourceBookId}`);
    await tx.execute(sql`DELETE FROM book_knowledge_index WHERE book_id = ${sourceBookId}`);
  }
}
