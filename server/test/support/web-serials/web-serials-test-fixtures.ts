/* eslint-disable @typescript-eslint/require-await */
import { vi } from 'vitest';

import { Permission } from '@bookorbit/types';
import type { RequestUser } from '../../../src/common/types/request-user';
import type { EngineSeries } from '../../../src/modules/web-serials/engines/web-serial-engine';
import { WebSerialsCatalogService } from '../../../src/modules/web-serials/web-serials-catalog.service';
import { WebSerialJobMoveService } from '../../../src/modules/web-serials/web-serials-job-move.service';
import { WebSerialJobsService } from '../../../src/modules/web-serials/web-serials-jobs.service';

export const USER = { id: 7, isSuperuser: false, permissions: [] } as unknown as RequestUser;
export const ADMIN = { id: 1, isSuperuser: false, permissions: [Permission.ManageAppSettings] } as unknown as RequestUser;
export const CONN = { url: 'http://engine', username: null, password: null };

export const mangaSeries: EngineSeries = {
  kind: 'manga',
  title: 'Dungeon Saga',
  author: 'A. Writer',
  authors: ['A. Writer'],
  synopsis: 'Story',
  tags: [],
  language: null,
  remoteCoverPath: '/thumb/1',
  sourceName: 'MangaSource',
  sourceUrl: 'https://source/1',
  status: 'ongoing',
  chapterCount: 2,
  units: [1, 2].map((n) => ({
    unitKey: `c${n}`,
    label: `Chapter ${n}`,
    sequence: String(n),
    chapterCount: 1,
    publishedAt: null,
    packaging: 'chapter' as const,
    remote: { chapterId: String(n) },
  })),
  packagingOptions: ['chapter', 'volume', 'series'],
  defaultPackaging: 'chapter',
};

export function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    userId: 7,
    kind: 'manga',
    seriesKey: 'm:1',
    title: 'Dungeon Saga',
    author: 'A. Writer',
    sourceName: 'MangaSource',
    packaging: 'chapter',
    selection: { mode: 'all' },
    skipImported: true,
    targetLibraryId: 3,
    targetFolderId: 30,
    libraryName: 'Manga',
    ownerName: 'Ann',
    queuePosition: null,
    queueOrder: 5000,
    status: 'queued',
    unitsTotal: 0,
    unitsDone: 0,
    unitsFailed: 0,
    unitsSkipped: 0,
    message: null,
    currentUnit: null,
    engineState: { hasCover: true },
    metadata: {},
    createdAt: new Date('2026-10-13T10:00:00Z'),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

