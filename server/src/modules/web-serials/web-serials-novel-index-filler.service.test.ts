/* eslint-disable @typescript-eslint/require-await */
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSerialNovelIndexSourceRow } from './schema/web-serials.schema';
import {
  browseCandidatesFor,
  NOVEL_INDEX_PAGE_CAP,
  NOVEL_INDEX_PAGE_DELAY_MS,
  NOVEL_INDEX_RECHECK_DELAY_MS,
  NOVEL_INDEX_TOPUP_INTERVAL_MS,
  WebSerialsNovelIndexFillerService,
} from './web-serials-novel-index-filler.service';

vi.mock('./web-serials-novel-index.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./web-serials-novel-index.service')>()),
  WebSerialsNovelIndexService: class {},
}));
vi.mock('./web-serials-schema-bootstrap.service', () => ({ WebSerialsSchemaBootstrapService: class {} }));

const CONN = { url: 'http://novel-sources:8282', username: null, password: null };
const USER = { id: 1 } as never;
const NOW = new Date('2026-10-14T12:00:00Z');
const ORDER_FILTER = {
  orderBy: {
    type: 'Picker',
    label: 'Order by',
    value: '',
    options: [
      { label: 'Default', value: '' },
      { label: 'Latest', value: 'latest' },
      { label: 'A-Z', value: 'alphabetical' },
    ],
  },
};

type Page = Array<{ name: string; path: string }>;
type Guard = { nextPage?: number; fillState?: string };

function items(prefix: string, count: number): Page {
  return Array.from({ length: count }, (_, index) => ({ name: `${prefix} ${index}`, path: `${prefix}/${index}` }));
}

