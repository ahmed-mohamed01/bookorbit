import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { MonitoredAuthorConfig, MonitoredWork, ProviderConfigurations } from '@bookorbit/types';
import type { MergedWork, Observation } from './reconcile/observation.types';
import type { MonitoredCatalog } from './monitored-store.service';
import {
  MonitoredCatalogService,
  enforceUniqueWorkIds,
  normalizeMonitoredName,
  resolvePreviousWorks,
  shouldKeepPreviousCatalog,
  shouldRejectEmptyCatalog,
} from './monitored-catalog.service';
import { mapHardcoverObservations } from './providers/hardcover-bibliography.provider';

describe('monitored catalog helpers', () => {
  it('normalizes author identity without punctuation or diacritics', () => {
    expect(normalizeMonitoredName('Álex N. Gilbert')).toBe('alexngilbert');
  });

  it('keeps the previous catalog only when a FAILING Hardcover collapsed it', () => {
    const failed = { attempted: true, failed: true };
    const healthy = { attempted: true, failed: false };
    const disabled = { attempted: false, failed: false };

    expect(shouldKeepPreviousCatalog(5, 0, failed)).toBe(true);
    expect(shouldKeepPreviousCatalog(5, 1, failed)).toBe(true);
    expect(shouldKeepPreviousCatalog(5, 4, failed)).toBe(false);
    // A healthy Hardcover that simply has nothing for a small author must not 503 forever.
    expect(shouldKeepPreviousCatalog(5, 0, healthy)).toBe(false);
    // Hardcover switched off is not a Hardcover outage.
    expect(shouldKeepPreviousCatalog(5, 0, disabled)).toBe(false);
    expect(shouldKeepPreviousCatalog(0, 0, failed)).toBe(false);
  });

  it('refuses to persist an empty first catalog when Hardcover failed', () => {
    expect(shouldRejectEmptyCatalog({ attempted: true, failed: true }, 0)).toBe(true);
    expect(shouldRejectEmptyCatalog({ attempted: true, failed: true }, 3)).toBe(false);
    expect(shouldRejectEmptyCatalog({ attempted: true, failed: false }, 0)).toBe(false);
    expect(shouldRejectEmptyCatalog({ attempted: false, failed: false }, 0)).toBe(false);
  });

  it('maps Hardcover contributions without discarding evidence before reconciliation', () => {
    const observations = mapHardcoverObservations([
      { contribution: 'Author', book: { id: 2, slug: 'variant', title: 'Variant', canonical_id: 1, users_count: 2 } },
      { contribution: 'Author', book: { id: 1, slug: 'canonical', title: 'Canonical', users_count: 10 } },
    ]);

    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ id: 'hc:2', canonicalId: 'hc:1', role: 'Author' });
  });

  it('maps every distinct Hardcover series membership with its own index', () => {
    const [observation] = mapHardcoverObservations([
      {
        contribution: 'Author',
        book: {
          id: 1,
          slug: 'tress-of-the-emerald-sea',
          title: 'Tress of the Emerald Sea',
          featured_book_series: { position: 1, series: { name: "Hoid's Travails" } },
          book_series: [
            { position: 1, series: { id: 1, name: " Hoid's Travails " } },
            { position: 1, series: { id: 2, name: 'Secret Projects' } },
            { position: 29, series: { id: 3, name: 'The Cosmere' } },
            { position: 99, series: { id: 4, name: 'the cosmere' } },
          ],
        },
      },
    ]);

    expect(observation.seriesName).toBe("Hoid's Travails");
    expect(observation.seriesMemberships).toEqual([
      { name: "Hoid's Travails", index: '1' },
      { name: 'Secret Projects', index: '1' },
      { name: 'The Cosmere', index: '29' },
    ]);
  });

  it('falls back to the featured Hardcover series when memberships are missing', () => {
    const [observation] = mapHardcoverObservations([
      {
        book: {
          id: 1,
          slug: 'test-book',
          title: 'Test Book',
          featured_book_series: { position: 2, series: { name: 'Test Series' } },
        },
      },
    ]);

    expect(observation.seriesMemberships).toEqual([{ name: 'Test Series', index: '2' }]);
  });

  it('uses previous work only for stable identity, not mutable user state', () => {
    const service = new MonitoredCatalogService({} as never, {} as never, {} as never, {} as never, {} as never);
    const previousWork = {
      id: 'stable-id',
      providerWorkIds: { hardcover: '1' },
      monitorState: 'paused',
      monitorFormats: { ebook: false },
      userVisibility: 'hidden',
      requestIds: { ebook: 10 },
    };
    const merged = {
      title: 'Test',
      subtitle: null,
      seriesName: null,
      seriesIndex: null,
      seriesMemberships: [],
      releaseYear: 2026,
      ebookReleaseDate: '2026',
      ebookDatePrecision: 'year',
      audioReleaseDate: null,
      audioDatePrecision: null,
      cover: null,
      description: null,
      sources: ['hardcover'],
      providerWorkIds: { hardcover: '1' },
    };
    const mapped = Reflect.apply((service as unknown as { mapWork: (...args: unknown[]) => unknown }).mapWork, service, [
      'monitor-1',
      merged,
      { verdict: 'verified', flags: [] },
      previousWork,
    ]);

    expect(mapped).toMatchObject({ id: 'stable-id', monitorState: 'monitoring', monitorFormats: {}, requestIds: {} });
    expect(mapped).not.toHaveProperty('userVisibility');
  });
});

