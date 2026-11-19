import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Permission, type JobView } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { JobSourceRegistry } from '../../jobs/job-source.registry';
import type { JobViewer } from '../../jobs/job-source';
import type { MonitoredFetchJobActionRow, MonitoredFetchJobPageRow } from './monitored-fetch-job-page.repository';
import { MonitoredFetchJobSource } from './monitored-fetch-job-source';

const MONITOR = '0b6c3c3e-8f39-4f53-9a8e-2b1d33f0a001';
const OTHER = '0b6c3c3e-8f39-4f53-9a8e-2b1d33f0a002';
const ADDED = new Date('2026-11-01T10:00:00.000Z');
const QUEUED = new Date('2026-11-15T10:00:00.000Z');

function user(id: number, permissions: Permission[] = [], isSuperuser = false, active = true): RequestUser {
  return { id, name: `User ${id}`, active, isSuperuser, permissions } as unknown as RequestUser;
}

const owner = user(7, [Permission.BookRequestAccess]);
const stranger = user(8, [Permission.BookRequestAccess]);
const admin = user(1, [Permission.ManageAppSettings, Permission.ManageBookRequests]);
const superuser = user(2, [], true);

function page(change: Partial<MonitoredFetchJobPageRow> = {}): MonitoredFetchJobPageRow {
  return {
    id: MONITOR,
    ownerUserId: owner.id,
    authorName: 'Ursula K. Le Guin',
    localAuthorId: 12,
    fetchState: 'queued',
    fetchErrorKind: null,
    fetchErrorAt: null,
    fetchRetryAt: null,
    fetchQueuedAt: QUEUED,
    fetchStartedAt: null,
    addedAt: ADDED,
    lastRefreshedAt: null,
    key: { prefix: [1, 1], suffix: [1], id: MONITOR },
    ...change,
  };
}

function makeSource() {
  const registry = new JobSourceRegistry();
  const jobs = {
    pageForJobs: vi.fn((): Promise<MonitoredFetchJobPageRow[]> => Promise.resolve([])),
    countForJobs: vi.fn(() => Promise.resolve({ queue: 2, needsYou: 0, failed: 1, running: 1, queued: 1, paused: 0 })),
    findActionRows: vi.fn((): Promise<MonitoredFetchJobActionRow[]> =>
      Promise.resolve([{ id: MONITOR, ownerUserId: owner.id, fetchState: 'failed' }]),
    ),
  };
  const monitored = {
    findMonitorsWithPortraits: vi.fn(() => Promise.resolve(new Set([MONITOR]))),
    refreshAuthor: vi.fn(() => Promise.resolve({ fetch: { state: 'queued' } })),
  };
  const source = new MonitoredFetchJobSource(registry, jobs as never, monitored as never);
  source.onModuleInit();
  return { source, registry, jobs, monitored };
}

const viewerOf = (who: RequestUser): JobViewer => ({ user: who, access: { own: true, all: false } });

function query(view: JobView, ownerId: number | null) {
  return {
    view,
    owner: ownerId === null ? null : { id: ownerId, ownerless: false },
    cutoffAt: new Date('2026-11-08T12:00:00.000Z'),
    after: null,
    typeIndex: 14,
    limit: 51,
  };
}

async function listed(change: Partial<MonitoredFetchJobPageRow>) {
  const { source, jobs } = makeSource();
  jobs.pageForJobs.mockResolvedValue([page(change)]);
  const [row] = await source.list(query('queue', owner.id), viewerOf(owner));
  return row!;
}

