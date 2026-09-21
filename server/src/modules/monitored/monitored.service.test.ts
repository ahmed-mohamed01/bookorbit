import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitoredAuthorConfig, MonitoredWork } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { MonitoredAutoRequestService } from './monitored-autorequest.service';
import { MonitoredService } from './monitored.service';

const viewer = { id: 1, isSuperuser: false } as RequestUser;

function author(patch: Partial<MonitoredAuthorConfig> = {}): MonitoredAuthorConfig {
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
    ...patch,
  };
}

function work(patch: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'monitor-1:hardcover:1',
    title: 'Test Work',
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: 2026,
    ebookReleaseDate: '2026-09-10',
    ebookDatePrecision: 'day',
    audioReleaseDate: '2026-09-20',
    audioDatePrecision: 'day',
    coverUrl: null,
    description: null,
    verdict: 'verified',
    flags: [],
    sources: ['hardcover', 'audible'],
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

type ServiceDeps = {
  catalog?: Record<string, unknown>;
  authorsRepository?: Record<string, unknown>;
  monitoredAuthorStore?: Record<string, unknown>;
  authorMetadataPreferences?: Record<string, unknown>;
  enrichmentExecutor?: Record<string, unknown>;
  authorImageStorage?: Record<string, unknown>;
  hardcover?: Record<string, unknown>;
  providerConfigs?: Record<string, unknown>;
  libraryService?: Record<string, unknown>;
  indexerSearch?: Record<string, unknown>;
  fulfillment?: Record<string, unknown>;
  autoRequests?: Record<string, unknown>;
  appSettings?: Record<string, unknown>;
  releaseWatcher?: Record<string, unknown>;
  releaseProbe?: Record<string, unknown>;
  releaseDateLookup?: Record<string, unknown>;
};

function service(store: Record<string, unknown>, bookRequests: Record<string, unknown> = {}, deps: ServiceDeps = {}): MonitoredService {
  const autoRequests = deps.autoRequests ?? new MonitoredAutoRequestService(bookRequests as never, store as never);
  return new MonitoredService(
    store as never,
    // Every read path asks the catalog to heal stale availability first, so the collaborator has to
    // be there even for tests that are not about healing.
    { recomputeWorkAvailability: vi.fn().mockResolvedValue(new Set<string>()), ...deps.catalog } as never,
    autoRequests as never,
    (deps.hardcover ?? {}) as never,
    (deps.providerConfigs ?? {
      forUser: vi.fn().mockResolvedValue({ hardcover: { enabled: true, apiKey: 'key' }, audible: { enabled: true, domain: 'com' } }),
    }) as never,
    (deps.authorsRepository ?? {}) as never,
    (deps.monitoredAuthorStore ?? {}) as never,
    (deps.authorMetadataPreferences ?? {}) as never,
    (deps.enrichmentExecutor ?? {}) as never,
    (deps.libraryService ?? {}) as never,
    bookRequests as never,
    (deps.fulfillment ?? {}) as never,
    (deps.indexerSearch ?? {}) as never,
    (deps.authorImageStorage ?? {}) as never,
    (deps.appSettings ?? { getMonitoredSettings: vi.fn().mockResolvedValue({ refreshCooldownMinutes: 10, releaseProbeEnabled: true }) }) as never,
    (deps.releaseWatcher ?? { checkMonitor: vi.fn().mockResolvedValue({ announced: 0 }) }) as never,
    (deps.releaseProbe ?? { enrolAndProbe: vi.fn().mockResolvedValue(undefined) }) as never,
    (deps.releaseDateLookup ?? { lookup: vi.fn().mockResolvedValue({ format: 'ebook', candidates: [], unavailable: [] }) }) as never,
  );
}

function refreshHarness(profile: { hasPhoto: boolean; description: string | null }) {
  const monitor = author({ localAuthorId: 7 });
  const execute = vi.fn().mockResolvedValue({ kind: 'updated' });
  const store = {
    getAuthor: vi.fn().mockResolvedValue(monitor),
    updateAuthorFields: vi.fn().mockResolvedValue(monitor),
    getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [] }),
  };
  const instance = service(
    store,
    {},
    {
      catalog: { fetchCatalog: vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z' }, hardcoverAuthorId: null }) },
      authorsRepository: { findByIdForEnrichment: vi.fn().mockResolvedValue({ ...profile, website: null, genres: [] }) },
      authorMetadataPreferences: { getPreferences: vi.fn().mockResolvedValue({}) },
      enrichmentExecutor: { execute },
    },
  );
  return { instance, execute };
}

/** A create path that reaches the catalog fetch: everything before it resolves, nothing else matters. */
function createHarness(fetchCatalog: ReturnType<typeof vi.fn>, providerConfigs?: Record<string, unknown>) {
  let saved: Record<string, unknown> = {};
  const store = {
    hasAuthorNamed: vi.fn().mockResolvedValue(false),
    upsertAuthor: vi.fn().mockImplementation((input: Record<string, unknown>) => {
      saved = { ...input, id: input.id ?? 'monitor-1' };
      return Promise.resolve(saved);
    }),
    updateAuthorFields: vi.fn().mockImplementation((_id: string, fields: Record<string, unknown>) => {
      saved = { ...saved, ...fields };
      return Promise.resolve(saved);
    }),
    removeAuthor: vi.fn().mockResolvedValue(true),
    getCatalog: vi.fn().mockResolvedValue(null),
  };
  const instance = service(
    store,
    {},
    {
      catalog: { fetchCatalog },
      providerConfigs,
      authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null), findOrCreateByName: vi.fn().mockResolvedValue(null) },
    },
  );
  return { instance, store };
}

