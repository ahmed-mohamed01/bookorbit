export const RELEASE_INSPECTION_FACTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "release_inspection_facts" (
  "info_hash" text PRIMARY KEY,
  "file_count" integer NOT NULL,
  "unit_count" integer,
  "primary_file_count" integer NOT NULL,
  "formats" text[] NOT NULL DEFAULT '{}',
  "inspected_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
alter table release_inspection_facts add column if not exists unit_count integer;
`;
