CREATE TABLE "audiobookshelf_book_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"abs_library_item_id" varchar(255) NOT NULL,
	"abs_title" varchar(1000),
	"abs_author_name" varchar(1000),
	"book_id" integer,
	"match_method" varchar(20),
	"match_confidence" real,
	"needs_review" boolean DEFAULT false NOT NULL,
	"match_error" text,
	"last_match_attempt_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_synced_status" varchar(20),
	"last_synced_progress" real,
	"last_synced_abs_update" bigint,
	"last_synced_position_abs_update" bigint,
	"last_synced_progress_at" timestamp with time zone,
	"last_seen_in_inventory_at" timestamp with time zone,
	"sync_error" text,
	"sync_excluded" boolean DEFAULT false NOT NULL,
	"manual_unlinked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audiobookshelf_book_state_user_item_uidx" UNIQUE("user_id","abs_library_item_id")
);
--> statement-breakpoint
CREATE TABLE "audiobookshelf_user_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"server_url" varchar(2048) NOT NULL,
	"api_token" varchar(2048) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_status" boolean DEFAULT true NOT NULL,
	"sync_position" boolean DEFAULT true NOT NULL,
	"sync_sessions" boolean DEFAULT true NOT NULL,
	"excluded_library_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"last_session_watermark" bigint,
	"last_deep_session_scan_at" timestamp with time zone,
	"session_backfill_cursor_page" integer,
	"session_backfill_max_updated" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audiobookshelf_user_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "reading_attempts" DROP CONSTRAINT "reading_attempts_origin_chk";--> statement-breakpoint
ALTER TABLE "reading_sessions" DROP CONSTRAINT "reading_sessions_source_chk";--> statement-breakpoint
ALTER TABLE "reading_sessions" ALTER COLUMN "source" SET DATA TYPE varchar(20);--> statement-breakpoint
ALTER TABLE "audiobookshelf_book_state" ADD CONSTRAINT "audiobookshelf_book_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audiobookshelf_book_state" ADD CONSTRAINT "audiobookshelf_book_state_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audiobookshelf_user_settings" ADD CONSTRAINT "audiobookshelf_user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audiobookshelf_book_state_user_book_idx" ON "audiobookshelf_book_state" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE INDEX "bm_audible_id_idx" ON "book_metadata" USING btree ("audible_id");--> statement-breakpoint
ALTER TABLE "reading_attempts" ADD CONSTRAINT "reading_attempts_origin_chk" CHECK ("reading_attempts"."origin" in ('manual', 'bookorbit', 'kobo', 'koreader', 'hardcover', 'audiobookshelf', 'migration'));--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD CONSTRAINT "reading_sessions_source_chk" CHECK ("reading_sessions"."source" in ('web', 'koreader', 'manual', 'kobo', 'audiobookshelf'));