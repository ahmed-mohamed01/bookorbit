ALTER TABLE "audiobookshelf_book_state" ADD COLUMN "last_synced_position_abs_update" bigint;--> statement-breakpoint
ALTER TABLE "audiobookshelf_book_state" ADD COLUMN "last_synced_progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audiobookshelf_book_state" ADD COLUMN "last_seen_in_inventory_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audiobookshelf_user_settings" ADD COLUMN "last_deep_session_scan_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audiobookshelf_user_settings" ADD COLUMN "session_backfill_cursor_page" integer;--> statement-breakpoint
ALTER TABLE "audiobookshelf_user_settings" ADD COLUMN "session_backfill_max_updated" bigint;