-- Backfill existing rows to the ASIN/ISBN-10 canonical form the ABS matcher now
-- expects. normalizeAsin() (trim + uppercase, empty -> null) is applied at both
-- query and write boundaries, and ISBN-10 check chars are uppercased on write, but
-- rows written before that fix are stored un-normalized and silently miss exact
-- matches. Both statements are idempotent (the IS DISTINCT FROM guard skips
-- already-normalized rows, so re-running is a no-op).
UPDATE "book_metadata"
SET "audible_id" = NULLIF(upper(trim("audible_id")), '')
WHERE "audible_id" IS NOT NULL
  AND "audible_id" IS DISTINCT FROM NULLIF(upper(trim("audible_id")), '');
--> statement-breakpoint
UPDATE "book_metadata"
SET "isbn10" = upper("isbn10")
WHERE "isbn10" IS NOT NULL
  AND "isbn10" IS DISTINCT FROM upper("isbn10");
