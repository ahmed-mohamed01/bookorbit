// Web Serials schema bootstrap SQL, embedded as a string (see storyteller-schema.ts for why) and
// applied on every boot; every statement is idempotent.
//
// Constraint names are short (`<table>_<column>_fk`): Postgres silently truncates identifiers over
// 63 bytes. Every constraint is declared inline for a fresh database AND added by a guarded ALTER,
// because `CREATE TABLE IF NOT EXISTS` is a no-op on a table an earlier iteration already created.
// The guards match `conrelid` as well as `conname`: a constraint name is only unique per table.

import { WEB_SERIAL_SERIES_KEY_MAX_LENGTH } from './web-serials.schema';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

function guardedConstraint(table: string, name: string, definition: string): string {
  return `DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('${table}')
			AND conname = '${name}'
	) THEN
		ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition};
	END IF;
END $$;`;
}

function replacedConstraint(table: string, name: string, definition: string, marker: string): string {
  return `DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('${table}')
			AND conname = '${name}'
			AND pg_get_constraintdef(oid) LIKE '%${marker}%'
	) THEN
		ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}";
		ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition};
	END IF;
END $$;`;
}

const SETTINGS = 'web_serial_settings';
const JOBS = 'web_serial_jobs';
const ITEMS = 'web_serial_job_items';
const IMPORTS = 'web_serial_imports';
const NOVEL_PREFS = 'web_serial_novel_prefs';
const NOVEL_INDEX = 'web_serial_novel_index';
const NOVEL_INDEX_SOURCES = 'web_serial_novel_index_sources';
const VOLUME_REQUESTS = 'web_serial_volume_requests';

const JOB_STATUSES = `'queued', 'paused', 'running', 'importing', 'completed', 'completed_with_gaps', 'failed', 'cancelled'`;
const ITEM_STATUSES = `'pending', 'fetching', 'importing', 'imported', 'skipped', 'failed'`;
const NOVEL_INDEX_FILL_STATES = `'pending', 'filling', 'done', 'paused'`;

const CONSTRAINTS: { table: string; name: string; definition: string }[] = [
  { table: SETTINGS, name: 'web_serial_settings_singleton_chk', definition: 'CHECK ("id" = 1)' },
  {
    table: SETTINGS,
    name: 'web_serial_settings_packaging_chk',
    definition: `CHECK ("novel_default_packaging" in ('volume', 'series'))`,
  },
  {
    table: SETTINGS,
    name: 'web_serial_settings_novel_engine_chk',
    definition: `CHECK ("novel_engine" in ('lnreader', 'lncrawl'))`,
  },
  {
    table: SETTINGS,
    name: 'web_serial_settings_concurrency_chk',
    definition: 'CHECK ("max_concurrent_jobs" between 1 and 6)',
  },
  {
    table: SETTINGS,
    name: 'web_serial_settings_manga_library_fk',
    definition: 'FOREIGN KEY ("manga_target_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action',
  },
  {
    table: SETTINGS,
    name: 'web_serial_settings_manga_folder_fk',
    definition: 'FOREIGN KEY ("manga_target_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action',
  },
  {
    table: SETTINGS,
    name: 'web_serial_settings_novel_library_fk',
    definition: 'FOREIGN KEY ("novel_target_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action',
  },
  {
    table: SETTINGS,
    name: 'web_serial_settings_novel_folder_fk',
    definition: 'FOREIGN KEY ("novel_target_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action',
  },
  { table: JOBS, name: 'web_serial_jobs_kind_chk', definition: `CHECK ("kind" in ('manga', 'novel'))` },
  { table: JOBS, name: 'web_serial_jobs_packaging_chk', definition: `CHECK ("packaging" in ('chapter', 'volume', 'series'))` },
  {
    table: JOBS,
    name: 'web_serial_jobs_user_id_fk',
    definition: 'FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action',
  },
  {
    table: JOBS,
    name: 'web_serial_jobs_library_fk',
    definition: 'FOREIGN KEY ("target_library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action',
  },
  {
    table: JOBS,
    name: 'web_serial_jobs_folder_fk',
    definition: 'FOREIGN KEY ("target_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action',
  },
  { table: ITEMS, name: 'web_serial_job_items_job_unit_unique', definition: 'UNIQUE ("job_id", "unit_key")' },
  { table: ITEMS, name: 'web_serial_job_items_status_chk', definition: `CHECK ("status" in (${ITEM_STATUSES}))` },
  {
    table: ITEMS,
    name: 'web_serial_job_items_job_id_fk',
    definition: 'FOREIGN KEY ("job_id") REFERENCES "public"."web_serial_jobs"("id") ON DELETE cascade ON UPDATE no action',
  },
  {
    table: ITEMS,
    name: 'web_serial_job_items_book_id_fk',
    definition: 'FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action',
  },
];

