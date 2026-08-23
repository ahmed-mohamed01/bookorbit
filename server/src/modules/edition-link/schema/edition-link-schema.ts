export const EDITION_LINK_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS "book_edition_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"text_book_id" integer NOT NULL,
	"audio_book_id" integer NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_edition_links_text_book_id_unique" UNIQUE("text_book_id"),
	CONSTRAINT "book_edition_links_audio_book_id_unique" UNIQUE("audio_book_id")
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'book_edition_links_text_book_id_books_id_fk'
	) THEN
		ALTER TABLE "book_edition_links" ADD CONSTRAINT "book_edition_links_text_book_id_books_id_fk" FOREIGN KEY ("text_book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'book_edition_links_audio_book_id_books_id_fk'
	) THEN
		ALTER TABLE "book_edition_links" ADD CONSTRAINT "book_edition_links_audio_book_id_books_id_fk" FOREIGN KEY ("audio_book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
	col_notnull boolean;
	fk_deltype "char";
BEGIN
	-- Guarded bootstrap: only touch created_by when its shape is actually wrong. An unconditional
	-- DROP NOT NULL + DROP/ADD CONSTRAINT every boot takes ACCESS EXCLUSIVE locks and leaves a window
	-- with no FK where concurrent instances can race. We inspect the catalog and alter only on drift.
	SELECT attnotnull INTO col_notnull
	FROM pg_attribute
	WHERE attrelid = 'book_edition_links'::regclass AND attname = 'created_by' AND NOT attisdropped;

	IF col_notnull THEN
		ALTER TABLE "book_edition_links" ALTER COLUMN "created_by" DROP NOT NULL;
	END IF;

	SELECT confdeltype INTO fk_deltype
	FROM pg_constraint
	WHERE conname = 'book_edition_links_created_by_users_id_fk' AND conrelid = 'book_edition_links'::regclass;

	-- confdeltype 'n' = ON DELETE SET NULL. Recreate only when the FK is missing or has a different action.
	IF fk_deltype IS DISTINCT FROM 'n'::"char" THEN
		ALTER TABLE "book_edition_links" DROP CONSTRAINT IF EXISTS "book_edition_links_created_by_users_id_fk";
		ALTER TABLE "book_edition_links" ADD CONSTRAINT "book_edition_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "book_edition_links_text_book_id_unique" ON "book_edition_links" USING btree ("text_book_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "book_edition_links_audio_book_id_unique" ON "book_edition_links" USING btree ("audio_book_id");
`;
