import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { Permission } from '@bookorbit/types';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { WebSerialsController } from './web-serials.controller';

vi.mock('./web-serials-catalog.service', () => ({ WebSerialsCatalogService: class {} }));
vi.mock('./web-serials-jobs.service', () => ({ WebSerialJobsService: class {} }));
vi.mock('./web-serials-job-move.service', () => ({ WebSerialJobMoveService: class {} }));
vi.mock('./web-serials-novel-providers.service', () => ({ WebSerialsNovelProvidersService: class {} }));
vi.mock('./web-serials-published-requests.service', () => ({ WebSerialsPublishedRequestsService: class {} }));
vi.mock('./web-serials-cover.service', () => ({ WebSerialsCoverService: class {} }));
vi.mock('./web-serials-discover.service', () => ({ WebSerialsDiscoverService: class {} }));
vi.mock('./web-serials-novel-index.service', () => ({ WebSerialsNovelIndexService: class {} }));

const USER = { id: 7 } as RequestUser;

function setup() {
  const service = {
    getCapabilities: vi.fn().mockResolvedValue({}),
    search: vi.fn().mockResolvedValue({ hits: [] }),
    resolve: vi.fn().mockResolvedValue({}),
    getSeriesDetail: vi.fn().mockResolvedValue({}),
    getSeriesLookup: vi.fn().mockResolvedValue({ state: 'no_match', match: null, message: null }),
    getSeriesSources: vi.fn().mockResolvedValue({ options: [], failedSources: [] }),
    createJob: vi.fn().mockResolvedValue({ id: 1 }),
    listJobs: vi.fn().mockResolvedValue({ items: [] }),
    cancelJob: vi.fn().mockResolvedValue({}),
    retryJob: vi.fn().mockResolvedValue({}),
    getMoveCandidates: vi.fn().mockResolvedValue({ remainingTotal: 1, candidates: [], failedSources: [] }),
    moveJob: vi.fn().mockResolvedValue({ from: {}, to: {} }),
    getJobDetail: vi.fn().mockResolvedValue({}),
    pauseJob: vi.fn().mockResolvedValue({}),
    resumeJob: vi.fn().mockResolvedValue({}),
    moveJobToTop: vi.fn().mockResolvedValue({}),
    removeJob: vi.fn().mockResolvedValue(undefined),
    clearFinished: vi.fn().mockResolvedValue({ removed: 0 }),
    retryItem: vi.fn().mockResolvedValue({}),
    pauseQueue: vi.fn().mockResolvedValue({ queuePaused: true }),
    resumeQueue: vi.fn().mockResolvedValue({ queuePaused: false }),
    discover: vi.fn().mockResolvedValue({ results: [], fallback: 'empty' }),
    getEntry: vi.fn().mockResolvedValue({ matchId: '1995', kind: 'manga', inLibrary: false }),
    getSources: vi.fn().mockResolvedValue({ options: [], failedSources: [] }),
    getCover: vi.fn().mockResolvedValue({ body: Buffer.from('img'), contentType: 'image/png' }),
    getProviders: vi.fn().mockResolvedValue({}),
    updateProviders: vi.fn().mockResolvedValue({}),
    suggest: vi.fn().mockResolvedValue({ query: 'om', suggestions: [] }),
    record: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([{ volume: '2', bookRequestId: 9 }]),
  };
  const covers = { getCover: vi.fn().mockResolvedValue({ body: Buffer.from('img'), contentType: 'image/png' }) };
  return {
    controller: new WebSerialsController(
      service as never,
      service as never,
      service as never,
      covers as never,
      service as never,
      service as never,
      service as never,
      service as never,
    ),
    service,
    covers,
  };
}

