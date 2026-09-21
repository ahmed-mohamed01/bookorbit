import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { Pool } from 'pg';

import { sanitizeLogValue } from '../common/utils/log-sanitize.utils';

export const PARKED_CHECK_ROWS_TABLE = 'fork_parked_check_rows';

// Fork values stored in a nullable upstream column that a CHECK constraint guards. When a pending
// upstream migration recreates the constraint, its ADD CONSTRAINT validates every row, rejects
// these, and rolls the whole migration run back. Parking nulls the value (NULL passes a CHECK)
// and records the row, so the owning module's schema bootstrap can restore it once it has
// re-extended the constraint. See FORK_MAINTENANCE.md, "Schema decoupling".
const PARKED_CHECK_VALUES = [
  { table: 'reading_sessions', column: 'source', constraint: 'reading_sessions_source_chk', value: 'audiobookshelf' },
] as const;

type ParkingResult = {
  parkedRows: number;
};

export async function parkRowsBlockingPendingCheckConstraints(
  pool: Pick<Pool, 'connect'>,
  migrations: readonly Pick<MigrationMeta, 'folderMillis' | 'sql'>[],
): Promise<ParkingResult> {
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('bookorbit'), hashtext('check-constraint-row-parking'))`);
    const ledger = await client.query<{ tableName: string | null }>(`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS "tableName"`);
    if (ledger.rows.length === 0 || ledger.rows[0]?.tableName === null) {
      await client.query('COMMIT');
      return { parkedRows: 0 };
    }

    const applied = await client.query<{ lastApplied: string | null }>(
      `SELECT max(created_at)::text AS "lastApplied" FROM drizzle.__drizzle_migrations`,
    );
    const lastApplied = Number(applied.rows[0]?.lastApplied ?? 0);
    const pendingSql = migrations.filter((migration) => migration.folderMillis > lastApplied).flatMap((migration) => migration.sql);

    let parkedRows = 0;
    for (const entry of PARKED_CHECK_VALUES) {
      if (!pendingSql.some((statement) => statement.includes(`"${entry.constraint}"`))) continue;
      const table = await client.query<{ tableName: string | null }>(`SELECT to_regclass($1)::text AS "tableName"`, [`public.${entry.table}`]);
      if (table.rows.length === 0 || table.rows[0]?.tableName === null) continue;

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.${PARKED_CHECK_ROWS_TABLE} (
          table_name text NOT NULL,
          column_name text NOT NULL,
          row_id bigint NOT NULL,
          original_value text NOT NULL,
          parked_at timestamp with time zone NOT NULL DEFAULT now(),
          PRIMARY KEY (table_name, column_name, row_id)
        )
      `);
      await client.query(
        `
        INSERT INTO public.${PARKED_CHECK_ROWS_TABLE} (table_name, column_name, row_id, original_value)
        SELECT $1, $2, id, ${entry.column}
        FROM public.${entry.table}
        WHERE ${entry.column} = $3
        ON CONFLICT DO NOTHING
      `,
        [entry.table, entry.column, entry.value],
      );
      const parked = await client.query(`UPDATE public.${entry.table} SET ${entry.column} = NULL WHERE ${entry.column} = $1`, [entry.value]);
      parkedRows += parked.rowCount ?? 0;
    }

    await client.query('COMMIT');
    if (parkedRows > 0) {
      console.log(
        `[db.check-constraint-row-parking] [end] durationMs=${Date.now() - startedAt} parkedRows=${parkedRows} - fork rows parked ahead of a constraint rebuild`,
      );
    }
    return { parkedRows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const errorClass = error instanceof Error ? error.name : 'UnknownError';
    const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    console.error(
      `[db.check-constraint-row-parking] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - fork row parking failed`,
    );
    throw error;
  } finally {
    client.release();
  }
}
