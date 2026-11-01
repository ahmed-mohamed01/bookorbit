// Edition-sync schema bootstrap SQL. Fork tables are never Drizzle migrations (see
// FORK_MAINTENANCE.md "Schema decoupling"); every statement is idempotent so a second boot is a no-op.
// Embedded as a string because the SWC watch builder does not reliably copy .sql assets.
export const EDITION_SYNC_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS "edition_sync_user_settings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"book_sync_mode" varchar(20) DEFAULT 'all_eligible' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edition_sync_user_settings_mode_chk" CHECK ("book_sync_mode" in ('all_eligible', 'selected_only'))
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edition_sync_user_settings_user_fk') THEN
		ALTER TABLE "edition_sync_user_settings" ADD CONSTRAINT "edition_sync_user_settings_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edition_sync_book_overrides" (
	"user_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"sync_override" varchar(10) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edition_sync_book_overrides_pk" PRIMARY KEY ("user_id", "book_id"),
	CONSTRAINT "edition_sync_book_overrides_value_chk" CHECK ("sync_override" in ('included', 'excluded'))
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edition_sync_book_overrides_user_fk') THEN
		ALTER TABLE "edition_sync_book_overrides" ADD CONSTRAINT "edition_sync_book_overrides_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edition_sync_book_overrides_book_fk') THEN
		ALTER TABLE "edition_sync_book_overrides" ADD CONSTRAINT "edition_sync_book_overrides_book_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edition_sync_book_overrides_book_idx" ON "edition_sync_book_overrides" USING btree ("book_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edition_sync_book_index" (
	"book_id" integer PRIMARY KEY NOT NULL,
	"status" varchar(10) NOT NULL,
	"worker_job_id" uuid,
	"stage" varchar(30),
	"progress" smallint,
	"index_file_id" integer,
	"index_path" text,
	"index_bytes" bigint,
	"provenance" jsonb,
	"report" jsonb,
	"worker_version" varchar(100),
	"indexed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" varchar(50),
	"error_code" varchar(50),
	"last_error" varchar(2000),
	"failed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"retry_requested" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edition_sync_book_index_status_chk" CHECK ("status" in ('running', 'ready', 'failed', 'stale'))
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edition_sync_book_index_book_fk') THEN
		ALTER TABLE "edition_sync_book_index" ADD CONSTRAINT "edition_sync_book_index_book_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edition_sync_book_index_file_fk') THEN
		ALTER TABLE "edition_sync_book_index" ADD CONSTRAINT "edition_sync_book_index_file_fk" FOREIGN KEY ("index_file_id") REFERENCES "public"."book_files"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edition_sync_book_index_status_idx" ON "edition_sync_book_index" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edition_sync_book_index_pinned_idx" ON "edition_sync_book_index" USING btree ("pinned_at") WHERE "pinned_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edition_sync_book_index_worker_job_idx" ON "edition_sync_book_index" USING btree ("worker_job_id") WHERE "worker_job_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edition_sync_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"cron_expression" varchar(100),
	"run_hours" smallint DEFAULT 8 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" integer,
	CONSTRAINT "edition_sync_settings_singleton_chk" CHECK ("id" = 1),
	CONSTRAINT "edition_sync_settings_run_hours_chk" CHECK ("run_hours" BETWEEN 1 AND 24)
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edition_sync_settings_user_fk') THEN
		ALTER TABLE "edition_sync_settings" ADD CONSTRAINT "edition_sync_settings_user_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
INSERT INTO "edition_sync_settings" ("id", "cron_expression", "run_hours") VALUES (1, '0 2 * * *', 8) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edition_sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"trigger" varchar(10) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_until" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"books_indexed" integer DEFAULT 0 NOT NULL,
	"books_failed" integer DEFAULT 0 NOT NULL,
	"seconds_indexed" double precision DEFAULT 0 NOT NULL,
	"stop_reason" varchar(30),
	CONSTRAINT "edition_sync_runs_trigger_chk" CHECK ("trigger" in ('scheduled', 'manual', 'toggle'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edition_sync_runs_started_idx" ON "edition_sync_runs" USING btree ("started_at");
--> statement-breakpoint
ALTER TABLE edition_sync_book_index ADD COLUMN IF NOT EXISTS files_changed_at timestamptz;
--> statement-breakpoint
ALTER TABLE edition_sync_settings ADD COLUMN IF NOT EXISTS on_files_changed varchar(10) DEFAULT 'next_run' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edition_sync_settings_files_changed_chk') THEN
  ALTER TABLE edition_sync_settings ADD CONSTRAINT edition_sync_settings_files_changed_chk CHECK (on_files_changed IN ('next_run', 'immediate'));
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION edition_sync_book_files_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
 affected_book_id integer;
 affected_book_ids integer[];
 content_changed boolean := true;
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.role <> 'content' THEN RETURN NULL; END IF;
  affected_book_ids := ARRAY[NEW.book_id];
 ELSIF TG_OP = 'DELETE' THEN
  IF OLD.role <> 'content' THEN RETURN NULL; END IF;
  affected_book_ids := ARRAY[OLD.book_id];
 ELSE
  IF (OLD.role <> 'content' AND NEW.role <> 'content') OR
     ROW(OLD.book_id, OLD.role, OLD.size_bytes, OLD.mtime, OLD.file_hash, OLD.absolute_path)
     IS NOT DISTINCT FROM
     ROW(NEW.book_id, NEW.role, NEW.size_bytes, NEW.mtime, NEW.file_hash, NEW.absolute_path)
  THEN RETURN NULL; END IF;
  content_changed := ROW(OLD.book_id, OLD.role, OLD.size_bytes, OLD.mtime, OLD.file_hash)
    IS DISTINCT FROM ROW(NEW.book_id, NEW.role, NEW.size_bytes, NEW.mtime, NEW.file_hash);
  affected_book_ids := ARRAY[OLD.book_id];
  IF NEW.book_id IS DISTINCT FROM OLD.book_id THEN
   affected_book_ids := array_append(affected_book_ids, NEW.book_id);
  END IF;
 END IF;
 FOREACH affected_book_id IN ARRAY affected_book_ids LOOP
  UPDATE edition_sync_book_index
  SET files_changed_at = now(), updated_at = now(),
      invalidated_at = CASE WHEN status = 'failed' AND content_changed OR (status = 'ready' AND invalidated_reason IS NULL) THEN now() ELSE invalidated_at END,
      invalidated_reason = CASE WHEN status = 'failed' AND content_changed THEN 'files_changed' ELSE invalidated_reason END,
      attempt_count = CASE WHEN status = 'failed' AND content_changed THEN 0 ELSE attempt_count END,
      retry_requested = CASE WHEN status = 'failed' AND content_changed THEN false ELSE retry_requested END,
      status = CASE WHEN status = 'failed' AND content_changed THEN 'stale' ELSE status END
  WHERE book_id = affected_book_id;
 END LOOP;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER edition_sync_book_files_changed
AFTER INSERT OR UPDATE OF book_id, role, size_bytes, mtime, file_hash, absolute_path OR DELETE ON book_files
FOR EACH ROW EXECUTE FUNCTION edition_sync_book_files_changed();
`;
