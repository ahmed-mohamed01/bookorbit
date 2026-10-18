export const BOOK_COVER_PLACEHOLDER_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS "book_cover_placeholders" (
  "book_id" integer NOT NULL,
  "medium" varchar(5) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("book_id", "medium"),
  CHECK ("medium" IN ('ebook', 'audio'))
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'book_cover_placeholders_book_id_books_id_fk' AND conrelid = 'book_cover_placeholders'::regclass
  ) THEN
    ALTER TABLE "book_cover_placeholders" ADD CONSTRAINT "book_cover_placeholders_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade;
  END IF;
END $$;
`;
