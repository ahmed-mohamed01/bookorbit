import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PARKED_CHECK_ROWS_TABLE, parkRowsBlockingPendingCheckConstraints } from './check-constraint-row-parking';

const REBUILD = 'ALTER TABLE "reading_sessions" DROP CONSTRAINT "reading_sessions_source_chk";';

function createPool(options: { ledger?: boolean; lastApplied?: string | null; table?: boolean; parked?: number; failOn?: string } = {}) {
  const { ledger = true, lastApplied = '100', table = true, parked = 0, failOn } = options;
  const query = vi.fn((statement: string, params?: unknown[]) => {
    if (failOn && statement.includes(failOn)) return Promise.reject(new Error('boom "quoted"'));
    if (statement.includes(`to_regclass('drizzle.__drizzle_migrations')`)) {
      return Promise.resolve({ rows: [{ tableName: ledger ? 'drizzle.__drizzle_migrations' : null }] });
    }
    if (statement.includes('max(created_at)')) return Promise.resolve({ rows: [{ lastApplied }] });
    if (statement.includes('to_regclass($1)')) return Promise.resolve({ rows: [{ tableName: table ? String(params?.[0]) : null }] });
    if (statement.startsWith('UPDATE')) return Promise.resolve({ rows: [], rowCount: parked });
    return Promise.resolve({ rows: [] });
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(() => Promise.resolve({ query, release })) } as unknown as Pick<Pool, 'connect'>;
  return { pool, query, release };
}

function statementsOf(query: ReturnType<typeof createPool>['query']): string[] {
  return query.mock.calls.map(([statement]) => statement);
}

describe('parkRowsBlockingPendingCheckConstraints', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does nothing on a fresh database with no migration ledger', async () => {
    const { pool, query, release } = createPool({ ledger: false });

    await expect(parkRowsBlockingPendingCheckConstraints(pool, [{ folderMillis: 200, sql: [REBUILD] }])).resolves.toEqual({ parkedRows: 0 });

    expect(statementsOf(query).some((statement) => statement.startsWith('UPDATE'))).toBe(false);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('leaves rows alone when the constraint rebuild is already applied', async () => {
    const { pool, query } = createPool({ lastApplied: '200' });

    await expect(parkRowsBlockingPendingCheckConstraints(pool, [{ folderMillis: 200, sql: [REBUILD] }])).resolves.toEqual({ parkedRows: 0 });

    expect(statementsOf(query).some((statement) => statement.includes(PARKED_CHECK_ROWS_TABLE))).toBe(false);
  });

  it('leaves rows alone when no pending migration touches the constraint', async () => {
    const { pool, query } = createPool();

    await expect(
      parkRowsBlockingPendingCheckConstraints(pool, [{ folderMillis: 200, sql: ['ALTER TABLE "books" ADD COLUMN "x" integer;'] }]),
    ).resolves.toEqual({ parkedRows: 0 });

    expect(statementsOf(query).some((statement) => statement.startsWith('UPDATE'))).toBe(false);
  });

  it('skips a table that does not exist yet', async () => {
    const { pool, query } = createPool({ table: false });

    await expect(parkRowsBlockingPendingCheckConstraints(pool, [{ folderMillis: 200, sql: [REBUILD] }])).resolves.toEqual({ parkedRows: 0 });

    expect(statementsOf(query).some((statement) => statement.startsWith('UPDATE'))).toBe(false);
  });

  it('records the rows before nulling them when a pending migration rebuilds the constraint', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { pool, query, release } = createPool({ parked: 223 });

    await expect(parkRowsBlockingPendingCheckConstraints(pool, [{ folderMillis: 200, sql: [REBUILD] }])).resolves.toEqual({ parkedRows: 223 });

    const statements = statementsOf(query);
    const insertAt = statements.findIndex((statement) => statement.includes(`INSERT INTO public.${PARKED_CHECK_ROWS_TABLE}`));
    const updateAt = statements.findIndex((statement) => statement.startsWith('UPDATE public.reading_sessions SET source = NULL'));
    expect(insertAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(insertAt);
    expect(query.mock.calls[insertAt]?.[1]).toEqual(['reading_sessions', 'source', 'audiobookshelf']);
    expect(query.mock.calls[updateAt]?.[1]).toEqual(['audiobookshelf']);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[db.check-constraint-row-parking] [end]'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('parkedRows=223'));
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back, logs a sanitized failure and rethrows', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { pool, query, release } = createPool({ failOn: 'INSERT INTO' });

    await expect(parkRowsBlockingPendingCheckConstraints(pool, [{ folderMillis: 200, sql: [REBUILD] }])).rejects.toThrow('boom');

    expect(statementsOf(query)).toContain('ROLLBACK');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[db.check-constraint-row-parking] [fail]'));
    expect(error).toHaveBeenCalledWith(expect.not.stringContaining('boom "quoted"'));
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('Shelfmark row parking', () => {
  it('parks the adapter and enabled flag before relabeling and disabling the client', async () => {
    const { pool, query } = createPool({ parked: 2 });
    await expect(
      parkRowsBlockingPendingCheckConstraints(pool, [
        { folderMillis: 200, sql: ['ALTER TABLE "download_clients" DROP CONSTRAINT "download_clients_adapter_type_chk";'] },
      ]),
    ).resolves.toEqual({ parkedRows: 2 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT $1, $2, id, adapter_type'), ['download_clients', 'adapter_type', 'shelfmark']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('enabled::text'), ['download_clients', 'enabled', 'shelfmark']);
    expect(query).toHaveBeenCalledWith('UPDATE public.download_clients SET adapter_type = $2, enabled = false WHERE adapter_type = $1', [
      'shelfmark',
      'qbittorrent',
    ]);
    const statements = statementsOf(query);
    expect(statements.findIndex((s) => s.includes('enabled::text'))).toBeLessThan(
      statements.findIndex((s) => s.startsWith('UPDATE public.download_clients')),
    );
  });

  it('relabels Shelfmark downloads only for a pending source constraint rebuild', async () => {
    const { pool, query } = createPool({ parked: 3 });
    await expect(
      parkRowsBlockingPendingCheckConstraints(pool, [
        { folderMillis: 200, sql: ['ALTER TABLE "book_request_downloads" DROP CONSTRAINT "book_request_downloads_source_chk";'] },
      ]),
    ).resolves.toEqual({ parkedRows: 3 });
    expect(query).toHaveBeenCalledWith('UPDATE public.book_request_downloads SET source = $2 WHERE source = $1', ['shelfmark', 'direct_url']);
    expect(statementsOf(query).some((s) => s.includes('UPDATE public.download_clients'))).toBe(false);
  });
});