const IMPORT_CONSTRAINTS: { table: string; name: string; definition: string }[] = [
  { table: IMPORTS, name: 'web_serial_imports_unique', definition: 'UNIQUE ("user_id", "series_key", "unit_key", "packaging")' },
  {
    table: IMPORTS,
    name: 'web_serial_imports_user_id_fk',
    definition: 'FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action',
  },
  {
    table: IMPORTS,
    name: 'web_serial_imports_book_id_fk',
    definition: 'FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action',
  },
];

const NOVEL_PREFS_CONSTRAINTS: { table: string; name: string; definition: string }[] = [
  {
    table: NOVEL_PREFS,
    name: 'web_serial_novel_prefs_user_id_fk',
    definition: 'FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action',
  },
];

const NOVEL_INDEX_CONSTRAINTS: { table: string; name: string; definition: string }[] = [
  { table: NOVEL_INDEX, name: 'web_serial_novel_index_source_path_unique', definition: 'UNIQUE ("source_id", "path")' },
  {
    table: NOVEL_INDEX_SOURCES,
    name: 'web_serial_novel_index_sources_state_chk',
    definition: `CHECK ("fill_state" in (${NOVEL_INDEX_FILL_STATES}))`,
  },
];

const VOLUME_REQUEST_CONSTRAINTS: { table: string; name: string; definition: string }[] = [
  { table: VOLUME_REQUESTS, name: 'web_serial_volume_requests_kind_chk', definition: `CHECK ("kind" in ('manga', 'novel'))` },
  { table: VOLUME_REQUESTS, name: 'web_serial_volume_requests_unique', definition: 'UNIQUE ("user_id", "kind", "match_id", "volume")' },
  {
    table: VOLUME_REQUESTS,
    name: 'web_serial_volume_requests_user_id_fk',
    definition: 'FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action',
  },
];

const QUEUE_ORDER_DEFAULT = '((extract(epoch from now()) * 1000)::bigint)';
const SERIES_KEY_LENGTH = WEB_SERIAL_SERIES_KEY_MAX_LENGTH;

/** Widening a varchar keeps the data and its indexes; the guard makes every later boot a catalogue read. */
function widenedSeriesKey(table: string): string {
  return `DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = 'series_key'
			AND character_maximum_length < ${SERIES_KEY_LENGTH}
	) THEN
		ALTER TABLE "${table}" ALTER COLUMN "series_key" TYPE varchar(${SERIES_KEY_LENGTH});
	END IF;
END $$;`;
}