describe('MonitoredService', () => {
  it('emits independent ebook and audiobook releases with per-format status', async () => {
    const monitoredWork = work({
      requestIds: { audiobook: 22 },
      requestStatuses: { audiobook: 'grabbed' },
      matchedBookIds: { ebook: 11 },
      ownedFormats: ['ebook'],
    });
    const store = {
      findReleasePage: vi.fn().mockResolvedValue({
        items: [
          { monitor: author(), work: monitoredWork, format: 'ebook', releaseDate: '2026-09-10' },
          { monitor: author(), work: monitoredWork, format: 'audiobook', releaseDate: '2026-09-20' },
        ],
        total: 2,
        page: 0,
        size: 50,
      }),
    };

    const result = await service(store).listReleases(viewer, { page: 0, size: 50, sort: 'date', order: 'asc', filter: 'all' });

    expect(result.items).toHaveLength(2);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ format: 'ebook', status: 'grabbed', requestId: null }),
        expect.objectContaining({ format: 'audiobook', status: 'queued', requestId: 22 }),
      ]),
    );
    expect(store.findReleasePage).toHaveBeenCalledWith(expect.objectContaining({ viewer, page: 0, size: 50, sort: 'date', filter: 'all' }));
  });

  it('reports a filed release as grabbed while its book request is still recorded on the work', async () => {
    const monitoredWork = work({ requestIds: { ebook: 22 }, matchedBookIds: { ebook: 11 }, ownedFormats: ['ebook'] });
    const store = {
      findReleasePage: vi.fn().mockResolvedValue({
        items: [{ monitor: author(), work: monitoredWork, format: 'ebook', releaseDate: '2026-09-10' }],
        total: 1,
        page: 0,
        size: 50,
      }),
    };

    const result = await service(store).listReleases(viewer, { page: 0, size: 50, sort: 'date', order: 'asc', filter: 'all' });

    // The request id outliving the download must not pin the row to "queued" forever.
    expect(result.items[0]).toEqual(expect.objectContaining({ status: 'grabbed', requestId: 22 }));
  });

  it.each([
    ['downloading', 'downloading'],
    ['importing', 'moving'],
    ['needs_review', 'needs_review'],
    ['failed', 'available'],
  ] as const)('maps a %s request to the %s release state', async (requestStatus, expectedStatus) => {
    const monitoredWork = work({ requestIds: { ebook: 22 }, requestStatuses: { ebook: requestStatus } });
    const store = {
      findReleasePage: vi.fn().mockResolvedValue({
        items: [{ monitor: author(), work: monitoredWork, format: 'ebook', releaseDate: '2026-09-01' }],
        total: 1,
        page: 0,
        size: 50,
      }),
    };

    const result = await service(store).listReleases(viewer, { page: 0, size: 50, sort: 'date', order: 'asc', filter: 'all' });

    expect(result.items[0]?.status).toBe(expectedStatus);
  });

  it('lists year, month, and day precision releases whose ranges overlap the window edges', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
    try {
      const releaseWorks = [
        work({ id: 'year', ebookReleaseDate: '2026', ebookDatePrecision: 'year', audioReleaseDate: null, audioDatePrecision: null }),
        work({ id: 'month', ebookReleaseDate: '2026-06', ebookDatePrecision: 'month', audioReleaseDate: null, audioDatePrecision: null }),
        work({ id: 'day', ebookReleaseDate: '2027-09-05', ebookDatePrecision: 'day', audioReleaseDate: null, audioDatePrecision: null }),
      ];
      const store = {
        findReleasePage: vi.fn().mockResolvedValue({
          items: releaseWorks.map((item) => ({ monitor: author(), work: item, format: 'ebook', releaseDate: item.ebookReleaseDate })),
          total: 3,
          page: 0,
          size: 50,
        }),
      };

      const result = await service(store).listReleases(viewer, { page: 0, size: 50, sort: 'date', order: 'asc', filter: 'all' });

      expect(result.items.map((release) => release.workId)).toEqual(['year', 'month', 'day']);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['regular user', viewer],
    ['superuser', { id: 9, isSuperuser: true } as RequestUser],
  ])('does not let a %s request work from a monitor owned by another user', async (_label, actor) => {
    const submit = vi.fn();
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author({ ownerUserId: 2 }), work: work() }) };

    await expect(service(store, { submit }).requestFromWork(actor, work().id, { format: 'ebook' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses an ebook request for an audiobook-only work', async () => {
    const submit = vi.fn();
    const audioOnly = work({ ebookReleaseDate: null, ebookDatePrecision: null, audioReleaseDate: '2026-05-01', audioDatePrecision: 'day' });
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: audioOnly }) };

    await expect(service(store, { submit }).requestFromWork(viewer, audioOnly.id, { format: 'ebook' })).rejects.toBeInstanceOf(BadRequestException);
    expect(submit).not.toHaveBeenCalled();
  });

  it('omits a fractional series index from a request instead of truncating it', async () => {
    const submit = vi.fn().mockResolvedValue({ request: { id: 91 } });
    const updateWorkUserState = vi.fn().mockResolvedValue(work({ requestIds: { ebook: 91 } }));
    const store = {
      getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: work({ seriesName: 'Test Series', seriesIndex: '4.5' }) }),
      updateWorkUserState,
    };

    await service(store, { submit }).requestFromWork(viewer, work().id, { format: 'ebook' });

    expect(submit.mock.calls[0]?.[0]).not.toHaveProperty('seriesIndex');
    expect(updateWorkUserState).toHaveBeenCalledWith(work().id, { requestIds: { ebook: 91 } }, viewer);
  });

  it('maps autoDownload to the auto-request autoGrab option', async () => {
    const monitoredAuthor = author();
    const monitoredWork = work();
    const submitWorkRequest = vi.fn().mockResolvedValue(monitoredWork);
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: monitoredAuthor, work: monitoredWork }) };

    await service(store, {}, { autoRequests: { submitWorkRequest } }).requestFromWork(viewer, monitoredWork.id, {
      format: 'ebook',
      autoDownload: false,
    });

    expect(submitWorkRequest).toHaveBeenCalledWith(viewer, monitoredAuthor, monitoredWork, 'ebook', { autoGrab: false });
  });

  it('omits the autoGrab option when autoDownload is undefined', async () => {
    const monitoredAuthor = author();
    const monitoredWork = work();
    const submitWorkRequest = vi.fn().mockResolvedValue(monitoredWork);
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: monitoredAuthor, work: monitoredWork }) };

    await service(store, {}, { autoRequests: { submitWorkRequest } }).requestFromWork(viewer, monitoredWork.id, { format: 'ebook' });

    expect(submitWorkRequest).toHaveBeenCalledWith(viewer, monitoredAuthor, monitoredWork, 'ebook', undefined);
  });

  it('asks the lookup service with the work, its monitor and its provider ids', async () => {
    const lookup = vi.fn().mockResolvedValue({ format: 'ebook', candidates: [], unavailable: [] });
    const target = work({ providerWorkIds: { hardcover: 'the-infinite-extent', audible: 'B012345678' } });
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: target }) };

    await expect(service(store, {}, { releaseDateLookup: { lookup } }).listReleaseDateCandidates(viewer, target.id, 'ebook')).resolves.toEqual({
      format: 'ebook',
      candidates: [],
      unavailable: [],
    });
    expect(lookup).toHaveBeenCalledWith({
      workId: target.id,
      title: target.title,
      authorName: author().authorName,
      hardcoverSlug: 'the-infinite-extent',
      audibleAsin: 'B012345678',
      format: 'ebook',
      userId: viewer.id,
    });
  });

  it('refuses candidates and asks no provider while the release probe is off', async () => {
    const lookup = vi.fn();
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: work() }) };
    const instance = service(
      store,
      {},
      {
        appSettings: { getMonitoredSettings: vi.fn().mockResolvedValue({ refreshCooldownMinutes: 10, releaseProbeEnabled: false }) },
        releaseDateLookup: { lookup },
      },
    );

    await expect(instance.listReleaseDateCandidates(viewer, work().id, 'ebook')).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      message: 'The release date probe is turned off',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('still asks the providers while the release probe is on', async () => {
    const lookup = vi.fn().mockResolvedValue({ format: 'ebook', candidates: [], unavailable: [] });
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: work() }) };
    const instance = service(
      store,
      {},
      {
        appSettings: { getMonitoredSettings: vi.fn().mockResolvedValue({ refreshCooldownMinutes: 10, releaseProbeEnabled: true }) },
        releaseDateLookup: { lookup },
      },
    );

    await expect(instance.listReleaseDateCandidates(viewer, work().id, 'ebook')).resolves.toMatchObject({ format: 'ebook' });
    expect(lookup).toHaveBeenCalledOnce();
  });

  it.each([
    ['a work that does not exist', null, NotFoundException],
    ['a monitor owned by another user', { monitor: author({ ownerUserId: 2 }), work: work() }, ForbiddenException],
  ])('answers for %s before it reads the release probe setting', async (_label, entry, expected) => {
    const getMonitoredSettings = vi.fn();
    const lookup = vi.fn();
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue(entry) };
    const instance = service(store, {}, { appSettings: { getMonitoredSettings }, releaseDateLookup: { lookup } });

    await expect(instance.listReleaseDateCandidates(viewer, work().id, 'ebook')).rejects.toBeInstanceOf(expected);
    expect(getMonitoredSettings).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['candidates', (instance: MonitoredService) => instance.listReleaseDateCandidates(viewer, work().id, 'ebook')],
    ['a chosen date', (instance: MonitoredService) => instance.setWorkReleaseDate(viewer, work().id, 'ebook', '2027-01-02')],
    ['a refresh', (instance: MonitoredService) => instance.refreshWorkReleaseDates(viewer, work().id)],
  ])('refuses %s on a monitor owned by another user', async (_label, call) => {
    const releaseProbe = { setUserReleaseDate: vi.fn(), clearUserReleaseDate: vi.fn(), refreshWork: vi.fn() };
    const lookup = vi.fn();
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author({ ownerUserId: 2 }), work: work() }) };

    await expect(call(service(store, {}, { releaseProbe, releaseDateLookup: { lookup } }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(lookup).not.toHaveBeenCalled();
    expect(releaseProbe.setUserReleaseDate).not.toHaveBeenCalled();
    expect(releaseProbe.refreshWork).not.toHaveBeenCalled();
  });

  it.each([
    ['candidates', (instance: MonitoredService) => instance.listReleaseDateCandidates(viewer, 'gone', 'ebook')],
    ['a chosen date', (instance: MonitoredService) => instance.setWorkReleaseDate(viewer, 'gone', 'ebook', null)],
    ['a refresh', (instance: MonitoredService) => instance.refreshWorkReleaseDates(viewer, 'gone')],
  ])('answers 404 for %s on a work that does not exist', async (_label, call) => {
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue(null) };

    await expect(call(service(store))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stores a chosen date against the work and its monitor, then returns the fresh work', async () => {
    const setUserReleaseDate = vi.fn().mockResolvedValue(1);
    // A chosen date changes the probe row, not what the providers list, so the lookup cache stands.
    const forget = vi.fn();
    const stored = work({
      formatReleases: {
        ebook: {
          status: 'dated',
          releaseDate: '2027-01-02',
          precision: 'day',
          source: 'user',
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      },
    });
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: stored }) };

    await expect(
      service(store, {}, { releaseProbe: { setUserReleaseDate }, releaseDateLookup: { forget } }).setWorkReleaseDate(
        viewer,
        stored.id,
        'ebook',
        '2027-01-02',
      ),
    ).resolves.toBe(stored);

    expect(setUserReleaseDate).toHaveBeenCalledWith({ id: stored.id, monitorAuthorId: author().id, ownerUserId: 1 }, 'ebook', '2027-01-02');
    expect(forget).not.toHaveBeenCalled();
  });

  it('clears a chosen date instead of storing one when the date is null', async () => {
    const releaseProbe = { setUserReleaseDate: vi.fn(), clearUserReleaseDate: vi.fn().mockResolvedValue(true) };
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: work() }) };

    await service(store, {}, { releaseProbe }).setWorkReleaseDate(viewer, work().id, 'audiobook', null);

    expect(releaseProbe.clearUserReleaseDate).toHaveBeenCalledWith(work().id, 'audiobook');
    expect(releaseProbe.setUserReleaseDate).not.toHaveBeenCalled();
  });

  it('refreshes one work through the probe and returns what it wrote', async () => {
    const refreshWork = vi.fn().mockResolvedValue(undefined);
    const refreshed = work({ ebookReleaseDate: '2027-02-02' });
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: refreshed }) };

    await expect(service(store, {}, { releaseProbe: { refreshWork } }).refreshWorkReleaseDates(viewer, refreshed.id)).resolves.toBe(refreshed);

    expect(refreshWork).toHaveBeenCalledWith({ id: author().id, ownerUserId: 1 }, refreshed.id);
  });

  it('surfaces a failed work refresh without dropping cached candidates', async () => {
    const refreshWork = vi.fn().mockRejectedValue(new Error('probe failed'));
    const forget = vi.fn();
    const stored = work();
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: stored }) };

    await expect(
      service(store, {}, { releaseProbe: { refreshWork }, releaseDateLookup: { forget } }).refreshWorkReleaseDates(viewer, stored.id),
    ).rejects.toThrow('probe failed');

    expect(forget).not.toHaveBeenCalled();
  });

  it('rejects an overlay update for a monitor owned by another user', async () => {
    const updateWorkUserState = vi.fn();
    const foreign = author({ ownerUserId: 2 });
    const store = {
      getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: foreign, work: work() }),
      getAuthor: vi.fn().mockResolvedValue(foreign),
      updateWorkUserState,
    };

    await expect(service(store).updateWork(viewer, work().id, { hidden: true })).rejects.toBeInstanceOf(ForbiddenException);
    expect(updateWorkUserState).not.toHaveBeenCalled();
  });

  it('derives summary counts directly from the store count query', async () => {
    const countSummary = vi.fn().mockResolvedValue({ authors: 2, books: 3, releases: 4 });
    await expect(service({ countSummary }).getSummary(viewer)).resolves.toEqual({
      authors: 2,
      books: 3,
      releases: 4,
      hardcoverConfigured: true,
      audibleConfigured: true,
    });
    expect(countSummary).toHaveBeenCalledOnce();
  });

  it('reports Hardcover as unconfigured when the provider is disabled', async () => {
    const countSummary = vi.fn().mockResolvedValue({ authors: 2, books: 3, releases: 4 });
    const providerConfigs = {
      forUser: vi.fn().mockResolvedValue({ hardcover: { enabled: false, apiKey: 'key' }, audible: { enabled: true, domain: 'com' } }),
    };

    await expect(service({ countSummary }, {}, { providerConfigs }).getSummary(viewer)).resolves.toEqual({
      authors: 2,
      books: 3,
      releases: 4,
      hardcoverConfigured: false,
      audibleConfigured: true,
    });
  });

  it('reports Audible as unconfigured when the provider is disabled, since audiobook dates come only from it', async () => {
    const countSummary = vi.fn().mockResolvedValue({ authors: 2, books: 3, releases: 4 });
    const providerConfigs = {
      forUser: vi.fn().mockResolvedValue({ hardcover: { enabled: true, apiKey: 'key' }, audible: { enabled: false, domain: 'com' } }),
    };

    await expect(service({ countSummary }, {}, { providerConfigs }).getSummary(viewer)).resolves.toEqual({
      authors: 2,
      books: 3,
      releases: 4,
      hardcoverConfigured: true,
      audibleConfigured: false,
    });
  });

  // This pins the wiring only: the aggregate is read from the store instead of composing catalogs.
  // It cannot see the store's counting SQL (the reference here IS the JS summarizer), so the
  // null-safety of the visible/hidden buckets is asserted on the generated SQL in the store suite.
  it('reads list counts from the store aggregate instead of loading catalogs', async () => {
    const monitor = author();
    const seededWorks = [
      work({ id: 'owned-ebook', ownedFormats: ['ebook'] }),
      work({ id: 'hidden', userVisibility: 'hidden', ownedFormats: ['ebook', 'audiobook'] }),
      work({ id: 'visible-override', verdict: 'suspect', userVisibility: 'visible', ownedFormats: ['audiobook'] }),
    ];
    const referenceService = service({});
    const reference = Reflect.apply(
      (referenceService as unknown as { summarizeWorks: (...args: unknown[]) => unknown }).summarizeWorks,
      referenceService,
      [monitor, seededWorks],
    );
    const store = {
      findAuthorPage: vi.fn().mockResolvedValue({ items: [{ author: monitor, aggregate: reference }], total: 1, page: 0, size: 50 }),
    };
    const instance = service(store, {}, { authorsRepository: { findPortraitCandidates: vi.fn().mockResolvedValue([]) } });

    const result = await instance.listAuthors(viewer, { page: 0, size: 50, sort: 'name', order: 'asc' });

    expect(result.items[0]).toMatchObject({ counts: { total: 2, ebookOwned: 1, audioOwned: 1, hidden: 1 } });
    expect(store.findAuthorPage).toHaveBeenCalledWith(expect.objectContaining({ viewer, page: 0, size: 50, sort: 'name' }));
  });

  it('returns author profile metadata after updating monitor settings', async () => {
    const monitor = author({ localAuthorId: 7 });
    const updated = { ...monitor, paused: true };
    const store = {
      getAuthor: vi.fn().mockResolvedValue(monitor),
      updateAuthorFields: vi.fn().mockResolvedValue(updated),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [] }),
    };
    const instance = service(
      store,
      {},
      {
        authorsRepository: {
          findByIdForEnrichment: vi.fn().mockResolvedValue({
            description: 'Author biography',
            website: 'https://author.example',
            genres: ['Fantasy'],
            hasPhoto: true,
          }),
        },
      },
    );

    const result = await instance.updateAuthor('monitor-1', { paused: true }, viewer);

    expect(result).toMatchObject({ description: 'Author biography', portraitAuthorId: 7, website: 'https://author.example', genres: ['Fantasy'] });
    expect(store.updateAuthorFields).toHaveBeenCalledWith('monitor-1', { paused: true }, viewer);
  });

  it('returns no portrait path when the linked local author has no photo', async () => {
    const getImagePath = vi.fn();
    const findByIdForEnrichment = vi.fn().mockResolvedValue({ description: 'bio', website: null, genres: [], hasPhoto: false });
    const store = { getAuthor: vi.fn().mockResolvedValue(author({ localAuthorId: 7 })) };
    const instance = service(store, {}, { authorsRepository: { findByIdForEnrichment }, authorImageStorage: { getImagePath } });

    await expect(instance.getAuthorPortraitPath('monitor-1', viewer)).resolves.toBeNull();
    expect(findByIdForEnrichment).toHaveBeenCalledWith(7);
    expect(getImagePath).not.toHaveBeenCalled();
  });

  it('resolves the portrait path from the linked local author without a library visibility check', async () => {
    const getImagePath = vi.fn().mockResolvedValue('/data/authors/7/photo.png');
    const findByIdForEnrichment = vi.fn().mockResolvedValue({ description: 'bio', website: null, genres: [], hasPhoto: true });
    const store = { getAuthor: vi.fn().mockResolvedValue(author({ localAuthorId: 7 })) };
    const instance = service(store, {}, { authorsRepository: { findByIdForEnrichment }, authorImageStorage: { getImagePath } });

    await expect(instance.getAuthorPortraitPath('monitor-1', viewer)).resolves.toBe('/data/authors/7/photo.png');
    expect(getImagePath).toHaveBeenCalledWith(7);
    expect(store.getAuthor).toHaveBeenCalledWith('monitor-1', viewer);
  });

  it('rejects a portrait request for a monitor the viewer cannot read', async () => {
    const getImagePath = vi.fn();
    const instance = service({ getAuthor: vi.fn().mockResolvedValue(null) }, {}, { authorImageStorage: { getImagePath } });

    await expect(instance.getAuthorPortraitPath('foreign-private', viewer)).rejects.toBeInstanceOf(NotFoundException);
    expect(getImagePath).not.toHaveBeenCalled();
  });

  it('re-enriches the local author on refresh when the profile has no photo', async () => {
    const { instance, execute } = refreshHarness({ hasPhoto: false, description: 'bio' });

    await instance.refreshAuthor('monitor-1', viewer);

    expect(execute).toHaveBeenCalledWith({ authorId: 7, preferences: {}, allowOrphan: true });
  });

  it('re-enriches the local author on refresh when the profile has no description', async () => {
    const { instance, execute } = refreshHarness({ hasPhoto: true, description: null });

    await instance.refreshAuthor('monitor-1', viewer);

    expect(execute).toHaveBeenCalledWith({ authorId: 7, preferences: {}, allowOrphan: true });
  });

  it('does not re-enrich the local author on refresh when the profile is complete', async () => {
    const { instance, execute } = refreshHarness({ hasPhoto: true, description: 'bio' });

    await instance.refreshAuthor('monitor-1', viewer);

    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects refresh when Hardcover is unconfigured before fetching the catalog', async () => {
    const fetchCatalog = vi.fn();
    const instance = service(
      { getAuthor: vi.fn().mockResolvedValue(author()) },
      {},
      {
        catalog: { fetchCatalog },
        providerConfigs: { forUser: vi.fn().mockResolvedValue({ hardcover: { enabled: false, apiKey: 'key' } }) },
      },
    );

    await expect(instance.refreshAuthor('monitor-1', viewer)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it("passes the caller's refresh config to the catalog", async () => {
    const monitor = author({ ownerUserId: 27 });
    const config = { hardcover: { enabled: true, apiKey: 'owner-key' } };
    const forUser = vi.fn().mockResolvedValue(config);
    const failure = new Error('stop after fetch');
    const fetchCatalog = vi.fn().mockRejectedValue(failure);
    const instance = service({ getAuthor: vi.fn().mockResolvedValue(monitor) }, {}, { catalog: { fetchCatalog }, providerConfigs: { forUser } });
    const owner = { id: monitor.ownerUserId, isSuperuser: false } as RequestUser;

    await expect(instance.refreshAuthor(monitor.id, owner)).rejects.toBe(failure);
    expect(forUser).toHaveBeenCalledWith(monitor.ownerUserId);
    expect(fetchCatalog).toHaveBeenCalledWith(monitor, config);
  });

  it('uses the configured refresh cooldown for each monitored author', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T12:00:00.000Z'));
    try {
      const monitor = author({ lastRefreshedAt: '2026-09-06T11:55:00.000Z' });
      const fetchCatalog = vi.fn();
      const instance = service(
        { getAuthor: vi.fn().mockResolvedValue(monitor) },
        {},
        {
          catalog: { fetchCatalog },
          appSettings: { getMonitoredSettings: vi.fn().mockResolvedValue({ refreshCooldownMinutes: 10 }) },
        },
      );

      const failure = await instance.refreshAuthor(monitor.id, viewer).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HttpException);
      expect((failure as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(fetchCatalog).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a refresh once the configured cooldown has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T12:00:00.000Z'));
    try {
      const monitor = author({ lastRefreshedAt: '2026-09-06T11:55:00.000Z' });
      const failure = new Error('stop after fetch');
      const fetchCatalog = vi.fn().mockRejectedValue(failure);
      const instance = service(
        { getAuthor: vi.fn().mockResolvedValue(monitor) },
        {},
        {
          catalog: { fetchCatalog },
          appSettings: { getMonitoredSettings: vi.fn().mockResolvedValue({ refreshCooldownMinutes: 5 }) },
        },
      );

      await expect(instance.refreshAuthor(monitor.id, viewer)).rejects.toBe(failure);
      expect(fetchCatalog).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['disabled', { enabled: false, apiKey: 'key' }],
    ['missing API key', { enabled: true, apiKey: '' }],
  ])('rejects create when Hardcover is %s before writing or fetching the catalog', async (_label, hardcover) => {
    const upsertAuthor = vi.fn();
    const fetchCatalog = vi.fn();
    const instance = service(
      { hasAuthorNamed: vi.fn().mockResolvedValue(false), upsertAuthor },
      {},
      {
        catalog: { fetchCatalog },
        providerConfigs: { forUser: vi.fn().mockResolvedValue({ hardcover }) },
      },
    );

    await expect(instance.createAuthor({ authorName: 'Test Author', formats: {} }, viewer)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(upsertAuthor).not.toHaveBeenCalled();
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it('passes the resolved user config to the create catalog fetch', async () => {
    const config = { hardcover: { enabled: true, apiKey: 'user-key' } };
    const forUser = vi.fn().mockResolvedValue(config);
    const failure = new Error('stop after fetch');
    const fetchCatalog = vi.fn().mockRejectedValue(failure);
    const { instance } = createHarness(fetchCatalog, { forUser });

    await expect(instance.createAuthor({ authorName: 'Test Author', formats: {} }, viewer)).rejects.toBe(failure);
    expect(forUser).toHaveBeenCalledWith(viewer.id);
    expect(fetchCatalog).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: viewer.id }), config);
  });

  it('stamps a new monitor for release checking at the same instant it is added', async () => {
    const failure = new Error('stop after fetch');
    const { instance, store } = createHarness(vi.fn().mockRejectedValue(failure));

    await expect(instance.createAuthor({ authorName: 'Test Author', formats: {} }, viewer)).rejects.toBe(failure);

    const inserted = store.upsertAuthor.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.lastReleaseCheckAt).toBe(inserted.addedAt);
  });

  it('runs create fan-out after reading the saved catalog and succeeds when items failed', async () => {
    const monitoredWork = work();
    const getCatalog = vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [monitoredWork] });
    let saved!: MonitoredAuthorConfig;
    const store = {
      hasAuthorNamed: vi.fn().mockResolvedValue(false),
      upsertAuthor: vi.fn().mockImplementation((input: MonitoredAuthorConfig) => {
        saved = input;
        return Promise.resolve(input);
      }),
      updateAuthorFields: vi.fn().mockImplementation((_id: string, fields: Partial<MonitoredAuthorConfig>) => {
        saved = { ...saved, ...fields };
        return Promise.resolve(saved);
      }),
      removeAuthor: vi.fn(),
      getCatalog,
    };
    const fanOut = vi.fn().mockResolvedValue({ created: 0, skipped: 0, failed: 1 });
    const checkMonitor = vi.fn().mockResolvedValue({ announced: 0 });
    const instance = service(
      store,
      {},
      {
        catalog: { fetchCatalog: vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z' }, hardcoverAuthorId: null }) },
        autoRequests: { fanOut },
        releaseWatcher: { checkMonitor },
        authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null), findOrCreateByName: vi.fn().mockResolvedValue(null) },
      },
    );

    await expect(instance.createAuthor({ authorName: 'Test Author', formats: {} }, viewer)).resolves.toMatchObject({ works: [monitoredWork] });
    expect(fanOut).toHaveBeenCalledWith(expect.objectContaining({ authorName: 'Test Author' }), [monitoredWork], viewer);
    expect(getCatalog.mock.invocationCallOrder[0]).toBeLessThan(fanOut.mock.invocationCallOrder[0]);
    expect(checkMonitor).toHaveBeenCalledWith(expect.objectContaining({ authorName: 'Test Author' }));
    expect(fanOut.mock.invocationCallOrder[0]).toBeLessThan(checkMonitor.mock.invocationCallOrder[0]);
  });

  it('enriches a freshly created local author only once', async () => {
    const monitoredWork = work();
    let saved!: MonitoredAuthorConfig;
    const store = {
      hasAuthorNamed: vi.fn().mockResolvedValue(false),
      upsertAuthor: vi.fn().mockImplementation((input: MonitoredAuthorConfig) => {
        saved = input;
        return Promise.resolve(input);
      }),
      updateAuthorFields: vi.fn().mockImplementation((_id: string, fields: Partial<MonitoredAuthorConfig>) => {
        saved = { ...saved, ...fields };
        return Promise.resolve(saved);
      }),
      removeAuthor: vi.fn(),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [monitoredWork] }),
    };
    const findByIdForEnrichment = vi.fn().mockResolvedValue({ description: null, website: null, genres: [], hasPhoto: false });
    const execute = vi.fn().mockResolvedValue({ kind: 'updated' });
    const instance = service(
      store,
      {},
      {
        catalog: { fetchCatalog: vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z' }, hardcoverAuthorId: null }) },
        autoRequests: { fanOut: vi.fn().mockResolvedValue({ created: 0, skipped: 0, failed: 0 }) },
        authorsRepository: {
          findIdByNormalizedName: vi.fn().mockResolvedValue(null),
          findOrCreateByName: vi.fn().mockResolvedValue(7),
          findByIdForEnrichment,
        },
        authorMetadataPreferences: { getPreferences: vi.fn().mockResolvedValue({}) },
        enrichmentExecutor: { execute },
      },
    );

    await instance.createAuthor({ authorName: 'Test Author', formats: {} }, viewer);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(findByIdForEnrichment).toHaveBeenCalledTimes(1);
  });

  it('runs refresh fan-out after reading the saved catalog and succeeds when items failed', async () => {
    const monitoredAuthor = author({ localAuthorId: 7 });
    const monitoredWork = work();
    const getCatalog = vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [monitoredWork] });
    const store = {
      getAuthor: vi.fn().mockResolvedValue(monitoredAuthor),
      updateAuthorFields: vi.fn().mockResolvedValue(monitoredAuthor),
      getCatalog,
    };
    const fanOut = vi.fn().mockResolvedValue({ created: 0, skipped: 0, failed: 1 });
    const checkMonitor = vi.fn().mockResolvedValue({ announced: 0 });
    const instance = service(
      store,
      {},
      {
        catalog: { fetchCatalog: vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z' }, hardcoverAuthorId: null }) },
        autoRequests: { fanOut },
        releaseWatcher: { checkMonitor },
        authorsRepository: {
          findByIdForEnrichment: vi.fn().mockResolvedValue({ description: 'bio', website: null, genres: [], hasPhoto: true }),
        },
      },
    );

    await expect(instance.refreshAuthor(monitoredAuthor.id, viewer)).resolves.toMatchObject({ works: [monitoredWork] });
    expect(fanOut).toHaveBeenCalledWith(monitoredAuthor, [monitoredWork], viewer);
    expect(getCatalog.mock.invocationCallOrder[0]).toBeLessThan(fanOut.mock.invocationCallOrder[0]);
    expect(checkMonitor).toHaveBeenCalledWith(monitoredAuthor);
    expect(fanOut.mock.invocationCallOrder[0]).toBeLessThan(checkMonitor.mock.invocationCallOrder[0]);
  });

  it('does not fail an interactive refresh when the release check throws', async () => {
    const monitoredAuthor = author({ localAuthorId: 7 });
    const store = {
      getAuthor: vi.fn().mockResolvedValue(monitoredAuthor),
      updateAuthorFields: vi.fn().mockResolvedValue(monitoredAuthor),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [] }),
    };
    const instance = service(
      store,
      {},
      {
        catalog: { fetchCatalog: vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z' }, hardcoverAuthorId: null }) },
        autoRequests: { fanOut: vi.fn().mockResolvedValue({ created: 0, skipped: 0, failed: 0 }) },
        releaseWatcher: { checkMonitor: vi.fn().mockRejectedValue(new Error('notification database unavailable')) },
        authorsRepository: {
          findByIdForEnrichment: vi.fn().mockResolvedValue({ description: 'bio', website: null, genres: [], hasPhoto: true }),
        },
      },
    );

    await expect(instance.refreshAuthor(monitoredAuthor.id, viewer)).resolves.toMatchObject({ works: [] });
  });

  // Unattended requesting is the auto-request follow-up; until then a request must trace back to
  // a human clicking Refresh, so the scheduled path refreshes and persists but never fans out.
  it('refreshes for the scheduler without filing requests', async () => {
    const monitoredAuthor = author({ localAuthorId: 7 });
    const monitoredWork = work();
    const store = {
      updateAuthorFields: vi.fn().mockResolvedValue(monitoredAuthor),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [monitoredWork] }),
    };
    const fanOut = vi.fn().mockResolvedValue({ created: 0, skipped: 0, failed: 0 });
    const instance = service(
      store,
      {},
      {
        catalog: { fetchCatalog: vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z' }, hardcoverAuthorId: null }) },
        autoRequests: { fanOut },
        authorsRepository: {
          findByIdForEnrichment: vi.fn().mockResolvedValue({ description: 'bio', website: null, genres: [], hasPhoto: true }),
        },
      },
    );

    await expect(instance.refreshForSchedule(monitoredAuthor, viewer)).resolves.toBe(true);
    expect(store.updateAuthorFields).toHaveBeenCalledWith(
      monitoredAuthor.id,
      expect.objectContaining({ lastRefreshedAt: expect.anything() }),
      viewer,
    );
    expect(fanOut).not.toHaveBeenCalled();
  });

  it('probes after the catalog fetch and before reading the catalog or filing requests', async () => {
    const monitoredAuthor = author({ localAuthorId: 7 });
    const calls: string[] = [];
    const store = {
      getAuthor: vi.fn().mockResolvedValue(monitoredAuthor),
      updateAuthorFields: vi.fn().mockResolvedValue(monitoredAuthor),
      getCatalog: vi.fn().mockImplementation(() => {
        calls.push('getCatalog');
        return Promise.resolve({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [] });
      }),
    };
    const fanOut = vi.fn().mockImplementation(() => {
      calls.push('fanOut');
      return Promise.resolve({ created: 0, skipped: 0, failed: 0 });
    });
    const instance = service(
      store,
      {},
      {
        catalog: {
          fetchCatalog: vi.fn().mockImplementation(() => {
            calls.push('fetchCatalog');
            return Promise.resolve({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z' }, hardcoverAuthorId: null });
          }),
        },
        releaseProbe: {
          enrolAndProbe: vi.fn().mockImplementation(() => {
            calls.push('probe');
            return Promise.resolve();
          }),
        },
        autoRequests: { fanOut },
        authorsRepository: { findByIdForEnrichment: vi.fn().mockResolvedValue({ description: 'bio', website: null, genres: [], hasPhoto: true }) },
      },
    );

    await instance.refreshAuthor(monitoredAuthor.id, viewer);

    expect(calls).toEqual(['fetchCatalog', 'probe', 'getCatalog', 'fanOut']);
  });

  it('continues a catalog refresh when the release probe rejects', async () => {
    const monitoredAuthor = author({ localAuthorId: 7 });
    const store = {
      getAuthor: vi.fn().mockResolvedValue(monitoredAuthor),
      updateAuthorFields: vi.fn().mockResolvedValue(monitoredAuthor),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [] }),
    };
    const instance = service(
      store,
      {},
      {
        catalog: { fetchCatalog: vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z' }, hardcoverAuthorId: null }) },
        releaseProbe: { enrolAndProbe: vi.fn().mockRejectedValue(new TypeError('probe failed')) },
        autoRequests: { fanOut: vi.fn().mockResolvedValue({ created: 0, skipped: 0, failed: 0 }) },
        authorsRepository: { findByIdForEnrichment: vi.fn().mockResolvedValue({ description: 'bio', website: null, genres: [], hasPhoto: true }) },
      },
    );

    await expect(instance.refreshAuthor(monitoredAuthor.id, viewer)).resolves.toMatchObject({ works: [] });
    expect(store.getCatalog).toHaveBeenCalled();
  });

  it('hands the refreshed detail every class, so the caller can still count what it is not showing', async () => {
    // The detail view replaces its whole copy with this answer and reads every class to count them.
    // Returning only the default class emptied those counts until the next navigation.
    const monitoredAuthor = author({ localAuthorId: 7 });
    const shown = work({ id: 'shown' });
    const underReview = work({ id: 'suspect', verdict: 'suspect' });
    const store = {
      getAuthor: vi.fn().mockResolvedValue(monitoredAuthor),
      updateAuthorFields: vi.fn().mockResolvedValue(monitoredAuthor),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [shown, underReview] }),
    };
    const instance = service(
      store,
      {},
      {
        catalog: { fetchCatalog: vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z' }, hardcoverAuthorId: null }) },
        autoRequests: { fanOut: vi.fn().mockResolvedValue({ created: 0, skipped: 0, failed: 0 }) },
        authorsRepository: {
          findByIdForEnrichment: vi.fn().mockResolvedValue({ description: 'bio', website: null, genres: [], hasPhoto: true }),
        },
      },
    );

    const detail = await instance.refreshAuthor(monitoredAuthor.id, viewer);

    expect(detail.works.map((entry) => entry.id)).toEqual(['shown', 'suspect']);
    // The headline count still reports only what the default list shows.
    expect(detail.author.counts.total).toBe(1);
    expect(detail.author.counts.hidden).toBe(1);
  });

  it('does not revert a concurrent paused patch when refresh finishes from an older snapshot', async () => {
    let current = author({ localAuthorId: 7, paused: false });
    const updateAuthorFields = vi.fn().mockImplementation((_id: string, fields: Partial<MonitoredAuthorConfig>) => {
      current = {
        ...current,
        ...fields,
        providerIds: { ...current.providerIds, ...(fields.providerIds ?? {}) },
      };
      return current;
    });
    const store = {
      getAuthor: vi.fn().mockImplementation(() => current),
      updateAuthorFields,
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-02T00:00:00.000Z', works: [] }),
    };
    const instance = service(
      store,
      {},
      {
        catalog: {
          fetchCatalog: vi.fn().mockImplementation(() => {
            current = { ...current, paused: true };
            return { catalog: { fetchedAt: '2026-09-02T00:00:00.000Z' }, hardcoverAuthorId: '42' };
          }),
        },
        authorsRepository: {
          findByIdForEnrichment: vi.fn().mockResolvedValue({ description: 'bio', website: null, genres: [], hasPhoto: true }),
        },
      },
    );

    const result = await instance.refreshAuthor('monitor-1', viewer);

    expect(result.author.paused).toBe(true);
    expect(updateAuthorFields).toHaveBeenCalledWith(
      'monitor-1',
      { localAuthorId: 7, providerIds: { hardcover: '42' }, lastRefreshedAt: '2026-09-02T00:00:00.000Z' },
      viewer,
    );
    expect(updateAuthorFields.mock.calls[0]?.[1]).not.toHaveProperty('paused');
  });

  it('returns provider matches when the viewer can reach no local library', async () => {
    const findPage = vi.fn().mockResolvedValue({ items: [], total: 0, page: 0, size: 5 });
    const findMonitoredIdsByNames = vi.fn().mockResolvedValue(new Map());
    const instance = service(
      { findMonitoredIdsByNames },
      {},
      {
        authorsRepository: { findPage },
        libraryService: { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) },
        providerConfigs: { forUser: vi.fn().mockResolvedValue({ hardcover: { enabled: true, apiKey: 'key' } }) },
        hardcover: { searchAuthors: vi.fn().mockResolvedValue([{ id: 344878, name: 'Zogarth', books_count: 25 }]) },
      },
    );

    const results = await instance.searchAuthors('zogarth', viewer);

    expect(findPage).toHaveBeenCalledWith(expect.objectContaining({ libraryIds: [] }));
    expect(results).toEqual([
      expect.objectContaining({ name: 'Zogarth', providerIds: { hardcover: '344878' }, localAuthorId: null, alreadyMonitoredId: null }),
    ]);
    expect(findMonitoredIdsByNames).toHaveBeenCalledWith(['Zogarth'], viewer);
  });

  // Hardcover carries "Alexander   Olson" (7 books) and "Alexander Olson" (an empty stub) as two
  // records. Both normalize to one key, and taking the later hit bound the monitor to the stub.
  function searchService(hits: unknown[], local: unknown[] = []) {
    return service(
      { findMonitoredIdsByNames: vi.fn().mockResolvedValue(new Map()) },
      {},
      {
        authorsRepository: { findPage: vi.fn().mockResolvedValue({ items: local, total: local.length, page: 0, size: 5 }) },
        libraryService: { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) },
        providerConfigs: { forUser: vi.fn().mockResolvedValue({ hardcover: { enabled: true, apiKey: 'key' } }) },
        hardcover: { searchAuthors: vi.fn().mockResolvedValue(hits) },
      },
    );
  }

  const fullOlson = { id: 685771, name: 'Alexander   Olson', books_count: 7 };
  const stubOlson = { id: 1163778, name: 'Alexander Olson', books_count: 0 };

  it('keeps the fullest Hardcover record when two of them fold onto one author name', async () => {
    const results = await searchService([fullOlson, stubOlson]).searchAuthors('Alexander Olson', viewer);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ providerIds: { hardcover: '685771' }, bookCount: 7 });
  });

  it('picks the fullest record whichever order the provider returned them in', async () => {
    const results = await searchService([stubOlson, fullOlson]).searchAuthors('Alexander Olson', viewer);

    expect(results[0]).toMatchObject({ providerIds: { hardcover: '685771' }, bookCount: 7 });
  });

  it('holds the first record when neither carries a book count to separate them', async () => {
    const results = await searchService([
      { id: 1, name: 'Alexander Olson' },
      { id: 2, name: 'Alexander   Olson', books_count: 0 },
    ]).searchAuthors('Alexander Olson', viewer);

    expect(results).toHaveLength(1);
    expect(results[0].providerIds).toEqual({ hardcover: '1' });
  });

  it('leaves a library author its own name and id when a provider record folds onto it', async () => {
    const results = await searchService([fullOlson, stubOlson], [{ id: 62, name: 'Alexander Olson', bookCount: 3 }]).searchAuthors(
      'Alexander Olson',
      viewer,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'Alexander Olson', localAuthorId: 62, providerIds: { hardcover: '685771' } });
  });

  it('keeps two genuinely different authors apart', async () => {
    const results = await searchService([fullOlson, { id: 1544174, name: 'Alexander I. Olson', books_count: 1 }]).searchAuthors(
      'Alexander Olson',
      viewer,
    );

    expect(results.map((result) => result.providerIds.hardcover)).toEqual(['685771', '1544174']);
  });

  it('annotates a search hit with the monitor id the bounded lookup returned', async () => {
    const findMonitoredIdsByNames = vi.fn().mockResolvedValue(new Map([['zogarth', 'monitor-9']]));
    const instance = service(
      { findMonitoredIdsByNames },
      {},
      {
        authorsRepository: { findPage: vi.fn().mockResolvedValue({ items: [], total: 0, page: 0, size: 5 }) },
        libraryService: { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) },
        providerConfigs: { forUser: vi.fn().mockResolvedValue({ hardcover: { enabled: true, apiKey: 'key' } }) },
        hardcover: { searchAuthors: vi.fn().mockResolvedValue([{ id: 344878, name: 'Zogarth', books_count: 25 }]) },
      },
    );

    const results = await instance.searchAuthors('zogarth', viewer);

    expect(results[0].alreadyMonitoredId).toBe('monitor-9');
  });

  it('does not run an indexer search on a monitor owned by another user', async () => {
    const search = vi.fn();
    const foreign = author({ ownerUserId: 2 });
    const store = {
      getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: foreign, work: work() }),
      getAuthor: vi.fn().mockResolvedValue(foreign),
    };

    const instance = service(store, {}, { indexerSearch: { search } });

    await expect(instance.searchWorkReleases(viewer, work().id, 'ebook')).rejects.toBeInstanceOf(ForbiddenException);
    expect(search).not.toHaveBeenCalled();
  });

  // Masking is the store's single enforcement point, so what the service owes is reading through it
  // with the viewer attached and passing the result on untouched.
  it('reads the detail catalog through the viewer-scoped store', async () => {
    const foreign = author({ ownerUserId: 2 });
    const getCatalog = vi.fn().mockResolvedValue({
      fetchedAt: '2026-09-01T00:00:00.000Z',
      works: [work({ id: 'w-shown', requestIds: {} })],
    });
    const store = { getAuthor: vi.fn().mockResolvedValue(foreign), getCatalog };
    const instance = service(store, {}, { authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null) } });

    const detail = await instance.getAuthor('monitor-1', viewer, { sort: 'releaseDate', order: 'desc', includeHidden: false });

    expect(getCatalog).toHaveBeenCalledWith('monitor-1', viewer);
    expect(detail.works.map((item) => item.id)).toEqual(['w-shown']);
    expect(detail.works[0].requestIds).toEqual({});
  });

  it('keeps the overlay intact for the monitor owner', async () => {
    const store = {
      getAuthor: vi.fn().mockResolvedValue(author()),
      getCatalog: vi.fn().mockResolvedValue({
        fetchedAt: '2026-09-01T00:00:00.000Z',
        works: [work({ userVisibility: 'visible', requestIds: { ebook: 17 } })],
      }),
    };
    const instance = service(store, {}, { authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null) } });

    const detail = await instance.getAuthor('monitor-1', viewer, { sort: 'releaseDate', order: 'desc', includeHidden: false });

    expect(detail.works[0].requestIds).toEqual({ ebook: 17 });
    expect(detail.works[0].userVisibility).toBe('visible');
  });

  it.each(['asc', 'desc'] as const)('sorts undated works last in %s release-date order because TBA has no date', async (order) => {
    const store = {
      getAuthor: vi.fn().mockResolvedValue(author()),
      getCatalog: vi.fn().mockResolvedValue({
        fetchedAt: '2026-09-01T00:00:00.000Z',
        works: [
          work({ id: 'undated', ebookReleaseDate: null, ebookDatePrecision: null, audioReleaseDate: null, audioDatePrecision: null }),
          work({ id: 'dated', ebookReleaseDate: '2026-10-01', audioReleaseDate: null, audioDatePrecision: null }),
        ],
      }),
    };
    const instance = service(store, {}, { authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null) } });

    const detail = await instance.getAuthor('monitor-1', viewer, { sort: 'releaseDate', order, includeHidden: false });

    expect(detail.works.map((item) => item.id)).toEqual(['dated', 'undated']);
  });

  it('does not let includeHidden reveal works the owner curated away from viewers', async () => {
    const foreign = author({ ownerUserId: 2 });
    const store = {
      getAuthor: vi.fn().mockResolvedValue(foreign),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [work({ userVisibility: 'hidden' })] }),
    };
    const instance = service(store, {}, { authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null) } });

    const detail = await instance.getAuthor('monitor-1', viewer, { sort: 'releaseDate', order: 'desc', includeHidden: true });

    expect(detail.works).toEqual([]);
  });

  it('builds the release feed from the viewer-scoped store rows without a queued status for a masked overlay', async () => {
    const monitoredWork = work({ requestIds: {}, audioReleaseDate: null, audioDatePrecision: null });
    const findReleasePage = vi.fn().mockResolvedValue({
      items: [
        {
          monitor: author({ ownerUserId: 2 }),
          work: monitoredWork,
          format: 'ebook',
          releaseDate: monitoredWork.ebookReleaseDate,
        },
      ],
      total: 1,
      page: 0,
      size: 50,
    });
    const store = { findReleasePage };

    const result = await service(store).listReleases(viewer, { page: 0, size: 50, sort: 'date', order: 'asc', filter: 'all' });

    expect(findReleasePage).toHaveBeenCalledWith(expect.objectContaining({ viewer }));
    expect(result.items.every((release) => release.requestId === null)).toBe(true);
    expect(result.items.every((release) => release.status !== 'queued')).toBe(true);
  });

  it('refuses to monitor a work the viewer-scoped catalog does not carry', async () => {
    const owned = author({ ownerUserId: viewer.id });
    const getCatalog = vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [] });
    const upsertBook = vi.fn();
    const store = { getAuthor: vi.fn().mockResolvedValue(owned), getCatalog, hasBookForWork: vi.fn().mockResolvedValue(false), upsertBook };

    await expect(
      service(store).createBook({ monitorAuthorId: 'monitor-1', workId: 'w-hidden', formats: ['ebook'] } as never, viewer),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(getCatalog).toHaveBeenCalledWith('monitor-1', viewer);
    expect(upsertBook).not.toHaveBeenCalled();
  });

  it('attributes a created monitored book to the caller', async () => {
    const owned = author({ ownerUserId: viewer.id });
    const monitoredWork = work({ id: 'w-shown' });
    const upsertBook = vi.fn().mockImplementation((input: Record<string, unknown>) => Promise.resolve({ ...input, id: 'book-1' }));
    const store = {
      getAuthor: vi.fn().mockResolvedValue(owned),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [monitoredWork] }),
      hasBookForWork: vi.fn().mockResolvedValue(false),
      upsertBook,
    };

    await service(store).createBook({ monitorAuthorId: owned.id, workId: monitoredWork.id, formats: ['ebook'] } as never, viewer);

    expect(upsertBook).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: viewer.id }), viewer);
  });

  it('returns the viewer-scoped work from createBook and updateBook', async () => {
    const owned = author({ ownerUserId: viewer.id });
    const masked = work({ id: 'w-shown', requestIds: {} });
    const getCatalog = vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [masked] });
    const entry = {
      id: 'book-1',
      ownerUserId: viewer.id,
      monitorAuthorId: 'monitor-1',
      workId: 'w-shown',
      formats: ['ebook'],
      paused: false,
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = {
      getAuthor: vi.fn().mockResolvedValue(owned),
      getCatalog,
      hasBookForWork: vi.fn().mockResolvedValue(false),
      getBook: vi.fn().mockResolvedValue(entry),
      upsertBook: vi.fn().mockImplementation((input: Record<string, unknown>) => Promise.resolve({ ...input, id: 'book-1' })),
    };
    const instance = service(store);

    const created = await instance.createBook({ monitorAuthorId: 'monitor-1', workId: 'w-shown', formats: ['ebook'] } as never, viewer);
    const updated = await instance.updateBook('book-1', { paused: true } as never, viewer);

    expect(created.work.requestIds).toEqual({});
    expect(updated.work.requestIds).toEqual({});
    expect(getCatalog).toHaveBeenNthCalledWith(1, 'monitor-1', viewer);
    expect(getCatalog).toHaveBeenNthCalledWith(2, 'monitor-1', viewer);
  });

  it.each([{}, { hidden: undefined }])('does not write an overlay row for the empty work patch %j', async (patch) => {
    const updateWorkUserState = vi.fn();
    const existing = work();
    const store = {
      getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: existing }),
      getAuthor: vi.fn().mockResolvedValue(author()),
      updateWorkUserState,
    };

    await expect(service(store).updateWork(viewer, existing.id, patch)).resolves.toBe(existing);
    expect(updateWorkUserState).not.toHaveBeenCalled();
  });

  it('refuses a download destination in a library the caller cannot reach', async () => {
    const upsertAuthor = vi.fn();
    const instance = service(
      { hasAuthorNamed: vi.fn().mockResolvedValue(false), upsertAuthor },
      {},
      { libraryService: { findAccessibleLibraryIds: vi.fn().mockResolvedValue([9]) } },
    );

    await expect(
      instance.createAuthor({ authorName: 'Probe', formats: { ebook: { mode: 'auto-all', libraryId: 4, folderId: null } } }, viewer),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsertAuthor).not.toHaveBeenCalled();
  });

  it('collapses the internal whitespace a provider name arrives with', async () => {
    const hasAuthorNamed = vi.fn().mockResolvedValue(true);
    const instance = service({ hasAuthorNamed });

    await expect(instance.createAuthor({ authorName: 'Alexander   Olson', formats: {} }, viewer)).rejects.toBeInstanceOf(BadRequestException);

    expect(hasAuthorNamed).toHaveBeenCalledWith(viewer.id, 'Alexander Olson');
  });

  it('checks a create duplicate with one owner-scoped existence query', async () => {
    const hasAuthorNamed = vi.fn().mockResolvedValue(true);
    const instance = service({ hasAuthorNamed });

    await expect(instance.createAuthor({ authorName: ' existing author ', formats: {} }, viewer)).rejects.toBeInstanceOf(BadRequestException);

    expect(hasAuthorNamed).toHaveBeenCalledWith(viewer.id, 'existing author');
  });

  it('refuses a download folder with no library selected', async () => {
    const upsertAuthor = vi.fn();
    const instance = service(
      { hasAuthorNamed: vi.fn().mockResolvedValue(false), upsertAuthor },
      {},
      { libraryService: { findAccessibleLibraryIds: vi.fn().mockResolvedValue([4]) } },
    );

    await expect(
      instance.createAuthor({ authorName: 'Probe', formats: { ebook: { mode: 'auto-all', libraryId: null, folderId: 4 } } }, viewer),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsertAuthor).not.toHaveBeenCalled();
  });

  it('refuses a download folder that belongs to a different library', async () => {
    const upsertAuthor = vi.fn();
    const instance = service(
      { hasAuthorNamed: vi.fn().mockResolvedValue(false), upsertAuthor },
      {},
      {
        libraryService: {
          findAccessibleLibraryIds: vi.fn().mockResolvedValue([4, 5]),
          findOne: vi.fn().mockResolvedValue({ id: 4, folders: [{ id: 4 }] }),
        },
      },
    );

    await expect(
      instance.createAuthor({ authorName: 'Probe', formats: { ebook: { mode: 'auto-all', libraryId: 4, folderId: 5 } } }, viewer),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsertAuthor).not.toHaveBeenCalled();
  });

  it('accepts a download folder that belongs to an accessible library', async () => {
    const findOne = vi.fn().mockResolvedValue({ id: 4, folders: [{ id: 4 }] });
    const boom = new Error('provider unavailable');
    const store = { hasAuthorNamed: vi.fn().mockResolvedValue(false), upsertAuthor: vi.fn().mockRejectedValue(boom), removeAuthor: vi.fn() };
    const instance = service(store, {}, { libraryService: { findAccessibleLibraryIds: vi.fn().mockResolvedValue([4]), findOne } });

    await expect(
      instance.createAuthor({ authorName: 'Probe', formats: { ebook: { mode: 'auto-all', libraryId: 4, folderId: 4 } } }, viewer),
    ).rejects.toBe(boom);
    expect(findOne).toHaveBeenCalledWith(4);
    expect(store.upsertAuthor).toHaveBeenCalledOnce();
  });

  it.each([
    ['direct', Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })],
    ['wrapped', Object.assign(new Error('query failed'), { cause: Object.assign(new Error('duplicate key'), { code: '23505' }) })],
  ])('turns a %s unique violation into a duplicate rejection', async (_label, failure) => {
    const store = { hasAuthorNamed: vi.fn().mockResolvedValue(false), upsertAuthor: vi.fn().mockRejectedValue(failure), removeAuthor: vi.fn() };

    await expect(service(store).createAuthor({ authorName: 'Probe', formats: {} }, viewer)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rate limits a second catalog-fetching create from the same user', async () => {
    const boom = new Error('provider unavailable');
    const instance = createHarness(vi.fn().mockRejectedValue(boom)).instance;

    await expect(instance.createAuthor({ authorName: 'First', formats: {} }, viewer)).rejects.toBe(boom);
    const second = await instance.createAuthor({ authorName: 'Second', formats: {} }, viewer).catch((error: unknown) => error);

    expect(second).toBeInstanceOf(HttpException);
    expect((second as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('rate limits each user independently', async () => {
    const boom = new Error('provider unavailable');
    const instance = createHarness(vi.fn().mockRejectedValue(boom)).instance;

    await expect(instance.createAuthor({ authorName: 'First', formats: {} }, viewer)).rejects.toBe(boom);
    await expect(instance.createAuthor({ authorName: 'Second', formats: {} }, { id: 2, isSuperuser: false } as RequestUser)).rejects.toBe(boom);
  });

  it('does not burn the create cooldown on a create that never reached a provider', async () => {
    const duplicate = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const fetchCatalog = vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z', works: [] }, hardcoverAuthorId: null });
    const { instance, store } = createHarness(fetchCatalog);
    store.upsertAuthor.mockRejectedValueOnce(duplicate);

    await expect(instance.createAuthor({ authorName: 'First', formats: {} }, viewer)).rejects.toBeInstanceOf(BadRequestException);
    await expect(instance.createAuthor({ authorName: 'Second', formats: {} }, viewer)).resolves.toMatchObject({ works: [] });
    expect(fetchCatalog).toHaveBeenCalledOnce();
  });

  // Both orphan predicates (no books, no monitors) are now inside the DELETE, so the service asks
  // once and believes the answer instead of racing a separate read against a concurrent writer.
  it('asks for one atomic orphan delete of the local author row a deleted monitor leaves behind', async () => {
    const deleteOrphanAuthor = vi.fn().mockResolvedValue(true);
    const store = { getAuthor: vi.fn().mockResolvedValue(author({ localAuthorId: 7 })), removeAuthor: vi.fn().mockResolvedValue(true) };

    await service(store, {}, { monitoredAuthorStore: { deleteOrphanAuthor } }).deleteAuthor('monitor-1', viewer);

    expect(deleteOrphanAuthor).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('completes the monitor deletion when the atomic orphan delete matches nothing', async () => {
    const deleteOrphanAuthor = vi.fn().mockResolvedValue(false);
    const store = { getAuthor: vi.fn().mockResolvedValue(author({ localAuthorId: 7 })), removeAuthor: vi.fn().mockResolvedValue(true) };

    await expect(service(store, {}, { monitoredAuthorStore: { deleteOrphanAuthor } }).deleteAuthor('monitor-1', viewer)).resolves.toBeUndefined();
    expect(store.removeAuthor).toHaveBeenCalledWith('monitor-1', viewer);
  });

  it('leaves the monitor deleted when orphan cleanup fails', async () => {
    const store = { getAuthor: vi.fn().mockResolvedValue(author({ localAuthorId: 7 })), removeAuthor: vi.fn().mockResolvedValue(true) };
    const monitoredAuthorStore = { deleteOrphanAuthor: vi.fn().mockRejectedValue(new Error('db down')) };

    await expect(service(store, {}, { monitoredAuthorStore }).deleteAuthor('monitor-1', viewer)).resolves.toBeUndefined();
    expect(store.removeAuthor).toHaveBeenCalledWith('monitor-1', viewer);
  });

  it('defaults unspecified quick-monitor formats to off', () => {
    const instance = service({});
    const result = Reflect.apply((instance as unknown as { mergeFormats: (...args: unknown[]) => unknown }).mergeFormats, instance, [
      undefined,
      { ebook: { mode: 'notify', libraryId: null, folderId: null } },
    ]);

    expect(result).toMatchObject({ ebook: { mode: 'notify' }, audiobook: { mode: 'off' } });
  });

  it('reports isOwner only when the viewer id matches the owner id', async () => {
    const superuser = { id: 9, isSuperuser: true } as RequestUser;
    const foreign = author({ ownerUserId: 1 });
    const aggregate = { counts: { total: 0, ebookOwned: 0, audioOwned: 0, hidden: 0 }, nextReleaseAt: null };
    const store = {
      findAuthorPage: vi.fn().mockResolvedValue({ items: [{ author: foreign, aggregate }], total: 1, page: 0, size: 50 }),
    };
    const instance = service(store, {}, { authorsRepository: { findPortraitCandidates: vi.fn().mockResolvedValue([]) } });

    const query = { page: 0, size: 50, sort: 'name', order: 'asc' } as const;
    const [item] = (await instance.listAuthors(superuser, query)).items;
    const [ownerItem] = (await instance.listAuthors({ id: 1, isSuperuser: false } as RequestUser, query)).items;
    const [strangerItem] = (await instance.listAuthors({ id: 5, isSuperuser: false } as RequestUser, query)).items;

    expect(item.isOwner).toBe(false);
    expect(ownerItem.isOwner).toBe(true);
    expect(strangerItem.isOwner).toBe(false);
  });

  it('refuses a superuser write to another user monitored author', async () => {
    const superuser = { id: 9, isSuperuser: true } as RequestUser;
    const updateAuthorFields = vi.fn();
    const store = { getAuthor: vi.fn().mockResolvedValue(author({ ownerUserId: 1 })), updateAuthorFields };

    await expect(service(store).updateAuthor('monitor-1', { paused: true }, superuser)).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.getAuthor).toHaveBeenCalledWith('monitor-1');
    expect(updateAuthorFields).not.toHaveBeenCalled();
  });

  it('refuses a superuser write to another user monitored book', async () => {
    const superuser = { id: 9, isSuperuser: true } as RequestUser;
    const upsertBook = vi.fn();
    const store = {
      getBook: vi.fn().mockResolvedValue({
        id: 'book-1',
        ownerUserId: 1,
        monitorAuthorId: 'monitor-1',
        workId: 'w-1',
        formats: ['ebook'],
        paused: false,
        addedAt: '2026-01-01T00:00:00.000Z',
      }),
      upsertBook,
    };

    await expect(service(store).updateBook('book-1', { paused: true }, superuser)).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.getBook).toHaveBeenCalledWith('book-1');
    expect(upsertBook).not.toHaveBeenCalled();
  });

  it("rejects a duplicate monitored book with an owner-scoped lookup instead of reading every user's rows", async () => {
    const monitor = author();
    const hasBookForWork = vi.fn().mockResolvedValue(true);
    const store = {
      getAuthor: vi.fn().mockResolvedValue(monitor),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [work({ id: 'w-1' })] }),
      hasBookForWork,
      upsertBook: vi.fn(),
    };

    await expect(
      service(store).createBook({ monitorAuthorId: 'monitor-1', workId: 'w-1', formats: ['ebook'] } as never, viewer),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(hasBookForWork).toHaveBeenCalledWith(viewer.id, 'monitor-1', 'w-1');
  });
});

/**
 * The release store a grab resolves against is keyed by book request id. These cover the seam
 * between a monitored search, which writes no request row, and fulfilment, which can only see
 * results filed under the real one.
 */
describe('MonitoredService release picker', () => {
  const picked = { format: 'ebook', indexerId: 3, releaseGuid: 'guid-1' } as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A request that already exists and was folded in from Requests: its own row carries an ISBN and
   * a language the monitored picker never searched with.
   */
  function grabHarness(options: { warm?: boolean; searchFinds?: boolean; grabRejects?: Error } = {}) {
    const calls: string[] = [];
    const monitor = author();
    const entry = { monitor, work: work({ requestIds: { ebook: 42 } }) };
    const request = {
      id: 42,
      mediaKind: 'ebook',
      title: 'Folded In From Requests',
      authors: ['Someone Else'],
      isbn10: null,
      isbn13: '9780000000001',
      metadataSources: [],
      preferredFormats: ['epub'],
      language: 'eng',
    };
    const held = new Set(options.warm ? [`${picked.indexerId}:${picked.releaseGuid}`] : []);
    const find = vi.fn((requestId: number, indexerId: number, guid: string) => {
      calls.push(`find:${requestId}`);
      return held.has(`${indexerId}:${guid}`) ? { indexerId, guid } : undefined;
    });
    const search = vi.fn(() => {
      calls.push('search');
      if (options.searchFinds !== false) held.add(`${picked.indexerId}:${picked.releaseGuid}`);
      return Promise.resolve({ releases: [] });
    });
    const grab = vi.fn(() => {
      calls.push('grab');
      if (options.grabRejects) return Promise.reject(options.grabRejects);
      return Promise.resolve({ id: 42 });
    });
    const assertCanFulfil = vi.fn(() => {
      calls.push('assertCanFulfil');
      return Promise.resolve({ request });
    });
    const store = {
      getWorkWithMonitor: vi.fn().mockResolvedValue(entry),
      getAuthor: vi.fn().mockResolvedValue(monitor),
    };
    const instance = service(store, { assertCanFulfil }, { indexerSearch: { search, find, forget: vi.fn() }, fulfillment: { grab } });
    return { instance, calls, search, find, grab, request };
  }

  it("warms the real request's own release store before handing the pick to fulfilment", async () => {
    const { instance, calls, search, grab, request } = grabHarness();

    await instance.grabWorkRelease(viewer, work().id, picked);

    // The request is settled first, then searched under its own id, and only a store that holds the
    // pick is grabbed from. Searching after the grab, or under the synthetic search id, is the bug.
    expect(calls).toEqual(['assertCanFulfil', 'assertCanFulfil', 'find:42', 'search', 'find:42', 'grab']);
    expect(search).toHaveBeenCalledWith(request, {
      refresh: true,
      overrides: { title: 'Test Work', authors: ['Test Author'], isbn: null, language: null, preferredFormats: [] },
    });
    expect(grab).toHaveBeenCalledWith(42, { indexerId: 3, releaseGuid: 'guid-1' }, viewer);
  });

  it('resolves to the book request the grab ran under, which is what the caller opens progress for', async () => {
    const { instance } = grabHarness({ warm: true });

    await expect(instance.grabWorkRelease(viewer, work().id, picked)).resolves.toEqual({ id: 42 });
  });

  it('grabs a release the store already holds without a second indexer round trip', async () => {
    const { instance, calls, search, grab } = grabHarness({ warm: true });

    await instance.grabWorkRelease(viewer, work().id, picked);

    expect(calls).toEqual(['assertCanFulfil', 'assertCanFulfil', 'find:42', 'grab']);
    expect(search).not.toHaveBeenCalled();
    expect(grab).toHaveBeenCalledWith(42, { indexerId: 3, releaseGuid: 'guid-1' }, viewer);
  });

  it('surfaces the upstream refusal when a fresh search no longer carries the picked release', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const refusal = new BadRequestException({
      message: 'That release is no longer in the search results. Search again and pick one.',
      errorCode: 'GRAB_RELEASE_REFUSED',
      statusCode: HttpStatus.BAD_REQUEST,
    });
    const { instance, search, grab } = grabHarness({ searchFinds: false, grabRejects: refusal });

    await expect(instance.grabWorkRelease(viewer, work().id, picked)).rejects.toBe(refusal);

    // One warm-up, then the refusal is the truth: the release really is gone from the fresh results.
    expect(search).toHaveBeenCalledTimes(1);
    expect(grab).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[monitored.work.grab_release] [fail]'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requestId=42 searched=true releaseFound=false'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('errorClass=BadRequestException'));
  });

  it('searches under a stable negative id per work and format, and drops the entry nothing reads back', async () => {
    const monitor = author();
    const search = vi.fn().mockResolvedValue({ releases: [] });
    const forget = vi.fn();
    const store = {
      getWorkWithMonitor: vi.fn((id: string) => Promise.resolve({ monitor, work: work({ id }) })),
      getAuthor: vi.fn().mockResolvedValue(monitor),
    };
    const instance = service(store, {}, { indexerSearch: { search, forget } });

    await instance.searchWorkReleases(viewer, 'work-a', 'ebook');
    await instance.searchWorkReleases(viewer, 'work-a', 'ebook');
    await instance.searchWorkReleases(viewer, 'work-a', 'audiobook');
    await instance.searchWorkReleases(viewer, 'work-b', 'ebook');

    const ids = search.mock.calls.map(([request]: [{ id: number }]) => request.id);
    // Negative keeps it clear of every real request id, so a browse can never read or evict one.
    expect(ids.every((id) => id < 0)).toBe(true);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(3);
    expect(forget.mock.calls).toEqual(ids.map((id) => [id]));
  });
});

