import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as dbSchema from '../../db/schema';
import { EditionSyncRepository } from './edition-sync.repository';
import type { EditionSyncBookListSettings } from './edition-sync.types';
import { editionSyncUserSettings } from './schema/edition-sync.schema';

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

it.each([true, false])('builds the wanting CTE from default-on users (pinned=%s)', async (pinnedOnly) => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  await new EditionSyncRepository({ execute } as never).findNextQueuedBook({ pinnedOnly });
  const query = sqlText(execute.mock.calls[0][0]);
  expect(query).toContain('FROM users u');
  expect(query).toContain('LEFT JOIN edition_sync_user_settings s');
  expect(query).toContain('COALESCE(s.enabled, true)');
  expect(query).toContain("COALESCE(s.book_sync_mode, 'all_eligible')");
  expect(query).not.toContain('edition_sync_settings ');
});
it.each(['countUnused', 'findUnused', 'deleteUnusedIndexRow'] as const)('%s does not depend on the server switch', async (method) => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ returning });
  const db = { execute, delete: vi.fn().mockReturnValue({ where }) };
  const repo = new EditionSyncRepository(db as never);
  if (method === 'deleteUnusedIndexRow') await repo.deleteUnusedIndexRow(4, { status: 'ready', indexPath: '/a' });
  else await repo[method](10);
  const query = sqlText(method === 'deleteUnusedIndexRow' ? where.mock.calls[0][0] : execute.mock.calls[0][0]);
  expect(query).toContain('wanting AS (');
  expect(query).not.toMatch(/edition_sync_settings\b/);
});
it('uses a true column default for scope-only inserts without overwriting existing enabled values', async () => {
  expect(editionSyncUserSettings.enabled.default).toBe(true);
  const { repo, chain } = setup();
  await repo.upsertUserSettings(7, { bookSyncMode: 'selected_only' });
  expect(chain.values.mock.calls[0][0]).not.toHaveProperty('enabled');
  expect(chain.onConflictDoUpdate.mock.calls[0][0].set).not.toHaveProperty('enabled');
});
it('persists the server switch on admin inserts and updates', async () => {
  const { repo, chain } = setup();
  await repo.updateAdminSettings({ enabled: true }, 7);
  expect(chain.values.mock.calls[0][0]).toMatchObject({ enabled: true });
  expect(chain.onConflictDoUpdate.mock.calls[0][0].set).toMatchObject({ enabled: true });
});

it('caches the server switch briefly and drops the cache on an admin update', async () => {
  const { repo } = setup();
  const find = vi.spyOn(repo, 'findAdminSettings').mockResolvedValue({ enabled: true } as never);
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  await expect(repo.isServerEnabled()).resolves.toBe(true);
  find.mockResolvedValue({ enabled: false } as never);
  await expect(repo.isServerEnabled()).resolves.toBe(true);
  expect(find).toHaveBeenCalledTimes(1);
  now.mockReturnValue(15_001);
  await expect(repo.isServerEnabled()).resolves.toBe(false);
  find.mockResolvedValue({ enabled: true } as never);
  await repo.updateAdminSettings({ enabled: true }, 7);
  await expect(repo.isServerEnabled()).resolves.toBe(true);
  expect(find).toHaveBeenCalledTimes(3);
  now.mockRestore();
});

it('defaults a missing admin singleton to disabled', async () => {
  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  await expect(new EditionSyncRepository({ select } as never).findAdminSettings()).resolves.toMatchObject({ enabled: false });
});

