// Reading-alignment schema bootstrap SQL, embedded as a string rather than shipped as a .sql
// asset. The SWC watch builder does not reliably copy assets into dist, and a missing file
// makes the entire app fail to boot. Embedding removes that build-config coupling so this
// works identically in dev watch, nest build, tests and Docker.
export const READING_ALIGNMENT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS "audiobook_alignment" (
	"id" serial PRIMARY KEY NOT NULL,
	"text_book_id" integer NOT NULL,
	"audio_book_id" integer NOT NULL,
	"ebook_file_id" integer,
	"audio_content_hash" varchar(128),
	"epub_content_hash" varchar(128),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"sample_interval_sec" integer,
	"clip_seconds" integer,
	"whisper_model" varchar(100),
	"anchor_count" integer DEFAULT 0 NOT NULL,
	"samples_done" integer DEFAULT 0 NOT NULL,
	"samples_total" integer,
	"error" text,
	"built_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audiobook_alignment_text_book_id_audio_book_id_unique" UNIQUE("text_book_id","audio_book_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audiobook_alignment_anchor" (
	"id" serial PRIMARY KEY NOT NULL,
	"alignment_id" integer NOT NULL,
	"audio_seconds" real NOT NULL,
	"spine_index" integer NOT NULL,
	"phrase" text NOT NULL,
	"confidence" real,
	"ebook_fraction" real
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'audiobook_alignment_text_book_id_books_id_fk'
	) THEN
		ALTER TABLE "audiobook_alignment" ADD CONSTRAINT "audiobook_alignment_text_book_id_books_id_fk" FOREIGN KEY ("text_book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'audiobook_alignment_audio_book_id_books_id_fk'
	) THEN
		ALTER TABLE "audiobook_alignment" ADD CONSTRAINT "audiobook_alignment_audio_book_id_books_id_fk" FOREIGN KEY ("audio_book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'audiobook_alignment_ebook_file_id_book_files_id_fk'
	) THEN
		ALTER TABLE "audiobook_alignment" ADD CONSTRAINT "audiobook_alignment_ebook_file_id_book_files_id_fk" FOREIGN KEY ("ebook_file_id") REFERENCES "public"."book_files"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'audiobook_alignment_anchor_alignment_id_audiobook_alignment_id_fk'
	) THEN
		ALTER TABLE "audiobook_alignment_anchor" ADD CONSTRAINT "audiobook_alignment_anchor_alignment_id_audiobook_alignment_id_fk" FOREIGN KEY ("alignment_id") REFERENCES "public"."audiobook_alignment"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audiobook_alignment_anchor_alignment_id_idx" ON "audiobook_alignment_anchor" USING btree ("alignment_id");
--> statement-breakpoint
DO $$ BEGIN
	-- Enforce one anchor per (alignment, audioSeconds) so a resumed build's re-inserted boundary sample
	-- is a no-op rather than a duplicate. Run once: dedup any rows a pre-fix crash left behind (keep the
	-- lowest id), then create the index. Guarded on the index's absence so later boots do no table scan.
	IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'audiobook_alignment_anchor_alignment_id_audio_seconds_unique') THEN
		DELETE FROM "audiobook_alignment_anchor" a
		USING "audiobook_alignment_anchor" b
		WHERE a."alignment_id" = b."alignment_id" AND a."audio_seconds" = b."audio_seconds" AND a."id" > b."id";
		CREATE UNIQUE INDEX "audiobook_alignment_anchor_alignment_id_audio_seconds_unique" ON "audiobook_alignment_anchor" USING btree ("alignment_id","audio_seconds");
	END IF;
END $$;
`;
