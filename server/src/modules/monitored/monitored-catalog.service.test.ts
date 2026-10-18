import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { MonitoredAuthorConfig, MonitoredWork, ProviderConfigurations } from '@bookorbit/types';
import type { MergedWork, Observation } from './reconcile/observation.types';
import type { MonitoredCatalog } from './monitored-store.service';
import { emptyWorkMatchOverrides, type FormatMatchOverride, type WorkMatchOverrides } from './monitored-match-overrides';
import {
  MonitoredCatalogService,
  catalogWorkId,
  enforceUniqueWorkIds,
  normalizeMonitoredName,
  resolvePreviousWorks,
  shouldKeepPreviousCatalog,
  shouldRejectEmptyCatalog,
} from './monitored-catalog.service';
import { HardcoverBibliographyProvider, mapHardcoverObservations } from './providers/hardcover-bibliography.provider';
import { HardcoverClient } from '../metadata-fetch/providers/hardcover/hardcover.client';
import * as fetchWithThrottleModule from '../metadata-fetch/fetch-with-throttle';

vi.mock('../metadata-fetch/fetch-with-throttle', () => ({ fetchWithThrottle: vi.fn() }));

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
    const service = new MonitoredCatalogService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
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

  it('keeps a renamed id inside the column when the colliding id is already near its limit', () => {
    const long = 'x'.repeat(254);
    const works = [{ id: long }, { id: long }] as Parameters<typeof enforceUniqueWorkIds>[0];
    enforceUniqueWorkIds(works);

    expect(works[1]!.id).not.toBe(long);
    expect(works[1]!.id.length).toBeLessThanOrEqual(255);
  });
});

