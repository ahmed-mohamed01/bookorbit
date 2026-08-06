import { index, integer, pgTable, real, serial, text, timestamp, unique, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { bookFiles, books } from '../../../db/schema/books';

export const audiobookAlignment = pgTable(
  'audiobook_alignment',
  {
    id: serial('id').primaryKey(),
    textBookId: integer('text_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    audioBookId: integer('audio_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    ebookFileId: integer('ebook_file_id').references(() => bookFiles.id, { onDelete: 'set null' }),
    audioContentHash: varchar('audio_content_hash', { length: 128 }),
    epubContentHash: varchar('epub_content_hash', { length: 128 }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    sampleIntervalSec: integer('sample_interval_sec'),
    clipSeconds: integer('clip_seconds'),
    whisperModel: varchar('whisper_model', { length: 100 }),
    anchorCount: integer('anchor_count').notNull().default(0),
    samplesDone: integer('samples_done').notNull().default(0),
    samplesTotal: integer('samples_total'),
    error: text('error'),
    builtAt: timestamp('built_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [unique('audiobook_alignment_text_book_id_audio_book_id_unique').on(t.textBookId, t.audioBookId)],
);

export const audiobookAlignmentAnchor = pgTable(
  'audiobook_alignment_anchor',
  {
    id: serial('id').primaryKey(),
    alignmentId: integer('alignment_id')
      .notNull()
      .references(() => audiobookAlignment.id, { onDelete: 'cascade' }),
    audioSeconds: real('audio_seconds').notNull(),
    spineIndex: integer('spine_index').notNull(),
    phrase: text('phrase').notNull(),
    confidence: real('confidence'),
    ebookFraction: real('ebook_fraction'),
  },
  (t) => [
    index('audiobook_alignment_anchor_alignment_id_idx').on(t.alignmentId),
    // A build checkpoints progress and inserts anchors in separate statements, so a crash can leave an
    // anchor persisted without its checkpoint. On resume that sample is re-processed; this uniqueness
    // makes the re-insert a no-op (see insertAnchor's onConflictDoNothing) instead of a duplicate.
    uniqueIndex('audiobook_alignment_anchor_alignment_id_audio_seconds_unique').on(t.alignmentId, t.audioSeconds),
  ],
);

export type AudiobookAlignment = typeof audiobookAlignment.$inferSelect;
export type NewAudiobookAlignment = typeof audiobookAlignment.$inferInsert;
export type AudiobookAlignmentAnchor = typeof audiobookAlignmentAnchor.$inferSelect;
export type NewAudiobookAlignmentAnchor = typeof audiobookAlignmentAnchor.$inferInsert;
