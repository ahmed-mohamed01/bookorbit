import type { ReadAlongNarrationMismatch, ReadAlongOffsetsSource } from '@bookorbit/types';
import { index, integer, jsonb, pgTable, serial, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { bookFiles, books } from '../../../db/schema/books';
import type { AudioSignatureEntry, NarrationFileOffset, NarrationSignatureEntry, ReadAlongOffsetsStatus } from '../../book/read-along-offsets-store';

export const readAlongNarrationOffsets = pgTable(
  'read_along_narration_offsets',
  {
    id: serial('id').primaryKey(),
    readAlongFileId: integer('read_along_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    audioBookId: integer('audio_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    narrationSignature: jsonb('narration_signature').$type<NarrationSignatureEntry[]>().notNull(),
    audioSignature: jsonb('audio_signature').$type<AudioSignatureEntry[]>().notNull(),
    status: varchar('status', { length: 20 }).$type<ReadAlongOffsetsStatus>().notNull(),
    source: varchar('source', { length: 20 }).$type<ReadAlongOffsetsSource>().notNull(),
    offsets: jsonb('offsets').$type<NarrationFileOffset[]>(),
    mismatch: jsonb('mismatch').$type<ReadAlongNarrationMismatch>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('read_along_narration_offsets_file_audio_unique').on(table.readAlongFileId, table.audioBookId),
    index('read_along_narration_offsets_audio_book_id_idx').on(table.audioBookId),
  ],
);
