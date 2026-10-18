import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export const SHELFMARK_SCHEMA_SQL = `
ALTER TABLE "book_request_downloads" ADD COLUMN IF NOT EXISTS "content_file_count" integer;
--> statement-breakpoint
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid = 'public.download_clients'::regclass AND conname = 'download_clients_adapter_type_chk'
    AND pg_get_constraintdef(oid) NOT LIKE '%shelfmark%';
  IF definition IS NOT NULL THEN
    ALTER TABLE "download_clients" DROP CONSTRAINT "download_clients_adapter_type_chk";
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s OR %I = %L)',
      'download_clients', 'download_clients_adapter_type_chk', regexp_replace(definition, '^CHECK ', ''), 'adapter_type', 'shelfmark');
  END IF;
END $$;
--> statement-breakpoint
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid = 'public.book_request_downloads'::regclass AND conname = 'book_request_downloads_source_chk'
    AND pg_get_constraintdef(oid) NOT LIKE '%shelfmark%';
  IF definition IS NOT NULL THEN
    ALTER TABLE "book_request_downloads" DROP CONSTRAINT "book_request_downloads_source_chk";
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s OR %I = %L)',
      'book_request_downloads', 'book_request_downloads_source_chk', regexp_replace(definition, '^CHECK ', ''), 'source', 'shelfmark');
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fork_parked_check_rows') IS NOT NULL THEN
    UPDATE "download_clients" t SET "adapter_type" = p.original_value
    FROM fork_parked_check_rows p WHERE p.table_name = 'download_clients' AND p.column_name = 'adapter_type' AND p.row_id = t.id AND t."adapter_type" = 'qbittorrent';
    DELETE FROM fork_parked_check_rows WHERE table_name = 'download_clients' AND column_name = 'adapter_type';
    UPDATE "download_clients" t SET "enabled" = p.original_value::boolean
    FROM fork_parked_check_rows p WHERE p.table_name = 'download_clients' AND p.column_name = 'enabled' AND p.row_id = t.id AND t."enabled" = false;
    DELETE FROM fork_parked_check_rows WHERE table_name = 'download_clients' AND column_name = 'enabled';
    UPDATE "book_request_downloads" t SET "source" = p.original_value
    FROM fork_parked_check_rows p WHERE p.table_name = 'book_request_downloads' AND p.column_name = 'source' AND p.row_id = t.id AND t."source" = 'direct_url';
    DELETE FROM fork_parked_check_rows WHERE table_name = 'book_request_downloads' AND column_name = 'source';
  END IF;
END $$;
`;

export async function readShelfmarkSchemaChanges(
  db: Pick<NodePgDatabase<Record<string, unknown>>, 'execute'>,
): Promise<{ constraintsExtended: number; rowsRestored: number }> {
  const constraints = await db.execute<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM pg_constraint WHERE
      ((conrelid = 'public.download_clients'::regclass AND conname = 'download_clients_adapter_type_chk') OR
       (conrelid = 'public.book_request_downloads'::regclass AND conname = 'book_request_downloads_source_chk'))
      AND pg_get_constraintdef(oid) NOT LIKE '%shelfmark%'
    `);
  const parked = await db.execute<{ present: boolean }>(sql`SELECT to_regclass('public.fork_parked_check_rows') IS NOT NULL AS present`);
  let rowsRestored = 0;
  if (parked.rows[0].present) {
    const rows = await db.execute<{ count: number }>(sql`
        SELECT count(*)::integer AS count FROM fork_parked_check_rows p WHERE
        (p.table_name = 'download_clients' AND p.column_name = 'adapter_type' AND EXISTS
          (SELECT 1 FROM download_clients t WHERE t.id = p.row_id AND t.adapter_type = 'qbittorrent')) OR
        (p.table_name = 'download_clients' AND p.column_name = 'enabled' AND EXISTS
          (SELECT 1 FROM download_clients t WHERE t.id = p.row_id AND t.enabled = false)) OR
        (p.table_name = 'book_request_downloads' AND p.column_name = 'source' AND EXISTS
          (SELECT 1 FROM book_request_downloads t WHERE t.id = p.row_id AND t.source = 'direct_url'))
      `);
    rowsRestored = rows.rows[0].count;
  }
  return { constraintsExtended: constraints.rows[0].count, rowsRestored };
}