function mergedWork(patch: Partial<MergedWork>): MergedWork {
  return { title: 'Untitled', seriesName: null, seriesIndex: null, providerWorkIds: {}, ...patch } as MergedWork;
}

function previousCatalog(works: Partial<MonitoredWorkLike>[]): MonitoredCatalog {
  return { fetchedAt: '2026-01-01T00:00:00.000Z', works: works as MonitoredCatalog['works'] };
}

type MonitoredWorkLike = {
  id: string;
  title: string;
  seriesName: string | null;
  seriesIndex: string | null;
  providerWorkIds: Record<string, string>;
};

describe('resolvePreviousWorks', () => {
  it('never hands the same previous work to two clusters', () => {
    const previous = previousCatalog([{ id: 'stable-1', title: 'Skyward', seriesName: null, seriesIndex: null, providerWorkIds: {} }]);
    const resolved = resolvePreviousWorks([mergedWork({ title: 'Skyward' }), mergedWork({ title: 'skyward' })], previous);

    expect(resolved[0]?.id).toBe('stable-1');
    expect(resolved[1]).toBeUndefined();
  });

  it('keeps both stable ids when two previous works share a normalized title', () => {
    const previous = previousCatalog([
      { id: 'stable-1', title: 'Legion', seriesName: null, seriesIndex: null, providerWorkIds: {} },
      { id: 'stable-2', title: 'legion', seriesName: null, seriesIndex: null, providerWorkIds: {} },
    ]);
    const resolved = resolvePreviousWorks([mergedWork({ title: 'Legion' }), mergedWork({ title: 'LEGION' })], previous);

    expect(resolved.map((work) => work?.id)).toEqual(['stable-1', 'stable-2']);
  });

  it('gives a contested previous work to the strongest tier, not the first cluster', () => {
    const previous = previousCatalog([
      { id: 'stable-1', title: 'Skyward', seriesName: null, seriesIndex: null, providerWorkIds: { hardcover: '77' } },
    ]);
    const resolved = resolvePreviousWorks(
      [mergedWork({ title: 'Skyward' }), mergedWork({ title: 'Different Title', providerWorkIds: { hardcover: '77' } })],
      previous,
    );

    expect(resolved[1]?.id).toBe('stable-1');
    expect(resolved[0]).toBeUndefined();
  });
});

describe('enforceUniqueWorkIds', () => {
  it('renames a colliding work id and reports the collision', () => {
    const works = [{ id: 'dup' }, { id: 'dup' }, { id: 'other' }] as Parameters<typeof enforceUniqueWorkIds>[0];
    const collisions = enforceUniqueWorkIds(works);

    expect(collisions).toEqual(['dup']);
    expect(new Set(works.map((work) => work.id)).size).toBe(3);
  });
});