describe('catalogWorkId', () => {
  const monitorId = 'a4807888-9349-4135-8935-39d0bea6b5b0';

  it('keeps an id that fits the column unchanged', () => {
    expect(catalogWorkId(monitorId, 'hardcover', 'a-study-in-scarlet')).toBe(`${monitorId}:hardcover:a-study-in-scarlet`);
  });

  it('hashes an omnibus slug that would overflow the column, the same way every refresh', () => {
    const slug =
      'aventuras-de-sherlock-holmes-adventure-of-shoscombe-old-place-adventure-of-the-dying-detective-adventure-of-the-red-circle-boscombe-valley-mystery-case-of-identity-five-orange-pips-problem-of-thor-bridge-scandal-in-bohemia';
    const id = catalogWorkId(monitorId, 'hardcover', slug);

    expect(id.length).toBeLessThanOrEqual(255);
    expect(id).toMatch(new RegExp(`^${monitorId}:hardcover:[0-9a-f]{64}$`));
    expect(catalogWorkId(monitorId, 'hardcover', slug)).toBe(id);
    expect(catalogWorkId(monitorId, 'hardcover', `${slug}-2`)).not.toBe(id);
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
    { getMonitoredSettings: vi.fn().mockResolvedValue({ releaseProbeEnabled: true }) } as never,
  );
}

// A provider that swallowed its own outage reported success, and the guards that exist to protect a
// known-good catalog from a Hardcover outage never fired. These pin the three outcomes apart.
describe('fetchCatalog provider failure guards', () => {
  it('keeps the previous catalog and fails loudly when the Hardcover fetch throws', async () => {
    const store = {
      getCatalog: vi.fn().mockResolvedValue(previousWorks(5)),
      saveCatalog: vi.fn(),
      findMatchOverrides: vi.fn().mockResolvedValue([]),
    };
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
    const store = {
      getCatalog: vi.fn().mockResolvedValue(null),
      saveCatalog: vi.fn(),
      findMatchOverrides: vi.fn().mockResolvedValue([]),
      findClaimedBookIds: vi.fn().mockResolvedValue(new Set<number>()),
    };
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
    const store = {
      getCatalog: vi.fn().mockResolvedValue(previousWorks(5)),
      saveCatalog: vi.fn(),
      findMatchOverrides: vi.fn().mockResolvedValue([]),
    };
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
    expect(store.saveCatalog).toHaveBeenCalledWith('monitor-1', expect.any(Object), { enrolReleaseProbes: true });
  });

  // Driven through the real client and a 503 on the wire, because the whole defect was the client
  // answering a failed request with an empty list: a provider mocked to throw would prove nothing.
  function outagingCatalogService(store: Record<string, unknown>) {
    vi.mocked(fetchWithThrottleModule.fetchWithThrottle).mockResolvedValue({ ok: false, status: 503 } as Response);
    return catalogService(
      {
        hardcover: new HardcoverBibliographyProvider(new HardcoverClient()),
        goodreads: fakeProvider('goodreads', { enabled: false }),
        audible: fakeProvider('audible', { enabled: false }),
      },
      store,
    );
  }

  it('refuses a first catalog when the author search itself failed', async () => {
    const store = {
      getCatalog: vi.fn().mockResolvedValue(null),
      saveCatalog: vi.fn(),
      findMatchOverrides: vi.fn().mockResolvedValue([]),
      findClaimedBookIds: vi.fn().mockResolvedValue(new Set<number>()),
    };

    await expect(outagingCatalogService(store).fetchCatalog(monitorConfig(), providerConfig())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(store.saveCatalog).not.toHaveBeenCalled();
  });

  it('keeps a populated catalog when a refresh cannot resolve the author', async () => {
    const store = {
      getCatalog: vi.fn().mockResolvedValue(previousWorks(5)),
      saveCatalog: vi.fn(),
      findMatchOverrides: vi.fn().mockResolvedValue([]),
    };

    await expect(outagingCatalogService(store).fetchCatalog(monitorConfig(), providerConfig())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(store.saveCatalog).not.toHaveBeenCalled();
  });

  it('lets a genuinely empty Hardcover bibliography shrink the catalog', async () => {
    const store = {
      getCatalog: vi.fn().mockResolvedValue(previousWorks(5)),
      saveCatalog: vi.fn(),
      findMatchOverrides: vi.fn().mockResolvedValue([]),
    };
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
    const store = {
      updateWorkMatch: vi.fn().mockResolvedValue(undefined),
      saveCatalog: vi.fn(),
      updateWorkUserState: vi.fn(),
      findMatchOverrides: vi.fn().mockResolvedValue([]),
      findClaimedBookIds: vi.fn().mockResolvedValue(new Set<number>()),
    };
    const db = queuedSelectDb(rows);
    const service = new MonitoredCatalogService({} as never, {} as never, {} as never, store as never, db as never, {} as never);
    return { service, store, db };
  }

  it('rematches only the works whose filed request has outrun their stored match', async () => {
    const queued = work({ id: 'w-queued', requestIds: { ebook: 42 }, requestStatuses: { ebook: 'available' } });
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
      linkedFormats: [],
      answeredFormats: [],
    });
  });

  it('writes the owned-match columns and nothing else, leaving the caller its own works', async () => {
    const queued = work({ id: 'w-queued', requestIds: { ebook: 42 }, requestStatuses: { ebook: 'available' } });
    const { service, store } = harness([[libraryRow()]]);

    await service.recomputeWorkAvailability([{ monitor: monitor(), works: [queued] }]);

    expect(Object.keys(store.updateWorkMatch.mock.calls[0][1])).toEqual([
      'matchedBookId',
      'matchedBookIds',
      'ownedFormats',
      'linkedFormats',
      'answeredFormats',
    ]);
    expect(store.saveCatalog).not.toHaveBeenCalled();
    expect(store.updateWorkUserState).not.toHaveBeenCalled();
    // The composed work belongs to the read that is rendering it; the rematch answers through the store.
    expect(queued.matchedBookId).toBeNull();
    expect(queued.ownedFormats).toEqual([]);
  });

  it('does not spend the rematch cooldown before a request reaches available', async () => {
    const downloading = work({ id: 'w-downloading', requestIds: { ebook: 42 }, requestStatuses: { ebook: 'downloading' } });
    const { service, store, db } = harness([]);

    const healed = await service.recomputeWorkAvailability([{ monitor: monitor(), works: [downloading] }]);

    expect(healed.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
    expect(store.updateWorkMatch).not.toHaveBeenCalled();
  });

  it('leaves a work alone for the cooldown window however often it is read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
    try {
      const queued = work({ id: 'w-queued', requestIds: { ebook: 42 }, requestStatuses: { ebook: 'available' } });
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
      requestStatuses: { audiobook: 'available' },
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
      linkedFormats: [],
      answeredFormats: [],
    });
  });

  it('reports nothing healed, and writes nothing, when the library still has no such book', async () => {
    const queued = work({ id: 'w-queued', requestIds: { ebook: 42 }, requestStatuses: { ebook: 'available' } });
    const { service, store } = harness([[]]);

    const healed = await service.recomputeWorkAvailability([{ monitor: monitor(), works: [queued] }]);

    expect(healed.size).toBe(0);
    expect(store.updateWorkMatch).not.toHaveBeenCalled();
  });

  describe('owned matching across volume-shaped titles', () => {
    interface PlacedTitle {
      title: string;
      seriesName?: string | null;
      seriesIndex?: string | null;
    }

    async function rematch(workSide: PlacedTitle, librarySide: PlacedTitle) {
      const queued = work({ id: 'w', ...workSide, requestIds: { ebook: 42 }, requestStatuses: { ebook: 'available' } });
      const { service, store } = harness([[libraryRow({ bookId: 8, format: 'epub', ...librarySide })]]);
      await service.recomputeWorkAvailability([{ monitor: monitor(), works: [queued] }]);
      return store;
    }

    const otherVolume: [string, PlacedTitle, PlacedTitle][] = [
      [
        'a later volume against the bare series title',
        { title: 'Beware of Chicken Volume 6', seriesName: 'Beware of Chicken', seriesIndex: '6' },
        { title: 'Beware of Chicken' },
      ],
      [
        'a later volume against the numbered first book',
        { title: 'Beware of Chicken Volume 6', seriesName: 'Beware of Chicken', seriesIndex: '6' },
        { title: 'Beware of Chicken', seriesName: 'Beware of Chicken', seriesIndex: '1' },
      ],
      [
        'a light novel volume against another volume behind the same front',
        { title: 'The Water Magician: Arc 1 Volume 7', seriesName: 'The Water Magician (Light Novel)', seriesIndex: '7' },
        { title: 'The Water Magician: The Central Provinces Arc, Volume 1' },
      ],
      [
        'the first book of a saga against a later entry of the inner series',
        { title: 'Mistborn: The Final Empire', seriesName: 'The Mistborn Saga', seriesIndex: '1' },
        { title: 'Mistborn: Secret History', seriesName: 'Mistborn', seriesIndex: '3.5' },
      ],
      [
        'a colon-front namesake against a later entry of the series',
        { title: 'Mistborn: Collected Tales' },
        { title: 'Mistborn: Secret History', seriesName: 'Mistborn', seriesIndex: '3.5' },
      ],
      [
        'a colon-front series compilation against a later entry of the series',
        { title: 'Mistborn: The Wax & Wayne Series' },
        { title: 'Mistborn: Secret History', seriesName: 'Mistborn', seriesIndex: '3.5' },
      ],
      [
        'a trilogy namesake against the series it names',
        { title: 'Star Wars: Heir to the Empire (Thrawn Trilogy, Book 1)', seriesName: 'Star Wars: The Thrawn Trilogy', seriesIndex: '1' },
        { title: 'Star Wars: Thrawn (Book 1)', seriesName: 'Star Wars: Thrawn', seriesIndex: '1' },
      ],
      [
        'book one of one series against book one of another',
        { title: 'Mistborn: The Final Empire, Book 1', seriesName: 'Mistborn', seriesIndex: '1' },
        { title: 'Mistborn: The Alloy of Law, Book 1', seriesName: 'Mistborn: Wax and Wayne', seriesIndex: '1' },
      ],
      [
        'the prose book against its graphic novel edition',
        { title: 'Dune', seriesName: 'Dune', seriesIndex: '1' },
        { title: 'Dune: The Graphic Novel, Book 1' },
      ],
      [
        'the manga against the light novel edition of the same volume',
        { title: 'The Water Magician (Manga): Volume 2', seriesName: 'The Water Magician (Manga)', seriesIndex: '2' },
        { title: 'The Water Magician: Arc 1 Volume 2', seriesName: 'The Water Magician (Light Novel)', seriesIndex: '2' },
      ],
      [
        'a later volume against the first of a self-named series',
        { title: 'Unintended Cultivator', seriesName: 'Unintended Cultivator', seriesIndex: '3' },
        { title: 'Unintended Cultivator', seriesName: 'Unintended Cultivator', seriesIndex: '1' },
      ],
      ['a spelled-out volume against another', { title: 'Azarinth Healer: Book Seven' }, { title: 'Azarinth Healer: Book Three' }],
      [
        'a stated volume against the numbered first book',
        { title: 'Defiance of the Fall 2: A LitRPG Adventure' },
        { title: 'Defiance of the Fall', seriesName: 'Defiance of the Fall', seriesIndex: '1' },
      ],
    ];

    it.each(otherVolume)('claims none of another volume or edition: %s', async (_, workSide, librarySide) => {
      const store = await rematch(workSide, librarySide);
      expect(store.updateWorkMatch).not.toHaveBeenCalled();
    });

    const otherEdition: [string, PlacedTitle, PlacedTitle][] = [
      [
        'the light novel against the manga edition of the same volume',
        { title: 'The Water Magician: Arc 1 Volume 2', seriesName: 'The Water Magician', seriesIndex: '2' },
        { title: 'The Water Magician: Arc 1 Volume 2 (Manga)', seriesName: 'The Water Magician (Manga)', seriesIndex: '2' },
      ],
      [
        'the prose book against the graphic novel of the same name',
        { title: 'Dungeon Crawler Carl' },
        { title: 'Dungeon Crawler Carl (Graphic Novel)' },
      ],
      [
        'the prose edition against the manga claiming the same series slot',
        { title: 'The Water Magician: Arc 1 Volume 2', seriesName: 'The Water Magician', seriesIndex: '2' },
        { title: 'The Water Magician: Arc 1 Volume 2 (Manga)', seriesName: 'The Water Magician', seriesIndex: '2' },
      ],
      [
        'the light novel volume against the manga edition of the same slot',
        { title: 'Ascendance of a Bookworm: Volume 1 (Light Novel)', seriesName: 'Ascendance of a Bookworm', seriesIndex: '1' },
        { title: 'Ascendance of a Bookworm: Volume 1 (Manga)', seriesName: 'Ascendance of a Bookworm', seriesIndex: '1' },
      ],
    ];

    it.each(otherEdition)('claims none of another edition: %s', async (_, workSide, librarySide) => {
      const store = await rematch(workSide, librarySide);
      expect(store.updateWorkMatch).not.toHaveBeenCalled();
    });

    const sameBook: [string, PlacedTitle, PlacedTitle][] = [
      [
        'the first book against its bare series title',
        { title: 'Beware of Chicken', seriesName: 'Beware of Chicken', seriesIndex: '1' },
        { title: 'Beware of Chicken' },
      ],
      [
        'a trailing volume number against a subtitle',
        { title: 'Beware of Chicken 5', seriesName: 'Beware of Chicken', seriesIndex: '5' },
        { title: 'Beware of Chicken 5: A Xianxia Cultivation Novel' },
      ],
      [
        'the same volume under a longer series name',
        { title: 'The Water Magician: Arc 1 Volume 3', seriesName: 'The Water Magician (Light Novel)', seriesIndex: '3' },
        { title: 'The Water Magician: Arc 1 Volume 3', seriesName: 'The Water Magician: The Central Provinces Arc', seriesIndex: '3' },
      ],
      [
        'the same book under a different series name',
        { title: 'Mistborn: The Final Empire', seriesName: 'The Mistborn Saga', seriesIndex: '1' },
        { title: 'Mistborn: The Final Empire', seriesName: 'Mistborn', seriesIndex: '1' },
      ],
      [
        'the same book numbered in two series',
        { title: 'The Alloy of Law', seriesName: 'Mistborn', seriesIndex: '4' },
        { title: 'The Alloy of Law', seriesName: 'Mistborn: Wax and Wayne', seriesIndex: '1' },
      ],
      [
        'the same book with the series named in the title',
        { title: 'Evershore', seriesName: 'Skyward Flight', seriesIndex: '3' },
        { title: 'Evershore (Skyward Flight)', seriesName: 'Skyward', seriesIndex: '6' },
      ],
      [
        'the same novella slot stated twice',
        { title: 'Mitosis: A Reckoners Story', seriesName: 'The Reckoners', seriesIndex: '1.5' },
        { title: 'Mitosis: The Reckoners (Book 1.5)', seriesName: 'The Reckoners', seriesIndex: '1.5' },
      ],
      [
        'the same volume with and without a subtitle',
        { title: 'The Primal Hunter 16: A LitRPG Adventure', seriesName: 'The Primal Hunter', seriesIndex: '16' },
        { title: 'The Primal Hunter 16', seriesName: 'The Primal Hunter', seriesIndex: '16' },
      ],
      ['a number inside the title word', { title: 'Catch-22', seriesName: 'Catch-22', seriesIndex: '1' }, { title: 'Catch-22' }],
      [
        'the same labelled volume on both sides',
        { title: 'Solo Leveling: Volume 1 (Manga)', seriesName: 'Solo Leveling', seriesIndex: '1' },
        { title: 'Solo Leveling: Volume 1 (Manga)' },
      ],
    ];

    it.each(sameBook)('claims the book the work is: %s', async (_, workSide, librarySide) => {
      const store = await rematch(workSide, librarySide);
      expect(store.updateWorkMatch).toHaveBeenCalledWith('w', {
        matchedBookId: 8,
        matchedBookIds: { ebook: 8 },
        ownedFormats: ['ebook'],
        linkedFormats: [],
        answeredFormats: [],
      });
    });
  });

  describe('owner answers and possible matches', () => {
    type MatchOwnedBooks = (
      works: MonitoredWork[],
      localAuthorId: number | null,
      overrides: Map<string, WorkMatchOverrides>,
      options: { detectPossible: boolean },
    ) => Promise<void>;

    async function match(rows: unknown[][], works: MonitoredWork[], overrides = new Map<string, WorkMatchOverrides>(), detectPossible = true) {
      const { service } = harness(rows);
      const matchOwnedBooks = (service as unknown as { matchOwnedBooks: MatchOwnedBooks }).matchOwnedBooks;
      await Reflect.apply(matchOwnedBooks, service, [works, 7, overrides, { detectPossible }]);
      return works;
    }

    function answers(patch: { ebook?: Partial<FormatMatchOverride> }): WorkMatchOverrides {
      const result = emptyWorkMatchOverrides();
      Object.assign(result.ebook, patch.ebook);
      return result;
    }

    const inhibitorWork = () => work({ id: 'w-ip', title: 'Inhibitor Phase', seriesName: 'Revelation Space', seriesIndex: '4' });
    const inhibitorBook = () => libraryRow({ bookId: 31, title: 'Inhibitor Phase', seriesName: 'Revelation Space', seriesIndex: '5' });

    it('offers a same-titled book with another series number as a possible match instead of matching it', async () => {
      const [result] = await match([[inhibitorBook()]], [inhibitorWork()]);

      expect(result.matchedBookIds).toEqual({});
      expect(result.possibleMatches).toEqual({ ebook: { bookId: 31, title: 'Inhibitor Phase', seriesName: 'Revelation Space', seriesIndex: '5' } });
    });

    it('does not offer a volume another work of the catalog already owns', async () => {
      const volumeOne = work({ id: 'w-1', title: 'Beware of Chicken', seriesName: 'Beware of Chicken', seriesIndex: '1' });
      const volumeSix = work({ id: 'w-6', title: 'Beware of Chicken Volume 6', seriesName: 'Beware of Chicken', seriesIndex: '6' });
      const owned = libraryRow({ bookId: 11, title: 'Beware of Chicken', seriesName: 'Beware of Chicken', seriesIndex: '1' });

      const [first, sixth] = await match([[owned]], [volumeOne, volumeSix]);

      expect(first.matchedBookIds).toEqual({ ebook: 11 });
      expect(sixth.matchedBookIds).toEqual({});
      expect(sixth.possibleMatches).toBeUndefined();
    });

    it('stops offering a book the owner said is a different book', async () => {
      const overrides = new Map([['w-ip', answers({ ebook: { rejected: new Set([31]) } })]]);

      const [result] = await match([[inhibitorBook()]], [inhibitorWork()], overrides);

      expect(result.possibleMatches).toBeUndefined();
      expect(result.matchedBookIds).toEqual({});
      expect(result.answeredFormats).toEqual(['ebook']);
    });

    it('matches a linked book whatever its series number says, and records the link', async () => {
      const overrides = new Map([['w-ip', answers({ ebook: { linkedBookId: 31 } })]]);

      const [result] = await match([[inhibitorBook()], [inhibitorBook()]], [inhibitorWork()], overrides);

      expect(result.matchedBookIds).toEqual({ ebook: 31 });
      expect(result.ownedFormats).toEqual(['ebook']);
      expect(result.linkedFormats).toEqual(['ebook']);
      expect(result.possibleMatches).toBeUndefined();
    });

    it('ignores a link to a book that no longer holds a file of the format', async () => {
      const overrides = new Map([['w-ip', answers({ ebook: { linkedBookId: 31 } })]]);

      const [result] = await match([[libraryRow({ bookId: 31, format: null })], []], [inhibitorWork()], overrides);

      expect(result.matchedBookIds).toEqual({});
      expect(result.linkedFormats).toEqual([]);
    });

    it('keeps an automatic match the owner undid from coming back', async () => {
      const mistborn = work({ id: 'w-m', title: 'Mistborn' });
      const overrides = new Map([['w-m', answers({ ebook: { rejected: new Set([5]) } })]]);

      const [result] = await match([[libraryRow({ title: 'Mistborn' })]], [mistborn], overrides);

      expect(result.matchedBookIds).toEqual({});
      expect(result.ownedFormats).toEqual([]);
    });

    it('brings a possible match back when one work is rematched, unless another work owns the book', async () => {
      const { service, store } = harness([[inhibitorBook()]]);
      const open = await service.rematchWork(monitor(), inhibitorWork());
      expect(open.possibleMatches?.ebook?.bookId).toBe(31);

      const claimed = harness([[inhibitorBook()]]);
      claimed.store.findClaimedBookIds.mockResolvedValue(new Set([31]));
      const owned = await claimed.service.rematchWork(monitor(), inhibitorWork());
      expect(owned.possibleMatches).toBeUndefined();
      expect(claimed.store.findClaimedBookIds).toHaveBeenCalledWith('monitor-1', 'w-ip');
      expect(store.findMatchOverrides).toHaveBeenCalledWith(['monitor-1']);
    });

    it('leaves possible matches alone in a pass that cannot see the rest of the catalog', async () => {
      const [result] = await match([[inhibitorBook()]], [inhibitorWork()], new Map(), false);

      expect(result.possibleMatches).toBeUndefined();
    });
  });
});

// The reason slot resolution hides a work used to be computed and thrown away, leaving the review
// tray unable to say whether a row was a box set, a comic or an anthology.
describe('fetchCatalog review kinds', () => {
  /** matchOwnedBooks runs on every fetch; nothing in this library matches, so every select is empty. */
  function emptySelectDb() {
    const select = vi.fn(() => {
      const builder: Record<string, unknown> = {};
      for (const step of ['from', 'innerJoin', 'leftJoin']) builder[step] = vi.fn(() => builder);
      builder.where = vi.fn(() => Promise.resolve([]));
      return builder;
    });
    return { select };
  }

  const hardcoverBook = (id: number, title: string, raw: Record<string, unknown> = {}) =>
    observation({
      source: 'hardcover',
      id: `hc:${id}`,
      title,
      popularity: 400,
      popularityKind: 'users',
      language: 'english',
      role: 'Author',
      raw: { id, title, book_status: { id: 1, name: 'Published' }, contributor_role_id: 1, users_count: 400, ...raw },
    });

  it('persists the kind of a work it hid, and none for one it never judged', async () => {
    const crowd = Array.from({ length: 6 }, (_, index) => ({ contribution: 'Author', author: { id: index + 1, name: `Author ${index}` } }));
    const store = {
      getCatalog: vi.fn().mockResolvedValue(null),
      saveCatalog: vi.fn(),
      findMatchOverrides: vi.fn().mockResolvedValue([]),
      findClaimedBookIds: vi.fn().mockResolvedValue(new Set<number>()),
    };
    const service = new MonitoredCatalogService(
      fakeProvider('hardcover', {
        observations: [hardcoverBook(1, 'A Real Novel'), hardcoverBook(2, 'Voices of the Deep', { cached_contributors: crowd })],
      }) as never,
      fakeProvider('goodreads', { enabled: false }) as never,
      fakeProvider('audible', { enabled: false }) as never,
      store as never,
      emptySelectDb() as never,
      { getMonitoredSettings: vi.fn().mockResolvedValue({ releaseProbeEnabled: true }) } as never,
    );

    await service.fetchCatalog(monitorConfig(), providerConfig());
    const works = (store.saveCatalog.mock.calls[0][1] as MonitoredCatalog).works;
    const anthology = works.find((work) => work.title === 'Voices of the Deep');

    // Suspect alone is what the tray already knew; the kind is what lets it be filtered to.
    expect(anthology?.verdict).toBe('suspect');
    expect(anthology?.kind).toBe('anthology');
    expect(works.find((work) => work.title === 'A Real Novel')?.kind).toBeUndefined();
  });
});
