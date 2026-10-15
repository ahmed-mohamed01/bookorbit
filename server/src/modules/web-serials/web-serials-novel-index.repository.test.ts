import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { WebSerialsNovelIndexRepository } from './web-serials-novel-index.repository';

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

function queryBuilder<T>(result: T) {
  const builder: Record<string, ReturnType<typeof vi.fn>> & { then?: Promise<T>['then'] } = {};
  for (const method of [
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'values',
    'returning',
    'set',
    'leftJoin',
    'innerJoin',
    'groupBy',
    'onConflictDoUpdate',
    'onConflictDoNothing',
    'for',
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mockDb(
  options: { select?: unknown[]; selectDistinct?: unknown[]; insert?: unknown[]; update?: unknown[]; delete?: unknown[]; execute?: unknown[] } = {},
) {
  const queues = {
    select: [...(options.select ?? [])],
    selectDistinct: [...(options.selectDistinct ?? [])],
    insert: [...(options.insert ?? [])],
    update: [...(options.update ?? [])],
    delete: [...(options.delete ?? [])],
    execute: [...(options.execute ?? [])],
  };
  const db = {
    select: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.select.shift() ?? [])),
    selectDistinct: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.selectDistinct.shift() ?? [])),
    insert: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.insert.shift() ?? [])),
    update: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.update.shift() ?? [])),
    delete: vi.fn<(table?: unknown) => unknown>(() => queryBuilder(queues.delete.shift() ?? [])),
    execute: vi.fn<(query: unknown) => Promise<{ rows: unknown[]; rowCount?: number }>>(() =>
      Promise.resolve((queues.execute.shift() as { rows: unknown[]; rowCount?: number } | undefined) ?? { rows: [], rowCount: 0 }),
    ),
    transaction: vi.fn(),
  };
  db.transaction.mockImplementation((fn: (tx: typeof db) => unknown) => Promise.resolve(fn(db)));
  return db;
}

const builderAt = (method: ReturnType<typeof vi.fn>, index = 0) => method.mock.results[index]!.value as ReturnType<typeof queryBuilder>;
const whereSql = (builder: ReturnType<typeof queryBuilder>) => render(builder.where!.mock.calls[0]![0]);

