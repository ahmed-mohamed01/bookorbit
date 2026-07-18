import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sqlChunkText } from '../../common/test-utils/sql-chunk-text';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import type { AbsMappedSession } from './audiobookshelf-sessions.util';

function thenable(result: unknown) {
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  return chain;
}

function insertChain(captured: { values: unknown[]; conflict: unknown[] }, getReturning: () => { sessionId: string }[]) {
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  };
  chain.values = vi.fn((rows: unknown) => {
    captured.values.push(rows);
    return chain;
  });
  chain.onConflictDoUpdate = vi.fn((cfg: unknown) => {
    captured.conflict.push(cfg);
    return chain;
  });
  chain.returning = vi.fn(() => Promise.resolve(getReturning()));
  return chain;
}

function deleteChain() {
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  };
  chain.where = vi.fn().mockReturnValue(chain);
  return chain;
}

function makeSession(overrides: Partial<AbsMappedSession> = {}): AbsMappedSession {
  return {
    sessionId: 'sess-1',
    bookId: 100,
    bookFileId: 10,
    libraryId: 1,
    startedAt: new Date('2026-01-01T10:00:00.000Z'),
    endedAt: new Date('2026-01-01T10:10:00.000Z'),
    durationSeconds: 600,
    endProgress: 50,
    progressDelta: null,
    ...overrides,
  };
}

describe('AudiobookshelfRepository.ingestSessions', () => {
  let selectResults: unknown[][];
  let selectCall: number;
  let captured: { values: unknown[]; conflict: unknown[] };
  let returningOverride: { sessionId: string }[] | null;
  let execute: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;
  let tx: Record<string, unknown>;
  let db: Record<string, unknown>;
  let repo: AudiobookshelfRepository;

  beforeEach(() => {
    selectResults = [];
    selectCall = 0;
    captured = { values: [], conflict: [] };
    returningOverride = null;
    execute = vi.fn().mockResolvedValue(undefined);
    del = vi.fn(() => deleteChain());
    // By default the upsert returns every submitted session (all inserted or changed). Tests set
    // returningOverride to model the change guard skipping unchanged rows.
    const getReturning = () =>
      returningOverride ?? ((captured.values[0] as { sessionId: string }[] | undefined) ?? []).map((r) => ({ sessionId: r.sessionId }));
    tx = {
      select: vi.fn(() => thenable(selectResults[selectCall++] ?? [])),
      insert: vi.fn(() => insertChain(captured, getReturning)),
      delete: del,
      execute,
    };
    db = { transaction: vi.fn((cb: (t: unknown) => Promise<unknown>) => cb(tx)) };
    repo = new AudiobookshelfRepository(db as never);
  });

  it('upserts sessions and reports which ids were newly inserted', async () => {
    // Existing sessions lookup returns sess-2 as already present, so only sess-1 is inserted.
    selectResults = [[{ sessionId: 'sess-2' }], []];
    const result = await repo.ingestSessions(7, 'UTC', [makeSession({ sessionId: 'sess-1' }), makeSession({ sessionId: 'sess-2' })]);

    expect(result).toEqual({ insertedSessionIds: ['sess-1'], updated: 1 });
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });

  it('links each row to the latest non-deleted reading attempt for its book', async () => {
    selectResults = [[], []];
    await repo.ingestSessions(7, 'UTC', [makeSession()]);

    const rows = captured.values[0] as Array<{ attemptId: unknown; source: unknown; sessionId: unknown }>;
    const attemptSql = sqlChunkText(rows[0]!.attemptId).replace(/\s+/g, ' ');
    expect(attemptSql).toContain('from reading_attempts');
    expect(attemptSql).toContain('deleted_at is null');
    expect(attemptSql).toContain('order by id desc');
    expect(rows[0]!.source).toBe('audiobookshelf');
  });

  it('recomputes daily stats grouped per affected library (one advisory lock + delete each)', async () => {
    // existing lookup, then one recompute select per library.
    selectResults = [[], [], []];
    await repo.ingestSessions(7, 'UTC', [
      makeSession({ sessionId: 'a', libraryId: 1 }),
      makeSession({ sessionId: 'b', libraryId: 2 }),
      makeSession({ sessionId: 'c', libraryId: 1 }),
    ]);

    // Two distinct libraries -> two advisory locks and two daily-stats deletes.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('returns early for an empty batch without opening a transaction', async () => {
    const result = await repo.ingestSessions(7, 'UTC', []);
    expect(result).toEqual({ insertedSessionIds: [], updated: 0 });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('guards the upsert with an is-distinct-from clause so unchanged rows are not rewritten', async () => {
    selectResults = [[], []];
    await repo.ingestSessions(7, 'UTC', [makeSession()]);

    const conflict = captured.conflict[0] as { setWhere: unknown };
    expect(conflict.setWhere).toBeDefined();
    expect(sqlChunkText(conflict.setWhere).replace(/\s+/g, ' ')).toContain('is distinct from');
  });

  it('skips the recompute entirely when an overlap row is unchanged (no lock, no delete)', async () => {
    // The session already exists and the change guard returns it in neither insert nor update.
    selectResults = [[{ sessionId: 'sess-1' }]];
    returningOverride = [];

    const result = await repo.ingestSessions(7, 'UTC', [makeSession({ sessionId: 'sess-1' })]);

    expect(result).toEqual({ insertedSessionIds: [], updated: 0 });
    expect(execute).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('recomputes stats for a grown open session that actually changed', async () => {
    // Existing row, and the change guard reports it as updated.
    selectResults = [[{ sessionId: 'sess-1' }], []];
    returningOverride = [{ sessionId: 'sess-1' }];

    const result = await repo.ingestSessions(7, 'UTC', [makeSession({ sessionId: 'sess-1' })]);

    expect(result).toEqual({ insertedSessionIds: [], updated: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('recomputes far-apart affected days in separate bounded windows under one advisory lock', async () => {
    // existing lookup, then one recompute range select per bounded day window.
    selectResults = [[], [], []];
    await repo.ingestSessions(7, 'UTC', [
      makeSession({ sessionId: 'jan', libraryId: 1, startedAt: new Date('2026-01-01T10:00:00.000Z'), endedAt: new Date('2026-01-01T10:10:00.000Z') }),
      makeSession({ sessionId: 'apr', libraryId: 1, startedAt: new Date('2026-04-01T10:00:00.000Z'), endedAt: new Date('2026-04-01T10:10:00.000Z') }),
    ]);

    // One library -> a single advisory lock; two windows >31 days apart -> two deletes + two range loads,
    // so a batch touching distant days never loads the whole span into memory at once.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(2);
  });
});

describe('AudiobookshelfRepository.findLibraryIdsByBookIds', () => {
  it('maps each book id to its library id', async () => {
    const db = {
      select: vi.fn(() =>
        thenable([
          { id: 100, libraryId: 1 },
          { id: 200, libraryId: 2 },
        ]),
      ),
    };
    const repo = new AudiobookshelfRepository(db as never);

    const map = await repo.findLibraryIdsByBookIds([100, 200, 100]);

    expect(map.get(100)).toBe(1);
    expect(map.get(200)).toBe(2);
  });

  it('returns an empty map for no ids', async () => {
    const db = { select: vi.fn() };
    const repo = new AudiobookshelfRepository(db as never);
    await expect(repo.findLibraryIdsByBookIds([])).resolves.toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });
});