function observation(patch: Partial<Observation> = {}): Observation {
  return {
    source: 'goodreads',
    id: 'gr:1',
    canonicalId: null,
    title: 'Some Book',
    subtitle: null,
    hasDesc: false,
    description: null,
    cover: null,
    releaseDate: null,
    releaseYear: 2020,
    precision: 'year',
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    popularity: 10,
    popularityKind: 'ratings',
    format: 'unknown',
    language: null,
    role: null,
    isbn10: null,
    isbn13: null,
    asin: null,
    raw: {},
    ...patch,
  } as Observation;
}

function fakeProvider(source: string, options: { enabled?: boolean; observations?: Observation[]; failWith?: Error } = {}) {
  return {
    source,
    curated: false,
    isEnabled: () => options.enabled ?? true,
    resolveAuthor: vi.fn(() => {
      if (options.failWith) return Promise.reject(options.failWith);
      return Promise.resolve({ id: '1', name: 'Test Author', bookCount: null, imageUrl: null });
    }),
    fetchObservations: vi.fn(() => {
      if (options.failWith) return Promise.reject(options.failWith);
      return Promise.resolve(options.observations ?? []);
    }),
    toObservations: (rows: unknown[]) => rows as Observation[],
  };
}

function monitorConfig(): MonitoredAuthorConfig {
  return {
    id: 'monitor-1',
    ownerUserId: 1,
    isShared: false,
    authorName: 'Test Author',
    localAuthorId: null,
    providerIds: {},
    formats: {
      ebook: { mode: 'notify', libraryId: null, folderId: null },
      audiobook: { mode: 'notify', libraryId: null, folderId: null },
    },
    paused: false,
    addedAt: '2026-01-01T00:00:00.000Z',
    lastRefreshedAt: null,
  };
}

function providerConfig(): ProviderConfigurations {
  return {
    hardcover: { enabled: true, apiKey: 'key' },
    goodreads: { enabled: true },
    audible: { enabled: true, domain: 'com' },
  } as ProviderConfigurations;
}

function previousWorks(count: number): MonitoredCatalog {
  return {
    fetchedAt: '2026-01-01T00:00:00.000Z',
    works: Array.from({ length: count }, (_, index) => ({
      id: `work-${index}`,
      title: `Work ${index}`,
      providerWorkIds: {},
    })) as MonitoredCatalog['works'],
  };
}

function catalogService(providers: { hardcover: unknown; goodreads: unknown; audible: unknown }, store: Record<string, unknown>) {
  return new MonitoredCatalogService(
    providers.hardcover as never,
    providers.goodreads as never,
    providers.audible as never,
    store as never,
    {} as never,
  );
}