describe('WebSerialsNovelIndexRepository light novel index', () => {
  const entry = (path: string, title = 'Omniscient Reader') => ({
    sourceId: 'novelbuddy',
    path,
    url: `https://novelbuddy.me/${path}`,
    title,
    titleKey: title.toLowerCase(),
    mtl: false,
    coverUrl: null,
    author: null,
  });

  it('upserts entries once per source path, keeps a stored cover and counts inserts apart from updates', async () => {
    const db = mockDb({ insert: [[{ inserted: true }, { inserted: false }]] });

    await expect(
      new WebSerialsNovelIndexRepository(db as never).upsertNovelIndexEntries([entry('a'), entry('a', 'Omniscient Reader 2'), entry('b')]),
    ).resolves.toEqual({ added: 1, updated: 1 });
    const builder = builderAt(db.insert);
    expect((builder.values!.mock.calls[0]![0] as unknown[]).length).toBe(2);
    const conflict = builder.onConflictDoUpdate!.mock.calls[0]![0];
    expect(render(conflict.set.coverUrl).sql).toBe('coalesce(excluded.cover_url, "web_serial_novel_index"."cover_url")');
    expect(render(conflict.set.lastSeenAt).sql).toBe('now()');
    expect(render(builder.returning!.mock.calls[0]![0].inserted).sql).toBe('(xmax = 0)');
  });

  it('writes nothing for an empty batch', async () => {
    const db = mockDb();
    await expect(new WebSerialsNovelIndexRepository(db as never).upsertNovelIndexEntries([])).resolves.toEqual({ added: 0, updated: 0 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('records details of an opened novel with its status and chapter count', async () => {
    const db = mockDb();

    await new WebSerialsNovelIndexRepository(db as never).recordNovelIndexDetails({ ...entry('a'), status: 'completed', chapterCount: 551 });

    const builder = builderAt(db.insert);
    expect(builder.values!.mock.calls[0]![0]).toMatchObject({ status: 'completed', chapterCount: 551, detailsAt: expect.any(Date) });
    expect(builder.onConflictDoUpdate!.mock.calls[0]![0].set).toMatchObject({ status: 'completed', chapterCount: 551 });
  });

  it('searches a bounded pool of escaped prefix matches and word-similarity matches, machine translations ranked below', async () => {
    const db = mockDb({
      execute: [
        { rows: [] },
        {
          rows: [
            {
              source_id: 'a',
              path: 'p',
              url: null,
              title: 'Omni',
              title_key: 'omni',
              mtl: false,
              cover_url: null,
              match_id: null,
              status: null,
              chapter_count: 3,
              prefix: true,
            },
          ],
        },
      ],
    });

    await expect(new WebSerialsNovelIndexRepository(db as never).searchNovelIndex('100%_omni', ['a', 'b'])).resolves.toEqual([
      { sourceId: 'a', path: 'p', url: null, title: 'Omni', mtl: false, coverUrl: null, matchId: null, status: null, chapterCount: 3 },
    ]);
    const query = render(db.execute.mock.calls[1]![0]);
    expect(query.sql).toMatch(/"web_serial_novel_index"\."source_id" in \(\$\d+, \$\d+\) and "web_serial_novel_index"\."title_key" like \$\d+/);
    expect(query.sql).toMatch(/order by "web_serial_novel_index"\."title_key" using ~<~ limit \$\d+/);
    const capped = String.raw`\(select count\(\*\) from \(select 1 from filtered limit \$\d+\) capped\)`;
    expect(query.sql).toMatch(/with filtered as materialized \(select .* and \$\d+ <% lower\("web_serial_novel_index"\."title_key"\)\)/s);
    expect(query.sql).toMatch(new RegExp(String.raw`from filtered\s+where ${capped} <= \$\d+\s+order by word_similarity\(\$\d+, title_key\) desc`));
    expect(query.sql).toMatch(
      new RegExp(
        String.raw`where ${capped} > \$\d+ and "web_serial_novel_index"\."source_id" in \(\$\d+, \$\d+\) and \$\d+ <% "web_serial_novel_index"\."title_key"`,
      ),
    );
    expect(query.sql).toMatch(/order by \$\d+ <<-> "web_serial_novel_index"\."title_key" limit \$\d+\)/);
    expect(render(db.execute.mock.calls[0]![0]).sql).toBe('set local enable_seqscan = off');
    expect(query.sql).toContain('select distinct on (source_id, path) *');
    expect(query.sql).toContain('then 0.5 else 0 end) desc');
    expect(query.params.slice(0, 4)).toEqual(['a', 'b', '100%_omni', 'a']);
    expect(query.params).toContain(1001);
    expect(query.params).toContain('100\\%\\_omni%');
    expect(query.params).toContain(1000);
    expect(query.params.at(-1)).toBe(60);
  });

  it('matches short queries by prefix only and asks nothing without sources', async () => {
    const db = mockDb();
    const repo = new WebSerialsNovelIndexRepository(db as never);

    await repo.searchNovelIndex('om', ['a']);
    expect(render(db.execute.mock.calls[1]![0]).sql).not.toContain('<%');
    await expect(repo.searchNovelIndex('omni', [])).resolves.toEqual([]);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('groups suggestions by match id else title key in one bounded query', async () => {
    const db = mockDb({
      execute: [
        { rows: [] },
        {
          rows: [
            {
              match_id: '12',
              title: 'Omniscient Reader',
              entries: [
                { sourceId: 'a', path: 'x', coverUrl: null, mtl: false, titleKey: 'omniscient reader', author: null },
                { sourceId: 'b', path: 'y', coverUrl: null, mtl: true, titleKey: 'omniscient reader', author: null },
              ],
            },
          ],
        },
      ],
    });

    await expect(new WebSerialsNovelIndexRepository(db as never).suggestNovelIndex('omni', ['a', 'b'], 8)).resolves.toEqual([
      {
        matchId: '12',
        title: 'Omniscient Reader',
        mtlOnly: false,
        sourcesCount: 2,
        entries: [
          { sourceId: 'a', path: 'x', coverUrl: null, mtl: false },
          { sourceId: 'b', path: 'y', coverUrl: null, mtl: true },
        ],
      },
    ]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const query = render(db.execute.mock.calls[1]![0]);
    expect(query.sql).toContain(`coalesce('m:' || match_id, 't:' || title_key) as group_key`);
    expect(query.sql).toContain('group by group_key');
    expect(query.sql).toContain('order by bool_or(prefix) desc, bool_and(mtl), max(score) desc');
    expect(query.sql).toContain('"web_serial_novel_index"."source_id" in ($');
    expect(query.params).toContain(200);
    expect(query.sql).toMatch(/min\(length\(title\)\), group_key$/);
    expect(query.sql).not.toMatch(/limit \$\d+$/);
  });

  it('folds an unmatched copy of a matched series into it when the author agrees or is unknown', async () => {
    const entry = (sourceId: string, titleKey: string, author: string | null, extra: Partial<{ coverUrl: string; mtl: boolean }> = {}) => ({
      sourceId,
      path: `p-${sourceId}`,
      coverUrl: null,
      mtl: false,
      titleKey,
      author,
      ...extra,
    });
    const db = mockDb({
      execute: [
        { rows: [] },
        {
          rows: [
            {
              match_id: null,
              title: 'Solo Leveling',
              entries: [entry('c', 'solo leveling', null, { coverUrl: 'https://c.test/1.jpg' }), entry('d', 'solo leveling', 'Kubō')],
            },
            {
              match_id: '7',
              title: 'Solo Leveling',
              entries: [entry('a', 'solo leveling', 'Chugong', { mtl: true }), entry('b', 'solo leveling', 'Kubou')],
            },
            { match_id: null, title: 'Solo Leveling', entries: [entry('e', 'solo leveling', 'Someone Else')] },
            { match_id: null, title: 'Solo Leveling Ragnarok', entries: [entry('f', 'solo leveling ragnarok', null)] },
          ],
        },
      ],
    });

    const suggestions = await new WebSerialsNovelIndexRepository(db as never).suggestNovelIndex('solo', ['a', 'b', 'c', 'd', 'e', 'f'], 8);

    expect(suggestions.map((suggestion) => [suggestion.matchId, suggestion.entries.map((item) => item.sourceId)])).toEqual([
      ['7', ['c', 'b', 'd', 'a']],
      [null, ['e']],
      [null, ['f']],
    ]);
    expect(suggestions[0]).toMatchObject({ mtlOnly: false, sourcesCount: 4 });
  });

  it('leaves an unmatched copy alone when two matched series carry its title', async () => {
    const entry = (sourceId: string, author: string | null) => ({
      sourceId,
      path: 'p',
      coverUrl: null,
      mtl: false,
      titleKey: 'reincarnated',
      author,
    });
    const db = mockDb({
      execute: [
        { rows: [] },
        {
          rows: [
            { match_id: '1', title: 'Reincarnated', entries: [entry('a', 'One')] },
            { match_id: '2', title: 'Reincarnated', entries: [entry('b', 'Two')] },
            { match_id: null, title: 'Reincarnated', entries: [entry('c', null)] },
          ],
        },
      ],
    });

    const suggestions = await new WebSerialsNovelIndexRepository(db as never).suggestNovelIndex('rein', ['a', 'b', 'c'], 2);

    expect(suggestions.map((suggestion) => suggestion.matchId)).toEqual(['1', '2']);
  });

  it('reads unmatched entries with an author by title, bounded, and stamps matches only where still unmatched', async () => {
    const db = mockDb({ select: [[{ sourceId: 'a', path: 'p', titleKey: 'orv', author: 'Sing Shong' }]], execute: [{ rows: [], rowCount: 1 }] });
    const repo = new WebSerialsNovelIndexRepository(db as never);

    await expect(repo.findUnmatchedNovelIndexByTitleKeys(['orv'])).resolves.toEqual([
      { sourceId: 'a', path: 'p', titleKey: 'orv', author: 'Sing Shong' },
    ]);
    const where = whereSql(builderAt(db.select));
    expect(where.sql).toContain('"web_serial_novel_index"."match_id" is null');
    expect(where.sql).toContain('"web_serial_novel_index"."author" is not null');
    expect(builderAt(db.select).limit).toHaveBeenCalledWith(500);
    const order = builderAt(db.select).orderBy!.mock.calls[0]!.map((part: unknown) => render(part).sql);
    expect(order).toEqual([
      '"web_serial_novel_index"."title_key" asc',
      '"web_serial_novel_index"."source_id" asc',
      '"web_serial_novel_index"."path" asc',
    ]);

    await expect(repo.setNovelIndexMatches([{ sourceId: 'a', path: 'p', matchId: '12' }])).resolves.toBe(1);
    const query = render(db.execute.mock.calls[0]![0]);
    expect(query.sql).toContain('from (values ($1, $2, $3)) as v(source_id, path, match_id)');
    expect(query.sql).toContain('"web_serial_novel_index"."match_id" is null');
    await expect(repo.findUnmatchedNovelIndexByTitleKeys([])).resolves.toEqual([]);
    await expect(repo.setNovelIndexMatches([])).resolves.toBe(0);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('finds candidates by match id or by an unmatched equal title within the given sources', async () => {
    const db = mockDb({ select: [[]] });

    await new WebSerialsNovelIndexRepository(db as never).findNovelIndexCandidates('12', ['orv'], ['a']);

    const where = whereSql(builderAt(db.select));
    expect(where.params).toEqual(['a', '12', 'orv']);
    expect(where.sql).toContain('"web_serial_novel_index"."match_id" is null');
  });

  it('drops removed sources with their entries and resets a rebuilt one to its first page', async () => {
    const db = mockDb({ delete: [[], [{ id: 1 }, { id: 2 }], []] });
    const repo = new WebSerialsNovelIndexRepository(db as never);

    await expect(repo.deleteNovelIndexSources(['gone'])).resolves.toBe(2);
    expect(builderAt(db.delete, 0).where).toHaveBeenCalled();
    expect(render(builderAt(db.delete, 0).where!.mock.calls[0]![0]).sql).toContain('web_serial_novel_index_sources');
    await repo.resetNovelIndexSource('again');

    expect(db.delete).toHaveBeenCalledTimes(3);
    expect(builderAt(db.insert).onConflictDoUpdate!.mock.calls[0]![0].set).toEqual({
      fillState: 'pending',
      nextPage: 1,
      fillSort: null,
      filledAt: null,
      lastTopupAt: null,
      entries: 0,
      emptyPage: null,
      firstPageFailures: 0,
      recheckAt: null,
      lastError: null,
    });
  });

  it('saves fill state by update only, under the guard, and reports whether a row matched', async () => {
    const db = mockDb({ update: [[{ sourceId: 'a' }], []] });
    const repo = new WebSerialsNovelIndexRepository(db as never);

    await expect(repo.saveNovelIndexSource('a', { nextPage: 4 }, { nextPage: 3 })).resolves.toBe(true);
    await expect(repo.saveNovelIndexSource('gone', { nextPage: 4 })).resolves.toBe(false);

    expect(db.insert).not.toHaveBeenCalled();
    const where = whereSql(builderAt(db.update));
    expect(where.sql).toContain('"next_page" = $2');
    expect(where.params).toEqual(['a', 3]);
  });

  it('writes a page only after locking a fill state that still matches the guard', async () => {
    const db = mockDb({ select: [[{ sourceId: 'a' }], []], insert: [[{ inserted: true }, { inserted: false }]] });
    const repo = new WebSerialsNovelIndexRepository(db as never);
    const entry = { sourceId: 'a', path: 'n/1', url: null, title: 'One', titleKey: 'one', mtl: false, coverUrl: null, author: null };
    const patch = vi.fn((written: { added: number }) => ({ nextPage: 4, entries: 10 + written.added }));

    await expect(repo.commitNovelIndexPage('a', { nextPage: 3 }, [entry, { ...entry, path: 'n/2' }], patch)).resolves.toEqual({
      added: 1,
      updated: 1,
    });
    expect(builderAt(db.select).for).toHaveBeenCalledWith('update');
    expect(builderAt(db.update).set).toHaveBeenCalledWith({ nextPage: 4, entries: 11 });

    await expect(repo.commitNovelIndexPage('a', { nextPage: 3 }, [entry], patch)).resolves.toBeNull();
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('reads an index entry cover by source and path, and answers null when there is none', async () => {
    const db = mockDb({ select: [[{ coverUrl: 'https://a.test/c.jpg' }], []] });
    const repo = new WebSerialsNovelIndexRepository(db as never);

    await expect(repo.findNovelIndexCover('alpha', 'novel/x')).resolves.toBe('https://a.test/c.jpg');
    await expect(repo.findNovelIndexCover('alpha', 'novel/y')).resolves.toBeNull();
    const where = whereSql(builderAt(db.select));
    expect(where.sql).toContain('"source_id" = $1');
    expect(where.params).toEqual(['alpha', 'novel/x']);
  });
});
