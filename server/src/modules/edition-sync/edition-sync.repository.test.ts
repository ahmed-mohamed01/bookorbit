import { sql, type SQL } from 'drizzle-orm';
import { DatabaseSync } from 'node:sqlite';
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
  it.each([true, false])('swaps two locked pinned timestamps or skips, moved=%s', async (moved) => {
    const execute = vi
      .fn<(query: SQL) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ target: 7, neighbour: 8 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: moved ? [{ bookId: 7 }, { bookId: 8 }] : [] });
    const transaction = vi.fn((work: (tx: { execute: typeof execute }) => Promise<unknown>) => work({ execute }));
    const repo = new EditionSyncRepository({ transaction } as never);
    await expect(repo.reorderPinnedBook(7, sql`AND b.library_id = 5`, 'move-up')).resolves.toBe(moved);
    expect(sqlText(execute.mock.calls[1]![0])).toContain('(q.pinned_at, -q.book_id) < (t.pinned_at, -t.book_id)');
    expect(sqlText(execute.mock.calls[1]![0])).toContain('AND b.library_id = 5');
    expect(sqlText(execute.mock.calls[3]![0])).toContain('ORDER BY book_id FOR UPDATE');
    expect(sqlText(execute.mock.calls[3]![0])).toContain('SET pinned_at = other.pinned_at');
  });

  it('skips a claim when another book moved ahead during preparation', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ bookId: 8, pinned: true }] });
    const insert = vi.fn();
    const transaction = vi.fn((work: (tx: { execute: typeof execute; insert: typeof insert }) => Promise<unknown>) => work({ execute, insert }));
    const repo = new EditionSyncRepository({ transaction } as never);
    await expect(repo.claimIndexRow(7, 'job', new Date(), null, { pinnedOnly: true })).resolves.toBeNull();
    expect(insert).not.toHaveBeenCalled();
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

describe('EditionSyncRepository relative queue order', () => {
  function dropQueue(targetPinned: boolean | null) {
    const execute = vi
      .fn<(query: SQL) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 7, allowed: true, pinned: false }, ...(targetPinned === null ? [] : [{ id: 12, allowed: true, pinned: targetPinned }])],
      });
    const transaction = vi.fn((work: (tx: { execute: typeof execute }) => Promise<unknown>) => work({ execute }));
    return { execute, repo: new EditionSyncRepository({ transaction } as never) };
  }

  it.each([
    ['before', '<'],
    ['after', '>'],
  ] as const)('promotes a backlog book %s a pin using its two new neighbours', async (place, compare) => {
    const { execute, repo } = dropQueue(true);
    execute.mockResolvedValueOnce({ rows: [{ moved: true, spread: false }] });
    await expect(repo.reorderTo(7, 12, place, sql`AND b.library_id = 5`)).resolves.toBe('done');
    const placement = sqlText(execute.mock.calls[4]![0]);
    expect(placement).toContain(`(q.pinned_at, -q.book_id) ${compare} (a.pinned_at, -a.book_id)`);
    expect(placement).toContain('a.pinned_at + (n.pinned_at - a.pinned_at) / 2');
    expect(placement).toContain('AND b.library_id = 5');
  });

  it('spreads tight pin timestamps before retrying the new placement', async () => {
    const { execute, repo } = dropQueue(true);
    execute
      .mockResolvedValueOnce({ rows: [{ moved: false, spread: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ moved: true, spread: false }] });
    await expect(repo.reorderTo(7, 12, 'after', sql``)).resolves.toBe('done');
    expect(sqlText(execute.mock.calls[5]![0])).toContain("interval '2 microseconds'");
    expect(sqlText(execute.mock.calls[6]![0])).toBe(sqlText(execute.mock.calls[4]![0]));
  });

  it('places a drop before the first backlog book at the end of the pinned lane', async () => {
    const { execute, repo } = dropQueue(false);
    execute.mockResolvedValueOnce({ rows: [{ id: 12 }] }).mockResolvedValueOnce({ rows: [{ moved: true, spread: false }] });
    await expect(repo.reorderTo(7, 12, 'before', sql``)).resolves.toBe('done');
    expect(sqlText(execute.mock.calls[4]![0])).toContain('i.pinned_at IS NULL');
    expect(sqlText(execute.mock.calls[5]![0])).toContain("coalesce(a.pinned_at, n.pinned_at) + interval '1 microsecond'");
  });

  it('refuses ordering within the computed backlog', async () => {
    const { execute, repo } = dropQueue(false);
    execute.mockResolvedValueOnce({ rows: [{ id: 9 }] });
    await expect(repo.reorderTo(7, 12, 'before', sql``)).resolves.toBe('refused');
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('skips when the neighbour is gone', async () => {
    const { execute, repo } = dropQueue(null);
    await expect(repo.reorderTo(7, 12, 'after', sql``)).resolves.toBe('skipped');
    expect(execute).toHaveBeenCalledTimes(4);
  });
});

