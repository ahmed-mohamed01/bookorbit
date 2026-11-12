import type {
  AudioConvertErrorCode,
  AudioConvertJobResult,
  AudioConvertJobStage,
  AudioConvertJobStatus,
  AudioConvertJobTrigger,
  AudioConvertResolvedCodec,
} from '@bookorbit/types';
import { boolean, integer, jsonb, pgTable, smallint, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Module-local table declarations for the fork tables created by AUDIO_CONVERT_SCHEMA_SQL. They are not
// in the db/schema barrel, so drizzle-kit never sees them. Constraints and indexes live in the bootstrap SQL.

export const audioConvertSettings = pgTable('audio_convert_settings', {
  id: smallint('id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  autoConvert: boolean('auto_convert').notNull().default(false),
  codec: varchar('codec', { length: 10 }).$type<'auto' | 'copy' | 'aac'>().notNull().default('auto'),
  bitrate: varchar('bitrate', { length: 10 }).notNull().default('128k'),
  channels: smallint('channels'),
  embedChapters: boolean('embed_chapters').notNull().default(true),
  embedMetadata: boolean('embed_metadata').notNull().default(true),
  backupDays: integer('backup_days').notNull().default(14),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  updatedByUserId: integer('updated_by_user_id'),
});

/**
 * What a job has done on disk, written before each step so a restart can finish or undo it.
 * `phase` is `swapping` from just before the rename until the commit, and `committed` is written in the
 * same transaction that points the book at the new file.
 */
export interface AudioConvertWorkPaths {
  workDir?: string;
  tempOutput?: string;
  backupPath?: string;
  /** Original absolute path -> its copy inside `backupPath`. */
  backupFiles?: Record<string, string>;
  phase?: 'swapping' | 'committed';
  finalPath?: string;
  /** `computeFileHash` of the converted file, so recovery only ever removes our own output. */
  newHash?: string;
  originals?: string[];
  result?: Partial<AudioConvertJobResult>;
}

export const audioConvertJobs = pgTable('audio_convert_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookId: integer('book_id').notNull(),
  libraryId: integer('library_id').notNull(),
  userId: integer('user_id'),
  trigger: varchar('trigger', { length: 10 }).$type<AudioConvertJobTrigger>().notNull(),
  status: varchar('status', { length: 10 }).$type<AudioConvertJobStatus>().notNull(),
  stage: varchar('stage', { length: 12 }).$type<AudioConvertJobStage>(),
  progress: smallint('progress'),
  codec: varchar('codec', { length: 10 }).$type<'auto' | 'copy' | 'aac'>().notNull().default('auto'),
  bitrate: varchar('bitrate', { length: 10 }).notNull().default('128k'),
  channels: smallint('channels'),
  codecUsed: varchar('codec_used', { length: 10 }).$type<AudioConvertResolvedCodec>(),
  attempts: integer('attempts').notNull().default(0),
  nextStepAt: timestamp('next_step_at', { withTimezone: true }),
  stageStartedAt: timestamp('stage_started_at', { withTimezone: true }),
  errorCode: varchar('error_code', { length: 40 }).$type<AudioConvertErrorCode>(),
  errorMessage: varchar('error_message', { length: 2000 }),
  result: jsonb('result').$type<Partial<AudioConvertJobResult>>(),
  workPaths: jsonb('work_paths').$type<AudioConvertWorkPaths>(),
  backupPath: text('backup_path'),
  backupDeletedAt: timestamp('backup_deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
});

export type AudioConvertJobRow = typeof audioConvertJobs.$inferSelect;
export type AudioConvertSettingsRow = typeof audioConvertSettings.$inferSelect;

export const audioConvertWatch = pgTable('audio_convert_watch', {
  bookId: integer('book_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});
