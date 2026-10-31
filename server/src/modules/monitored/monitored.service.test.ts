import { Permission } from '@bookorbit/types';
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
import { ProviderThrottleError } from '../metadata-fetch/provider-throttle.error';
import { MonitoredAutoRequestService } from './monitored-autorequest.service';
import { MonitoredService } from './monitored.service';

const viewer = { id: 1, isSuperuser: false, active: true, permissions: [Permission.BookRequestAccess] } as RequestUser;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    fetch: { state: 'idle', errorKind: null, errorAt: null, retryAt: null },
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
  coordinator?: Record<string, unknown>;
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
  requestSources?: Record<string, unknown>;
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
    (deps.requestSources ?? { assertRequestable: vi.fn().mockResolvedValue(undefined) }) as never,
    (deps.fulfillment ?? {}) as never,
    (deps.indexerSearch ?? {}) as never,
    (deps.authorImageStorage ?? {}) as never,
    (deps.appSettings ?? { getMonitoredSettings: vi.fn().mockResolvedValue({ refreshCooldownMinutes: 10, releaseProbeEnabled: true }) }) as never,
    (deps.releaseWatcher ?? { checkMonitor: vi.fn().mockResolvedValue({ announced: 0 }) }) as never,
    (deps.releaseProbe ?? { enrolAndProbe: vi.fn().mockResolvedValue(undefined) }) as never,
    (deps.releaseDateLookup ?? { lookup: vi.fn().mockResolvedValue({ format: 'ebook', candidates: [], unavailable: [] }) }) as never,
    { findByIdWithPermissions: vi.fn().mockResolvedValue(viewer) } as never,
    (deps.coordinator ?? { request: vi.fn().mockResolvedValue(true), enqueueInserted: vi.fn(), clearRetry: vi.fn(), cancel: vi.fn() }) as never,
  );
}

