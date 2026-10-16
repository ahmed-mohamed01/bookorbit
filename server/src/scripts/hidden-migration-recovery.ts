import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { Pool } from 'pg';

import { sanitizeLogValue } from '../common/utils/log-sanitize.utils';

// Fork migrations that shipped before an upstream sync, then were renumbered after upstream's.
// Drizzle applies only migrations newer than the newest ledger row, so a database that ran one of
// these first never sees the upstream migrations now journaled ahead of it. Add a hash here
// whenever a sync renumbers a fork migration that has already shipped.
const RENUMBERED_FORK_MIGRATION_HASHES = new Set<string>([
  // 0117_add_shelfmark_download_client (shipped as 0111)
  '8f494e7a42e0635f666be4eb6821f2cc22c4c5eaa49b921126666e8b7d832e68',
  // 0118_add_download_content_file_count (shipped as 0112)
  'e00e8c085cfedc1ad4714389b1b039a8b02d99bc7dd82991e492b0fc8a5889fe',
]);

type RecoveryMigration = Pick<MigrationMeta, 'folderMillis' | 'hash' | 'sql'>;

/**
 * Migrations missing from the ledger that sit between the newest recorded upstream migration and
 * the newest recorded renumbered fork migration. Anything older than the upstream anchor is left
 * alone, so an edited historical migration is never replayed.
 */
export function findHiddenMigrations(migrations: readonly RecoveryMigration[], recordedHashes: ReadonlySet<string>): RecoveryMigration[] {
  let anchor = -1;
  let lastFork = -1;
  migrations.forEach((migration, index) => {
    if (!recordedHashes.has(migration.hash)) return;
    if (RENUMBERED_FORK_MIGRATION_HASHES.has(migration.hash)) lastFork = index;
    else anchor = index;
  });
  if (lastFork <= anchor) return [];
  return migrations.slice(anchor + 1, lastFork).filter((migration) => !recordedHashes.has(migration.hash));
}

export async function applyMigrationsHiddenByRenumberedForkRows(
  pool: Pick<Pool, 'connect'>,
  migrations: readonly RecoveryMigration[],
): Promise<{ appliedMigrations: number }> {
  const client = await pool.connect();
  const startedAt = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('bookorbit'), hashtext('migration-ledger-compatibility'))`);
    const table = await client.query<{ tableName: string | null }>(`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS "tableName"`);
    if (table.rows[0]?.tableName === null || table.rows.length === 0) {
      await client.query('COMMIT');
      return { appliedMigrations: 0 };
    }

    const ledger = await client.query<{ hash: string }>(`SELECT hash FROM drizzle.__drizzle_migrations`);
    const hidden = findHiddenMigrations(migrations, new Set(ledger.rows.map((row) => row.hash)));
    for (const migration of hidden) {
      for (const statement of migration.sql) {
        await client.query(statement);
      }
      await client.query(`INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)`, [migration.hash, migration.folderMillis]);
    }
    await client.query('COMMIT');
    if (hidden.length > 0) {
      console.warn(
        `[db.hidden-migration-recovery] [end] durationMs=${Date.now() - startedAt} applied=${hidden.length} - migrations hidden by renumbered fork rows applied`,
      );
    }
    return { appliedMigrations: hidden.length };
  } catch (error) {
    await client.query('ROLLBACK');
    const errorClass = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[db.hidden-migration-recovery] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - hidden migrations could not be applied`,
    );
    throw error;
  } finally {
    client.release();
  }
}