const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "${SETTINGS}" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"manga_url" varchar(2048),
	"manga_username" varchar(255),
	"manga_password_enc" text,
	"manga_languages" jsonb DEFAULT '["en"]'::jsonb NOT NULL,
	"manga_target_library_id" integer,
	"manga_target_folder_id" integer,
	"manga_last_check" jsonb,
	"novel_url" varchar(2048),
	"novel_username" varchar(255),
	"novel_password_enc" text,
	"novel_search_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"novel_engine" varchar(10) DEFAULT 'lnreader' NOT NULL,
	"novel_sources_url" varchar(2048),
	"novel_sources_token_enc" text,
	"novel_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"novel_target_library_id" integer,
	"novel_target_folder_id" integer,
	"novel_default_packaging" varchar(10) DEFAULT 'volume' NOT NULL,
	"novel_last_check" jsonb,
	"novel_index_daily_budget" integer DEFAULT 1500 NOT NULL,
	"lookup_enabled" boolean DEFAULT true NOT NULL,
	"lookup_last_check" jsonb,
	"max_concurrent_jobs" integer DEFAULT 2 NOT NULL,
	"queue_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_serial_settings_singleton_chk" CHECK ("id" = 1),
	CONSTRAINT "web_serial_settings_packaging_chk" CHECK ("novel_default_packaging" in ('volume', 'series')),
	CONSTRAINT "web_serial_settings_concurrency_chk" CHECK ("max_concurrent_jobs" between 1 and 6)
);`,
  `CREATE TABLE IF NOT EXISTS "${JOBS}" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" varchar(10) NOT NULL,
	"series_key" varchar(${SERIES_KEY_LENGTH}) NOT NULL,
	"series_url" varchar(2048),
	"title" varchar(1000) NOT NULL,
	"author" varchar(1000),
	"source_name" varchar(255) NOT NULL,
	"packaging" varchar(10) NOT NULL,
	"selection" jsonb NOT NULL,
	"skip_imported" boolean DEFAULT true NOT NULL,
	"target_library_id" integer NOT NULL,
	"target_folder_id" integer,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"units_total" integer DEFAULT 0 NOT NULL,
	"units_done" integer DEFAULT 0 NOT NULL,
	"units_failed" integer DEFAULT 0 NOT NULL,
	"units_skipped" integer DEFAULT 0 NOT NULL,
	"message" text,
	"current_unit" jsonb,
	"engine_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"queue_order" bigint DEFAULT ${QUEUE_ORDER_DEFAULT} NOT NULL,
	CONSTRAINT "web_serial_jobs_kind_chk" CHECK ("kind" in ('manga', 'novel')),
	CONSTRAINT "web_serial_jobs_packaging_chk" CHECK ("packaging" in ('chapter', 'volume', 'series')),
	CONSTRAINT "web_serial_jobs_status_chk" CHECK ("status" in (${JOB_STATUSES}))
);`,
  `CREATE TABLE IF NOT EXISTS "${ITEMS}" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"unit_key" varchar(255) NOT NULL,
	"label" varchar(1000) NOT NULL,
	"sequence" varchar(20) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"book_id" integer,
	"error" text,
	"remote_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_serial_job_items_job_unit_unique" UNIQUE ("job_id", "unit_key"),
	CONSTRAINT "web_serial_job_items_status_chk" CHECK ("status" in (${ITEM_STATUSES}))
);`,
  `CREATE TABLE IF NOT EXISTS "${IMPORTS}" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"series_key" varchar(${SERIES_KEY_LENGTH}) NOT NULL,
	"match_key" varchar(64),
	"kind" varchar(10) NOT NULL,
	"unit_key" varchar(255) NOT NULL,
	"sequence" varchar(20) NOT NULL,
	"packaging" varchar(10) NOT NULL,
	"book_id" integer,
	"chapter_from" double precision,
	"chapter_to" double precision,
	"title_key" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_serial_imports_unique" UNIQUE ("user_id", "series_key", "unit_key", "packaging")
);`,
  `CREATE TABLE IF NOT EXISTS "${NOVEL_PREFS}" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"disabled_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS "${NOVEL_INDEX}" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" varchar(100) NOT NULL,
	"path" varchar(2048) NOT NULL,
	"url" varchar(2048),
	"title" varchar(1000) NOT NULL,
	"title_key" varchar(1000) NOT NULL,
	"author" varchar(500),
	"mtl" boolean DEFAULT false NOT NULL,
	"cover_url" varchar(2048),
	"match_id" varchar(16),
	"status" varchar(16),
	"chapter_count" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details_at" timestamp with time zone,
	CONSTRAINT "web_serial_novel_index_source_path_unique" UNIQUE ("source_id", "path")
);`,
  `CREATE TABLE IF NOT EXISTS "${NOVEL_INDEX_SOURCES}" (
	"source_id" varchar(100) PRIMARY KEY NOT NULL,
	"fill_state" varchar(10) DEFAULT 'pending' NOT NULL,
	"next_page" integer DEFAULT 1 NOT NULL,
	"fill_sort" text,
	"filled_at" timestamp with time zone,
	"last_topup_at" timestamp with time zone,
	"entries" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"requests_today" integer DEFAULT 0 NOT NULL,
	"requests_day" varchar(10),
	"empty_page" integer,
	"first_page_failures" integer DEFAULT 0 NOT NULL,
	"recheck_at" timestamp with time zone,
	CONSTRAINT "web_serial_novel_index_sources_state_chk" CHECK ("fill_state" in (${NOVEL_INDEX_FILL_STATES}))
);`,
  `CREATE TABLE IF NOT EXISTS "${VOLUME_REQUESTS}" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" varchar(10) NOT NULL,
	"match_id" varchar(16) NOT NULL,
	"volume" varchar(16) NOT NULL,
	"book_request_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_serial_volume_requests_kind_chk" CHECK ("kind" in ('manga', 'novel')),
	CONSTRAINT "web_serial_volume_requests_unique" UNIQUE ("user_id", "kind", "match_id", "volume")
);`,
];

const COLUMN_STATEMENTS = [
  `ALTER TABLE "${NOVEL_INDEX_SOURCES}" ADD COLUMN IF NOT EXISTS "fill_sort" text;`,
  `ALTER TABLE "${SETTINGS}" ADD COLUMN IF NOT EXISTS "lookup_enabled" boolean DEFAULT true NOT NULL;`,
  `ALTER TABLE "${SETTINGS}" ADD COLUMN IF NOT EXISTS "lookup_last_check" jsonb;`,
  `ALTER TABLE "${SETTINGS}" ADD COLUMN IF NOT EXISTS "manga_source_ids" jsonb;`,
  `ALTER TABLE "${SETTINGS}" ADD COLUMN IF NOT EXISTS "novel_engine" varchar(10);`,
  `ALTER TABLE "${SETTINGS}" ADD COLUMN IF NOT EXISTS "novel_sources_url" varchar(2048);`,
  `ALTER TABLE "${SETTINGS}" ADD COLUMN IF NOT EXISTS "novel_sources_token_enc" text;`,
  `ALTER TABLE "${SETTINGS}" ADD COLUMN IF NOT EXISTS "novel_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;`,
  `UPDATE "${SETTINGS}" SET "novel_engine" = CASE WHEN "novel_url" IS NOT NULL THEN 'lncrawl' ELSE 'lnreader' END WHERE "novel_engine" IS NULL;`,
  `ALTER TABLE "${SETTINGS}" ALTER COLUMN "novel_engine" SET DEFAULT 'lnreader';`,
  `ALTER TABLE "${SETTINGS}" ALTER COLUMN "novel_engine" SET NOT NULL;`,
  `ALTER TABLE "${JOBS}" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;`,
  `ALTER TABLE "${JOBS}" ADD COLUMN IF NOT EXISTS "current_unit" jsonb;`,
  `ALTER TABLE "${SETTINGS}" ADD COLUMN IF NOT EXISTS "queue_paused" boolean DEFAULT false NOT NULL;`,
  `ALTER TABLE "${JOBS}" ADD COLUMN IF NOT EXISTS "queue_order" bigint DEFAULT ${QUEUE_ORDER_DEFAULT} NOT NULL;`,
  `ALTER TABLE "${SETTINGS}" ADD COLUMN IF NOT EXISTS "novel_index_daily_budget" integer DEFAULT 1500 NOT NULL;`,
  `ALTER TABLE "${NOVEL_INDEX}" ADD COLUMN IF NOT EXISTS "author" varchar(500);`,
  `ALTER TABLE "${NOVEL_INDEX_SOURCES}" ADD COLUMN IF NOT EXISTS "empty_page" integer;`,
  `ALTER TABLE "${NOVEL_INDEX_SOURCES}" ADD COLUMN IF NOT EXISTS "first_page_failures" integer DEFAULT 0 NOT NULL;`,
  `ALTER TABLE "${NOVEL_INDEX_SOURCES}" ADD COLUMN IF NOT EXISTS "recheck_at" timestamp with time zone;`,
  `ALTER TABLE "${IMPORTS}" ADD COLUMN IF NOT EXISTS "chapter_from" double precision;`,
  `ALTER TABLE "${IMPORTS}" ADD COLUMN IF NOT EXISTS "chapter_to" double precision;`,
  `ALTER TABLE "${IMPORTS}" ADD COLUMN IF NOT EXISTS "title_key" varchar(1000);`,
  widenedSeriesKey(JOBS),
  widenedSeriesKey(IMPORTS),
];

