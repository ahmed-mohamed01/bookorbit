import { pgTable, integer, text, jsonb, timestamp, serial, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { books } from '../../../db/schema';
import type { BookKnowledgeCard, BookKnowledgeChecks } from '@bookorbit/types';
export const knowledgeIndex = pgTable(
  'book_knowledge_index',
  {
    bookId: integer('book_id')
      .primaryKey()
      .references(() => books.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    textVersion: integer('text_version').notNull(),
    termsVersion: integer('terms_version').notNull(),
    status: text('status').$type<'queued' | 'running' | 'ready' | 'failed'>().notNull(),
    progress: integer('progress').notNull().default(0),
    error: text('error'),
    stageMs: jsonb('stage_ms'),
    sentenceCount: integer('sentence_count'),
    termCount: integer('term_count'),
    artifactBytes: integer('artifact_bytes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('book_knowledge_index_book_idx').on(t.bookId), index('book_knowledge_index_status_idx').on(t.status, t.bookId)],
);
export const knowledgeCards = pgTable(
  'book_knowledge_cards',
  {
    id: serial('id').primaryKey(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    termKey: text('term_key').notNull(),
    cutoffOrdinal: integer('cutoff_ordinal').notNull(),
    model: text('model').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    card: jsonb('card').$type<BookKnowledgeCard>().notNull(),
    checks: jsonb('checks').$type<BookKnowledgeChecks>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('book_knowledge_cards_cache_idx').on(t.bookId, t.fingerprint, t.termKey, t.cutoffOrdinal, t.model, t.promptVersion, t.evidenceHash),
  ],
);
export const knowledgeKindReviews = pgTable(
  'book_knowledge_kind_reviews',
  {
    id: serial('id').primaryKey(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    requestHash: text('request_hash').notNull(),
    answers: jsonb('answers').$type<Record<string, string>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('book_knowledge_kind_reviews_cache_idx').on(t.bookId, t.fingerprint, t.requestHash)],
);
