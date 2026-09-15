export const MONITORED_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS "monitored_settings" (
	"id" integer DEFAULT 1 PRIMARY KEY NOT NULL,
	"refresh_cooldown_minutes" integer DEFAULT 10 NOT NULL,
	"sync_enabled" boolean DEFAULT true NOT NULL,
	"sync_interval_hours" integer DEFAULT 12 NOT NULL,
	CONSTRAINT "monitored_settings_single_row_chk" CHECK ("monitored_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "author_catalog_source_works" (
	"work_id" varchar(255) NOT NULL,
	"source" varchar(20) NOT NULL,
	"provider_work_id" varchar(255) NOT NULL,
	CONSTRAINT "author_catalog_source_works_work_id_source_pk" PRIMARY KEY("work_id","source")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "author_catalog_state" (
	"monitor_author_id" varchar(36) PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "author_catalog_works" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"monitor_author_id" varchar(36) NOT NULL,
	"title" varchar(1000) NOT NULL,
	"subtitle" varchar(1000),
	"series_name" varchar(500),
	"series_index" varchar(50),
	"series_memberships" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"release_year" integer,
	"ebook_release_date" varchar(10),
	"ebook_date_precision" varchar(5),
	"audio_release_date" varchar(10),
	"audio_date_precision" varchar(5),
	"cover_url" text,
	"description" text,
	"verdict" varchar(10) NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" varchar(20),
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_book_id" integer,
	"matched_ebook_book_id" integer,
	"matched_audio_book_id" integer,
	"owned_formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "author_catalog_works_verdict_chk" CHECK ("author_catalog_works"."verdict" in ('verified', 'probable', 'suspect')),
	CONSTRAINT "author_catalog_works_kind_chk" CHECK ("author_catalog_works"."kind" is null or "author_catalog_works"."kind" in ('collection', 'anthology', 'graphic_novel', 'format_variant', 'duplicate'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "author_provider_identities" (
	"monitor_author_id" varchar(36) NOT NULL,
	"source" varchar(20) NOT NULL,
	"provider_id" varchar(255) NOT NULL,
	CONSTRAINT "author_provider_identities_monitor_author_id_source_pk" PRIMARY KEY("monitor_author_id","source")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitored_author_works" (
	"work_id" varchar(255) PRIMARY KEY NOT NULL,
	"monitor_author_id" varchar(36) NOT NULL,
	"monitor_state" varchar(12) DEFAULT 'monitoring' NOT NULL,
	"monitor_ebook" boolean,
	"monitor_audiobook" boolean,
	"user_visibility" varchar(10),
	"ebook_request_id" integer,
	"audiobook_request_id" integer,
	CONSTRAINT "monitored_author_works_monitor_state_chk" CHECK ("monitored_author_works"."monitor_state" in ('monitoring', 'paused', 'stopped')),
	CONSTRAINT "monitored_author_works_user_visibility_chk" CHECK ("monitored_author_works"."user_visibility" is null or "monitored_author_works"."user_visibility" in ('hidden', 'visible'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitored_authors" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"author_name" varchar(500) NOT NULL,
	"local_author_id" integer,
	"paused" boolean DEFAULT false NOT NULL,
	"ebook_mode" varchar(20) NOT NULL,
	"ebook_library_id" integer,
	"ebook_folder_id" integer,
	"audiobook_mode" varchar(20) NOT NULL,
	"audiobook_library_id" integer,
	"audiobook_folder_id" integer,
	"added_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_sync_attempted_at" timestamp with time zone,
	"last_release_check_at" timestamp with time zone,
	CONSTRAINT "monitored_authors_ebook_mode_chk" CHECK ("monitored_authors"."ebook_mode" in ('notify', 'auto-upcoming', 'auto-all', 'off')),
	CONSTRAINT "monitored_authors_audiobook_mode_chk" CHECK ("monitored_authors"."audiobook_mode" in ('notify', 'auto-upcoming', 'auto-all', 'off'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitored_books" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"monitor_author_id" varchar(36) NOT NULL,
	"work_id" varchar(255) NOT NULL,
	"formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitored_release_events" (
	"work_id" varchar(255) NOT NULL,
	"monitor_author_id" varchar(36) NOT NULL,
	"owner_user_id" integer NOT NULL,
	"format" varchar(10) NOT NULL,
	"title" varchar(1000),
	"release_date" varchar(10) NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "monitored_release_events_work_id_format_pk" PRIMARY KEY("work_id","format"),
	CONSTRAINT "monitored_release_events_format_chk" CHECK ("monitored_release_events"."format" in ('ebook', 'audiobook'))
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'author_catalog_source_works_work_id_author_catalog_works_id_fk'
	) THEN
		ALTER TABLE "author_catalog_source_works" ADD CONSTRAINT "author_catalog_source_works_work_id_author_catalog_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."author_catalog_works"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'author_catalog_state_monitor_author_id_monitored_authors_id_fk'
	) THEN
		ALTER TABLE "author_catalog_state" ADD CONSTRAINT "author_catalog_state_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'author_catalog_works_monitor_author_id_monitored_authors_id_fk'
	) THEN
		ALTER TABLE "author_catalog_works" ADD CONSTRAINT "author_catalog_works_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'author_catalog_works_matched_book_id_books_id_fk'
	) THEN
		ALTER TABLE "author_catalog_works" ADD CONSTRAINT "author_catalog_works_matched_book_id_books_id_fk" FOREIGN KEY ("matched_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'author_catalog_works_matched_ebook_book_id_books_id_fk'
	) THEN
		ALTER TABLE "author_catalog_works" ADD CONSTRAINT "author_catalog_works_matched_ebook_book_id_books_id_fk" FOREIGN KEY ("matched_ebook_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'author_catalog_works_matched_audio_book_id_books_id_fk'
	) THEN
		ALTER TABLE "author_catalog_works" ADD CONSTRAINT "author_catalog_works_matched_audio_book_id_books_id_fk" FOREIGN KEY ("matched_audio_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'author_provider_identities_monitor_author_id_monitored_authors_id_fk'
	) THEN
		ALTER TABLE "author_provider_identities" ADD CONSTRAINT "author_provider_identities_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_author_works_work_id_author_catalog_works_id_fk'
	) THEN
		ALTER TABLE "monitored_author_works" ADD CONSTRAINT "monitored_author_works_work_id_author_catalog_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."author_catalog_works"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_author_works_monitor_author_id_monitored_authors_id_fk'
	) THEN
		ALTER TABLE "monitored_author_works" ADD CONSTRAINT "monitored_author_works_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_author_works_ebook_request_id_book_requests_id_fk'
	) THEN
		ALTER TABLE "monitored_author_works" ADD CONSTRAINT "monitored_author_works_ebook_request_id_book_requests_id_fk" FOREIGN KEY ("ebook_request_id") REFERENCES "public"."book_requests"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_author_works_audiobook_request_id_book_requests_id_fk'
	) THEN
		ALTER TABLE "monitored_author_works" ADD CONSTRAINT "monitored_author_works_audiobook_request_id_book_requests_id_fk" FOREIGN KEY ("audiobook_request_id") REFERENCES "public"."book_requests"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_authors_owner_user_id_users_id_fk'
	) THEN
		ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_authors_local_author_id_authors_id_fk'
	) THEN
		ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_local_author_id_authors_id_fk" FOREIGN KEY ("local_author_id") REFERENCES "public"."authors"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_authors_ebook_library_id_libraries_id_fk'
	) THEN
		ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_ebook_library_id_libraries_id_fk" FOREIGN KEY ("ebook_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_authors_ebook_folder_id_library_folders_id_fk'
	) THEN
		ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_ebook_folder_id_library_folders_id_fk" FOREIGN KEY ("ebook_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_authors_audiobook_library_id_libraries_id_fk'
	) THEN
		ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_audiobook_library_id_libraries_id_fk" FOREIGN KEY ("audiobook_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_authors_audiobook_folder_id_library_folders_id_fk'
	) THEN
		ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_audiobook_folder_id_library_folders_id_fk" FOREIGN KEY ("audiobook_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_books_owner_user_id_users_id_fk'
	) THEN
		ALTER TABLE "monitored_books" ADD CONSTRAINT "monitored_books_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_books_monitor_author_id_monitored_authors_id_fk'
	) THEN
		ALTER TABLE "monitored_books" ADD CONSTRAINT "monitored_books_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_release_events_monitor_author_id_monitored_authors_id_fk'
	) THEN
		ALTER TABLE "monitored_release_events" ADD CONSTRAINT "monitored_release_events_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_release_events_owner_user_id_users_id_fk'
	) THEN
		ALTER TABLE "monitored_release_events" ADD CONSTRAINT "monitored_release_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "author_catalog_source_works_provider_work_id_idx" ON "author_catalog_source_works" USING btree ("provider_work_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "author_catalog_works_monitor_author_id_idx" ON "author_catalog_works" USING btree ("monitor_author_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "author_catalog_works_monitor_author_verdict_idx" ON "author_catalog_works" USING btree ("monitor_author_id","verdict");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitored_author_works_monitor_author_id_idx" ON "monitored_author_works" USING btree ("monitor_author_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitored_authors_owner_user_id_idx" ON "monitored_authors" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitored_books_work_id_idx" ON "monitored_books" USING btree ("work_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monitored_authors_owner_lower_name_uidx" ON "monitored_authors" USING btree ("owner_user_id",lower("author_name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "author_catalog_works_matched_book_id_idx" ON "author_catalog_works" USING btree ("matched_book_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "author_catalog_works_matched_ebook_book_id_idx" ON "author_catalog_works" USING btree ("matched_ebook_book_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "author_catalog_works_matched_audio_book_id_idx" ON "author_catalog_works" USING btree ("matched_audio_book_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "author_catalog_works_title_unaccent_trgm_idx" ON "author_catalog_works" USING gin (public.bookorbit_unaccent("title") gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitored_authors_name_unaccent_trgm_idx" ON "monitored_authors" USING gin (public.bookorbit_unaccent("author_name") gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitored_books_owner_user_id_idx" ON "monitored_books" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monitored_books_owner_monitor_work_uidx" ON "monitored_books" USING btree ("owner_user_id","monitor_author_id","work_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitored_release_events_owner_user_id_idx" ON "monitored_release_events" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitored_release_events_monitor_author_id_idx" ON "monitored_release_events" USING btree ("monitor_author_id");
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'author_catalog_works'
			AND column_name = 'kind'
	) THEN
		ALTER TABLE "author_catalog_works" ADD COLUMN IF NOT EXISTS "kind" varchar(20);
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'monitored_authors'
			AND column_name = 'last_release_check_at'
	) THEN
		ALTER TABLE "monitored_authors" ADD COLUMN IF NOT EXISTS "last_release_check_at" timestamp with time zone;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'monitored_authors'
			AND column_name = 'last_sync_attempted_at'
	) THEN
		ALTER TABLE "monitored_authors" ADD COLUMN IF NOT EXISTS "last_sync_attempted_at" timestamp with time zone;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'monitored_release_events'
			AND column_name = 'title'
	) THEN
		ALTER TABLE "monitored_release_events" ADD COLUMN IF NOT EXISTS "title" varchar(1000);
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'author_catalog_works_kind_chk'
	) THEN
		ALTER TABLE "author_catalog_works" ADD CONSTRAINT "author_catalog_works_kind_chk" CHECK ("author_catalog_works"."kind" is null or "author_catalog_works"."kind" in ('collection', 'anthology', 'graphic_novel', 'format_variant', 'duplicate'));
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'monitored_release_events_work_id_author_catalog_works_id_fk'
	) THEN
		ALTER TABLE "monitored_release_events" DROP CONSTRAINT IF EXISTS "monitored_release_events_work_id_author_catalog_works_id_fk";
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_class
		WHERE relname = 'author_catalog_works_monitor_ebook_release_idx'
			AND relkind = 'i'
	) THEN
		DROP INDEX IF EXISTS "author_catalog_works_monitor_ebook_release_idx";
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_class
		WHERE relname = 'author_catalog_works_monitor_audio_release_idx'
			AND relkind = 'i'
	) THEN
		DROP INDEX IF EXISTS "author_catalog_works_monitor_audio_release_idx";
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_class
		WHERE relname = 'monitored_release_events_pending_idx'
			AND relkind = 'i'
	) THEN
		DROP INDEX IF EXISTS "monitored_release_events_pending_idx";
	END IF;
END $$;
--> statement-breakpoint
-- The catalog guard avoids ACCESS EXCLUSIVE locks on every boot because PostgreSQL locks before
-- evaluating a bare DROP COLUMN IF EXISTS. The inner IF EXISTS makes concurrent boots safe.
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'monitored_authors'
			AND column_name = 'is_shared'
	) THEN
		ALTER TABLE "monitored_authors" DROP COLUMN IF EXISTS "is_shared";
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'monitored_books'
			AND column_name = 'is_shared'
	) THEN
		ALTER TABLE "monitored_books" DROP COLUMN IF EXISTS "is_shared";
	END IF;
END $$;
`;