describe('settings books list', () => {
  const noFilters = { includeTagIds: [], includeGenreIds: [], excludeTagIds: [], excludeGenreIds: [] };
  const allEligible: EditionSyncBookListSettings = { effectiveEnabled: true, bookSyncMode: 'all_eligible' };

  function listQueries(user: object, settings = allEligible, q?: string) {
    const db = drizzle.mock({ schema: dbSchema });
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    Object.assign(db, { execute });
    return new EditionSyncRepository(db as never).listBooks(user as never, settings, 'queued', q, 3).then(() => {
      expect(execute).toHaveBeenCalledTimes(2);
      return execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query));
    });
  }

  it.each([false, true])('uses scoped set eligibility, bounded paging and grouped counts (superuser=%s)', async (isSuperuser) => {
    const [page, counts] = await listQueries(
      { id: 17, isSuperuser, contentFilters: noFilters },
      { effectiveEnabled: true, bookSyncMode: 'selected_only' },
      '100%_\\',
    );
    for (const query of [page, counts]) {
      expect(query.sql).toContain('eligible_files AS');
      expect(query.sql).toContain('user_library_access');
      expect(query.sql).toContain('o.user_id =');
      expect(query.params).toContain(isSuperuser);
      expect(query.params).toContain('%100\\%\\_\\\\%');
      expect(query.sql).not.toContain('OFFSET 256');
    }
    expect(page.sql).toContain('ORDER BY lower(s.title), s.id');
    expect(page.params).toEqual(expect.arrayContaining([50, 100]));
    expect(counts.sql.slice(counts.sql.lastIndexOf('SELECT count(*)')).match(/count\(\*\) FILTER/g)).toHaveLength(4);
    expect(counts.sql).not.toContain('LIMIT');
    expect(page.sql).toContain("ESCAPE '\\'");
  });

  it('filters the page and counts each filter from the same status sets', async () => {
    const [page, counts] = await listQueries({ id: 17, isSuperuser: true, contentFilters: noFilters });
    expect(page.sql).toContain('WHERE status IN ($');
    expect(page.params).toEqual(expect.arrayContaining(['queued', 'stale', 'running']));
    for (const name of ['problems', 'queued', 'synced', 'off']) expect(counts.sql).toContain(`::int AS "${name}"`);
    expect(counts.params).toEqual(expect.arrayContaining(['failed', 'queued', 'stale', 'running', 'ready', 'off']));
  });

  it('only offers the whisper fallback on a failed row, which an off row never is', async () => {
    const [page] = await listQueries({ id: 17, isSuperuser: true, contentFilters: noFilters });
    expect(page.sql).toContain("(s.status = 'failed' AND");
    expect(page.sql).toContain("CASE WHEN NOT enabled THEN 'off'");
  });

  it('takes the title from book metadata, falling back to the folder, for the search and the order', async () => {
    const [page, counts] = await listQueries({ id: 17, isSuperuser: true, contentFilters: noFilters }, allEligible, 'dune');
    for (const query of [page, counts]) {
      expect(query.sql).toContain('LEFT JOIN book_metadata m ON m.book_id = b.id');
      expect(query.sql).toContain('COALESCE(m.title, b.folder_path) AS title');
      expect(query.sql).toContain('AND COALESCE(m.title, b.folder_path) ILIKE');
      expect(query.sql).not.toContain('b.title');
    }
  });

  it('applies the content filters of a non-superuser to rows and counts alike', async () => {
    const contentFilters = { ...noFilters, excludeTagIds: [4] };
    const [page, counts] = await listQueries({ id: 17, isSuperuser: false, contentFilters });
    for (const query of [page, counts]) {
      expect(query.sql).toContain('EXISTS (SELECT 1 FROM books WHERE books.id = b.id AND');
      expect(query.sql).toContain('"book_tags"."book_id" = "books"."id"');
    }
  });

  it('skips the content filters for a superuser', async () => {
    const [page] = await listQueries({ id: 1, isSuperuser: true, contentFilters: { ...noFilters, excludeTagIds: [4] } });
    expect(page.sql).not.toContain('book_tags');
  });

  it('turns every row off while the user sync is off', async () => {
    const [page, counts] = await listQueries(
      { id: 17, isSuperuser: true, contentFilters: noFilters },
      { effectiveEnabled: false, bookSyncMode: 'all_eligible' },
    );
    for (const query of [page, counts]) expect(query.params).toContain(false);
  });
});
