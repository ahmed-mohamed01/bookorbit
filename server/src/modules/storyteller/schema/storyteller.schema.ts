import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, real, serial, text, timestamp, unique, varchar } from 'drizzle-orm/pg-core';

import type { StorytellerConnectionTestResult, StorytellerPathMapping } from '@bookorbit/types';
import { books } from '../../../db/schema/books';
import { users } from '../../../db/schema/auth';
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

/** What a queued build is started with once a slot frees. */
export interface StorytellerQueuedRequest {
  force?: boolean;
  targetLibraryId?: number;
  targetFolderId?: number;
  cleanUpRemote?: boolean;
  useExistingUuid?: string;
  /** The row's status before it was queued, so a cancel can put a ready build back. */
  previousStatus?: string | null;
}

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
    targetFolderId: integer('target_folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    outputBookId: integer('output_book_id').references(() => books.id, { onDelete: 'set null' }),
    // The link this row's read-along was last attached to. Unlinking deletes that link and nulls this,
    // which is how a status read tells a relink that lost the read-along from a deliberate detach. The
    // foreign key to book_edition_links lives in the bootstrap SQL only: that table belongs to the
    // edition-link module, whose schema this module does not import.
    attachedLinkId: integer('attached_link_id'),
    storytellerBookUuid: varchar('storyteller_book_uuid', { length: 64 }),
    transport: varchar('transport', { length: 20 }),
    status: varchar('status', { length: 20 }).notNull().default('building'),
    phase: varchar('phase', { length: 20 }),
    remoteTask: varchar('remote_task', { length: 255 }),
    remoteProgress: real('remote_progress'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    builtAt: timestamp('built_at', { withTimezone: true }),
    // Who asked for the current attempt (kept for its whole life), when it was queued (its origin while
    // it runs), and the request that starts it (only while queued).
    requestedBy: integer('requested_by').references(() => users.id, { onDelete: 'set null' }),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    queuedRequest: jsonb('queued_request').$type<StorytellerQueuedRequest>(),
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
    index('storyteller_read_along_builds_queued_at_idx')
      .on(t.queuedAt)
      .where(sql`${t.status} = 'queued'`),
    check('storyteller_read_along_builds_status_chk', sql`${t.status} in ('queued', 'building', 'ready', 'failed', 'cancelled')`),
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