describe('MonitoredFetchJobSource', () => {
  it('registers itself as the watchlist-fetch type', () => {
    const { source, registry } = makeSource();
    expect(registry.get('watchlist-fetch')).toBe(source);
    expect(source.failedWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("shows a Watchlist holder their own updates and never anyone else's, admins included", () => {
    const { source } = makeSource();
    expect(source.access(owner)).toEqual({ own: true, all: false });
    expect(source.access(superuser)).toEqual({ own: true, all: false });
    expect(source.access(admin)).toEqual({ own: false, all: false });
    expect(source.access(user(9))).toEqual({ own: false, all: false });
    expect(source.access(user(10, [Permission.BookRequestAccess], false, false))).toEqual({ own: false, all: false });
  });

  it("reads only the viewer's own rows, and nothing for an everyone read", async () => {
    const { source, jobs } = makeSource();
    await source.list(query('history', owner.id), viewerOf(owner));
    expect(jobs.pageForJobs).toHaveBeenCalledWith(expect.objectContaining({ view: 'history', ownerUserId: owner.id, limit: 51 }));
    jobs.pageForJobs.mockClear();
    await expect(source.list(query('queue', null), viewerOf(owner))).resolves.toEqual([]);
    expect(jobs.pageForJobs).not.toHaveBeenCalled();
  });

  it('counts the owner only, and nothing for an everyone read', async () => {
    const { source, jobs } = makeSource();
    await expect(source.counts({ owner: { id: owner.id, ownerless: false }, cutoffAt: new Date() })).resolves.toMatchObject({ queue: 2 });
    expect(jobs.countForJobs).toHaveBeenCalledWith(owner.id, expect.any(Date));
    await expect(source.counts({ owner: null, cutoffAt: new Date() })).resolves.toEqual({
      queue: 0,
      needsYou: 0,
      failed: 0,
      running: 0,
      queued: 0,
      paused: 0,
    });
  });

  it('lists a queued fetch with no lane place, created when it was queued', async () => {
    const row = await listed({});
    expect(row.nativeId).toBe(MONITOR);
    expect(row.item).toMatchObject({
      status: 'queued',
      position: null,
      createdAt: QUEUED.toISOString(),
      startedAt: null,
      finishedAt: null,
      requester: { id: owner.id, name: 'User 7' },
    });
  });

  it('falls back to the time the author was added for a row queued before the column existed', async () => {
    const row = await listed({ fetchQueuedAt: null });
    expect(row.item.createdAt).toBe(ADDED.toISOString());
  });

  it('lists a running fetch from when it was claimed', async () => {
    const started = new Date('2026-11-15T10:05:00.000Z');
    const row = await listed({ fetchState: 'fetching', fetchStartedAt: started });
    expect(row.item).toMatchObject({ status: 'running', startedAt: started.toISOString(), finishedAt: null });
  });

  it('lists a failed fetch with its error kind, marked when a retry is already scheduled', async () => {
    const failedAt = new Date('2026-11-15T10:06:00.000Z');
    const retrying = await listed({ fetchState: 'failed', fetchErrorKind: 'rate_limited', fetchErrorAt: failedAt, fetchRetryAt: QUEUED });
    expect(retrying.item).toMatchObject({ status: 'failed', reason: 'rate_limited-retrying', finishedAt: failedAt.toISOString() });
    const final = await listed({ fetchState: 'failed', fetchErrorKind: 'author_gone', fetchErrorAt: failedAt });
    expect(final.item.reason).toBe('author_gone');
  });

  it('lists a finished fetch as completed when the catalog was refreshed', async () => {
    const refreshed = new Date('2026-11-15T10:07:00.000Z');
    const row = await listed({ fetchState: 'idle', lastRefreshedAt: refreshed });
    expect(row.item).toMatchObject({ status: 'completed', reason: null, finishedAt: refreshed.toISOString() });
  });

  it('names the author, links the Watchlist author page and shows the portrait only when there is one', async () => {
    const { source, jobs, monitored } = makeSource();
    jobs.pageForJobs.mockResolvedValue([page(), page({ id: OTHER, authorName: 'N. K. Jemisin', localAuthorId: null })]);
    const rows = await source.list(query('queue', owner.id), viewerOf(owner));
    const subjects = await source.describe(rows);
    expect(monitored.findMonitorsWithPortraits).toHaveBeenCalledTimes(1);
    expect(subjects.get(MONITOR)).toEqual({
      label: 'Ursula K. Le Guin',
      byline: null,
      url: `/watchlist/authors/${MONITOR}`,
      image: `/api/v1/monitored/authors/${MONITOR}/portrait`,
    });
    expect(subjects.get(OTHER)).toMatchObject({ label: 'N. K. Jemisin', image: null });
  });

  it("offers Try again only on a failed fetch of the viewer's own", async () => {
    const { source } = makeSource();
    const failed = await listed({ fetchState: 'failed', fetchErrorKind: 'timeout', fetchErrorAt: QUEUED });
    expect(source.actions(failed, viewerOf(owner))).toEqual({ actions: ['retry'], note: null });
    expect(source.actions(failed, viewerOf(stranger))).toEqual({ actions: [], note: null });
    expect(source.actions(await listed({ fetchState: 'fetching' }), viewerOf(owner))).toEqual({ actions: [], note: null });
    expect(source.actions(await listed({ fetchState: 'idle', lastRefreshedAt: QUEUED }), viewerOf(owner))).toEqual({ actions: [], note: null });
  });

  it('retries through the Watchlist refresh', async () => {
    const { source, monitored } = makeSource();
    await expect(source.act('retry', [MONITOR], viewerOf(owner))).resolves.toEqual([{ id: MONITOR, outcome: 'done', status: 'queued' }]);
    expect(monitored.refreshAuthor).toHaveBeenCalledWith(MONITOR, owner);
  });

  it("answers not-found for someone else's monitor, a malformed id and a missing one", async () => {
    const { source, monitored } = makeSource();
    await expect(source.act('retry', [MONITOR, 'nope', OTHER], viewerOf(stranger))).resolves.toEqual([
      { id: MONITOR, outcome: 'not-found', status: null },
      { id: 'nope', outcome: 'not-found', status: null },
      { id: OTHER, outcome: 'not-found', status: null },
    ]);
    expect(monitored.refreshAuthor).not.toHaveBeenCalled();
  });

  it('skips every other action and a fetch that is no longer failed', async () => {
    const { source, jobs, monitored } = makeSource();
    await expect(source.act('cancel', [MONITOR], viewerOf(owner))).resolves.toEqual([{ id: MONITOR, outcome: 'skipped', status: 'failed' }]);
    jobs.findActionRows.mockResolvedValue([{ id: MONITOR, ownerUserId: owner.id, fetchState: 'queued' }]);
    await expect(source.act('retry', [MONITOR], viewerOf(owner))).resolves.toEqual([{ id: MONITOR, outcome: 'skipped', status: 'queued' }]);
    expect(monitored.refreshAuthor).not.toHaveBeenCalled();
  });

  it('refuses an owner who lost Watchlist access and a refresh the Watchlist refuses', async () => {
    const lapsed = user(7);
    const { source, monitored } = makeSource();
    await expect(source.act('retry', [MONITOR], viewerOf(lapsed))).resolves.toEqual([{ id: MONITOR, outcome: 'refused', status: 'failed' }]);
    expect(monitored.refreshAuthor).not.toHaveBeenCalled();

    monitored.refreshAuthor.mockRejectedValueOnce(new ForbiddenException('No access to this monitored author'));
    await expect(source.act('retry', [MONITOR], viewerOf(owner))).resolves.toEqual([{ id: MONITOR, outcome: 'refused', status: 'failed' }]);
    monitored.refreshAuthor.mockRejectedValueOnce(new HttpException('cooldown', HttpStatus.TOO_MANY_REQUESTS));
    await expect(source.act('retry', [MONITOR], viewerOf(owner))).resolves.toEqual([{ id: MONITOR, outcome: 'refused', status: 'failed' }]);
    monitored.refreshAuthor.mockRejectedValueOnce(new NotFoundException('gone'));
    await expect(source.act('retry', [MONITOR], viewerOf(owner))).resolves.toEqual([{ id: MONITOR, outcome: 'not-found', status: null }]);
    monitored.refreshAuthor.mockRejectedValueOnce(new Error('database down'));
    await expect(source.act('retry', [MONITOR], viewerOf(owner))).resolves.toEqual([{ id: MONITOR, outcome: 'error', status: 'failed' }]);
  });
});
