import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, real, serial, text, timestamp, unique, varchar } from 'drizzle-orm/pg-core';

import type { StorytellerConnectionTestResult, StorytellerPathMapping } from '@bookorbit/types';
import { books } from '../../../db/schema/books';
import { libraries, libraryFolders } from '../../../db/schema/libraries';

// Single-row table (id is always 1): one Storyteller connection serves every BookOrbit user.
export const storytellerSettings = pgTable(
  'storyteller_settings',
  {
    id: integer('id').primaryKey().default(1),
    serverUrl: varchar('server_url', { length: 2048 }),
    username: varchar('username', { length: 255 }),
    passwordEnc: text('password_enc'),
    pathMappings: jsonb('path_mappings').$type<StorytellerPathMapping[]>().notNull().default([]),
    targetLibraryId: integer('target_library_id').references(() => libraries.id, { onDelete: 'set null' }),
    targetFolderId: integer('target_folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    transport: varchar('transport', { length: 20 }).notNull().default('auto'),
    deleteRemoteAfterImport: boolean('delete_remote_after_import').notNull().default(true),
    collectionName: varchar('collection_name', { length: 255 }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastCheckResult: jsonb('last_check_result').$type<StorytellerConnectionTestResult>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    check('storyteller_settings_singleton_chk', sql`${t.id} = 1`),
    check('storyteller_settings_transport_chk', sql`${t.transport} in ('auto', 'shared-paths', 'api-transfer')`),
  ],
);

// Constraint names below are short (`<table>_<column>_fk` rather than repeating the referenced
// table and column) to stay under Postgres's 63-byte identifier limit; see schema/storyteller-schema.ts.
export const storytellerReadAlongBuilds = pgTable(
  'storyteller_read_along_builds',
  {
    id: serial('id').primaryKey(),
    textBookId: integer('text_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    audioBookId: integer('audio_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    targetLibraryId: integer('target_library_id').references(() => libraries.id, { onDelete: 'set null' }),
    outputBookId: integer('output_book_id').references(() => books.id, { onDelete: 'set null' }),
    storytellerBookUuid: varchar('storyteller_book_uuid', { length: 64 }),
    transport: varchar('transport', { length: 20 }),
    status: varchar('status', { length: 20 }).notNull().default('building'),
    phase: varchar('phase', { length: 20 }),
    remoteTask: varchar('remote_task', { length: 255 }),
    remoteProgress: real('remote_progress'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    builtAt: timestamp('built_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('storyteller_read_along_builds_pair_unique').on(t.textBookId, t.audioBookId),
    index('storyteller_read_along_builds_output_book_id_idx').on(t.outputBookId),
    index('storyteller_read_along_builds_uuid_idx').on(t.storytellerBookUuid),
    check('storyteller_read_along_builds_status_chk', sql`${t.status} in ('building', 'ready', 'failed')`),
    check(
      'storyteller_read_along_builds_phase_chk',
      sql`${t.phase} is null or ${t.phase} in ('prepare', 'register', 'process', 'wait', 'collect', 'link')`,
    ),
    check('storyteller_read_along_builds_transport_chk', sql`${t.transport} is null or ${t.transport} in ('shared-paths', 'api-transfer')`),
    check(
      'storyteller_read_along_builds_remote_progress_chk',
      sql`${t.remoteProgress} is null or (${t.remoteProgress} >= 0 and ${t.remoteProgress} <= 1)`,
    ),
  ],
);

export type StorytellerSettingsRow = typeof storytellerSettings.$inferSelect;
export type NewStorytellerSettingsRow = typeof storytellerSettings.$inferInsert;
export type StorytellerReadAlongBuild = typeof storytellerReadAlongBuilds.$inferSelect;
export type NewStorytellerReadAlongBuild = typeof storytellerReadAlongBuilds.$inferInsert;
