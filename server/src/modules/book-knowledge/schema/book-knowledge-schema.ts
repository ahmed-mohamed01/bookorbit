export const BOOK_KNOWLEDGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS book_knowledge_index (
 book_id integer PRIMARY KEY,
 fingerprint text NOT NULL, text_version integer NOT NULL, terms_version integer NOT NULL,
 status text NOT NULL CHECK (status IN ('queued','running','ready','failed')), progress integer NOT NULL DEFAULT 0,
 error text, stage_ms jsonb, sentence_count integer, term_count integer, artifact_bytes integer,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_knowledge_index_book_fk') THEN
  ALTER TABLE "book_knowledge_index" ADD CONSTRAINT "book_knowledge_index_book_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE CASCADE;
 END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS book_knowledge_index_book_idx ON book_knowledge_index(book_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS book_knowledge_index_status_idx ON book_knowledge_index(status, book_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS book_knowledge_cards (
 id serial PRIMARY KEY, book_id integer NOT NULL,
 fingerprint text NOT NULL, term_key text NOT NULL, cutoff_ordinal integer NOT NULL, model text NOT NULL,
 prompt_version integer NOT NULL, evidence_hash text NOT NULL, card jsonb NOT NULL, checks jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_knowledge_cards_book_fk') THEN
  ALTER TABLE "book_knowledge_cards" ADD CONSTRAINT "book_knowledge_cards_book_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE CASCADE;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS book_knowledge_cards_cache_idx ON book_knowledge_cards(book_id,fingerprint,term_key,cutoff_ordinal,model,prompt_version,evidence_hash);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS book_knowledge_kind_reviews (
 id serial PRIMARY KEY, book_id integer NOT NULL,
 fingerprint text NOT NULL, request_hash text NOT NULL, answers jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'book_knowledge_kind_reviews'::regclass AND contype = 'f'
   AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'book_knowledge_kind_reviews'::regclass AND attname = 'book_id')]
 ) THEN
  ALTER TABLE "book_knowledge_kind_reviews" ADD CONSTRAINT "book_knowledge_kind_reviews_book_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE CASCADE;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS book_knowledge_kind_reviews_cache_idx ON book_knowledge_kind_reviews(book_id,fingerprint,request_hash);
--> statement-breakpoint
DROP TABLE IF EXISTS book_knowledge_settings;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS book_knowledge_cleanup (book_id integer PRIMARY KEY);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION book_knowledge_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO book_knowledge_cleanup(book_id) VALUES(OLD.book_id) ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER book_knowledge_deleted AFTER DELETE ON book_knowledge_index FOR EACH ROW EXECUTE FUNCTION book_knowledge_deleted();
--> statement-breakpoint
DROP TRIGGER IF EXISTS book_knowledge_file_deleted ON book_files;
--> statement-breakpoint
DROP FUNCTION IF EXISTS book_knowledge_file_deleted();
`;