// A provider that swallowed its own outage reported success, and the guards that exist to protect a
// known-good catalog from a Hardcover outage never fired. These pin the three outcomes apart.
describe('fetchCatalog provider failure guards', () => {
  it('keeps the previous catalog and fails loudly when the Hardcover fetch throws', async () => {
    const store = { getCatalog: vi.fn().mockResolvedValue(previousWorks(5)), saveCatalog: vi.fn() };
    const service = catalogService(
      {
        hardcover: fakeProvider('hardcover', { failWith: new Error('hardcover 503') }),
        goodreads: fakeProvider('goodreads', { observations: [observation()] }),
        audible: fakeProvider('audible', { enabled: false }),
      },
      store,
    );

    await expect(service.fetchCatalog(monitorConfig(), providerConfig())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(store.saveCatalog).not.toHaveBeenCalled();
  });

  it('refuses to persist a first catalog built during a Hardcover outage', async () => {
    const store = { getCatalog: vi.fn().mockResolvedValue(null), saveCatalog: vi.fn() };
    const service = catalogService(
      {
        hardcover: fakeProvider('hardcover', { failWith: new Error('hardcover 503') }),
        goodreads: fakeProvider('goodreads', { enabled: false }),
        audible: fakeProvider('audible', { enabled: false }),
      },
      store,
    );

    await expect(service.fetchCatalog(monitorConfig(), providerConfig())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(store.saveCatalog).not.toHaveBeenCalled();
  });

  it('never fires the guard when Hardcover is switched off rather than failing', async () => {
    const store = { getCatalog: vi.fn().mockResolvedValue(previousWorks(5)), saveCatalog: vi.fn() };
    const service = catalogService(
      {
        hardcover: fakeProvider('hardcover', { enabled: false }),
        goodreads: fakeProvider('goodreads', { observations: [observation()] }),
        audible: fakeProvider('audible', { enabled: false }),
      },
      store,
    );

    await expect(service.fetchCatalog(monitorConfig(), providerConfig())).resolves.toMatchObject({ catalog: { works: [] } });
    expect(store.saveCatalog).toHaveBeenCalledOnce();
  });

  it('lets a genuinely empty Hardcover bibliography shrink the catalog', async () => {
    const store = { getCatalog: vi.fn().mockResolvedValue(previousWorks(5)), saveCatalog: vi.fn() };
    const service = catalogService(
      {
        hardcover: fakeProvider('hardcover', { observations: [] }),
        goodreads: fakeProvider('goodreads', { observations: [] }),
        audible: fakeProvider('audible', { enabled: false }),
      },
      store,
    );

    await expect(service.fetchCatalog(monitorConfig(), providerConfig())).resolves.toMatchObject({ catalog: { works: [] } });
    expect(store.saveCatalog).toHaveBeenCalledOnce();
  });
});

describe('targeted availability recompute', () => {
  /** A db whose selects answer from a queue, in the order matchOwnedBooks issues them. */
  function queuedSelectDb(results: unknown[][]) {
    const queue = [...results];
    const select = vi.fn(() => {
      const rows = queue.shift() ?? [];
      const builder: Record<string, unknown> = {};
      for (const step of ['from', 'innerJoin', 'leftJoin']) builder[step] = vi.fn(() => builder);
      builder.where = vi.fn(() => Promise.resolve(rows));
      return builder;
    });
    return { select };
  }

  function monitor(patch: Partial<MonitoredAuthorConfig> = {}): MonitoredAuthorConfig {
    return {
      id: 'monitor-1',
      ownerUserId: 1,
      isShared: false,
      authorName: 'Zogarth',
      localAuthorId: 7,
      providerIds: {},
      formats: {
        ebook: { mode: 'notify', libraryId: null, folderId: null },
        audiobook: { mode: 'notify', libraryId: null, folderId: null },
      },
      paused: false,
      addedAt: '2026-01-01T00:00:00.000Z',
      lastRefreshedAt: null,
      ...patch,
    };
  }

  function work(patch: Partial<MonitoredWork> = {}): MonitoredWork {
    return {
      id: 'monitor-1:hardcover:1',
      title: 'The Primal Hunter 15',
      subtitle: null,
      seriesName: null,
      seriesIndex: null,
      seriesMemberships: [],
      releaseYear: 2026,
      ebookReleaseDate: '2026-09-01',
      ebookDatePrecision: 'day',
      audioReleaseDate: null,
      audioDatePrecision: null,
      coverUrl: null,
      description: null,
      verdict: 'verified',
      flags: [],
      sources: ['hardcover'],
      providerWorkIds: {},
      monitorState: 'monitoring',
      matchedBookId: null,
      matchedBookIds: {},
      ownedFormats: [],
      monitorFormats: {},
      requestIds: {},
      ...patch,
    };
  }

  function libraryRow(patch: Record<string, unknown> = {}) {
    return { bookId: 5, title: 'The Primal Hunter 15', seriesName: null, seriesIndex: null, publishedYear: null, format: 'epub', ...patch };
  }

  function harness(rows: unknown[][]) {
    const store = { updateWorkMatch: vi.fn().mockResolvedValue(undefined), saveCatalog: vi.fn(), updateWorkUserState: vi.fn() };
    const db = queuedSelectDb(rows);
    const service = new MonitoredCatalogService({} as never, {} as never, {} as never, store as never, db as never);
    return { service, store, db };
  }

  it('rematches only the works whose filed request has outrun their stored match', async () => {
    const queued = work({ id: 'w-queued', requestIds: { ebook: 42 } });
    const alreadyOwned = work({
      id: 'w-owned',
      title: 'The Primal Hunter 14',
      requestIds: { ebook: 41 },
      matchedBookId: 9,
      matchedBookIds: { ebook: 9 },
      ownedFormats: ['ebook'],
    });
    const neverRequested = work({ id: 'w-quiet', title: 'The Primal Hunter 13' });
    const { service, store } = harness([[libraryRow()]]);

    const healed = await service.recomputeWorkAvailability([{ monitor: monitor(), works: [queued, alreadyOwned, neverRequested] }]);

    expect([...healed]).toEqual(['w-queued']);
    expect(store.updateWorkMatch).toHaveBeenCalledTimes(1);
    expect(store.updateWorkMatch).toHaveBeenCalledWith('w-queued', {
      matchedBookId: 5,
      matchedBookIds: { ebook: 5 },
      ownedFormats: ['ebook'],
    });
  });

  it('writes the owned-match columns and nothing else, leaving the caller its own works', async () => {
    const queued = work({ id: 'w-queued', requestIds: { ebook: 42 } });
    const { service, store } = harness([[libraryRow()]]);

    await service.recomputeWorkAvailability([{ monitor: monitor(), works: [queued] }]);

    expect(Object.keys(store.updateWorkMatch.mock.calls[0][1])).toEqual(['matchedBookId', 'matchedBookIds', 'ownedFormats']);
    expect(store.saveCatalog).not.toHaveBeenCalled();
    expect(store.updateWorkUserState).not.toHaveBeenCalled();
    // The composed work belongs to the read that is rendering it; the rematch answers through the store.
    expect(queued.matchedBookId).toBeNull();
    expect(queued.ownedFormats).toEqual([]);
  });

  it('leaves a work alone for the cooldown window however often it is read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
    try {
      const queued = work({ id: 'w-queued', requestIds: { ebook: 42 } });
      const { service, store, db } = harness([[libraryRow()], [libraryRow()]]);
      const group = [{ monitor: monitor(), works: [queued] }];

      await service.recomputeWorkAvailability(group);
      await service.recomputeWorkAvailability(group);

      expect(db.select).toHaveBeenCalledTimes(1);
      expect(store.updateWorkMatch).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-09-05T12:01:01.000Z'));
      await service.recomputeWorkAvailability(group);

      expect(store.updateWorkMatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches through the same tiered path a refresh uses, down to the series-prefix bridge', async () => {
    const queued = work({
      id: 'w-queued',
      title: 'The Shattered Lens',
      seriesName: 'Alcatraz vs. the Evil Librarians',
      requestIds: { audiobook: 42 },
    });
    const { service, store } = harness([
      [libraryRow({ bookId: 8, title: 'Alcatraz versus the Shattered Lens', seriesName: 'Alcatraz', format: 'm4b' })],
    ]);

    const healed = await service.recomputeWorkAvailability([{ monitor: monitor(), works: [queued] }]);

    expect([...healed]).toEqual(['w-queued']);
    expect(store.updateWorkMatch).toHaveBeenCalledWith('w-queued', {
      matchedBookId: 8,
      matchedBookIds: { audiobook: 8 },
      ownedFormats: ['audiobook'],
    });
  });

  it('reports nothing healed, and writes nothing, when the library still has no such book', async () => {
    const queued = work({ id: 'w-queued', requestIds: { ebook: 42 } });
    const { service, store } = harness([[]]);

    const healed = await service.recomputeWorkAvailability([{ monitor: monitor(), works: [queued] }]);

    expect(healed.size).toBe(0);
    expect(store.updateWorkMatch).not.toHaveBeenCalled();
  });
});