export function setupServices(options: { settings?: Record<string, unknown>; library?: { allowedFormats: string[] } } = {}) {
  const client = {
    search: vi.fn().mockResolvedValue({ hits: [], failedSources: [] }),
    resolveUrl: vi.fn().mockResolvedValue(null),
    getSeries: vi.fn().mockResolvedValue(mangaSeries),
  };
  const configs: Record<string, unknown> = {
    manga: { connection: CONN, allowedSources: ['en'], targetLibraryId: 3, targetFolderId: 30 },
    novel: { connection: CONN, allowedSources: ['royalroad.com'], targetLibraryId: null, targetFolderId: null },
  };
  const engines = {
    client: vi.fn().mockReturnValue(client),
    loadSeries: vi.fn(async (_kind: string, remoteId: string) => client.getSeries(CONN, remoteId)),
    getConfig: vi.fn(async (kind: string) => configs[kind] ?? null),
    requireConfig: vi.fn(async (kind: string) => configs[kind]),
  };
  const repo = {
    getDisabledNovelDomains: vi.fn().mockResolvedValue([]),
    setDisabledNovelDomains: vi.fn().mockResolvedValue(undefined),
    findImportedUnitKeys: vi.fn().mockResolvedValue(['c1']),
    countCappedJobsForUser: vi.fn().mockResolvedValue(0),
    findLibraryFolders: vi.fn().mockResolvedValue([
      { id: 20, path: '/a' },
      { id: 30, path: '/b' },
    ]),
    createJob: vi.fn().mockResolvedValue({ id: 11, title: 'Dungeon Saga' }),
    findJobById: vi.fn().mockResolvedValue(jobRow()),
    listJobs: vi.fn().mockResolvedValue([jobRow()]),
    countActiveJobs: vi.fn().mockResolvedValue(0),
    findItemsForDetail: vi.fn().mockResolvedValue([]),
    cancelJob: vi.fn().mockResolvedValue({}),
    requeueForRetry: vi.fn().mockResolvedValue(true),
    pauseJob: vi.fn().mockResolvedValue({ id: 11 }),
    resumeJob: vi.fn().mockResolvedValue({ id: 11 }),
    restoreAfterMove: vi.fn().mockResolvedValue({ id: 11 }),
    moveJobToTop: vi.fn().mockResolvedValue({ id: 11 }),
    deleteFinishedJob: vi.fn().mockResolvedValue(true),
    clearFinishedJobs: vi.fn().mockResolvedValue([21, 22, 23]),
    retryItem: vi.fn().mockResolvedValue(true),
    findJobUnits: vi.fn().mockResolvedValue(mangaSeries.units),
    findImportedGroupKeys: vi.fn().mockResolvedValue([]),
    countJobs: vi.fn().mockResolvedValue({ total: 1, finishedCount: 0 }),
    findMoveItems: vi.fn().mockResolvedValue([]),
    hasInFlightItems: vi.fn().mockResolvedValue(false),
    getJobStatus: vi.fn().mockResolvedValue('paused'),
    countItemsByStatus: vi.fn().mockResolvedValue({}),
    insertItems: vi.fn().mockResolvedValue(0),
    refreshCounters: vi.fn().mockResolvedValue(undefined),
    moveJob: vi.fn().mockResolvedValue({ id: 22 }),
  };
  const settings = {
    catalogVersion: 1,
    getSettings: vi.fn().mockResolvedValue({
      lookup: { enabled: true },
      manga: { url: 'http://m', lastCheck: { ok: true, searchableSources: 4 }, targetLibraryId: 3, targetFolderId: 30 },
      novel: { url: 'http://n', lastCheck: null, searchDomains: ['royalroad.com'], targetLibraryId: 5, targetFolderId: 50 },
      ...options.settings,
    }),
    listNovelSources: vi.fn().mockResolvedValue([]),
    isQueuePaused: vi.fn().mockResolvedValue(false),
    setQueuePaused: vi.fn().mockResolvedValue(undefined),
  };
  const covers = { remember: vi.fn() };
  const libraryService = {
    verifyUserAccess: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn().mockResolvedValue(options.library ?? { allowedFormats: [] }),
  };
  const lookupService = {
    lookup: vi.fn().mockResolvedValue({ state: 'matched', match: { id: '1995' }, message: null, chapterVolumes: null }),
    getMatch: vi.fn().mockResolvedValue(null),
    findMatch: vi.fn().mockResolvedValue({ id: '1995' }),
    peekCachedLookup: vi.fn().mockReturnValue(null),
    searchTitles: vi.fn().mockResolvedValue([]),
  };
  const runner = { waitForJobToSettle: vi.fn().mockResolvedValue(true), abortJob: vi.fn(), interruptChapterFetch: vi.fn() };
  const importer = { removeJobWorkDir: vi.fn().mockResolvedValue(undefined) };
  const catalog = new WebSerialsCatalogService(
    repo as never,
    settings as never,
    engines as never,
    covers as never,
    libraryService as never,
    lookupService as never,
  );
  Object.assign(repo, {
    withUserJobQuota: vi.fn(async (_userId: number, _limit: number, _exceeded: unknown, operation: (value: typeof repo) => Promise<unknown>) =>
      operation(repo),
    ),
  });
  const jobs = new WebSerialJobsService(
    repo as never,
    settings as never,
    engines as never,
    catalog,
    libraryService as never,
    lookupService as never,
    runner as never,
    importer as never,
  );
  const move = new WebSerialJobMoveService(repo as never, catalog, jobs, runner as never);
  return { catalog, jobs, move, client, engines, repo, settings, covers, libraryService, lookupService, runner, importer };
}
