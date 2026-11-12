// Audio-convert schema bootstrap SQL. Fork tables are never Drizzle migrations (see FORK_MAINTENANCE.md
// "Schema decoupling"); every statement is idempotent so a second boot is a no-op.
export const AUDIO_CONVERT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS "audio_convert_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_convert" boolean DEFAULT false NOT NULL,
	"codec" varchar(10) DEFAULT 'auto' NOT NULL,
	"bitrate" varchar(10) DEFAULT '128k' NOT NULL,
	"channels" smallint,
	"embed_chapters" boolean DEFAULT true NOT NULL,
	"embed_metadata" boolean DEFAULT true NOT NULL,
	"backup_days" integer DEFAULT 14 NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by_user_id" integer,
	CONSTRAINT "audio_convert_settings_singleton_chk" CHECK ("id" = 1),
	CONSTRAINT "audio_convert_settings_codec_chk" CHECK ("codec" in ('auto', 'copy', 'aac')),
	CONSTRAINT "audio_convert_settings_channels_chk" CHECK ("channels" IS NULL OR "channels" in (1, 2))
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audio_convert_settings_user_fk') THEN
		ALTER TABLE "audio_convert_settings" ADD CONSTRAINT "audio_convert_settings_user_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "audio_convert_settings" ALTER COLUMN "enabled" SET DEFAULT true;
--> statement-breakpoint
INSERT INTO "audio_convert_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- On until an admin saves the settings; a saved choice is kept.
UPDATE "audio_convert_settings" SET "enabled" = true WHERE "updated_at" IS NULL AND NOT "enabled";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audio_convert_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" integer NOT NULL,
	"library_id" integer NOT NULL,
	"user_id" integer,
	"trigger" varchar(10) NOT NULL,
	"status" varchar(10) NOT NULL,
	"stage" varchar(12),
	"progress" smallint,
	"codec" varchar(10) DEFAULT 'auto' NOT NULL,
	"bitrate" varchar(10) DEFAULT '128k' NOT NULL,
	"channels" smallint,
	"codec_used" varchar(10),
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_step_at" timestamp with time zone,
	"stage_started_at" timestamp with time zone,
	"error_code" varchar(40),
	"error_message" varchar(2000),
	"result" jsonb,
	"work_paths" jsonb,
	"backup_path" text,
	"backup_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_convert_jobs_trigger_chk" CHECK ("trigger" in ('manual', 'book_page', 'auto')),
	CONSTRAINT "audio_convert_jobs_status_chk" CHECK ("status" in ('waiting', 'queued', 'running', 'success', 'failed', 'skipped', 'cancelled'))
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audio_convert_jobs_book_fk') THEN
		ALTER TABLE "audio_convert_jobs" ADD CONSTRAINT "audio_convert_jobs_book_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audio_convert_jobs_user_fk') THEN
		ALTER TABLE "audio_convert_jobs" ADD CONSTRAINT "audio_convert_jobs_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audio_convert_jobs_book_idx" ON "audio_convert_jobs" USING btree ("book_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audio_convert_jobs_library_idx" ON "audio_convert_jobs" USING btree ("library_id", "created_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audio_convert_jobs_one_active_uidx" ON "audio_convert_jobs" USING btree ("book_id") WHERE "status" in ('waiting', 'queued', 'running');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audio_convert_watch" (
	"book_id" integer PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audio_convert_watch_book_fk') THEN
		ALTER TABLE "audio_convert_watch" ADD CONSTRAINT "audio_convert_watch_book_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audio_convert_book_files_added() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.role <> 'content' OR lower(coalesce(NEW.format, '')) <> 'mp3' THEN RETURN NULL; END IF;
 INSERT INTO audio_convert_watch (book_id, last_seen_at) VALUES (NEW.book_id, now())
 ON CONFLICT (book_id) DO UPDATE SET last_seen_at = now();
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER audio_convert_book_files_added
AFTER INSERT ON book_files
FOR EACH ROW EXECUTE FUNCTION audio_convert_book_files_added();
`;