describe('WebSerialsController', () => {
  it('gates every route with WebSerialAccess', () => {
    const proto = WebSerialsController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(WebSerialsController.prototype).filter((name) => name !== 'constructor');
    expect(routes).toHaveLength(31);
    const adminRoutes = ['pauseQueue', 'resumeQueue'];
    for (const route of routes) {
      const expected = adminRoutes.includes(route) ? [Permission.WebSerialAccess, Permission.ManageAppSettings] : Permission.WebSerialAccess;
      expect(Reflect.getMetadata(PERMISSION_KEY, proto[route] as object), route).toEqual(expected);
    }
  });

  it('maps the documented paths and methods', () => {
    const proto = WebSerialsController.prototype as unknown as Record<string, object>;
    const route = (name: string) => [Reflect.getMetadata(METHOD_METADATA, proto[name]!), Reflect.getMetadata(PATH_METADATA, proto[name]!)];
    expect(Reflect.getMetadata(PATH_METADATA, WebSerialsController)).toBe('web-serials');
    expect(route('getCapabilities')).toEqual([RequestMethod.GET, 'capabilities']);
    expect(route('search')).toEqual([RequestMethod.GET, 'search']);
    expect(route('suggest')).toEqual([RequestMethod.GET, 'suggest']);
    expect(route('discover')).toEqual([RequestMethod.GET, 'discover']);
    expect(route('getDiscoverEntry')).toEqual([RequestMethod.GET, 'discover/:kind/:matchId']);
    expect(route('getDiscoverSources')).toEqual([RequestMethod.GET, 'discover/:kind/:matchId/sources']);
    expect(route('getDiscoverCover')).toEqual([RequestMethod.GET, 'discover/:kind/:matchId/cover']);
    expect(route('getNovelProviders')).toEqual([RequestMethod.GET, 'novel-providers']);
    expect(route('updateNovelProviders')).toEqual([RequestMethod.PUT, 'novel-providers']);
    expect(route('recordPublishedRequest')).toEqual([RequestMethod.POST, 'published-requests']);
    expect(route('listPublishedRequests')).toEqual([RequestMethod.GET, 'published-requests']);
    expect(route('resolve')).toEqual([RequestMethod.POST, 'resolve']);
    expect(route('getSeries')).toEqual([RequestMethod.GET, 'series/:seriesKey']);
    expect(route('getSeriesLookup')).toEqual([RequestMethod.GET, 'series/:seriesKey/lookup']);
    expect(route('getSeriesSources')).toEqual([RequestMethod.GET, 'series/:seriesKey/sources']);
    expect(route('getCover')).toEqual([RequestMethod.GET, 'series/:seriesKey/cover']);
    expect(route('createJob')).toEqual([RequestMethod.POST, 'jobs']);
    expect(route('listJobs')).toEqual([RequestMethod.GET, 'jobs']);
    expect(route('cancelJob')).toEqual([RequestMethod.POST, 'jobs/:id/cancel']);
    expect(route('retryJob')).toEqual([RequestMethod.POST, 'jobs/:id/retry']);
    expect(route('getMoveCandidates')).toEqual([RequestMethod.GET, 'jobs/:id/move-candidates']);
    expect(route('moveJob')).toEqual([RequestMethod.POST, 'jobs/:id/move']);
    expect(route('getJob')).toEqual([RequestMethod.GET, 'jobs/:id']);
    expect(route('pauseJob')).toEqual([RequestMethod.POST, 'jobs/:id/pause']);
    expect(route('resumeJob')).toEqual([RequestMethod.POST, 'jobs/:id/resume']);
    expect(route('moveJobToTop')).toEqual([RequestMethod.POST, 'jobs/:id/move-to-top']);
    expect(route('removeJob')).toEqual([RequestMethod.DELETE, 'jobs/:id']);
    expect(route('clearFinished')).toEqual([RequestMethod.POST, 'jobs/clear-finished']);
    expect(route('retryItem')).toEqual([RequestMethod.POST, 'jobs/:id/items/:itemId/retry']);
    expect(route('pauseQueue')).toEqual([RequestMethod.POST, 'queue/pause']);
    expect(route('resumeQueue')).toEqual([RequestMethod.POST, 'queue/resume']);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto['cancelJob']!)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto['removeJob']!)).toBe(204);
  });

  it('passes the current user to user-owned operations', async () => {
    const { controller, service } = setup();

    await controller.createJob(
      { seriesKey: 'm:1', packaging: 'chapter', selection: { mode: 'range', fromSequence: '1', toSequence: '3' }, libraryId: 2 },
      USER,
    );
    await controller.listJobs({ scope: 'all', limit: 10, offset: 5 }, USER);
    await controller.cancelJob(4, USER);
    await controller.retryJob(4, USER);
    await controller.getSeries({ seriesKey: 'm:1' }, {}, USER);
    await controller.getSeriesLookup({ seriesKey: 'm:1' }, {});
    await controller.discover({ q: 'frieren', kind: 'manga' }, USER);
    await controller.search({ q: 'dune', refresh: true }, USER);
    await controller.getDiscoverSources({ kind: 'manga', matchId: '1995' }, {}, USER);
    await controller.getSeriesSources({ seriesKey: 'm:1' }, {});
    await controller.getMoveCandidates(4, USER);
    await controller.moveJob(4, { seriesKey: 'm:2' }, USER);

    expect(service.createJob).toHaveBeenCalledWith(
      { seriesKey: 'm:1', packaging: 'chapter', selection: { mode: 'range', fromSequence: '1', toSequence: '3' }, libraryId: 2 },
      USER,
    );
    expect(service.listJobs).toHaveBeenCalledWith(USER, 'all', 10, 5);
    expect(service.cancelJob).toHaveBeenCalledWith(4, USER);
    expect(service.retryJob).toHaveBeenCalledWith(4, USER);
    expect(service.getSeriesDetail).toHaveBeenCalledWith('m:1', USER, undefined);
    expect(service.getSeriesLookup).toHaveBeenCalledWith('m:1', undefined);
    expect(service.discover).toHaveBeenCalledWith('frieren', 'manga', USER, false);
    expect(service.search).toHaveBeenCalledWith('dune', 'all', USER, true, 'full');
    expect(service.getSources).toHaveBeenCalledWith('manga', '1995', USER, false);
    expect(service.getSeriesSources).toHaveBeenCalledWith('m:1', false);
    expect(service.getMoveCandidates).toHaveBeenCalledWith(4, USER);
    expect(service.moveJob).toHaveBeenCalledWith(4, { seriesKey: 'm:2' }, USER);
  });

  it('passes the user and ids through the queue management routes', async () => {
    const { controller, service } = setup();

    await controller.getJob(4, USER);
    await controller.pauseJob(4, USER);
    await controller.resumeJob(4, USER);
    await controller.moveJobToTop(4, USER);
    await controller.removeJob(4, USER);
    await controller.clearFinished({ scope: 'mine' }, USER);
    await controller.retryItem(4, 9, USER);
    await controller.pauseQueue(USER);
    await controller.resumeQueue(USER);

    expect(service.getJobDetail).toHaveBeenCalledWith(4, USER);
    expect(service.pauseJob).toHaveBeenCalledWith(4, USER);
    expect(service.resumeJob).toHaveBeenCalledWith(4, USER);
    expect(service.moveJobToTop).toHaveBeenCalledWith(4, USER);
    expect(service.removeJob).toHaveBeenCalledWith(4, USER);
    expect(service.clearFinished).toHaveBeenCalledWith(USER, 'mine');
    expect(service.retryItem).toHaveBeenCalledWith(4, 9, USER);
    expect(service.pauseQueue).toHaveBeenCalledWith(USER);
    expect(service.resumeQueue).toHaveBeenCalledWith(USER);
  });

  it('defaults search to all kinds', async () => {
    const { controller, service } = setup();

    await controller.search({ q: 'dune' }, USER);

    expect(service.search).toHaveBeenCalledWith('dune', 'all', USER, false, 'full');
  });

  it('passes the index phase through and scopes suggestions to the caller', async () => {
    const { controller, service } = setup();

    await controller.search({ q: 'omni', kind: 'novel', phase: 'index' }, USER);
    await controller.suggest({ q: 'om', kind: 'novel' }, USER);

    expect(service.search).toHaveBeenCalledWith('omni', 'novel', USER, false, 'index');
    expect(service.suggest).toHaveBeenCalledWith('om', USER);
  });

  it('passes the current user to the novel provider preferences', async () => {
    const { controller, service } = setup();

    await controller.getNovelProviders(USER);
    await controller.updateNovelProviders({ disabledDomains: ['a.com'] }, USER);

    expect(service.getProviders).toHaveBeenCalledWith(USER);
    expect(service.updateProviders).toHaveBeenCalledWith(USER, { disabledDomains: ['a.com'] });
  });

  it('records and lists published volume requests for the calling user only', async () => {
    const { controller, service } = setup();
    const body = { kind: 'novel' as const, matchId: '12', volume: '2', bookRequestId: 9 };

    await controller.recordPublishedRequest(body, USER);
    await expect(controller.listPublishedRequests({ kind: 'novel', matchId: '12' }, USER)).resolves.toEqual([{ volume: '2', bookRequestId: 9 }]);

    expect(service.record).toHaveBeenCalledWith(USER, body);
    expect(service.list).toHaveBeenCalledWith(USER, 'novel', '12');
  });

  it('serves a cover with hardening headers', async () => {
    const { controller } = setup();
    const reply = { header: vi.fn(), type: vi.fn().mockReturnThis(), send: vi.fn() };

    await controller.getCover({ seriesKey: 'm:1' }, reply as never);

    expect(reply.header).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(reply.type).toHaveBeenCalledWith('image/png');
    expect(reply.send).toHaveBeenCalledWith(Buffer.from('img'));
  });

  it('defaults discover to all kinds', async () => {
    const { controller, service } = setup();

    await controller.discover({ q: 'dune' }, USER);

    expect(service.discover).toHaveBeenCalledWith('dune', 'all', USER, false);
  });

  it('serves one catalog entry scoped to the calling user', async () => {
    const { controller, service } = setup();

    await controller.getDiscoverEntry({ kind: 'manga', matchId: '1995' }, USER);

    expect(service.getEntry).toHaveBeenCalledWith('manga', '1995', USER);
  });

  it('serves a discover cover with hardening headers', async () => {
    const { controller, service } = setup();
    const reply = { header: vi.fn(), type: vi.fn().mockReturnThis(), send: vi.fn() };

    await controller.getDiscoverCover({ kind: 'manga', matchId: '1995' }, reply as never);

    expect(service.getCover).toHaveBeenCalledWith('manga', '1995');
    expect(reply.header).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(reply.type).toHaveBeenCalledWith('image/png');
  });
});