describe('upstream read-aloud activity', () => {
  function upstreamProbe() {
    const chain = { from: vi.fn(), where: vi.fn(), limit: vi.fn().mockResolvedValue([]) };
    chain.from.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    const repo = new EditionSyncRepository({ select: vi.fn().mockReturnValue(chain) } as never);
    return { repo, chain };
  }

  it('yields only to processing jobs and claimable queued jobs', async () => {
    const { repo, chain } = upstreamProbe();
    const now = new Date('2026-11-19T10:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(now);
    try {
      await expect(repo.hasUpstreamActiveJobs()).resolves.toBe(false);

      const query = new PgDialect().sqlToQuery(chain.where.mock.calls[0][0]);
      expect(query.sql).toBe(
        '("read_aloud_jobs"."status" = $1 or ("read_aloud_jobs"."status" = $2 and "read_aloud_jobs"."paused_at" is null and "read_aloud_jobs"."cancel_requested" = $3 and "read_aloud_jobs"."next_attempt_at" <= $4))',
      );
      expect(query.params).toEqual(['processing', 'queued', false, now.toISOString()]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets edition sync work during a queued retry backoff and yields once the retry is due', async () => {
    const { repo, chain } = upstreamProbe();
    const db = new DatabaseSync(':memory:');
    const retryAt = new Date('2026-11-19T10:30:00Z');
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-11-19T10:00:00Z'));
    try {
      db.exec('CREATE TABLE read_aloud_jobs (id INTEGER, status TEXT, paused_at TEXT, cancel_requested INTEGER, next_attempt_at TEXT)');
      db.prepare('INSERT INTO read_aloud_jobs VALUES (1, ?, NULL, 0, ?)').run('queued', retryAt.toISOString());
      chain.limit.mockImplementation((limit: number) => {
        const { sql, params } = new PgDialect().sqlToQuery(chain.where.mock.lastCall![0]);
        const bindings = Object.fromEntries(
          params.map((param, index) => [`$${index + 1}`, typeof param === 'boolean' ? Number(param) : String(param)]),
        );
        return Promise.resolve(db.prepare(`SELECT id FROM read_aloud_jobs WHERE ${sql} LIMIT ?`).all(bindings, limit));
      });

      await expect(repo.hasUpstreamActiveJobs()).resolves.toBe(false);
      vi.setSystemTime(retryAt);
      await expect(repo.hasUpstreamActiveJobs()).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
      db.close();
    }
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

it('checks the same wanting rules with the acting user excluded', async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ wanted: true }] })
    .mockResolvedValueOnce({ rows: [{ wanted: false }] });
  const repo = new EditionSyncRepository({ execute } as never);
  await expect(repo.isWanted(12)).resolves.toBe(true);
  await expect(repo.isWantedByAnotherUser(12, 7)).resolves.toBe(false);
  const dialect = new PgDialect();
  const anyUser = dialect.sqlToQuery(execute.mock.calls[0][0]);
  const anotherUser = dialect.sqlToQuery(execute.mock.calls[1][0]);
  expect(anotherUser.sql.replace(' AND u.id <> $1', '').replace(/\$(\d+)/g, (_, index) => `$${Number(index) - 1}`)).toBe(anyUser.sql);
  expect(anotherUser.params).toEqual([7, ...anyUser.params]);
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

  function listQueries(user: object, settings = allEligible, q?: string, libraryIds: number[] | null = null) {
    const db = drizzle.mock({ schema: dbSchema });
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    Object.assign(db, { execute });
    return new EditionSyncRepository(db as never).listBooks(user as never, libraryIds, settings, 'queued', q, 3).then(() => {
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
      expect(query.sql).not.toMatch(/a\.user_id = \$\d/);
      expect(query.sql).toContain('o.user_id =');
      expect(query.params).toContain('%100\\%\\_\\\\%');
      expect(query.sql).not.toContain('OFFSET 256');
    }
    expect(page.sql).toContain("ORDER BY (s.status = 'running') DESC, s.queue_position ASC NULLS LAST, lower(s.title), s.id");
    expect(page.params).toEqual(expect.arrayContaining([50, 100]));
    expect(counts.sql.slice(counts.sql.lastIndexOf('SELECT count(*)')).match(/count\(\*\) FILTER/g)).toHaveLength(4);
    expect(counts.sql).not.toContain('LIMIT');
    expect(page.sql).toContain("ESCAPE '\\'");
  });

  it('adds no library filter when the scope sees every library', async () => {
    const [page, counts] = await listQueries({ id: 17, isSuperuser: false, contentFilters: noFilters }, allEligible, undefined, null);
    for (const query of [page, counts]) expect(query.sql).not.toContain('b.library_id IN');
  });

  it('limits rows and counts to the libraries of a library-limited key', async () => {
    const [page, counts] = await listQueries({ id: 17, isSuperuser: false, contentFilters: noFilters }, allEligible, undefined, [3, 8]);
    for (const query of [page, counts]) {
      expect(query.sql).toMatch(/AND b\.library_id IN \(\$\d+, \$\d+\)/);
      expect(query.params).toEqual(expect.arrayContaining([3, 8]));
    }
  });

  it('matches nothing when the scope has no libraries', async () => {
    const [page, counts] = await listQueries({ id: 17, isSuperuser: false, contentFilters: noFilters }, allEligible, undefined, []);
    for (const query of [page, counts]) {
      expect(query.sql).toContain('AND false');
      expect(query.sql).not.toContain('b.library_id IN');
    }
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

it('selects monitoring fields with status guards and ranks the queue once', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  await new EditionSyncRepository({ execute } as never).listBooks(
    { id: 1, isSuperuser: true } as never,
    null,
    { effectiveEnabled: true, bookSyncMode: 'all_eligible' },
    'all',
    undefined,
    1,
  );
  const query = sqlText(execute.mock.calls[0][0]);
  for (const field of [
    'error_code',
    'attempt_count',
    'last_attempt_at',
    'invalidated_reason',
    'worker_version',
    'index_bytes',
    "report->'totals'->>'sentences'",
    "report->'totals'->>'matchedSentences'",
  ])
    expect(query).toContain(field);
  expect(query.match(/row_number\(\)/g)).toHaveLength(1);
  expect(query).toContain('queue_positions AS MATERIALIZED');
  expect(query).toContain("CASE WHEN s.status IN ('queued', 'stale') THEN qp.position END");
  expect(query).toContain("CASE WHEN s.status = 'ready' THEN i.worker_version END");
  expect(query).toContain('ORDER BY lower(s.title), s.id');
});

it.each(['all', 'queued', 'problems', 'synced', 'off'] as const)('only ranks the server queue when needed for %s', async (filter) => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  await new EditionSyncRepository({ execute } as never).listBooks(
    { id: 1, isSuperuser: true } as never,
    null,
    { effectiveEnabled: true, bookSyncMode: 'all_eligible' },
    filter,
    undefined,
    1,
  );
  const page = sqlText(execute.mock.calls[0][0]);
  const counts = sqlText(execute.mock.calls[1][0]);
  if (filter === 'all' || filter === 'queued') {
    expect(page).toContain('queue_positions AS MATERIALIZED');
    expect(page.match(/row_number\(\)/g)).toHaveLength(1);
    expect(page).toContain('LEFT JOIN queue_positions qp ON qp.id = s.id');
    expect(page).not.toContain('NULL::int AS queue_position');
  } else {
    expect(page).toContain('NULL::int AS queue_position');
    expect(page).not.toContain('queue_positions');
    expect(page).not.toContain('row_number()');
  }
  expect(counts).not.toContain('queue_positions');
  expect(counts).not.toContain('row_number()');
});

it('retries failed books in the shared user scope with one set update', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: [{ retried: 3 }] });
  const db = drizzle.mock({ schema: dbSchema });
  Object.assign(db, { execute });
  const repo = new EditionSyncRepository(db as never);
  expect(
    await repo.retryFailedBooks(
      { id: 17, isSuperuser: false, contentFilters: { includeTagIds: [], includeGenreIds: [], excludeTagIds: [4], excludeGenreIds: [] } } as never,
      [6],
      { effectiveEnabled: true, bookSyncMode: 'selected_only' },
      new Date(),
    ),
  ).toBe(3);
  expect(execute).toHaveBeenCalledTimes(1);
  const query = sqlText(execute.mock.calls[0][0]);
  expect(query).not.toContain('user_library_access');
  expect(query).toContain('b.library_id IN');
  expect(query).toContain('book_tags');
  expect(query).toContain('eligible_files AS');
  expect(query).toContain('CASE WHEN NOT enabled');
  expect(query).toContain("s.status = 'failed' AND i.status = 'failed' AND NOT i.retry_requested");
  expect(query).toContain('attempt_count = 0, retry_requested = true');
});

it('reads only the newest finished run with a deterministic tie break', async () => {
  const limit = vi.fn().mockResolvedValue([]);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  expect(await new EditionSyncRepository({ select } as never).findLastFinishedRun()).toBeNull();
  expect(sqlText(where.mock.calls[0][0])).toContain('IS NOT NULL');
  expect(sqlText(orderBy.mock.calls[0][0])).toContain('"ended_at" desc');
  expect(sqlText(orderBy.mock.calls[0][1])).toContain('"id" desc');
  expect(limit).toHaveBeenCalledWith(1);
});