function build(
  options: { sources?: Array<{ id: string; filters?: unknown }>; enabled?: string[]; budget?: number; pages?: Record<string, Page[]> } = {},
) {
  const states = new Map<string, WebSerialNovelIndexSourceRow>();
  const known = new Map<string, Set<string>>();
  const blank = (sourceId: string): WebSerialNovelIndexSourceRow => ({
    sourceId,
    fillState: 'pending',
    nextPage: 1,
    fillSort: null,
    filledAt: null,
    lastTopupAt: null,
    entries: 0,
    lastError: null,
    requestsToday: 0,
    requestsDay: null,
    emptyPage: null,
    firstPageFailures: 0,
    recheckAt: null,
  });
  const guarded = (id: string, guard: Guard) => {
    const current = states.get(id);
    if (!current) return null;
    if (guard.nextPage !== undefined && current.nextPage !== guard.nextPage) return null;
    if (guard.fillState !== undefined && current.fillState !== guard.fillState) return null;
    return current;
  };
  const repo = {
    getSettings: vi.fn(async () => ({ novelIndexDailyBudget: options.budget ?? 1500 })),
    listNovelIndexSources: vi.fn(async () => [...states.values()].map((row) => ({ ...row }))),
    ensureNovelIndexSources: vi.fn(async (ids: string[]) => {
      for (const id of ids) if (!states.has(id)) states.set(id, blank(id));
    }),
    saveNovelIndexSource: vi.fn(async (id: string, patch: Partial<WebSerialNovelIndexSourceRow>, guard: Guard = {}) => {
      const current = guarded(id, guard);
      if (!current) return false;
      states.set(id, { ...current, ...patch });
      return true;
    }),
    commitNovelIndexPage: vi.fn(
      async (
        id: string,
        guard: Guard,
        entries: Array<{ sourceId: string; path: string }>,
        patch: (written: { added: number; updated: number }) => Partial<WebSerialNovelIndexSourceRow>,
      ) => {
        if (!guarded(id, guard)) return null;
        const written = await repo.upsertNovelIndexEntries(entries);
        states.set(id, { ...states.get(id)!, ...patch(written) });
        return written;
      },
    ),
    deleteNovelIndexSources: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        states.delete(id);
        known.delete(id);
      }
      return ids.length;
    }),
    resetNovelIndexSource: vi.fn(async (id: string) => {
      known.delete(id);
      states.set(id, blank(id));
    }),
    upsertNovelIndexEntries: vi.fn(async (entries: Array<{ sourceId: string; path: string }>) => {
      let added = 0;
      for (const entry of entries) {
        const set = known.get(entry.sourceId) ?? new Set<string>();
        if (!set.has(entry.path)) added += 1;
        set.add(entry.path);
        known.set(entry.sourceId, set);
      }
      return { added, updated: entries.length - added };
    }),
    countNovelIndexEntries: vi.fn(async (id: string) => known.get(id)?.size ?? 0),
  };
  const sources = (options.sources ?? [{ id: 'a', filters: ORDER_FILTER }]).map((source) => ({ name: source.id.toUpperCase(), ...source }));
  const enabled = { ids: options.enabled ?? sources.map((source) => source.id) };
  const index = {
    scope: vi.fn(async () => ({ connection: CONN, enabledSourceIds: enabled.ids })),
    installedSources: vi.fn(async () => sources),
  };
  const pages = options.pages ?? {};
  const client = {
    listInstalled: vi.fn(async () => sources),
    browse: vi.fn<(conn: unknown, sourceId: string, page: number, options?: unknown) => Promise<{ items: Page; page: number; hasMore: boolean }>>(
      async (_conn, sourceId, page) => ({
        items: pages[sourceId]?.[page - 1] ?? [],
        page,
        hasMore: true,
      }),
    ),
  };
  const filler = new WebSerialsNovelIndexFillerService(
    repo as never,
    repo as never,
    index as never,
    client as never,
    { ready: Promise.resolve({ requeued: [] }) } as never,
  );
  const clock = { now: NOW.getTime(), slept: [] as number[] };
  vi.spyOn(filler as unknown as { now: () => Date }, 'now').mockImplementation(() => new Date(clock.now));
  vi.spyOn(filler as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockImplementation(async (ms) => {
    clock.slept.push(ms);
  });
  return { filler, repo, client, index, states, known, clock, enabled, sources };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

const NOVELBUDDY_FILTERS = {
  orderBy: {
    type: 'Picker',
    label: 'Order by',
    value: '',
    options: [
      { label: 'Default', value: '' },
      { label: 'Most views', value: 'views' },
      { label: 'Latest', value: 'latest' },
      { label: 'Popular', value: 'popular' },
      { label: 'A-Z', value: 'alphabetical' },
      { label: 'Rating', value: 'rating' },
      { label: 'Chapters', value: 'chapters' },
    ],
  },
};

const sortsOf = (filters: unknown, mode: 'fill' | 'topup') => browseCandidatesFor(filters, mode).map((candidate) => candidate.sort);

describe('browseCandidatesFor', () => {
  it('orders a fill A-Z, source default, popular and views, then latest', () => {
    expect(sortsOf(NOVELBUDDY_FILTERS, 'fill')).toEqual(['orderBy=alphabetical', 'orderBy=', 'orderBy=views', 'orderBy=popular', 'orderBy=latest']);
    expect(browseCandidatesFor(NOVELBUDDY_FILTERS, 'fill')[0].options).toEqual({
      latest: false,
      filters: { orderBy: { ...NOVELBUDDY_FILTERS.orderBy, value: 'alphabetical' } },
    });
  });

  it('orders a top-up latest options first, then the generic latest switch', () => {
    expect(sortsOf(NOVELBUDDY_FILTERS, 'topup')).toEqual(['orderBy=latest', 'latest']);
    expect(browseCandidatesFor(ORDER_FILTER, 'topup')[0].options).toEqual({
      latest: false,
      filters: { orderBy: { ...ORDER_FILTER.orderBy, value: 'latest' } },
    });
    expect(browseCandidatesFor(ORDER_FILTER, 'topup')[1].options).toEqual({ latest: true });
  });

  it('keeps the filter default when no option is empty or labelled default, and falls back without a sort filter', () => {
    const viewsOnly = { sort: { label: 'Sort', value: 'views', options: [{ label: 'Most viewed', value: 'views' }] } };
    expect(browseCandidatesFor(viewsOnly, 'fill')).toEqual([{ sort: 'sort=views', options: { latest: false, filters: viewsOnly } }]);
    expect(sortsOf(viewsOnly, 'topup')).toEqual(['latest']);
    expect(sortsOf({ genre: { label: 'Genre', options: [{ label: 'New', value: 'x' }] } }, 'topup')).toEqual(['latest']);
    expect(browseCandidatesFor(undefined, 'fill')).toEqual([{ sort: 'default', options: { latest: false } }]);
  });
});

describe('WebSerialsNovelIndexFillerService', () => {
  describe('sort fallback', () => {
    const NB = { id: 'nb', filters: NOVELBUDDY_FILTERS };
    const sortOf = (call: unknown[]) => ((call[3] as { filters?: { orderBy: { value: string } } }).filters?.orderBy.value ?? null) as string | null;

    it('keeps the preferred sort through one failed first page, then falls through on a repeat and keeps the winner', async () => {
      const { filler, client, states, clock } = build({ sources: [NB] });
      client.browse.mockImplementation(async (_c: unknown, _s: string, page: number, options: unknown) => {
        const value = sortOf([0, 0, 0, options]);
        if (value === 'alphabetical') throw new Error("Cannot read properties of undefined (reading 'items')");
        return { items: page <= 2 ? items(`p${page}`, 2) : [], page, hasMore: true };
      });

      await filler.tick();
      expect(client.browse.mock.calls.map((call) => [call[2], sortOf(call)])).toEqual([[1, 'alphabetical']]);
      expect(states.get('nb')).toMatchObject({ fillState: 'pending', fillSort: null, firstPageFailures: 1 });
      expect(states.get('nb')!.lastError).toContain('reading');

      await filler.tick();
      expect(client.browse).toHaveBeenCalledTimes(1);
      clock.now += NOVEL_INDEX_RECHECK_DELAY_MS;
      await filler.tick();
      clock.now += NOVEL_INDEX_RECHECK_DELAY_MS;
      await filler.tick();

      expect(client.browse.mock.calls.map((call) => [call[2], sortOf(call)])).toEqual([
        [1, 'alphabetical'],
        [1, 'alphabetical'],
        [1, ''],
        [2, ''],
        [3, ''],
        [3, ''],
      ]);
      expect(states.get('nb')).toMatchObject({ fillState: 'done', fillSort: 'orderBy=', requestsToday: 6, firstPageFailures: 0 });
    });

    it('tries the preferred sort again after a passing first-page failure', async () => {
      const { filler, client, states, clock } = build({ sources: [NB], pages: { nb: [items('x', 2)] } });
      client.browse.mockRejectedValueOnce(new Error('timeout'));

      await filler.tick();
      clock.now += NOVEL_INDEX_RECHECK_DELAY_MS;
      await filler.tick();

      expect(client.browse.mock.calls.slice(0, 2).map((call) => sortOf(call))).toEqual(['alphabetical', 'alphabetical']);
      expect(states.get('nb')).toMatchObject({ fillSort: 'orderBy=alphabetical', firstPageFailures: 0, emptyPage: 2 });
    });

    it('falls through when page 1 is empty', async () => {
      const { filler, client, states, clock } = build({ sources: [NB] });
      client.browse.mockImplementation(async (_c: unknown, _s: string, page: number, options: unknown) => ({
        items: sortOf([0, 0, 0, options]) === 'views' && page === 1 ? items('v', 2) : [],
        page,
        hasMore: true,
      }));

      await filler.tick();
      clock.now += NOVEL_INDEX_RECHECK_DELAY_MS;
      await filler.tick();

      expect(client.browse.mock.calls.slice(0, 3).map((call) => sortOf(call))).toEqual(['alphabetical', '', 'views']);
      expect(states.get('nb')).toMatchObject({ fillState: 'done', fillSort: 'orderBy=views', entries: 2 });
    });

    it('resumes with the stored sort and does not fall back after page 1', async () => {
      const { filler, client, states } = build({ sources: [NB], pages: { nb: [items('x', 2), items('y', 2)] } });
      states.set('nb', {
        sourceId: 'nb',
        filledAt: null,
        lastTopupAt: null,
        lastError: null,
        requestsToday: 0,
        requestsDay: null,
        fillState: 'paused',
        nextPage: 3,
        fillSort: 'orderBy=views',
        entries: 4,
        emptyPage: null,
        firstPageFailures: 0,
        recheckAt: null,
      });

      await filler.tick();

      expect(client.browse.mock.calls.map((call) => [call[2], sortOf(call)])).toEqual([[3, 'views']]);
    });

    it('restarts from page 1 with candidate selection when the stored sort is no longer offered', async () => {
      const { filler, client, states, clock } = build({ sources: [NB], pages: { nb: [items('x', 2)] } });
      states.set('nb', {
        sourceId: 'nb',
        filledAt: null,
        lastTopupAt: null,
        lastError: null,
        requestsToday: 0,
        requestsDay: null,
        fillState: 'filling',
        nextPage: 7,
        fillSort: 'orderBy=gone',
        entries: 12,
        emptyPage: null,
        firstPageFailures: 0,
        recheckAt: null,
      });

      await filler.tick();
      clock.now += NOVEL_INDEX_RECHECK_DELAY_MS;
      await filler.tick();

      expect(client.browse.mock.calls[0]!.slice(2, 3)).toEqual([1]);
      expect(sortOf(client.browse.mock.calls[0]!)).toBe('alphabetical');
      expect(states.get('nb')).toMatchObject({ fillState: 'done', fillSort: 'orderBy=alphabetical' });
    });

    it('records the chosen sort and clears it on rebuild', async () => {
      const { filler, states, repo } = build({ sources: [NB], pages: { nb: [items('x', 2), items('y', 2), []] } });
      await filler.tick();
      expect(states.get('nb')!.fillSort).toBe('orderBy=alphabetical');
      repo.resetNovelIndexSource.mockImplementationOnce(async (id: string) => {
        states.set(id, { ...states.get(id)!, fillSort: null, nextPage: 1, fillState: 'pending' });
      });
      await filler.rebuild('nb', USER);
      expect(repo.resetNovelIndexSource).toHaveBeenCalledWith('nb');
    });

    it('keeps the fill pending with a lastError when no sort works, without retrying in the same pass', async () => {
      const { filler, client, states } = build({ sources: [NB] });
      client.browse.mockRejectedValue(new Error('502'));
      states.set('nb', {
        sourceId: 'nb',
        fillState: 'pending',
        nextPage: 1,
        fillSort: null,
        filledAt: null,
        lastTopupAt: null,
        entries: 0,
        lastError: 'timeout',
        requestsToday: 0,
        requestsDay: null,
        emptyPage: null,
        firstPageFailures: 1,
        recheckAt: null,
      });

      await filler.tick();

      expect(client.browse).toHaveBeenCalledTimes(5);
      expect(states.get('nb')).toMatchObject({ fillState: 'pending', nextPage: 1, fillSort: null, requestsToday: 5 });
      expect(states.get('nb')!.lastError).toContain('No sort order worked');
    });

    it('uses the single default candidate for a source without a sort filter', async () => {
      const { filler, client } = build({ sources: [{ id: 'plain' }], pages: { plain: [items('x', 1)] } });
      await filler.tick();
      expect(client.browse.mock.calls[0]![3]).toEqual({ latest: false });
    });
  });

  it('pages a source from its stored next page until an empty page seen on two runs, pacing pages and persisting progress', async () => {
    const { filler, client, states, clock } = build({ pages: { a: [items('x', 3), items('y', 2), items('z', 2)] } });
    states.set('a', {
      ...states.get('a')!,
      sourceId: 'a',
      fillState: 'filling',
      nextPage: 2,
      filledAt: null,
      lastTopupAt: null,
      entries: 3,
      lastError: null,
      requestsToday: 0,
      requestsDay: null,
      emptyPage: null,
      firstPageFailures: 0,
      recheckAt: null,
    });

    await filler.tick();

    expect(client.browse.mock.calls.map((call) => call[2])).toEqual([2, 3, 4]);
    expect(client.browse.mock.calls[0]![3]).toEqual({ latest: false, filters: { orderBy: { ...ORDER_FILTER.orderBy, value: 'alphabetical' } } });
    expect(clock.slept).toEqual([NOVEL_INDEX_PAGE_DELAY_MS, NOVEL_INDEX_PAGE_DELAY_MS]);
    expect(states.get('a')).toMatchObject({ fillState: 'filling', nextPage: 4, emptyPage: 4 });
    expect(states.get('a')!.recheckAt).toEqual(new Date(NOW.getTime() + NOVEL_INDEX_RECHECK_DELAY_MS));

    clock.now += NOVEL_INDEX_RECHECK_DELAY_MS - 5 * 60_000;
    await filler.tick();
    expect(client.browse.mock.calls.map((call) => call[2])).toEqual([2, 3, 4]);

    clock.now += 5 * 60_000;
    await filler.tick();
    expect(client.browse.mock.calls.map((call) => call[2])).toEqual([2, 3, 4, 4]);
    expect(states.get('a')).toMatchObject({
      fillState: 'done',
      nextPage: 4,
      emptyPage: null,
      entries: 4,
      requestsToday: 4,
      requestsDay: '2026-10-14',
      recheckAt: null,
      lastError: null,
    });
    expect(states.get('a')!.filledAt).toEqual(new Date(clock.now));
  });

  it('resumes after a failed page from the page that failed, without retrying it in the same pass', async () => {
    const { filler, client, states, clock } = build({ pages: { a: [items('x', 2), items('y', 2)] } });
    client.browse
      .mockImplementationOnce(async () => ({ items: items('x', 2), page: 1, hasMore: true }))
      .mockRejectedValueOnce(new Error('site timeout'));

    await filler.tick();
    expect(states.get('a')).toMatchObject({ fillState: 'filling', nextPage: 2, lastError: 'site timeout', recheckAt: null });
    expect(client.browse).toHaveBeenCalledTimes(2);

    await filler.tick();
    clock.now += NOVEL_INDEX_RECHECK_DELAY_MS;
    await filler.tick();
    expect(client.browse.mock.calls.slice(2).map((call) => call[2])).toEqual([2, 3, 3]);
    expect(states.get('a')).toMatchObject({ fillState: 'done', lastError: null });
  });

  it('pauses at the daily budget and picks up again the next day', async () => {
    const { filler, client, states, clock } = build({ budget: 10, pages: { a: Array.from({ length: 15 }, (_, page) => items(`p${page}`, 1)) } });

    await filler.tick();
    expect(client.browse).toHaveBeenCalledTimes(10);
    expect(states.get('a')).toMatchObject({ fillState: 'paused', nextPage: 11, requestsToday: 10 });

    await filler.tick();
    expect(client.browse).toHaveBeenCalledTimes(10);

    clock.now += 24 * 60 * 60_000;
    await filler.tick();
    clock.now += NOVEL_INDEX_RECHECK_DELAY_MS;
    await filler.tick();
    expect(client.browse.mock.calls.at(-1)![2]).toBe(16);
    expect(states.get('a')).toMatchObject({ fillState: 'done', requestsToday: 7, requestsDay: '2026-10-15' });
  });

  it('stops a fill at the page cap and logs it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { filler, client, states } = build();
    states.set('a', {
      sourceId: 'a',
      fillState: 'filling',
      nextPage: NOVEL_INDEX_PAGE_CAP,
      fillSort: null,
      filledAt: null,
      lastTopupAt: null,
      entries: 0,
      lastError: null,
      requestsToday: 0,
      requestsDay: null,
      emptyPage: null,
      firstPageFailures: 0,
      recheckAt: null,
    });
    client.browse.mockImplementation(async (_conn, _id, page) => ({ items: items(`p${page}`, 1), page, hasMore: true }));

    await filler.tick();

    expect(client.browse).toHaveBeenCalledTimes(1);
    expect(states.get('a')).toMatchObject({ fillState: 'done', lastError: 'Stopped at the page cap' });
    expect(warn.mock.calls.some((call) => String(call[0]).includes(`pageCap=${NOVEL_INDEX_PAGE_CAP}`))).toBe(true);
  });

  it('tops a filled source up from its latest listing until a page of only known entries, every three hours', async () => {
    const { filler, client, states, known, clock } = build();
    known.set('a', new Set(['old/0', 'old/1']));
    states.set('a', {
      sourceId: 'a',
      fillState: 'done',
      nextPage: 9,
      fillSort: null,
      filledAt: NOW,
      lastTopupAt: new Date(NOW.getTime() - NOVEL_INDEX_TOPUP_INTERVAL_MS),
      entries: 2,
      lastError: null,
      requestsToday: 0,
      requestsDay: null,
      emptyPage: null,
      firstPageFailures: 0,
      recheckAt: null,
    });
    const pages = [
      items('new', 2),
      [...items('newer', 1), { name: 'old 0', path: 'old/0' }],
      [
        { name: 'old 0', path: 'old/0' },
        { name: 'old 1', path: 'old/1' },
      ],
      items('never', 2),
    ];
    client.browse.mockImplementation(async (_conn, _id, page) => ({ items: pages[page - 1] ?? [], page, hasMore: true }));

    await filler.tick();

    expect(client.browse.mock.calls.map((call) => call[2])).toEqual([1, 2, 3]);
    expect(client.browse.mock.calls[0]![3]).toEqual({ latest: false, filters: { orderBy: { ...ORDER_FILTER.orderBy, value: 'latest' } } });
    expect(states.get('a')).toMatchObject({ fillState: 'done', entries: 5, lastTopupAt: NOW });

    client.browse.mockClear();
    clock.now += 60 * 60_000;
    await filler.tick();
    expect(client.browse).not.toHaveBeenCalled();
  });

  it('stops a top-up after ten pages of new entries', async () => {
    const { filler, client, states } = build();
    states.set('a', {
      sourceId: 'a',
      fillState: 'done',
      nextPage: 1,
      fillSort: null,
      filledAt: NOW,
      lastTopupAt: null,
      entries: 0,
      lastError: null,
      requestsToday: 0,
      requestsDay: null,
      emptyPage: null,
      firstPageFailures: 0,
      recheckAt: null,
    });
    client.browse.mockImplementation(async (_conn, _id, page) => ({ items: items(`n${page}`, 1), page, hasMore: true }));

    await filler.tick();

    expect(client.browse).toHaveBeenCalledTimes(10);
    expect(states.get('a')!.lastTopupAt).toEqual(NOW);
  });

  it('fills one source at a time, skips disabled ones and keeps the entries of a source the service no longer lists', async () => {
    const { filler, client, repo, states } = build({
      sources: [{ id: 'a' }, { id: 'b' }, { id: 'off' }],
      enabled: ['a', 'b'],
      pages: { a: [items('a', 1)], b: [items('b', 1)] },
    });
    states.set('gone', {
      sourceId: 'gone',
      fillState: 'done',
      nextPage: 1,
      fillSort: null,
      filledAt: NOW,
      lastTopupAt: NOW,
      entries: 4,
      lastError: null,
      requestsToday: 0,
      requestsDay: null,
      emptyPage: null,
      firstPageFailures: 0,
      recheckAt: null,
    });
    let inFlight = 0;
    let peak = 0;
    client.browse.mockImplementation(async (_conn, sourceId: string, page: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { items: page === 1 ? items(sourceId, 1) : [], page, hasMore: true };
    });

    await filler.tick();

    expect(repo.deleteNovelIndexSources).not.toHaveBeenCalled();
    expect(states.get('gone')).toMatchObject({ fillState: 'done', entries: 4 });
    expect(peak).toBe(1);
    expect(new Set(client.browse.mock.calls.map((call) => call[1]))).toEqual(new Set(['a', 'b']));
    expect(states.get('off')!.fillState).toBe('pending');
  });

  it('stops filling a source the admin disables mid-run', async () => {
    const { filler, client, states, enabled } = build({ pages: { a: [items('x', 1), items('y', 1), items('z', 1)] } });
    client.browse.mockImplementation(async (_conn, _id, page) => {
      if (page === 2) enabled.ids = [];
      return { items: items(`p${page}`, 1), page, hasMore: true };
    });

    await filler.tick();

    expect(client.browse).toHaveBeenCalledTimes(2);
    expect(states.get('a')).toMatchObject({ fillState: 'filling', nextPage: 3 });
  });

  it('never brings back a source removed while one of its pages was being fetched', async () => {
    const { filler, client, repo, states, known, sources } = build();
    client.browse.mockImplementation(async (_conn, sourceId: string, page: number) => {
      if (page === 2) {
        sources.splice(0, sources.length);
        await repo.deleteNovelIndexSources([sourceId]);
      }
      return { items: items(`p${page}`, 1), page, hasMore: true };
    });

    await filler.tick();

    expect(client.browse).toHaveBeenCalledTimes(2);
    expect(states.has('a')).toBe(false);
    expect(known.has('a')).toBe(false);
  });

  it('leaves a rebuild that lands during a fetch at its first page, with no stale entries', async () => {
    const { filler, client, repo, states, known } = build();
    client.browse.mockImplementation(async (_conn, sourceId: string, page: number) => {
      if (page === 2) await repo.resetNovelIndexSource(sourceId);
      return { items: items(`p${page}`, 1), page, hasMore: true };
    });

    await filler.tick();

    expect(states.get('a')).toMatchObject({ fillState: 'pending', nextPage: 1, entries: 0, fillSort: null });
    expect(known.has('a')).toBe(false);
  });

  it('leaves no stale error on a source rebuilt while a failing run was in flight', async () => {
    const { filler, client, repo, states } = build();
    client.browse.mockImplementation(async (_conn, sourceId: string, page: number) => {
      if (page === 2) await repo.resetNovelIndexSource(sourceId);
      return { items: items(`p${page}`, 1), page, hasMore: true };
    });
    const commit = repo.commitNovelIndexPage.getMockImplementation()!;
    repo.commitNovelIndexPage.mockImplementation(async (...args) => {
      if (repo.commitNovelIndexPage.mock.calls.length === 2) throw new Error('database went away');
      return commit(...args);
    });

    await filler.tick();

    expect(states.get('a')).toMatchObject({ fillState: 'pending', nextPage: 1, lastError: null });
  });

  it('runs a requested source now and rebuilds one from its first page', async () => {
    const { filler, client, repo, states } = build({ pages: { a: [items('x', 1)] } });
    states.set('a', {
      sourceId: 'a',
      fillState: 'done',
      nextPage: 7,
      fillSort: null,
      filledAt: NOW,
      lastTopupAt: NOW,
      entries: 9,
      lastError: null,
      requestsToday: 0,
      requestsDay: null,
      emptyPage: null,
      firstPageFailures: 0,
      recheckAt: null,
    });

    const status = await filler.fillNow('a', USER);
    await filler.tick();
    expect(status.sources[0]).toMatchObject({ sourceId: 'a', name: 'A', enabled: true });
    expect(client.browse.mock.calls[0]![3]).toMatchObject({ filters: { orderBy: { value: 'latest' } } });

    client.browse.mockClear();
    await filler.rebuild('a', USER);
    await filler.tick();
    await filler.fillNow('a', USER);
    await filler.tick();
    expect(repo.resetNovelIndexSource).toHaveBeenCalledWith('a');
    expect(client.browse.mock.calls[0]![2]).toBe(1);
    expect(client.browse.mock.calls[0]![3]).toMatchObject({ filters: { orderBy: { value: 'alphabetical' } } });
    expect(states.get('a')).toMatchObject({ fillState: 'done', entries: 1 });
  });

  it('refuses actions on a source that is not installed or while the index is not configured', async () => {
    const { filler, index } = build();
    await expect(filler.fillNow('nope', USER)).rejects.toBeInstanceOf(NotFoundException);
    index.scope.mockResolvedValue(null as never);
    await expect(filler.rebuild('a', USER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports every installed source with its fill and today’s requests only', async () => {
    const { filler, states } = build({ sources: [{ id: 'a' }, { id: 'b' }], enabled: ['a'], budget: 300 });
    states.set('a', {
      sourceId: 'a',
      fillState: 'filling',
      nextPage: 4,
      fillSort: null,
      filledAt: null,
      lastTopupAt: null,
      entries: 70,
      lastError: 'boom',
      requestsToday: 3,
      requestsDay: '2026-10-13',
      emptyPage: null,
      firstPageFailures: 0,
      recheckAt: null,
    });

    await expect(filler.status()).resolves.toEqual({
      dailyBudget: 300,
      unavailable: false,
      sources: [
        {
          sourceId: 'a',
          name: 'A',
          enabled: true,
          fillState: 'filling',
          nextPage: 4,
          entries: 70,
          filledAt: null,
          lastTopupAt: null,
          lastError: 'boom',
          requestsToday: 0,
          running: false,
        },
        {
          sourceId: 'b',
          name: 'B',
          enabled: false,
          fillState: 'pending',
          nextPage: 1,
          entries: 0,
          filledAt: null,
          lastTopupAt: null,
          lastError: null,
          requestsToday: 0,
          running: false,
        },
      ],
    });
  });
});
