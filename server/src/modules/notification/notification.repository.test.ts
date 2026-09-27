import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import { NotificationRepository } from './notification.repository';

const dialect = new PgDialect();

function builder<T>(result: T) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & { then?: Promise<T>['then'] } = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'set', 'returning', 'values', 'onConflictDoUpdate']) chain[method] = vi.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

describe('NotificationRepository.insertOrCollapse', () => {
  it('carries the type into a collapsed row', async () => {
    const insert = builder([]);
    const db = { insert: vi.fn(() => insert) };
    const repo = new NotificationRepository(db as never);

    await repo.insertOrCollapse([{ userId: 3, type: 'read_along_build_failed', title: 't', groupKey: 'k' }]);

    const set = insert.onConflictDoUpdate.mock.calls[0]![0].set as Record<string, SQL>;
    expect(dialect.sqlToQuery(set.type!).sql).toBe('excluded.type');
  });
});

describe('NotificationRepository.updateLatestByGroupKey', () => {
  function setup(updated: unknown[]) {
    const select = builder([]);
    const update = builder(updated);
    const db = { select: vi.fn(() => select), update: vi.fn(() => update) };
    return { repo: new NotificationRepository(db as never), select, update };
  }

  it('scopes the update to the row the subquery picks', async () => {
    const update = builder([]);
    // A real query builder, so the subquery renders inside the update's predicate.
    const db = { select: vi.fn((fields: never) => new QueryBuilder().select(fields)), update: vi.fn(() => update) };
    const repo = new NotificationRepository(db as never);

    await repo.updateLatestByGroupKey(3, 'read_along_build:7:1', {
      type: 'read_along_build',
      title: 't',
      message: null,
      actionUrl: null,
      meta: null,
    });

    const where = dialect.sqlToQuery(update.where.mock.calls[0]![0] as SQL);
    expect(where.sql).toContain('"notifications"."id" in (select');
    expect(where.params).toEqual([3, 'read_along_build:7:1', 1]);
  });

  const patch = { type: 'read_along_build', title: 'Building', message: 'Sending', actionUrl: null, meta: { progress: 0.5 } };

  it('rewrites only the newest row with that key for that user, read or not', async () => {
    const row = { id: 9, userId: 3 };
    const { repo, select, update } = setup([row]);

    await expect(repo.updateLatestByGroupKey(3, 'read_along_build:7', patch)).resolves.toEqual(row);

    const scope = dialect.sqlToQuery(select.where.mock.calls[0]![0] as SQL);
    expect(scope.sql).toBe('("notifications"."user_id" = $1 and "notifications"."group_key" = $2)');
    expect(scope.params).toEqual([3, 'read_along_build:7']);
    expect(dialect.sqlToQuery(select.orderBy.mock.calls[0]![0] as SQL).sql).toBe('"notifications"."id" desc');
    expect(select.limit).toHaveBeenCalledWith(1);

    const set = update.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(set).toMatchObject(patch);
    expect(set.updatedAt).toBeInstanceOf(Date);
    expect(set).not.toHaveProperty('read');
    expect(set).not.toHaveProperty('count');
  });

  it('answers undefined when the user has no row with that key', async () => {
    const { repo } = setup([]);

    await expect(repo.updateLatestByGroupKey(3, 'read_along_build:7', patch)).resolves.toBeUndefined();
  });
});

describe('NotificationRepository deletes', () => {
  function setup() {
    const del = builder({ rowCount: 1 });
    const db = { delete: vi.fn(() => del) };
    return { repo: new NotificationRepository(db as never), del };
  }

  const lockedClause = `("notifications"."meta" ->> 'locked') is distinct from 'true'`;

  it('dismisses only an unlocked notification of that user', async () => {
    const { repo, del } = setup();

    await expect(repo.deleteOne(7, 3)).resolves.toBe(true);

    const where = dialect.sqlToQuery(del.where.mock.calls[0]![0] as SQL);
    expect(where.sql).toContain('"notifications"."id" = $1');
    expect(where.sql).toContain('"notifications"."user_id" = $2');
    expect(where.sql).toContain(lockedClause);
    expect(where.params.slice(0, 2)).toEqual([7, 3]);
  });

  it('clears every notification of that user except the locked ones', async () => {
    const { repo, del } = setup();

    await expect(repo.deleteAllForUser(3)).resolves.toBe(1);

    const where = dialect.sqlToQuery(del.where.mock.calls[0]![0] as SQL);
    expect(where.sql).toContain('"notifications"."user_id" = $1');
    expect(where.sql).toContain(lockedClause);
  });
});

describe('NotificationRepository locked lookups', () => {
  it('lists the locked rows of one type, bounded', async () => {
    const select = builder([{ id: 4 }]);
    const db = { select: vi.fn(() => select) };
    const repo = new NotificationRepository(db as never);

    await expect(repo.findLockedByType('read_along_build')).resolves.toEqual([{ id: 4 }]);

    const where = dialect.sqlToQuery(select.where.mock.calls[0]![0] as SQL);
    expect(where.sql).toBe(`("notifications"."type" = $1 and ("notifications"."meta" ->> 'locked') = 'true')`);
    expect(where.params).toEqual(['read_along_build']);
    expect(select.limit).toHaveBeenCalledWith(500);
  });

  it('reads the newest row of a group key for that user', async () => {
    const select = builder([{ id: 9, meta: { done: true } }]);
    const db = { select: vi.fn(() => select) };
    const repo = new NotificationRepository(db as never);

    await expect(repo.findLatestByGroupKey(3, 'read_along_build:7:1')).resolves.toEqual({ id: 9, meta: { done: true } });

    const where = dialect.sqlToQuery(select.where.mock.calls[0]![0] as SQL);
    expect(where.params).toEqual([3, 'read_along_build:7:1']);
    expect(select.limit).toHaveBeenCalledWith(1);
  });
});
