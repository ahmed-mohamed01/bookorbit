import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { Client } from 'pg';
import type { ContentFilterRules } from '@bookorbit/types';

import * as schema from '../../db/schema';
import { ReadingAlignmentJobPageRepository } from './reading-alignment-job-page.repository';

const CUTOFF = new Date('2026-11-08T12:00:00.000Z');
const FILTERS: ContentFilterRules = {
  includeTagIds: [],
  includeGenreIds: [],
  excludeTagIds: [44],
  excludeGenreIds: [],
} as unknown as ContentFilterRules;
const UNFILTERED = { contentFilters: null };

function setup() {
  const where = vi.fn<(condition: SQL) => unknown>();
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn((condition: SQL) => {
      where(condition);
      return Object.assign(Promise.resolve([]), chain);
    }),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve([])),
  };
  // The first select is the read under test; later ones are the content filter's subqueries, which must render for real.
  const subqueries = drizzle.mock({ schema });
  const db = { select: vi.fn((fields?: never) => (db.select.mock.calls.length === 1 ? chain : subqueries.select(fields))) };
  return { repository: new ReadingAlignmentJobPageRepository(db as never), where, chain };
}

function rendered(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}

describe('ReadingAlignmentJobPageRepository', () => {
  describe.each(['queue', 'failed', 'history'] as const)('%s SQL ordering', (view) => {
    it.each([false, true])('avoids bare integer sort positions (with cursor: %s)', async (withCursor) => {
      const client = new Client();
      vi.spyOn(client, 'query').mockImplementation(() => ({ rows: [] }));
      const logQuery = vi.fn<(text: string, params: unknown[]) => void>();
      const repository = new ReadingAlignmentJobPageRepository(drizzle({ client, schema, logger: { logQuery } }));
      const at = CUTOFF.getTime() * 1000 + 123;
      const after = withCursor ? { prefix: view === 'queue' ? [1, 0] : [at], suffix: view === 'queue' ? [at] : [], typeIndex: 17, id: 42 } : null;

      await repository.pageForJobs({ view, libraryIds: null, ...UNFILTERED, cutoffAt: CUTOFF, after, typeIndex: 17, limit: 51 });

      const [statement, params] = logQuery.mock.calls[0]!;
      const orderBy = statement.match(/\border by (.+?) limit\b/i)?.[1];
      expect(orderBy).toBeDefined();
      const terms = orderBy!.split(/,\s*/);
      for (const term of terms) expect(term).not.toMatch(/^[+-]?\d+(?:\s+(?:asc|desc))?(?:\s+nulls\s+(?:first|last))?$/i);
      expect(terms.at(-1)).toBe(`"audiobook_alignment"."id" ${view === 'queue' ? 'asc' : 'desc'}`);
      if (withCursor) expect(params).toEqual(expect.arrayContaining([at, 42]));
    });
  });

  it('keeps every read inside the libraries the viewer may edit', async () => {
    const { repository, where } = setup();
    await repository.countForJobs({ libraryIds: [5, 6], ...UNFILTERED }, CUTOFF);
    const query = rendered(where.mock.calls[0]![0]);
    expect(query.sql).toContain('"library_id" in ($');
    expect(query.params).toEqual(expect.arrayContaining([5, 6]));
  });

  it('puts no library filter on a read for a viewer who sees every library', async () => {
    const { repository, where } = setup();
    await repository.countForJobs({ libraryIds: null, ...UNFILTERED }, CUTOFF);
    expect(rendered(where.mock.calls[0]![0]).sql).not.toContain('"library_id"');
  });

  it('reads nothing at all for a viewer who may edit no library', async () => {
    const { repository, where } = setup();
    expect(await repository.countForJobs({ libraryIds: [], ...UNFILTERED }, CUTOFF)).toMatchObject({ queue: 0, failed: 0 });
    expect(
      await repository.pageForJobs({ view: 'queue', libraryIds: [], ...UNFILTERED, cutoffAt: CUTOFF, after: null, typeIndex: 17, limit: 51 }),
    ).toEqual([]);
    expect(await repository.findActionRows([4], { libraryIds: [], ...UNFILTERED })).toEqual([]);
    expect(where).not.toHaveBeenCalled();
  });

  it('applies the content filter to the joined book in pages, counts and action rows alike', async () => {
    const scope = { libraryIds: null, contentFilters: FILTERS };
    const counts = setup();
    await counts.repository.countForJobs(scope, CUTOFF);
    const failed = setup();
    await failed.repository.pageForJobs({ view: 'failed', ...scope, cutoffAt: CUTOFF, after: null, typeIndex: 17, limit: 51 });
    const queue = setup();
    await queue.repository.pageForJobs({ view: 'queue', ...scope, cutoffAt: CUTOFF, after: null, typeIndex: 17, limit: 51 });
    const actions = setup();
    await actions.repository.findActionRows([4], scope);
    for (const made of [counts, failed, queue, actions]) {
      const query = rendered(made.where.mock.calls[0]![0]);
      expect(query.sql).toContain('not exists (select 1 from "book_tags" where ("book_tags"."book_id" = "books"."id"');
      expect(query.params).toContain(44);
    }

    const unfiltered = setup();
    await unfiltered.repository.countForJobs({ libraryIds: null, ...UNFILTERED }, CUTOFF);
    expect(rendered(unfiltered.where.mock.calls[0]![0]).sql).not.toContain('book_tags');
  });

  it('keeps unalignable builds out of Failed and its count, and in History', async () => {
    const counts = setup();
    await counts.repository.countForJobs({ libraryIds: null, ...UNFILTERED }, CUTOFF);
    const failed = setup();
    await failed.repository.pageForJobs({ view: 'failed', libraryIds: null, ...UNFILTERED, cutoffAt: CUTOFF, after: null, typeIndex: 17, limit: 51 });
    for (const made of [counts, failed]) expect(rendered(made.where.mock.calls[0]![0]).params).not.toContain('unalignable');
  });

  it('pages Queue over running and waiting builds only, and History over settled and aged failures', async () => {
    const queue = setup();
    await queue.repository.pageForJobs({ view: 'queue', libraryIds: null, ...UNFILTERED, cutoffAt: CUTOFF, after: null, typeIndex: 17, limit: 51 });
    expect(rendered(queue.where.mock.calls[0]![0]).params).toEqual(expect.arrayContaining(['building', 'pending']));
    expect(queue.chain.limit).toHaveBeenCalledWith(51);

    const history = setup();
    await history.repository.pageForJobs({
      view: 'history',
      libraryIds: null,
      ...UNFILTERED,
      cutoffAt: CUTOFF,
      after: null,
      typeIndex: 17,
      limit: 51,
    });
    const query = rendered(history.where.mock.calls[0]![0]);
    expect(query.params).toEqual(expect.arrayContaining(['ready', 'unalignable']));
    expect(query.sql).toContain(`= 'failed' and`);
  });
});
