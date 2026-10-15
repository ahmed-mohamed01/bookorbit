import { describe, expect, it } from 'vitest';

import { splitSchemaStatements } from '../../../common/utils/schema-bootstrap.utils';
import {
  webSerialImports,
  webSerialNovelIndex,
  webSerialNovelIndexSources,
  webSerialNovelPrefs,
  webSerialJobItems,
  webSerialJobs,
  webSerialSettings,
  webSerialVolumeRequests,
} from './web-serials.schema';
import { WEB_SERIALS_SCHEMA_SQL, WEB_SERIALS_TABLE_NAMES } from './web-serials-schema';

const statements = splitSchemaStatements(WEB_SERIALS_SCHEMA_SQL);

describe('web serials schema SQL', () => {
  it('creates every table', () => {
    for (const table of WEB_SERIALS_TABLE_NAMES) {
      expect(statements.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS "${table}"`))).toBe(true);
    }
  });

  const inlineConstraints = [
    'web_serial_settings_singleton_chk',
    'web_serial_settings_packaging_chk',
    'web_serial_settings_concurrency_chk',
    'web_serial_jobs_kind_chk',
    'web_serial_jobs_packaging_chk',
    'web_serial_jobs_status_chk',
    'web_serial_job_items_job_unit_unique',
    'web_serial_job_items_status_chk',
    'web_serial_novel_index_source_path_unique',
    'web_serial_novel_index_sources_state_chk',
    'web_serial_volume_requests_kind_chk',
    'web_serial_volume_requests_unique',
  ];

  it.each(inlineConstraints)('declares %s inline for a fresh database', (name) => {
    const createTable = statements.find((s) => s.startsWith('CREATE TABLE') && s.includes(`CONSTRAINT "${name}"`));
    expect(createTable).toBeDefined();
  });

  const allConstraints = [
    ...inlineConstraints,
    'web_serial_settings_manga_library_fk',
    'web_serial_settings_manga_folder_fk',
    'web_serial_settings_novel_library_fk',
    'web_serial_settings_novel_folder_fk',
    'web_serial_jobs_user_id_fk',
    'web_serial_jobs_library_fk',
    'web_serial_jobs_folder_fk',
    'web_serial_job_items_job_id_fk',
    'web_serial_job_items_book_id_fk',
    'web_serial_novel_prefs_user_id_fk',
    'web_serial_volume_requests_kind_chk',
    'web_serial_volume_requests_unique',
    'web_serial_volume_requests_user_id_fk',
  ];

  it.each(allConstraints)('adds %s through a guarded ALTER for an already-installed database', (name) => {
    const alter = statements.find((s) => s.startsWith('DO $$') && s.includes(`ADD CONSTRAINT "${name}"`));
    expect(alter).toBeDefined();
    expect(alter).toContain('pg_constraint');
    expect(alter).toContain('conrelid = to_regclass(');
    expect(alter).toContain(`conname = '${name}'`);
  });

  it('adds the current_unit column idempotently', () => {
    expect(statements).toContain('ALTER TABLE "web_serial_jobs" ADD COLUMN IF NOT EXISTS "current_unit" jsonb;');
    expect(statements.find((s) => s.startsWith('CREATE TABLE') && s.includes('"web_serial_jobs"'))).toContain('"current_unit" jsonb,');
    expect(webSerialJobs.currentUnit.name).toBe('current_unit');
  });

  it('keeps every identifier within the Postgres 63 byte limit', () => {
    for (const name of [...allConstraints, ...[...WEB_SERIALS_SCHEMA_SQL.matchAll(/INDEX IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1]!)]) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    }
  });

  it('creates the user-scoped, active-status and book indexes', () => {
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ON "web_serial_jobs" ("user_id", "created_at" DESC)');
    expect(WEB_SERIALS_SCHEMA_SQL).toMatch(/ON "web_serial_jobs" \("status"\) WHERE "status" in \('queued', 'running', 'importing'\)/);
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ON "web_serial_job_items" ("book_id")');
  });

  it('cascades a user and a job but only nulls a deleted book', () => {
    expect(WEB_SERIALS_SCHEMA_SQL).toMatch(/"web_serial_jobs_user_id_fk" FOREIGN KEY \("user_id"\)[^;]*ON DELETE cascade/);
    expect(WEB_SERIALS_SCHEMA_SQL).toMatch(/"web_serial_job_items_job_id_fk" FOREIGN KEY \("job_id"\)[^;]*ON DELETE cascade/);
    expect(WEB_SERIALS_SCHEMA_SQL).toMatch(/"web_serial_job_items_book_id_fk" FOREIGN KEY \("book_id"\)[^;]*ON DELETE set null/);
  });

  it('creates the import ledger that outlives jobs and follows its book', () => {
    expect(WEB_SERIALS_TABLE_NAMES).toContain('web_serial_imports');
    for (const name of ['web_serial_imports_unique', 'web_serial_imports_user_id_fk', 'web_serial_imports_book_id_fk']) {
      expect(statements.find((s) => s.startsWith('DO $$') && s.includes(`ADD CONSTRAINT "${name}"`))).toContain(`conname = '${name}'`);
    }
    expect(WEB_SERIALS_SCHEMA_SQL).toMatch(/"web_serial_imports_user_id_fk" FOREIGN KEY \("user_id"\)[^;]*ON DELETE cascade/);
    expect(WEB_SERIALS_SCHEMA_SQL).toMatch(/"web_serial_imports_book_id_fk" FOREIGN KEY \("book_id"\)[^;]*ON DELETE cascade/);
    expect(WEB_SERIALS_SCHEMA_SQL).not.toMatch(/web_serial_imports[^;]*REFERENCES "public"."web_serial_jobs"/);
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ON "web_serial_imports" ("user_id", "series_key")');
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ON "web_serial_imports" ("user_id", "match_key")');
    expect(webSerialImports.matchKey.notNull).toBe(false);
    expect(webSerialImports.bookId.notNull).toBe(false);
  });

  it('keeps one per-user novel provider row that follows its user', () => {
    expect(WEB_SERIALS_TABLE_NAMES).toContain('web_serial_novel_prefs');
    const create = statements.find((s) => s.startsWith('CREATE TABLE') && s.includes('"web_serial_novel_prefs"'))!;
    expect(create).toContain('"user_id" integer PRIMARY KEY NOT NULL');
    expect(create).toContain(`"disabled_domains" jsonb DEFAULT '[]'::jsonb NOT NULL`);
    expect(WEB_SERIALS_SCHEMA_SQL).toMatch(/"web_serial_novel_prefs_user_id_fk" FOREIGN KEY \("user_id"\)[^;]*ON DELETE cascade/);
    expect(webSerialNovelPrefs.disabledDomains.default).toEqual([]);
  });

  it('records requested volumes per user with one row per volume, following the user', () => {
    expect(WEB_SERIALS_TABLE_NAMES).toContain('web_serial_volume_requests');
    const create = statements.find((s) => s.startsWith('CREATE TABLE') && s.includes('"web_serial_volume_requests"'))!;
    expect(create).toContain('CONSTRAINT "web_serial_volume_requests_unique" UNIQUE ("user_id", "kind", "match_id", "volume")');
    expect(WEB_SERIALS_SCHEMA_SQL).toMatch(/"web_serial_volume_requests_user_id_fk" FOREIGN KEY \("user_id"\)[^;]*ON DELETE cascade/);
    expect(webSerialVolumeRequests.bookRequestId.notNull).toBe(true);
  });

  it('backfills the ledger once from imported job items, idempotently', () => {
    const backfill = statements.find((s) => s.startsWith('INSERT INTO "web_serial_imports"'))!;
    expect(backfill).toBeDefined();
    expect(backfill).toContain(`i."status" = 'imported' AND i."book_id" IS NOT NULL`);
    expect(backfill).toContain(`'mb:'`);
    expect(backfill).toContain('jsonb_array_elements');
    expect(backfill).toContain('WHERE NOT EXISTS (SELECT 1 FROM "web_serial_imports")');
    expect(backfill).toContain('ON CONFLICT ("user_id", "series_key", "unit_key", "packaging") DO NOTHING');
    expect(statements.indexOf(backfill)).toBeGreaterThan(
      statements.findIndex((s) => s.includes('CREATE INDEX IF NOT EXISTS "web_serial_imports_match_idx"')),
    );
  });

  it('agrees with the drizzle declarations on defaults', () => {
    expect(webSerialSettings.maxConcurrentJobs.default).toBe(2);
    expect(webSerialSettings.mangaLanguages.default).toEqual(['en']);
    expect(webSerialSettings.novelDefaultPackaging.default).toBe('volume');
    expect(webSerialSettings.lookupEnabled.default).toBe(true);
    expect(webSerialJobs.status.default).toBe('queued');
    expect(webSerialJobs.skipImported.default).toBe(true);
    expect(webSerialJobs.metadata.default).toEqual({});
    expect(webSerialJobItems.status.default).toBe('pending');
  });

  it('adds the paused status by replacing the status check idempotently', () => {
    const replace = statements.find((s) => s.startsWith('DO $$') && s.includes('DROP CONSTRAINT IF EXISTS "web_serial_jobs_status_chk"'));
    expect(replace).toBeDefined();
    expect(replace).toContain("LIKE '%paused%'");
    expect(replace).toContain(`CHECK ("status" in ('queued', 'paused', 'running'`);
    expect(statements.find((s) => s.startsWith('CREATE TABLE') && s.includes('"web_serial_jobs"'))).toContain(`'queued', 'paused', 'running'`);
  });

  it('adds the queue order and instance pause columns to an existing installation', () => {
    expect(WEB_SERIALS_SCHEMA_SQL).toMatch(
      /ADD COLUMN IF NOT EXISTS "queue_order" bigint DEFAULT \(\(extract\(epoch from now\(\)\) \* 1000\)::bigint\) NOT NULL/,
    );
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ADD COLUMN IF NOT EXISTS "queue_paused" boolean DEFAULT false NOT NULL');
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ON "web_serial_jobs" ("queue_order", "id") WHERE "status" = \'queued\'');
    expect(webSerialJobs.queueOrder.notNull).toBe(true);
    expect(webSerialJobs.queueOrder.hasDefault).toBe(true);
    expect(webSerialSettings.queuePaused.default).toBe(false);
  });

  it('adds the manga source selection column to an existing installation', () => {
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ADD COLUMN IF NOT EXISTS "manga_source_ids" jsonb;');
    expect(webSerialSettings.mangaSourceIds.notNull).toBe(false);
  });

  it('adds lookup and metadata columns to an existing installation', () => {
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ADD COLUMN IF NOT EXISTS "lookup_enabled" boolean DEFAULT true NOT NULL');
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ADD COLUMN IF NOT EXISTS "lookup_last_check" jsonb');
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT \'{}\'::jsonb NOT NULL');
  });

  it('creates the light novel index with one row per source page and the search indexes', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE') && s.includes('"web_serial_novel_index"'))!;
    expect(create).toContain('"title_key" varchar(1000) NOT NULL');
    expect(create).toContain('"mtl" boolean DEFAULT false NOT NULL');
    expect(create).toContain('"match_id" varchar(16)');
    expect(create).toContain('UNIQUE ("source_id", "path")');
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ON "web_serial_novel_index" USING gist ("title_key" gist_trgm_ops)');
    expect(statements).toContain('DROP INDEX IF EXISTS "web_serial_novel_index_title_trgm_idx";');
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ON "web_serial_novel_index" ("title_key" varchar_pattern_ops)');
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ON "web_serial_novel_index" ("match_id") WHERE "match_id" is not null');
    expect(WEB_SERIALS_SCHEMA_SQL).not.toMatch(/CREATE EXTENSION/i);
    expect(webSerialNovelIndex.mtl.default).toBe(false);
    expect(webSerialNovelIndex.matchId.notNull).toBe(false);
  });

  it('builds the trigram filter and distance indexes before dropping the old trigram index', () => {
    const at = (fragment: string) => statements.findIndex((s) => s.includes(fragment));
    const filter = statements[at('"web_serial_novel_index_title_filter_idx"')]!;
    expect(filter).toBe(
      'CREATE INDEX IF NOT EXISTS "web_serial_novel_index_title_filter_idx" ON "web_serial_novel_index" USING gin (lower("title_key") gin_trgm_ops);',
    );
    const dropped = at('DROP INDEX IF EXISTS "web_serial_novel_index_title_trgm_idx"');
    expect(dropped).toBeGreaterThan(at('"web_serial_novel_index_title_gist_idx"'));
    expect(dropped).toBeGreaterThan(at('"web_serial_novel_index_title_filter_idx"'));
  });

  it('adds the fill recheck time to an existing installation', () => {
    const sources = statements.find((s) => s.startsWith('CREATE TABLE') && s.includes('"web_serial_novel_index_sources"'))!;
    expect(sources).toContain('"recheck_at" timestamp with time zone,');
    expect(statements).toContain('ALTER TABLE "web_serial_novel_index_sources" ADD COLUMN IF NOT EXISTS "recheck_at" timestamp with time zone;');
    expect(webSerialNovelIndexSources.recheckAt.notNull).toBe(false);
  });

  it('adds the index author and the fill confirmation columns to an existing installation', () => {
    const index = statements.find((s) => s.startsWith('CREATE TABLE') && s.includes('"web_serial_novel_index"'))!;
    const sources = statements.find((s) => s.startsWith('CREATE TABLE') && s.includes('"web_serial_novel_index_sources"'))!;
    expect(index).toContain('"author" varchar(500),');
    expect(sources).toContain('"empty_page" integer,');
    expect(sources).toContain('"first_page_failures" integer DEFAULT 0 NOT NULL,');
    expect(statements).toContain('ALTER TABLE "web_serial_novel_index" ADD COLUMN IF NOT EXISTS "author" varchar(500);');
    expect(statements).toContain('ALTER TABLE "web_serial_novel_index_sources" ADD COLUMN IF NOT EXISTS "empty_page" integer;');
    expect(statements).toContain(
      'ALTER TABLE "web_serial_novel_index_sources" ADD COLUMN IF NOT EXISTS "first_page_failures" integer DEFAULT 0 NOT NULL;',
    );
    expect(webSerialNovelIndex.author.name).toBe('author');
    expect(webSerialNovelIndexSources.firstPageFailures.default).toBe(0);
  });

  it('tracks the fill of each source and the daily index budget', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE') && s.includes('"web_serial_novel_index_sources"'))!;
    expect(create).toContain('"source_id" varchar(100) PRIMARY KEY NOT NULL');
    expect(create).toContain(`"fill_state" varchar(10) DEFAULT 'pending' NOT NULL`);
    expect(create).toContain(`CHECK ("fill_state" in ('pending', 'filling', 'done', 'paused'))`);
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ADD COLUMN IF NOT EXISTS "novel_index_daily_budget" integer DEFAULT 1500 NOT NULL');
    expect(create).toContain('"fill_sort" text,');
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('ALTER TABLE "web_serial_novel_index_sources" ADD COLUMN IF NOT EXISTS "fill_sort" text;');
    expect(webSerialNovelIndexSources.fillSort.notNull).toBe(false);
    expect(webSerialNovelIndexSources.nextPage.default).toBe(1);
    expect(webSerialSettings.novelIndexDailyBudget.default).toBe(1500);
  });
});