const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS "web_serial_jobs_user_created_idx" ON "${JOBS}" ("user_id", "created_at" DESC);`,
  `CREATE INDEX IF NOT EXISTS "web_serial_jobs_active_idx" ON "${JOBS}" ("status") WHERE "status" in ('queued', 'running', 'importing');`,
  `CREATE INDEX IF NOT EXISTS "web_serial_jobs_queue_idx" ON "${JOBS}" ("queue_order", "id") WHERE "status" = 'queued';`,
  `CREATE INDEX IF NOT EXISTS "web_serial_jobs_finished_idx" ON "${JOBS}" ("finished_at") WHERE "finished_at" is not null;`,
  `CREATE INDEX IF NOT EXISTS "web_serial_jobs_series_idx" ON "${JOBS}" ("user_id", "series_key");`,
  `CREATE INDEX IF NOT EXISTS "web_serial_job_items_book_id_idx" ON "${ITEMS}" ("book_id");`,
  `CREATE INDEX IF NOT EXISTS "web_serial_imports_series_idx" ON "${IMPORTS}" ("user_id", "series_key");`,
  `CREATE INDEX IF NOT EXISTS "web_serial_imports_match_idx" ON "${IMPORTS}" ("user_id", "match_key");`,
  `CREATE INDEX IF NOT EXISTS "web_serial_imports_book_id_idx" ON "${IMPORTS}" ("book_id");`,
  // pg_trgm is installed by the migration runner (scripts/postgres-extensions.ts) before any module boots.
  // GiST returns the closest titles in distance order, which wins when many titles match. GIN finds a few matches, or
  // none, far faster; it indexes lower(title_key) (keys are already lower case) so the planner can only use it where
  // the query asks for that expression. The replacements exist before the old index goes, so searches never lose both.
  `CREATE INDEX IF NOT EXISTS "web_serial_novel_index_title_gist_idx" ON "${NOVEL_INDEX}" USING gist ("title_key" gist_trgm_ops);`,
  `CREATE INDEX IF NOT EXISTS "web_serial_novel_index_title_filter_idx" ON "${NOVEL_INDEX}" USING gin (lower("title_key") gin_trgm_ops);`,
  `DROP INDEX IF EXISTS "web_serial_novel_index_title_trgm_idx";`,
  `CREATE INDEX IF NOT EXISTS "web_serial_novel_index_title_prefix_idx" ON "${NOVEL_INDEX}" ("title_key" varchar_pattern_ops);`,
  `CREATE INDEX IF NOT EXISTS "web_serial_novel_index_match_idx" ON "${NOVEL_INDEX}" ("match_id") WHERE "match_id" is not null;`,
];

/**
 * Seeds the import ledger from the job history, once: the guard makes every later boot a cheap no-op. Grouped manga
 * units contribute their member chapters too; the unit row itself carries a "first-last" sequence that can never
 * equal a chapter number.
 */
const BACKFILL_STATEMENT = `INSERT INTO "${IMPORTS}" ("user_id", "series_key", "match_key", "kind", "unit_key", "sequence", "packaging", "book_id")
SELECT "user_id", "series_key", "match_key", "kind", "unit_key", "sequence", "packaging", "book_id" FROM (
	SELECT j."user_id", j."series_key",
		CASE WHEN coalesce(j."metadata"->'match'->>'id', j."metadata"->'override'->>'matchId') IS NOT NULL
			THEN 'mb:' || coalesce(j."metadata"->'match'->>'id', j."metadata"->'override'->>'matchId') END AS "match_key",
		j."kind", i."unit_key",
		left(coalesce(
			CASE WHEN j."kind" = 'manga' AND jsonb_typeof(i."remote_ref"->'unit'->'remote'->'chapters') = 'array'
				THEN (i."remote_ref"->'unit'->'remote'->'chapters'->0->>'sequence') || '-' || (i."remote_ref"->'unit'->'remote'->'chapters'->-1->>'sequence') END,
			i."sequence"), 20) AS "sequence",
		j."packaging", i."book_id", i."id" AS "item_id", 0 AS "member"
	FROM "${ITEMS}" i JOIN "${JOBS}" j ON j."id" = i."job_id"
	WHERE i."status" = 'imported' AND i."book_id" IS NOT NULL
	UNION ALL
	SELECT j."user_id", j."series_key",
		CASE WHEN coalesce(j."metadata"->'match'->>'id', j."metadata"->'override'->>'matchId') IS NOT NULL
			THEN 'mb:' || coalesce(j."metadata"->'match'->>'id', j."metadata"->'override'->>'matchId') END,
		j."kind", left(coalesce(c.chapter->>'chapterId', i."unit_key" || ':' || c.ord), 255),
		left(coalesce(c.chapter->>'sequence', c.ord::text), 20),
		j."packaging", i."book_id", i."id", 1
	FROM "${ITEMS}" i JOIN "${JOBS}" j ON j."id" = i."job_id"
	CROSS JOIN LATERAL jsonb_array_elements(i."remote_ref"->'unit'->'remote'->'chapters') WITH ORDINALITY AS c(chapter, ord)
	WHERE i."status" = 'imported' AND i."book_id" IS NOT NULL AND j."kind" = 'manga'
		AND jsonb_typeof(i."remote_ref"->'unit'->'remote'->'chapters') = 'array'
) src
WHERE NOT EXISTS (SELECT 1 FROM "${IMPORTS}")
ORDER BY "item_id", "member"
ON CONFLICT ("user_id", "series_key", "unit_key", "packaging") DO NOTHING;`;

export const WEB_SERIALS_TABLE_NAMES = [SETTINGS, JOBS, ITEMS, IMPORTS, NOVEL_PREFS, NOVEL_INDEX, NOVEL_INDEX_SOURCES, VOLUME_REQUESTS] as const;

export const WEB_SERIALS_SCHEMA_SQL = [
  ...CREATE_STATEMENTS,
  ...COLUMN_STATEMENTS,
  ...[...CONSTRAINTS, ...IMPORT_CONSTRAINTS, ...NOVEL_PREFS_CONSTRAINTS, ...NOVEL_INDEX_CONSTRAINTS, ...VOLUME_REQUEST_CONSTRAINTS].map(
    ({ table, name, definition }) => guardedConstraint(table, name, definition),
  ),
  replacedConstraint(JOBS, 'web_serial_jobs_status_chk', `CHECK ("status" in (${JOB_STATUSES}))`, 'paused'),
  ...INDEX_STATEMENTS,
  BACKFILL_STATEMENT,
].join(`\n${STATEMENT_BREAKPOINT}\n`);