describe('MonitoredService availability healing', () => {
  function healingHarness(healed: string[], fresh: MonitoredWork[]) {
    const recomputeWorkAvailability = vi.fn().mockResolvedValue(new Set(healed));
    const getComposedWorks = vi.fn().mockResolvedValue(new Map(fresh.map((item) => [item.id, item])));
    return { recomputeWorkAvailability, getComposedWorks };
  }

  it('heals the works of an author detail and answers with what composition then says they own', async () => {
    const stale = work({ id: 'w-queued', requestIds: { ebook: 42 } });
    const { recomputeWorkAvailability, getComposedWorks } = healingHarness(
      ['w-queued'],
      [work({ id: 'w-queued', requestIds: { ebook: 42 }, matchedBookId: 5, matchedBookIds: { ebook: 5 }, ownedFormats: ['ebook'] })],
    );
    const monitor = author({ localAuthorId: 7 });
    const store = {
      getAuthor: vi.fn().mockResolvedValue(monitor),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [stale] }),
      getComposedWorks,
    };
    const instance = service(
      store,
      {},
      {
        catalog: { recomputeWorkAvailability },
        authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null), findByIdForEnrichment: vi.fn().mockResolvedValue(null) },
      },
    );

    const detail = await instance.getAuthor('monitor-1', viewer, { sort: 'releaseDate', order: 'desc', includeHidden: false });

    expect(recomputeWorkAvailability).toHaveBeenCalledWith([{ monitor, works: [stale] }]);
    // Read back through the store, so the masking that decides what a viewer is told they own still rules.
    expect(getComposedWorks).toHaveBeenCalledWith(['w-queued'], viewer);
    expect(detail.works[0].ownedFormats).toEqual(['ebook']);
    expect(detail.author.counts.ebookOwned).toBe(1);
  });

  it('does not read anything back when the rematch changed nothing', async () => {
    const getComposedWorks = vi.fn();
    const store = {
      getAuthor: vi.fn().mockResolvedValue(author()),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [work({ requestIds: { ebook: 42 } })] }),
      getComposedWorks,
    };
    const instance = service(store, {}, { authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null) } });

    await instance.getAuthor('monitor-1', viewer, { sort: 'releaseDate', order: 'desc', includeHidden: false });

    expect(getComposedWorks).not.toHaveBeenCalled();
  });

  it('rematches a release page as one group per author rather than one per row', async () => {
    const first = work({ id: 'w-1', requestIds: { ebook: 42 } });
    const second = work({ id: 'w-2', requestIds: { ebook: 43 } });
    const other = work({ id: 'w-3', requestIds: { ebook: 44 } });
    const monitorA = author({ id: 'monitor-a' });
    const monitorB = author({ id: 'monitor-b' });
    const recomputeWorkAvailability = vi.fn().mockResolvedValue(new Set<string>());
    const store = {
      findReleasePage: vi.fn().mockResolvedValue({
        items: [
          { monitor: monitorA, work: first, format: 'ebook', releaseDate: '2026-09-10' },
          { monitor: monitorA, work: second, format: 'ebook', releaseDate: '2026-09-11' },
          { monitor: monitorB, work: other, format: 'ebook', releaseDate: '2026-09-12' },
        ],
        total: 3,
        page: 0,
        size: 50,
      }),
    };
    const instance = service(store, {}, { catalog: { recomputeWorkAvailability } });

    await instance.listReleases(viewer, { page: 0, size: 50, sort: 'date', order: 'asc', filter: 'all' });

    expect(recomputeWorkAvailability).toHaveBeenCalledWith([
      { monitor: monitorA, works: [first, second] },
      { monitor: monitorB, works: [other] },
    ]);
  });

  it('reports a release as grabbed on the read that healed it', async () => {
    const stale = work({ id: 'w-1', requestIds: { ebook: 42 } });
    const { recomputeWorkAvailability, getComposedWorks } = healingHarness(
      ['w-1'],
      [work({ id: 'w-1', requestIds: { ebook: 42 }, matchedBookId: 5, matchedBookIds: { ebook: 5 }, ownedFormats: ['ebook'] })],
    );
    const store = {
      findReleasePage: vi.fn().mockResolvedValue({
        items: [{ monitor: author(), work: stale, format: 'ebook', releaseDate: '2026-09-10' }],
        total: 1,
        page: 0,
        size: 50,
      }),
      getComposedWorks,
    };
    const instance = service(store, {}, { catalog: { recomputeWorkAvailability } });

    const result = await instance.listReleases(viewer, { page: 0, size: 50, sort: 'date', order: 'asc', filter: 'all' });

    expect(result.items[0]).toEqual(expect.objectContaining({ status: 'grabbed', requestId: 42 }));
  });

  it('heals the single work a work-scoped action reads', async () => {
    const stale = work({ id: 'w-1', requestIds: { ebook: 42 } });
    const monitor = author({ localAuthorId: 7 });
    const { recomputeWorkAvailability, getComposedWorks } = healingHarness(
      ['w-1'],
      [work({ id: 'w-1', requestIds: { ebook: 42 }, matchedBookId: 5, matchedBookIds: { ebook: 5 }, ownedFormats: ['ebook'] })],
    );
    const store = {
      getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor, work: stale }),
      getAuthor: vi.fn().mockResolvedValue(monitor),
      getComposedWorks,
    };
    const instance = service(store, {}, { catalog: { recomputeWorkAvailability } });

    const updated = await instance.updateWork(viewer, 'w-1', {});

    expect(recomputeWorkAvailability).toHaveBeenCalledWith([{ monitor, works: [stale] }]);
    expect(updated.ownedFormats).toEqual(['ebook']);
  });
});
