import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { EditionSyncRepository } from './edition-sync.repository';

function setup() {
  const chain = { set: vi.fn(), where: vi.fn(), values: vi.fn(), onConflictDoUpdate: vi.fn(), returning: vi.fn().mockResolvedValue([]) };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.values.mockReturnValue(chain);
  chain.onConflictDoUpdate.mockReturnValue(chain);
  const db = { insert: vi.fn().mockReturnValue(chain), update: vi.fn().mockReturnValue(chain), delete: vi.fn().mockReturnValue(chain) };
  return { repo: new EditionSyncRepository(db as never), chain };
}
const sqlText = (query: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(query).sql;

describe('EditionSyncRepository write guards', () => {
  it('preserves the pin and claims only queueable rows', async () => {
    const { repo, chain } = setup();
    await repo.claimIndexRow(7, 'job', new Date());
    const conflict = chain.onConflictDoUpdate.mock.calls[0][0];
    expect(conflict.set).not.toHaveProperty('pinnedAt');
    expect(sqlText(conflict.setWhere)).toContain("= 'stale'");
    expect(sqlText(conflict.setWhere)).toContain("= 'failed'");
    expect(sqlText(conflict.setWhere)).toContain('retry_requested');
    expect(sqlText(conflict.setWhere)).toContain('files_changed_at');
    expect(sqlText(conflict.setWhere)).toContain('IS NOT DISTINCT FROM');
  });
  it('preserves the first pin unless explicitly retrying', async () => {
    const { repo, chain } = setup();
    await repo.pinBook(7, new Date(), false);
    expect(sqlText(chain.onConflictDoUpdate.mock.calls[0][0].set.pinnedAt)).toContain('COALESCE');
    const at = new Date();
    await repo.pinBook(7, at, true);
    expect(chain.onConflictDoUpdate.mock.calls[1][0].set.pinnedAt).toBe(at);
  });
  it('guards verification writes against running rows', async () => {
    const { repo, chain } = setup();
    await repo.markStale(7, 'audio_changed');
    expect(sqlText(chain.where.mock.calls[0][0])).toContain("<> 'running'");
    await repo.markRunningStale(7, 'yielded');
    expect(new PgDialect().sqlToQuery(chain.where.mock.calls[1][0]).params).toContain('running');
  });
  it('checks wanted, pin, status and path atomically before deleting', async () => {
    const { repo, chain } = setup();
    await repo.deleteUnusedIndexRow(7, { status: 'ready', indexPath: '/index' });
    const query = sqlText(chain.where.mock.calls[0][0]);
    expect(query).toContain('AND NOT EXISTS');
    expect(query).toContain('pinned_at');
    expect(query).toContain('IS NOT DISTINCT FROM');
    expect(chain.returning).toHaveBeenCalled();
  });
});

describe('files changed pin query', () => {
  it('bounds wanted stale books by quiet period and preserves retry state', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ book_id: 1 }] });
    const repo = new EditionSyncRepository({ execute } as never);
    const cutoff = new Date();
    expect(await repo.pinFilesChangedBooks(cutoff, 20)).toBe(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain("i.status = 'stale'");
    expect(query.params).toEqual(expect.arrayContaining(['epub_changed', 'audio_changed', 'file_missing', 'files_changed']));
    expect(query.sql).toContain('JOIN libraries l');
    expect(query.sql).toContain("b.status = 'present'");
    expect(query.sql).toContain('NOT f.media_overlay_available');
    expect(query.sql).toContain('AND NOT EXISTS');
    expect(query.sql).toContain('OFFSET');
    expect(query.sql).toContain('i.pinned_at IS NULL');
    expect(query.sql).toContain('i.files_changed_at IS NULL OR i.files_changed_at <=');
    expect(query.sql).toContain('FOR UPDATE OF i SKIP LOCKED');
    expect(query.sql).toContain('EXISTS');
    expect(query.sql).not.toContain('retry_requested =');
    expect(query.params).toContain(20);
  });
});

describe('ready writes', () => {
  it('atomically preserves changes since the snapshot on updates and upsert conflicts', async () => {
    const { repo, chain } = setup();
    const since = new Date(1234);
    await repo.updateIndexRow(7, { status: 'ready', invalidatedAt: null }, since);
    await repo.upsertIndexRow(7, { status: 'ready', invalidatedAt: null }, since);
    for (const set of [chain.set.mock.calls[0][0], chain.onConflictDoUpdate.mock.calls[0][0].set]) {
      const query = new PgDialect().sqlToQuery(set.invalidatedAt);
      expect(query.sql).toMatch(/CASE WHEN .*files_changed_at.* > .* THEN now\(\) ELSE NULL END/);
      expect(query.params).toContain(since);
      expect(set.invalidatedReason).toBeNull();
    }
  });
  it('never writes null for the file-change mode', async () => {
    const { repo, chain } = setup();
    await repo.updateAdminSettings({ onFilesChanged: null } as never, 7);
    expect(chain.onConflictDoUpdate.mock.calls[0][0].set).not.toHaveProperty('onFilesChanged');
  });
});
describe('pinned quiet period', () => {
  it.each([true, false])('applies the quiet period to pinned claims in either queue path: %s', async (pinnedOnly) => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await new EditionSyncRepository({ execute } as never).findNextQueuedBook({ pinnedOnly });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain('i.pinned_at IS NULL OR i.retry_requested');
    expect(query.sql).toContain('i.invalidated_reason NOT IN');
    expect(query.sql).toContain('i.files_changed_at IS NULL OR i.files_changed_at <= now() -');
    expect(query.params).toContain(600_000);
    expect(query.params).toEqual(expect.arrayContaining(['epub_changed', 'audio_changed', 'file_missing', 'files_changed']));
  });
});

describe('content check concurrency guards', () => {
  it('only stales the checked provenance and moves retries to the tail of the recheck queue', async () => {
    const { repo, chain } = setup();
    const provenance = { bookId: 7 } as never;
    await repo.markStale(7, 'audio_changed', provenance);
    const query = new PgDialect().sqlToQuery(chain.where.mock.calls[0][0]);
    expect(query.sql).toContain('"provenance" =');
    expect(query.sql).toContain('::jsonb');
    expect(query.params).toContain(JSON.stringify(provenance));
    await repo.flagRecheck(7, true);
    expect(sqlText(chain.set.mock.calls[1][0].invalidatedAt)).toBe('now()');
    await repo.flagRecheck(7);
    expect(sqlText(chain.set.mock.calls[2][0].invalidatedAt)).toContain('coalesce');
  });
});

it.each([{ rows: [] }, { rows: [{ bookId: 7 }] }])('returns whether guarded markStale updated a row: %j', async ({ rows }) => {
  const { repo, chain } = setup();
  chain.returning.mockResolvedValue(rows);
  expect(await repo.markStale(7, 'epub_changed', {} as never)).toBe(rows.length > 0);
  expect(chain.returning).toHaveBeenCalled();
  expect(sqlText(chain.where.mock.calls[0][0])).toContain('provenance');
});