/** A create path that reaches the catalog fetch: everything before it resolves, nothing else matters. */
function createHarness(fetchCatalog: ReturnType<typeof vi.fn>, providerConfigs?: Record<string, unknown>) {
  let saved: Record<string, unknown> = {};
  const store = {
    hasAuthorNamed: vi.fn().mockResolvedValue(false),
    upsertAuthor: vi.fn().mockImplementation((input: Record<string, unknown>) => {
      saved = { ...input, id: input.id ?? 'monitor-1', fetch: { state: input.fetchState, errorKind: null, errorAt: null, retryAt: null } };
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
  it('passes class selections through and returns undated releases as upcoming', async () => {
    const store = {
      findReleasePage: vi.fn().mockResolvedValue({
        items: [{ monitor: author(), work: work({ userVisibility: 'hidden' }), format: 'ebook', releaseDate: null }],
        total: 1,
        page: 0,
        size: 50,
      }),
    };
    const result = await service(store).listReleases(viewer, {
      page: 0,
      size: 50,
      order: 'asc',
      kinds: [],
      more: ['hidden'],
    });
    expect(store.findReleasePage).toHaveBeenCalledWith(expect.objectContaining({ kinds: [], more: ['hidden'] }));
    expect(result.items[0]).toMatchObject({ releaseDate: null, status: 'upcoming' });
  });

  it('maps watchlist search rows to items with isOwner and the author refresh time', async () => {
    const item = (ownerUserId: number) => ({
      work: work({ ownedFormats: ['ebook'] }),
      monitorAuthorId: 'monitor-1',
      authorName: 'Brandon Sanderson',
      authorModes: { ebook: 'auto-all', audiobook: 'off' },
      ownerUserId,
      authorLastRefreshedAt: '2026-09-01T10:00:00.000Z',
    });
    const store = { searchWorks: vi.fn().mockResolvedValue({ items: [item(1), item(2)], total: 2, page: 1, size: 20 }) };

    const result = await service(store).searchWorks(viewer, { q: 'mist', page: 1, size: 20 });

    expect(store.searchWorks).toHaveBeenCalledWith({ viewer, q: 'mist', page: 1, size: 20 });
    expect(result).toMatchObject({ total: 2, page: 1, size: 20 });
    expect(result.items[0]).toMatchObject({ isOwner: true, authorLastRefreshedAt: '2026-09-01T10:00:00.000Z', authorName: 'Brandon Sanderson' });
    expect(result.items[1]).toMatchObject({ isOwner: false });
    expect(result.items[0]).not.toHaveProperty('ownerUserId');
  });

  it('reports an owned undated format as grabbed, not upcoming', async () => {
    const store = {
      findReleasePage: vi.fn().mockResolvedValue({
        items: [{ monitor: author(), work: work({ ownedFormats: ['ebook'] }), format: 'ebook', releaseDate: null }],
        total: 1,
        page: 0,
        size: 50,
      }),
    };
    const result = await service(store).listReleases(viewer, { page: 0, size: 50, order: 'asc', kinds: [], more: ['hidden'] });
    expect(result.items[0]).toMatchObject({ releaseDate: null, status: 'grabbed' });
  });

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
          { monitor: author({ lastRefreshedAt: '2026-09-01T10:00:00.000Z' }), work: monitoredWork, format: 'ebook', releaseDate: '2026-09-10' },
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
        expect.objectContaining({ format: 'ebook', status: 'grabbed', requestId: null, authorLastRefreshedAt: '2026-09-01T10:00:00.000Z' }),
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
    ['superuser', { id: 9, isSuperuser: true, active: true } as RequestUser],
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

  it('accepts an ebook request when the ebook date lives only on its probe row', async () => {
    const expectedEbook = work({
      ebookReleaseDate: null,
      ebookDatePrecision: null,
      audioReleaseDate: '2026-05-01',
      audioDatePrecision: 'day',
      formatReleases: {
        ebook: {
          status: 'expected',
          releaseDate: '2026-10-13',
          precision: 'day',
          source: null,
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      },
    });
    const store = { getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: expectedEbook }) };
    const submitWorkRequest = vi.fn().mockResolvedValue(expectedEbook);

    await service(store, {}, { autoRequests: { submitWorkRequest } }).requestFromWork(viewer, expectedEbook.id, { format: 'ebook' });

    expect(submitWorkRequest).toHaveBeenCalledWith(viewer, expect.anything(), expectedEbook, 'ebook', undefined);
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

  it('classifies skipped, missing, and forbidden works without submitting them', async () => {
    const owned = work({ id: 'owned', ownedFormats: ['ebook'] });
    const active = work({ id: 'active', requestStatuses: { ebook: 'downloading' } });
    const audioOnly = work({ id: 'audio-only', ebookReleaseDate: null, ebookDatePrecision: null });
    const foreign = work({ id: 'foreign' });
    const getWorksWithMonitors = vi.fn().mockResolvedValue(
      new Map([
        ['owned', { monitor: author(), work: owned }],
        ['active', { monitor: author(), work: active }],
        ['audio-only', { monitor: author(), work: audioOnly }],
        ['foreign', { monitor: author({ ownerUserId: 2 }), work: foreign }],
      ]),
    );
    const submitWorkRequest = vi.fn();

    const result = await service({ getWorksWithMonitors }, {}, { autoRequests: { submitWorkRequest } }).bulkRequestWorks(viewer, {
      workIds: ['owned', 'active', 'audio-only', 'missing', 'foreign'],
      format: 'ebook',
    });

    expect(result.results).toEqual([
      { workId: 'owned', format: 'ebook', outcome: 'skipped', reason: 'owned' },
      { workId: 'active', format: 'ebook', outcome: 'skipped', reason: 'requested' },
      { workId: 'audio-only', format: 'ebook', outcome: 'skipped', reason: 'no_ebook' },
      { workId: 'missing', format: 'ebook', outcome: 'failed', reason: 'not_found', message: 'Monitored work not found' },
      { workId: 'foreign', format: 'ebook', outcome: 'failed', reason: 'forbidden', message: 'No access to this monitored work' },
    ]);
    expect(submitWorkRequest).not.toHaveBeenCalled();
  });

  it('expands both formats in order, passes autoDownload, defers after the first chunk, and keeps the latest returned work', async () => {
    const monitoredAuthor = author();
    const first = work({ id: 'work-1' });
    const second = work({ id: 'work-2' });
    const getWorksWithMonitors = vi.fn().mockResolvedValue(
      new Map([
        [first.id, { monitor: monitoredAuthor, work: first }],
        [second.id, { monitor: monitoredAuthor, work: second }],
      ]),
    );
    let requestId = 10;
    const submitWorkRequest = vi.fn((_user, _monitor, candidate: MonitoredWork, format: 'ebook' | 'audiobook', _options?: unknown) => {
      void _options;
      requestId++;
      return Promise.resolve(work({ ...candidate, requestIds: { ...candidate.requestIds, [format]: requestId } }));
    });

    const result = await service({ getWorksWithMonitors }, {}, { autoRequests: { submitWorkRequest } }).bulkRequestWorks(viewer, {
      workIds: [first.id, second.id],
      format: 'both',
      autoDownload: false,
    });

    expect(result.results.map(({ workId, format, outcome }) => ({ workId, format, outcome }))).toEqual([
      { workId: first.id, format: 'ebook', outcome: 'requested' },
      { workId: first.id, format: 'audiobook', outcome: 'requested' },
      { workId: second.id, format: 'ebook', outcome: 'requested' },
      { workId: second.id, format: 'audiobook', outcome: 'requested' },
    ]);
    expect(submitWorkRequest).toHaveBeenCalledTimes(4);
    expect(submitWorkRequest.mock.calls.slice(0, 3).map((call) => call[4])).toEqual([{ autoGrab: false }, { autoGrab: false }, { autoGrab: false }]);
    expect(submitWorkRequest.mock.calls[3]?.[4]).toEqual({ autoGrab: false, deferAutomation: true });
    expect(result.works).toHaveLength(2);
    expect(result.works[0]?.requestIds).toEqual({ audiobook: 12 });
  });

  it('validates bulk sources once and forwards each format selection, including undefined when omitted', async () => {
    const monitoredAuthor = author();
    const monitoredWork = work({ id: 'work-1' });
    const getWorksWithMonitors = vi.fn().mockResolvedValue(new Map([[monitoredWork.id, { monitor: monitoredAuthor, work: monitoredWork }]]));
    const assertRequestable = vi.fn().mockResolvedValue(undefined);
    const submitWorkRequest = vi
      .fn()
      .mockImplementation((_user, _monitor, candidate: MonitoredWork, format: 'ebook' | 'audiobook') =>
        Promise.resolve(work({ ...candidate, requestIds: { [format]: format === 'ebook' ? 11 : 12 } })),
      );

    await service({ getWorksWithMonitors }, {}, { autoRequests: { submitWorkRequest }, requestSources: { assertRequestable } }).bulkRequestWorks(
      viewer,
      {
        workIds: [monitoredWork.id],
        format: 'both',
        sources: { ebook: [1] },
      },
    );

    expect(assertRequestable.mock.calls).toEqual([
      [[1], 'ebook'],
      [undefined, 'audiobook'],
    ]);
    expect(submitWorkRequest).toHaveBeenNthCalledWith(1, viewer, monitoredAuthor, monitoredWork, 'ebook', { sourceIds: [1] });
    expect(submitWorkRequest).toHaveBeenNthCalledWith(2, viewer, monitoredAuthor, monitoredWork, 'audiobook', { sourceIds: undefined });
  });

  it('refuses a bulk source that does not carry the selected format before reading works', async () => {
    const getWorksWithMonitors = vi.fn();
    const assertRequestable = vi.fn().mockRejectedValue(new BadRequestException('Choose sources that search for audiobooks'));
    const instance = service({ getWorksWithMonitors }, {}, { requestSources: { assertRequestable } });

    await expect(instance.bulkRequestWorks(viewer, { workIds: ['work-1'], format: 'audiobook', sources: { audiobook: [1] } })).rejects.toThrow(
      'Choose sources that search for audiobooks',
    );
    expect(assertRequestable).toHaveBeenCalledWith([1], 'audiobook');
    expect(getWorksWithMonitors).not.toHaveBeenCalled();
  });

  it('ignores sources for a format the bulk request does not include', async () => {
    const monitoredAuthor = author();
    const monitoredWork = work({ id: 'work-1' });
    const getWorksWithMonitors = vi.fn().mockResolvedValue(new Map([[monitoredWork.id, { monitor: monitoredAuthor, work: monitoredWork }]]));
    const assertRequestable = vi.fn().mockResolvedValue(undefined);
    const submitWorkRequest = vi.fn().mockResolvedValue(work({ ...monitoredWork, requestIds: { ebook: 11 } }));

    await expect(
      service({ getWorksWithMonitors }, {}, { autoRequests: { submitWorkRequest }, requestSources: { assertRequestable } }).bulkRequestWorks(viewer, {
        workIds: [monitoredWork.id],
        format: 'ebook',
        sources: { ebook: [1], audiobook: [999] },
      }),
    ).resolves.toMatchObject({ results: [{ format: 'ebook', outcome: 'requested' }] });

    expect(assertRequestable.mock.calls).toEqual([[[1], 'ebook']]);
    expect(submitWorkRequest).toHaveBeenCalledWith(viewer, monitoredAuthor, monitoredWork, 'ebook', { sourceIds: [1] });
  });

  it('logs candidate bulk request failures with work, user, format, duration, class, and sanitized error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const monitoredAuthor = author();
    const monitoredWork = work({ id: 'work-1' });
    const getWorksWithMonitors = vi.fn().mockResolvedValue(new Map([[monitoredWork.id, { monitor: monitoredAuthor, work: monitoredWork }]]));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service(
      { getWorksWithMonitors },
      {},
      { autoRequests: { submitWorkRequest: vi.fn().mockRejectedValue(new Error('bad "source"')) } },
    ).bulkRequestWorks(viewer, { workIds: [monitoredWork.id], format: 'ebook' });

    expect(warn).toHaveBeenCalledWith(
      '[monitored.work.bulk_request] [fail] workId="work-1" userId=1 format=ebook durationMs=0 errorClass=Error error="bad \\"source\\"" - monitored work request failed',
    );
  });

  it('reports a destination refusal and stops later candidates of that format', async () => {
    const monitoredAuthor = author();
    const works = Array.from({ length: 4 }, (_, index) => work({ id: `work-${index + 1}` }));
    const getWorksWithMonitors = vi.fn().mockResolvedValue(new Map(works.map((item) => [item.id, { monitor: monitoredAuthor, work: item }])));
    const refusal = new BadRequestException({ message: 'Choose a request destination', errorCode: 'SUBMIT_DESTINATION_REQUIRED' });
    const submitWorkRequest = vi
      .fn()
      .mockRejectedValueOnce(refusal)
      .mockImplementation((_user, _monitor, candidate: MonitoredWork) =>
        Promise.resolve(work({ ...candidate, requestIds: { ebook: Number(candidate.id.slice(-1)) } })),
      );

    const result = await service({ getWorksWithMonitors }, {}, { autoRequests: { submitWorkRequest } }).bulkRequestWorks(viewer, {
      workIds: works.map((item) => item.id),
      format: 'ebook',
    });

    expect(submitWorkRequest).toHaveBeenCalledTimes(3);
    expect(result.results[0]).toMatchObject({ outcome: 'failed', reason: 'destination' });
    expect(result.results[3]).toEqual({
      workId: 'work-4',
      format: 'ebook',
      outcome: 'failed',
      reason: 'destination',
      message: 'Request destination is unavailable',
    });
  });

  it('rejects invalid bulk patches before reading works', async () => {
    const getWorksWithMonitors = vi.fn();
    const instance = service({ getWorksWithMonitors });

    await expect(instance.bulkUpdateWorks(viewer, { workIds: ['work-1'], patch: {} })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      instance.bulkUpdateWorks(viewer, { workIds: ['work-1'], patch: { hidden: true, automaticVisibility: true } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      instance.bulkUpdateWorks(viewer, { workIds: ['work-1'], patch: { kind: 'collection', automaticVisibility: true } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(getWorksWithMonitors).not.toHaveBeenCalled();
  });

  it('reports missing and forbidden bulk updates and writes owned works once', async () => {
    const owned = work({ id: 'owned' });
    const foreign = work({ id: 'foreign' });
    const getWorksWithMonitors = vi.fn().mockResolvedValue(
      new Map([
        ['owned', { monitor: author(), work: owned }],
        ['foreign', { monitor: author({ ownerUserId: 2 }), work: foreign }],
      ]),
    );
    const updated = work({ id: 'owned', monitorFormats: { ebook: false } });
    const updateWorksUserState = vi.fn().mockResolvedValue([updated]);

    const result = await service({ getWorksWithMonitors, updateWorksUserState }).bulkUpdateWorks(viewer, {
      workIds: ['owned', 'missing', 'foreign'],
      patch: { monitorEbook: false },
    });

    expect(updateWorksUserState).toHaveBeenCalledOnce();
    expect(updateWorksUserState).toHaveBeenCalledWith(['owned'], { monitorEbook: false }, viewer);
    expect(result).toEqual({
      works: [updated],
      failed: [
        { workId: 'missing', reason: 'not_found' },
        { workId: 'foreign', reason: 'forbidden' },
      ],
    });
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

  it.each([
    ['visibility', { hidden: true }],
    ['kind', { kind: 'collection' as const }],
  ])('rejects a %s overlay update for a monitor owned by another user', async (_field, patch) => {
    const updateWorkUserState = vi.fn();
    const foreign = author({ ownerUserId: 2 });
    const store = {
      getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: foreign, work: work() }),
      getAuthor: vi.fn().mockResolvedValue(foreign),
      updateWorkUserState,
    };

    await expect(service(store).updateWork(viewer, work().id, patch)).rejects.toBeInstanceOf(ForbiddenException);
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

  it('stamps release checking at the same instant a queued monitor is added', async () => {
    const { instance, store } = createHarness(vi.fn());
    await instance.createAuthor({ authorName: 'Test Author', formats: {} }, viewer);
    const inserted = store.upsertAuthor.mock.calls[0][0];
    expect(inserted.lastReleaseCheckAt).toBe(inserted.addedAt);
    expect(inserted.fetchState).toBe('queued');
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

  it('still returns the library author when Hardcover throttles the search', async () => {
    const instance = service(
      { findMonitoredIdsByNames: vi.fn().mockResolvedValue(new Map()) },
      {},
      {
        authorsRepository: {
          findPage: vi.fn().mockResolvedValue({ items: [{ id: 1920, name: 'Álex Gilbert', bookCount: 14 }], total: 1, page: 0, size: 5 }),
        },
        libraryService: { findAccessibleLibraryIds: vi.fn().mockResolvedValue([1]) },
        providerConfigs: { forUser: vi.fn().mockResolvedValue({ hardcover: { enabled: true, apiKey: 'key' } }) },
        hardcover: { searchAuthors: vi.fn().mockRejectedValue(new ProviderThrottleError(30)) },
      },
    );

    const results = await instance.searchAuthors('Álex Gilbert', viewer);

    expect(results).toEqual([expect.objectContaining({ name: 'Álex Gilbert', localAuthorId: 1920, providerIds: {} })]);
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
          work({
            id: 'undated',
            releaseYear: null,
            ebookReleaseDate: null,
            ebookDatePrecision: null,
            audioReleaseDate: null,
            audioDatePrecision: null,
          }),
          work({ id: 'dated', ebookReleaseDate: '2026-10-01', audioReleaseDate: null, audioDatePrecision: null }),
        ],
      }),
    };
    const instance = service(store, {}, { authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null) } });

    const detail = await instance.getAuthor('monitor-1', viewer, { sort: 'releaseDate', order, includeHidden: false });

    expect(detail.works.map((item) => item.id)).toEqual(['dated', 'undated']);
  });

  it('sorts by a date the owner set ahead of a stale store date on the other format', async () => {
    const ownerDated = work({
      id: 'owner-dated',
      ebookReleaseDate: '2029-01-01',
      audioReleaseDate: '2024-08-28',
      formatReleases: {
        ebook: {
          status: 'dated',
          releaseDate: '2029-01-01',
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
    const store = {
      getAuthor: vi.fn().mockResolvedValue(author()),
      getCatalog: vi.fn().mockResolvedValue({
        fetchedAt: '2026-09-01T00:00:00.000Z',
        works: [ownerDated, work({ id: 'next', ebookReleaseDate: '2027-01-01', audioReleaseDate: null, audioDatePrecision: null })],
      }),
    };
    const instance = service(store, {}, { authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null) } });

    const detail = await instance.getAuthor('monitor-1', viewer, { sort: 'releaseDate', order: 'asc', includeHidden: false });

    expect(detail.works.map((item) => item.id)).toEqual(['next', 'owner-dated']);
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

  it('lists owned flagged works for a non-owner viewer', async () => {
    const ownedFlagged = work({ ownedFormats: ['ebook'], verdict: 'suspect', flags: ['wrong_contributor'] });
    const store = {
      getAuthor: vi.fn().mockResolvedValue(author({ ownerUserId: 2 })),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [ownedFlagged] }),
    };
    const instance = service(store, {}, { authorsRepository: { findIdByNormalizedName: vi.fn().mockResolvedValue(null) } });

    const detail = await instance.getAuthor('monitor-1', viewer, { sort: 'title', order: 'asc', includeHidden: false });

    expect(detail.works).toEqual([ownedFlagged]);
    expect(store.getCatalog).toHaveBeenCalledWith('monitor-1', viewer);
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

  it('hands a work back to automatic visibility through the owner-checked write', async () => {
    const existing = work({ userVisibility: 'visible' });
    const updateWorkUserState = vi.fn().mockResolvedValue(work());
    const store = {
      getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: existing }),
      getAuthor: vi.fn().mockResolvedValue(author()),
      updateWorkUserState,
    };

    await service(store).updateWork(viewer, existing.id, { automaticVisibility: true });

    expect(updateWorkUserState).toHaveBeenCalledWith(existing.id, { automaticVisibility: true }, viewer);
  });

  it('refuses a patch that both hides a work and hands it back to automatic', async () => {
    const updateWorkUserState = vi.fn();
    const store = { getWorkWithMonitor: vi.fn(), updateWorkUserState };

    await expect(service(store).updateWork(viewer, work().id, { hidden: true, automaticVisibility: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(updateWorkUserState).not.toHaveBeenCalled();
    expect(store.getWorkWithMonitor).not.toHaveBeenCalled();
  });

  it('refuses a patch that both marks a work and hands it back to automatic', async () => {
    const updateWorkUserState = vi.fn();
    const store = { getWorkWithMonitor: vi.fn(), updateWorkUserState };

    await expect(service(store).updateWork(viewer, work().id, { kind: 'collection', automaticVisibility: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(updateWorkUserState).not.toHaveBeenCalled();
    expect(store.getWorkWithMonitor).not.toHaveBeenCalled();
  });

  it('narrows the author detail to works in the selected states on the server', async () => {
    const monitoredAuthor = author({ localAuthorId: 7 });
    const owned = work({ id: 'owned', ownedFormats: ['ebook', 'audiobook'], matchedBookId: 1, matchedBookIds: { ebook: 1, audiobook: 2 } });
    const missing = work({ id: 'missing', ebookReleaseDate: '2020-01-01', audioReleaseDate: '2020-01-01' });
    const switchedOff = work({
      id: 'switched-off',
      ebookReleaseDate: '2020-01-01',
      audioReleaseDate: '2020-01-01',
      monitorFormats: { ebook: false, audiobook: false },
    });
    const hidden = work({ id: 'hidden', userVisibility: 'hidden', ebookReleaseDate: '2020-01-01' });
    const store = {
      getAuthor: vi.fn().mockResolvedValue(monitoredAuthor),
      getCatalog: vi.fn().mockResolvedValue({ fetchedAt: '2026-09-01T00:00:00.000Z', works: [owned, missing, switchedOff, hidden] }),
    };
    const instance = service(store, {}, { authorsRepository: { findByIdForEnrichment: vi.fn().mockResolvedValue(null) } });

    const defaults = await instance.getAuthor(monitoredAuthor.id, viewer, {
      sort: 'title',
      order: 'asc',
      includeHidden: true,
      status: ['missing', 'in_progress', 'needs_attention', 'upcoming'],
    });
    const everything = await instance.getAuthor(monitoredAuthor.id, viewer, {
      sort: 'title',
      order: 'asc',
      includeHidden: true,
      status: ['in_library', 'not_watched', 'hidden'],
    });

    expect(defaults.works.map((entry) => entry.id)).toEqual(['missing']);
    expect(everything.works.map((entry) => entry.id).sort()).toEqual(['hidden', 'owned', 'switched-off']);
    // The counts describe the author, not the filtered page.
    expect(defaults.author.counts.total).toBe(3);
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
    const instance = createHarness(vi.fn()).instance;

    await expect(instance.createAuthor({ authorName: 'First', formats: {} }, viewer)).resolves.toMatchObject({ fetch: { state: 'queued' } });
    const second = await instance.createAuthor({ authorName: 'Second', formats: {} }, viewer).catch((error: unknown) => error);

    expect(second).toBeInstanceOf(HttpException);
    expect((second as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('rate limits each user independently', async () => {
    const instance = createHarness(vi.fn()).instance;

    await expect(instance.createAuthor({ authorName: 'First', formats: {} }, viewer)).resolves.toMatchObject({ fetch: { state: 'queued' } });
    await expect(instance.createAuthor({ authorName: 'Second', formats: {} }, { id: 2, isSuperuser: false } as RequestUser)).resolves.toMatchObject({
      fetch: { state: 'queued' },
    });
  });

  it('does not burn the create cooldown on a create that never reached a provider', async () => {
    const duplicate = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const fetchCatalog = vi.fn().mockResolvedValue({ catalog: { fetchedAt: '2026-09-01T00:00:00.000Z', works: [] }, hardcoverAuthorId: null });
    const { instance, store } = createHarness(fetchCatalog);
    store.upsertAuthor.mockRejectedValueOnce(duplicate);

    await expect(instance.createAuthor({ authorName: 'First', formats: {} }, viewer)).rejects.toBeInstanceOf(BadRequestException);
    await expect(instance.createAuthor({ authorName: 'Second', formats: {} }, viewer)).resolves.toMatchObject({ fetch: { state: 'queued' } });
    expect(fetchCatalog).not.toHaveBeenCalled();
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
    const superuser = { id: 9, isSuperuser: true, active: true } as RequestUser;
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
    const superuser = { id: 9, isSuperuser: true, active: true } as RequestUser;
    const updateAuthorFields = vi.fn();
    const store = { getAuthor: vi.fn().mockResolvedValue(author({ ownerUserId: 1 })), updateAuthorFields };

    await expect(service(store).updateAuthor('monitor-1', { paused: true }, superuser)).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.getAuthor).toHaveBeenCalledWith('monitor-1');
    expect(updateAuthorFields).not.toHaveBeenCalled();
  });

  it('refuses a superuser write to another user monitored book', async () => {
    const superuser = { id: 9, isSuperuser: true, active: true } as RequestUser;
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

    const ids = search.mock.calls.map((call) => (call[0] as { id: number }).id);
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

describe('MonitoredService work by library book', () => {
  it('returns the matched work with its monitor id and the author modes', async () => {
    const matched = work({ matchedBookIds: { ebook: 11 } });
    const monitor = author({
      formats: {
        ebook: { mode: 'auto-all', libraryId: null, folderId: null },
        audiobook: { mode: 'notify', libraryId: null, folderId: null },
      },
    });
    const store = {
      findWorkIdByMatchedBook: vi.fn().mockResolvedValue(matched.id),
      getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor, work: matched }),
    };

    await expect(service(store).getWorkByBook(viewer, 11)).resolves.toEqual({
      work: matched,
      monitorAuthorId: 'monitor-1',
      authorModes: { ebook: 'auto-all', audiobook: 'notify' },
    });
    expect(store.findWorkIdByMatchedBook).toHaveBeenCalledWith(11, viewer);
    expect(store.getWorkWithMonitor).toHaveBeenCalledWith(matched.id, viewer);
  });

  it('answers 404 when no work matches the book', async () => {
    const store = { findWorkIdByMatchedBook: vi.fn().mockResolvedValue(null), getWorkWithMonitor: vi.fn() };

    await expect(service(store).getWorkByBook(viewer, 11)).rejects.toBeInstanceOf(NotFoundException);
    expect(store.getWorkWithMonitor).not.toHaveBeenCalled();
  });

  it('answers 404 when the viewer cannot read the matched work, so another user monitor data never leaks', async () => {
    const store = {
      findWorkIdByMatchedBook: vi.fn().mockResolvedValue('monitor-9:hardcover:1'),
      getWorkWithMonitor: vi.fn().mockResolvedValue(null),
    };

    await expect(service(store).getWorkByBook(viewer, 11)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MonitoredService.setWorkMatch', () => {
  const target = () => work({ providerWorkIds: { hardcover: '77' } });

  function matchStore(patch: Record<string, unknown> = {}) {
    return {
      getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author(), work: target() }),
      isBookReadable: vi.fn().mockResolvedValue(true),
      writeMatchOverride: vi.fn().mockResolvedValue(undefined),
      updateWorkMatch: vi.fn().mockResolvedValue(undefined),
      ...patch,
    };
  }

  it('refuses an answer on a monitor owned by another user', async () => {
    const store = matchStore({ getWorkWithMonitor: vi.fn().mockResolvedValue({ monitor: author({ ownerUserId: 2 }), work: target() }) });

    await expect(service(store).setWorkMatch(viewer, target().id, 'ebook', { decision: 'link', bookId: 31 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(store.writeMatchOverride).not.toHaveBeenCalled();
  });

  it('refuses a link or a rejection without a book, and a hand-back that names one', async () => {
    const store = matchStore();
    const instance = service(store);

    await expect(instance.setWorkMatch(viewer, target().id, 'ebook', { decision: 'link' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(instance.setWorkMatch(viewer, target().id, 'ebook', { decision: 'automatic', bookId: 31 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.writeMatchOverride).not.toHaveBeenCalled();
  });

  it('answers 404 for a book the owner cannot open', async () => {
    const store = matchStore({ isBookReadable: vi.fn().mockResolvedValue(false) });

    await expect(service(store).setWorkMatch(viewer, target().id, 'ebook', { decision: 'link', bookId: 31 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(store.writeMatchOverride).not.toHaveBeenCalled();
  });

  it('files the answer under the work identity, rematches the work and returns it fresh', async () => {
    const store = matchStore();
    const rematched = { ...target(), matchedBookId: 31, matchedBookIds: { ebook: 31 }, ownedFormats: ['ebook'], linkedFormats: ['ebook'] };
    const rematchWork = vi.fn().mockResolvedValue(rematched);

    await service(store, {}, { catalog: { rematchWork } }).setWorkMatch(viewer, target().id, 'ebook', { decision: 'link', bookId: 31 });

    expect(store.writeMatchOverride).toHaveBeenCalledWith(
      { id: target().id, monitorAuthorId: 'monitor-1', identityKeys: ['hardcover:77'] },
      'ebook',
      { decision: 'link', bookId: 31 },
    );
    expect(rematchWork).toHaveBeenCalledWith(author(), target());
    expect(store.updateWorkMatch).toHaveBeenCalledWith(target().id, rematched, { withPossibleMatches: true });
    expect(store.getWorkWithMonitor).toHaveBeenLastCalledWith(target().id, viewer);
  });

  it('hands a format back to the matcher without checking any book', async () => {
    const store = matchStore();

    await service(store, {}, { catalog: { rematchWork: vi.fn().mockResolvedValue(target()) } }).setWorkMatch(viewer, target().id, 'audiobook', {
      decision: 'automatic',
    });

    expect(store.isBookReadable).not.toHaveBeenCalled();
    expect(store.writeMatchOverride).toHaveBeenCalledWith(expect.objectContaining({ id: target().id }), 'audiobook', { decision: 'automatic' });
  });
});

describe('MonitoredService.countWorkClasses', () => {
  const counts = { hidden: 1, placeholder: 2, unconfirmed: 3, kinds: {} };

  it('returns the store counts for the viewer without logging a fast read', async () => {
    const countWorkClasses = vi.fn().mockResolvedValue(counts);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service({ countWorkClasses }).countWorkClasses(viewer)).resolves.toBe(counts);

    expect(countWorkClasses).toHaveBeenCalledWith(viewer);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once past 500 ms in the class_counts log style', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_501);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service({ countWorkClasses: vi.fn().mockResolvedValue(counts) }).countWorkClasses(viewer);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[monitored.class_counts] [end] userId=1 durationMs=501 - slow class counts read');
  });
});

describe('fetch follow-ups', () => {
  function followUpHarness() {
    const monitor = author({ localAuthorId: 7 });
    const store = {
      getMonitorForFetch: vi.fn().mockResolvedValue(monitor),
      getCatalog: vi.fn().mockResolvedValue({ works: [] }),
      updateAuthorFields: vi.fn().mockResolvedValue(monitor),
    };
    const fanOut = vi.fn().mockResolvedValue({ created: 0 });
    const checkMonitor = vi.fn().mockResolvedValue(undefined);
    const instance = service(
      store,
      {},
      {
        autoRequests: { fanOut },
        releaseWatcher: { checkMonitor },
        authorsRepository: { findByIdForEnrichment: vi.fn().mockResolvedValue({ hasPhoto: true, description: 'bio' }) },
      },
    );
    return { instance, store, fanOut, checkMonitor, monitor };
  }
  it('continues release checking after fan-out throws', async () => {
    const h = followUpHarness();
    h.fanOut.mockRejectedValue(new Error('fan-out'));
    await h.instance.runFetchFollowUps('monitor-1', 'refresh');
    expect(h.checkMonitor).toHaveBeenCalled();
  });
  it('skips fan-out when paused at the re-read', async () => {
    const h = followUpHarness();
    h.store.getMonitorForFetch.mockResolvedValueOnce(h.monitor).mockResolvedValue({ ...h.monitor, paused: true });
    await h.instance.runFetchFollowUps('monitor-1', 'sync');
    expect(h.fanOut).not.toHaveBeenCalled();
  });
  it('stops after a re-read finds the monitor deleted', async () => {
    const h = followUpHarness();
    h.store.getMonitorForFetch.mockResolvedValueOnce(h.monitor).mockResolvedValue(null);
    await h.instance.runFetchFollowUps('monitor-1', 'sync');
    expect(h.fanOut).not.toHaveBeenCalled();
    expect(h.checkMonitor).not.toHaveBeenCalled();
  });
});

describe('background fetch entry points', () => {
  function entryHarness(monitor = author()) {
    const coordinator = { request: vi.fn().mockResolvedValue(true), enqueueInserted: vi.fn(), clearRetry: vi.fn(), cancel: vi.fn() };
    const fetchCatalog = vi.fn(() => new Promise(() => {}));
    const store = {
      hasAuthorNamed: vi.fn().mockResolvedValue(false),
      upsertAuthor: vi.fn((input) =>
        Promise.resolve({ ...input, fetch: { state: input.fetchState, errorKind: null, errorAt: null, retryAt: null } }),
      ),
      getAuthor: vi.fn().mockResolvedValue(monitor),
      getCatalog: vi.fn().mockResolvedValue(null),
      getAuthorAggregates: vi.fn().mockResolvedValue(new Map()),
      updateAuthorFields: vi.fn().mockResolvedValue(monitor),
      removeAuthor: vi.fn(),
    };
    const instance = service(store, {}, { coordinator, catalog: { fetchCatalog } });
    vi.spyOn(instance as never, 'loadAuthorProfile' as never).mockResolvedValue(null as never);
    return { instance, store, coordinator, fetchCatalog };
  }
  it('returns queued from create without awaiting a pending catalog fetch', async () => {
    const h = entryHarness();
    expect(await h.instance.createAuthor({ authorName: 'New', formats: {} }, viewer)).toMatchObject({ fetch: { state: 'queued' } });
    expect(h.fetchCatalog).not.toHaveBeenCalled();
    expect(h.coordinator.enqueueInserted).toHaveBeenCalled();
  });
  it('rejects a duplicate before insertion', async () => {
    const h = entryHarness();
    h.store.hasAuthorNamed.mockResolvedValue(true);
    await expect(h.instance.createAuthor({ authorName: 'New', formats: {} }, viewer)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.store.upsertAuthor).not.toHaveBeenCalled();
  });
  it('bypasses cooldown for failed fetches', async () => {
    const h = entryHarness(
      author({ lastRefreshedAt: new Date().toISOString(), fetch: { state: 'failed', errorKind: 'timeout', errorAt: null, retryAt: null } }),
    );
    await h.instance.refreshAuthor('monitor-1', viewer);
    expect(h.coordinator.request).toHaveBeenCalledWith('monitor-1', 'refresh');
  });
  it('keeps cooldown for idle fetches', async () => {
    const h = entryHarness(author({ lastRefreshedAt: new Date().toISOString() }));
    await expect(h.instance.refreshAuthor('monitor-1', viewer)).rejects.toMatchObject({ status: 429 });
    expect(h.coordinator.request).not.toHaveBeenCalled();
  });
  it('returns queued items without requesting again', async () => {
    const h = entryHarness(author({ fetch: { state: 'queued', errorKind: null, errorAt: null, retryAt: null } }));
    expect(await h.instance.refreshAuthor('monitor-1', viewer)).toMatchObject({ fetch: { state: 'queued' } });
    expect(h.coordinator.request).not.toHaveBeenCalled();
  });
  it('clears retries on pause', async () => {
    const h = entryHarness();
    await h.instance.updateAuthor('monitor-1', { paused: true }, viewer);
    expect(h.coordinator.clearRetry).toHaveBeenCalledWith('monitor-1');
  });
  it('cancels before deleting', async () => {
    const h = entryHarness();
    await h.instance.deleteAuthor('monitor-1', viewer);
    expect(h.coordinator.cancel.mock.invocationCallOrder[0]).toBeLessThan(h.store.removeAuthor.mock.invocationCallOrder[0]);
  });
});

describe('background fetch follow-up ordering and enrichment', () => {
  function harness(profile = { hasPhoto: true, description: 'bio' as string | null }) {
    const monitor = author({ localAuthorId: 7 });
    const probe = vi.fn().mockResolvedValue(undefined);
    const enrich = vi.fn().mockResolvedValue({ kind: 'updated' });
    const findByIdForEnrichment = vi.fn().mockResolvedValue(profile);
    const store = {
      getMonitorForFetch: vi.fn().mockResolvedValue(monitor),
      updateAuthorFields: vi.fn().mockResolvedValue(monitor),
      getCatalog: vi.fn().mockResolvedValue({ works: [work()] }),
    };
    const fanOut = vi.fn().mockResolvedValue({ created: 0 });
    const checkMonitor = vi.fn().mockResolvedValue(undefined);
    const instance = service(
      store,
      {},
      {
        releaseProbe: { enrolAndProbe: probe },
        autoRequests: { fanOut },
        releaseWatcher: { checkMonitor },
        authorsRepository: { findByIdForEnrichment },
        authorMetadataPreferences: { getPreferences: vi.fn().mockResolvedValue({}) },
        enrichmentExecutor: { execute: enrich },
      },
    );
    return { instance, store, probe, enrich, fanOut, checkMonitor, findByIdForEnrichment, monitor };
  }
  it.each([
    [false, 'bio', true],
    [true, null, true],
    [true, 'bio', false],
  ] as const)('enriches incomplete profiles with photo=%s and description=%s', async (hasPhoto, description, expected) => {
    const h = harness({ hasPhoto, description });
    await h.instance.runFetchFollowUps('monitor-1', 'refresh');
    expect(h.enrich).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected) expect(h.enrich).toHaveBeenCalledWith({ authorId: 7, preferences: {}, allowOrphan: true });
  });
  it.each(['probe', 'local_author', 'fanout', 'release_check'])('isolates a failure in %s', async (step) => {
    const h = harness();
    const error = new Error('follow-up failed');
    if (step === 'probe') h.probe.mockRejectedValue(error);
    if (step === 'local_author') h.store.updateAuthorFields.mockRejectedValue(error);
    if (step === 'fanout') h.fanOut.mockRejectedValue(error);
    if (step === 'release_check') h.checkMonitor.mockRejectedValue(error);
    await expect(h.instance.runFetchFollowUps('monitor-1', 'sync')).resolves.toBeUndefined();
    expect(h.fanOut).toHaveBeenCalled();
    expect(h.checkMonitor).toHaveBeenCalled();
  });
  it('stops when deleted during the release probe', async () => {
    const h = harness();
    const resolve = vi.spyOn(h.instance as never, 'resolveLocalAuthorId' as never);
    h.store.getMonitorForFetch.mockResolvedValueOnce(h.monitor).mockResolvedValue(null);
    await h.instance.runFetchFollowUps('monitor-1', 'refresh');
    expect(resolve).not.toHaveBeenCalled();
    expect(h.findByIdForEnrichment).not.toHaveBeenCalled();
    expect(h.fanOut).not.toHaveBeenCalled();
    expect(h.checkMonitor).not.toHaveBeenCalled();
  });
  it('uses current formats after probing and links before fan-out', async () => {
    const h = harness();
    const current = author({ localAuthorId: 7, formats: { ...h.monitor.formats, ebook: { mode: 'off', libraryId: null, folderId: null } } });
    h.store.getMonitorForFetch.mockResolvedValueOnce(h.monitor).mockResolvedValue(current);
    await h.instance.runFetchFollowUps('monitor-1', 'sync');
    expect(h.fanOut).toHaveBeenCalledWith(current, [work()], viewer);
    expect(h.probe.mock.invocationCallOrder[0]).toBeLessThan(h.store.updateAuthorFields.mock.invocationCallOrder[0]);
    expect(h.store.updateAuthorFields.mock.invocationCallOrder[0]).toBeLessThan(h.fanOut.mock.invocationCallOrder[0]);
    expect(h.fanOut.mock.invocationCallOrder[0]).toBeLessThan(h.checkMonitor.mock.invocationCallOrder[0]);
  });
  it('does not enrich a newly created local author twice', async () => {
    const h = harness({ hasPhoto: false, description: null });
    vi.spyOn(h.instance as never, 'resolveLocalAuthorId' as never).mockResolvedValue({ id: 7, created: true } as never);
    await h.instance.runFetchFollowUps('monitor-1', 'create');
    expect(h.findByIdForEnrichment).not.toHaveBeenCalled();
    expect(h.enrich).not.toHaveBeenCalled();
  });
});

describe('fetch event item', () => {
  it('uses owner-scoped aggregates without exposing internal attempts or reading the catalog', async () => {
    const store = {
      getAuthor: vi.fn().mockResolvedValue(author()),
      getMonitorForFetch: vi.fn().mockResolvedValue({ ...author(), fetchAttempts: 2 }),
      getAuthorAggregates: vi.fn().mockResolvedValue(new Map()),
      getCatalog: vi.fn(),
    };
    const instance = service(store);
    vi.spyOn(instance as never, 'loadAuthorProfile' as never).mockResolvedValue(null as never);
    const item = await instance.toFetchEventItem('monitor-1');
    expect(item).toMatchObject({ id: 'monitor-1', isOwner: true });
    expect(item).not.toHaveProperty('fetchAttempts');
    expect(store.getAuthorAggregates).toHaveBeenCalledWith(['monitor-1'], viewer, expect.any(String));
    expect(store.getCatalog).not.toHaveBeenCalled();
  });
});
