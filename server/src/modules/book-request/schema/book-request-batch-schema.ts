export const BOOK_REQUEST_BATCH_SCHEMA_SQL = `
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "kind" varchar(10) NOT NULL DEFAULT 'single';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_requests_kind_chk') THEN
    ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_kind_chk" CHECK ("kind" IN ('single', 'batch'));
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "book_request_batch_units" (
  "id" serial PRIMARY KEY,
  "request_id" integer NOT NULL REFERENCES "book_requests"("id") ON DELETE CASCADE,
  "unit_index" integer NOT NULL,
  "title" varchar(500),
  "primary_path" text NOT NULL,
  "file_paths" text[] NOT NULL,
  "media_kind" varchar(10) NOT NULL,
  "size_bytes" bigint,
  "status" varchar(10) NOT NULL DEFAULT 'waiting',
  "book_dock_file_id" integer,
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "book_request_batch_units_status_chk" CHECK ("status" IN ('waiting', 'placing', 'in_dock', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "book_request_batch_units_request_unit_uidx" ON "book_request_batch_units" ("request_id", "unit_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "book_request_batch_units_dock_file_idx" ON "book_request_batch_units" ("book_dock_file_id");
`;
