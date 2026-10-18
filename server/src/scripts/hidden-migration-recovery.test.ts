import type { Pool } from 'pg';

import { applyMigrationsHiddenByRenumberedForkRows, findHiddenMigrations } from './hidden-migration-recovery';

const FORK_SHELFMARK = '8f494e7a42e0635f666be4eb6821f2cc22c4c5eaa49b921126666e8b7d832e68';
const FORK_FILE_COUNT = 'e00e8c085cfedc1ad4714389b1b039a8b02d99bc7dd82991e492b0fc8a5889fe';

const migrations = [
  { hash: 'old', folderMillis: 100, sql: ['SELECT old'] },
  { hash: 'anchor', folderMillis: 200, sql: ['SELECT anchor'] },
  { hash: 'upstream-a', folderMillis: 300, sql: ['SELECT a1', 'SELECT a2'] },
  { hash: 'upstream-b', folderMillis: 400, sql: ['SELECT b'] },
  { hash: FORK_SHELFMARK, folderMillis: 500, sql: ['SELECT shelfmark'] },
  { hash: FORK_FILE_COUNT, folderMillis: 600, sql: ['SELECT file_count'] },
];

function ledger(hashes: string[]) {
  return hashes.map((hash) => ({ hash, created_at: migrations.find((m) => m.hash === hash)?.folderMillis ?? 0 }));
}

function createPool(tableName: string | null, recorded: string[]) {
  const query = vi.fn(async (statement: string): Promise<{ rows: unknown[]; rowCount?: number }> => {
    if (statement.includes('to_regclass')) return Promise.resolve({ rows: [{ tableName }] });
    if (statement.startsWith('SELECT hash')) return Promise.resolve({ rows: ledger(recorded) });
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(() => Promise.resolve({ query, release })) } as unknown as Pick<Pool, 'connect'>;
  return { pool, query, release };
}

describe('findHiddenMigrations', () => {
  it('returns upstream migrations journaled before a recorded renumbered fork migration', () => {
    const hidden = findHiddenMigrations(migrations, ledger(['old', 'anchor', FORK_SHELFMARK, FORK_FILE_COUNT]));

    expect(hidden.map((migration) => migration.hash)).toEqual(['upstream-a', 'upstream-b']);
  });

  it('never replays migrations older than the newest recorded upstream migration', () => {
    const hidden = findHiddenMigrations(migrations, ledger(['anchor', FORK_SHELFMARK]));

    expect(hidden.map((migration) => migration.hash)).toEqual(['upstream-a', 'upstream-b']);
  });

  it('recovers when fork migrations are absent from the journal', () => {
    expect(findHiddenMigrations(migrations.slice(0, 4), ledger(['anchor', FORK_SHELFMARK])).map((m) => m.hash)).toEqual(['upstream-a', 'upstream-b']);
  });

  it('leaves pending migrations newer than the fork rows to Drizzle', () => {
    expect(
      findHiddenMigrations(migrations, [
        { hash: 'anchor', created_at: '200' },
        { hash: FORK_SHELFMARK, created_at: '250' },
      ]),
    ).toEqual([]);
  });

  it('returns nothing once the gap is filled or when no fork row is recorded', () => {
    expect(findHiddenMigrations(migrations, ledger(['old', 'anchor', 'upstream-a', 'upstream-b', FORK_SHELFMARK, FORK_FILE_COUNT]))).toEqual([]);
    expect(findHiddenMigrations(migrations, ledger(['old', 'anchor']))).toEqual([]);
    expect(findHiddenMigrations(migrations, ledger([]))).toEqual([]);
  });
});

describe('applyMigrationsHiddenByRenumberedForkRows', () => {
  it('does nothing before Drizzle has created its ledger table', async () => {
    const { pool, query, release } = createPool(null, []);

    await expect(applyMigrationsHiddenByRenumberedForkRows(pool, migrations)).resolves.toEqual({ appliedMigrations: 0 });
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('runs each hidden statement and records the migration in one transaction', async () => {
    const { pool, query } = createPool('drizzle.__drizzle_migrations', ['old', 'anchor', FORK_SHELFMARK, FORK_FILE_COUNT]);

    await expect(applyMigrationsHiddenByRenumberedForkRows(pool, migrations)).resolves.toEqual({ appliedMigrations: 2 });
    const statements = query.mock.calls.map(([statement]) => statement);
    expect(statements.slice(statements.indexOf('SELECT a1'))).toEqual([
      'SELECT a1',
      'SELECT a2',
      'INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)',
      'SELECT b',
      'INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)',
      'COMMIT',
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO'), ['upstream-a', 300]);
  });

  it('rolls back when a hidden statement fails', async () => {
    const { pool, query, release } = createPool('drizzle.__drizzle_migrations', ['anchor', FORK_SHELFMARK]);
    query.mockImplementation((statement: string) => {
      if (statement.includes('to_regclass')) return Promise.resolve({ rows: [{ tableName: 'drizzle.__drizzle_migrations' }] });
      if (statement.startsWith('SELECT hash')) return Promise.resolve({ rows: ledger(['anchor', FORK_SHELFMARK]) });
      if (statement === 'SELECT a2') return Promise.reject(new Error('relation exists'));
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(applyMigrationsHiddenByRenumberedForkRows(pool, migrations)).rejects.toThrow('relation exists');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
