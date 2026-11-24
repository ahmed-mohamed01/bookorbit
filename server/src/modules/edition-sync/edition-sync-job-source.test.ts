import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Permission, type JobView } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import type { EditionSyncJobActionRow, EditionSyncJobPageRow } from './edition-sync-job-page.repository';
import { EditionSyncJobSource, type EditionSyncJobSourceRow } from './edition-sync-job-source';

const CUTOFF = new Date('2026-11-12T00:00:00.000Z');
const AT = new Date('2026-11-15T10:00:00.000Z');
const LATER = new Date('2026-11-15T11:00:00.000Z');

function user(id: number, permissions: Permission[] = [], isSuperuser = false): RequestUser {
  return { id, active: true, isSuperuser, permissions, contentFilters: null } as unknown as RequestUser;
}

const reader = user(7, [Permission.EditionSync]);
const operator = user(3, [Permission.ManageAppSettings]);
const superuser = user(1, [], true);
const stranger = user(9, [Permission.LibraryEditMetadata]);

function page(change: Partial<EditionSyncJobPageRow> = {}): EditionSyncJobPageRow {
  return {
    bookId: 12,
    status: 'queued',
    stage: null,
    progress: null,
    errorCode: null,
    createdAt: AT,
    lastAttemptAt: null,
    pinnedAt: AT,
    failedAt: null,
    indexedAt: null,
    rank: 2,
    pinnedCount: 2,
    key: { prefix: [1, 2], suffix: [1], id: 12 },
    ...change,
  };
}

function makeSource(options: { visible?: number[] | null; serverEnabled?: boolean; backlog?: number } = {}) {
  const registry = new JobSourceRegistry();
  const jobs = {
    pageForJobs: vi.fn((): Promise<EditionSyncJobPageRow[]> => Promise.resolve([])),
    countForJobs: vi.fn(() => Promise.resolve({ running: 1, pinned: 2, failed: 3 })),
    scoped: vi.fn(() => sql`true`),
    countBacklog: vi.fn(() => Promise.resolve(options.backlog ?? 0)),
    findActionRows: vi.fn((): Promise<EditionSyncJobActionRow[]> => Promise.resolve([])),
  };
  const repo = {
    isServerEnabled: vi.fn(() => Promise.resolve(options.serverEnabled ?? true)),
    findNextQueuedBook: vi.fn(() => Promise.resolve({ bookId: 12, pinned: true })),
    isWantedByAnotherUser: vi.fn(() => Promise.resolve(false)),
  };
  const bookState = {
    retry: vi.fn(() => Promise.resolve({})),
    setSyncEnabled: vi.fn(() => Promise.resolve({ wanted: false })),
    reorderTo: vi.fn().mockResolvedValue('done'),
    reorderQueuedBook: vi.fn(() => Promise.resolve(true)),
  };
  const scheduler = {
    activeTrigger: vi.fn<() => 'scheduled' | null>(() => 'scheduled'),
    startManualRun: vi.fn(() => Promise.resolve({ run: { active: true } })),
    currentBookId: vi.fn<() => number | null>(() => 12),
    stop: vi.fn(() => Promise.resolve({})),
  };
  const subjects = {
    describe: vi.fn(() => Promise.resolve(new Map([[12, { label: 'Dune', byline: 'Frank Herbert', url: '/book/12', image: null }]]))),
  };
  const visible = options.visible === undefined ? [5] : options.visible;
  const scope = {
    seesAllLibraries: vi.fn(() => visible === null),
    visibleIdsOrAll: vi.fn(() => Promise.resolve(visible)),
  };
  const source = new EditionSyncJobSource(
    registry,
    jobs as never,
    repo as never,
    bookState as never,
    scheduler as never,
    subjects as never,
    scope as never,
  );
  source.onModuleInit();
  return { source, registry, jobs, repo, bookState, scheduler, subjects, scope };
}

const viewerOf = (who: RequestUser) => ({ user: who, access: { own: false, all: true } });

function query(view: JobView, owner: { id: number; ownerless: boolean } | null = null) {
  return { view, owner, cutoffAt: CUTOFF, after: null, typeIndex: 13, limit: 51 };
}

function rowOf(change: Partial<EditionSyncJobPageRow>, status: string = change.status ?? 'queued'): EditionSyncJobSourceRow {
  const job = page(change);
  return { nativeId: String(job.bookId), key: job.key, job, startsRun: false, item: { status } as never };
}

async function listed(change: Partial<EditionSyncJobPageRow>, options: { serverEnabled?: boolean } = {}) {
  const { source, jobs } = makeSource(options);
  jobs.pageForJobs.mockResolvedValue([page(change)]);
  const [row] = await source.list(query('queue'), viewerOf(reader));
  return row!;
}

describe('EditionSyncJobSource', () => {
  it('promotes a backlog book within the viewer scope and invalidates the cached count', async () => {
    const { source, bookState, jobs } = makeSource({ backlog: 4 });
    const viewer = viewerOf(reader);
    const countQuery = { owner: null, cutoffAt: CUTOFF };
    await source.counts(countQuery, viewer);
    await expect(source.reorderTo('12', '7', 'before', viewer)).resolves.toEqual({ outcome: 'done', status: 'queued' });
    expect(jobs.scoped).toHaveBeenCalledWith({ libraryIds: [5], contentFilters: null, runningOnly: false });
    expect(bookState.reorderTo).toHaveBeenCalledWith(reader, 12, 7, 'before', expect.anything());
    await source.counts(countQuery, viewer);
    expect(jobs.countBacklog).toHaveBeenCalledTimes(2);
    await expect(source.reorderTo('12', '7', 'before', viewerOf(operator))).resolves.toMatchObject({ outcome: 'refused' });
    expect(bookState.reorderTo).toHaveBeenCalledTimes(1);
  });

  it.each(['refused', 'skipped'])('returns %s for an unavailable drop target', async (outcome) => {
    const { source, bookState } = makeSource();
    bookState.reorderTo.mockResolvedValue(outcome);
    await expect(source.reorderTo('12', '7', 'after', viewerOf(reader))).resolves.toEqual({ outcome, status: null });
  });

  it('registers itself as the edition-sync type', () => {
    const { source, registry } = makeSource();
    expect(registry.get('edition-sync')).toBe(source);
  });

  it('shows ownerless builds to whoever uses edition sync or runs it, and to no one else', () => {
    const { source } = makeSource();
    expect(source.access(reader)).toEqual({ own: false, all: true });
    expect(source.access(operator)).toEqual({ own: false, all: true });
    expect(source.access(superuser)).toEqual({ own: false, all: true });
    expect(source.access(stranger)).toEqual({ own: false, all: false });
    expect(source.access({ ...reader, active: false } as RequestUser)).toEqual({ own: false, all: false });
  });

  it('keeps every read to the viewer visible libraries and content filter, as the books list does', async () => {
    const filtered = { ...reader, contentFilters: { excludeTagIds: [4] } } as unknown as RequestUser;
    const { source, jobs, scope } = makeSource({ visible: [5, 6] });
    await source.list(query('failed'), viewerOf(filtered));
    expect(scope.visibleIdsOrAll).toHaveBeenCalledWith(filtered);
    expect(jobs.pageForJobs).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'failed', libraryIds: [5, 6], contentFilters: { excludeTagIds: [4] }, runningOnly: false, limit: 51 }),
    );
  });

  it('uses running-only scope for an admin who lacks edition sync access', async () => {
    const { source, jobs } = makeSource();
    await source.list(query('queue'), viewerOf(operator));
    expect(jobs.pageForJobs).toHaveBeenCalledWith(expect.objectContaining({ runningOnly: true, includeBacklog: true }));
    await source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(operator));
    expect(jobs.countForJobs).toHaveBeenCalledWith(expect.objectContaining({ runningOnly: true }), CUTOFF, true);
  });

  it("holds nothing in a read of one account's own jobs, and nothing for a viewer without access", async () => {
    const { source, jobs } = makeSource({ backlog: 4 });
    expect(await source.list(query('queue', { id: reader.id, ownerless: false }), viewerOf(reader))).toEqual([]);
    expect(await source.list(query('queue'), { user: stranger, access: { own: false, all: false } })).toEqual([]);
    expect(await source.counts({ owner: { id: reader.id, ownerless: false }, cutoffAt: CUTOFF }, viewerOf(reader))).toMatchObject({
      queue: 0,
      failed: 0,
    });
    expect(jobs.pageForJobs).not.toHaveBeenCalled();
    expect(jobs.countForJobs).not.toHaveBeenCalled();
  });

  it('lists individual backlog books after pinned books and forwards the cursor at the lane boundary', async () => {
    const { source, jobs } = makeSource();
    const viewer = viewerOf(reader);
    const pinned = page({ rank: 1, pinnedCount: 1, key: { prefix: [1, 1], suffix: [1], id: 12 } });
    const backlog = page({ bookId: 13, rank: 2, pinnedAt: null, pinnedCount: 1, key: { prefix: [1, 2], suffix: [1], id: 13 } });
    jobs.pageForJobs.mockResolvedValueOnce([pinned]).mockResolvedValueOnce([backlog]);
    const [first] = await source.list({ ...query('queue'), limit: 1 }, viewer);
    const after = { ...first!.key, typeIndex: 13 };
    const [second] = await source.list({ ...query('queue'), after, limit: 1 }, viewer);
    expect(first?.item.position).toBe(1);
    expect(second).toMatchObject({ nativeId: '13', item: { shape: 'job', status: 'queued', position: 2 } });
    expect(jobs.pageForJobs).toHaveBeenLastCalledWith(expect.objectContaining({ after, limit: 1, includeBacklog: true }));
    expect(jobs.countBacklog).not.toHaveBeenCalled();
  });

  it('counts every backlog book', async () => {
    const { source } = makeSource({ backlog: 4200 });
    expect(await source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(reader))).toEqual({
      queue: 4203,
      needsYou: 0,
      failed: 3,
      running: 1,
      queued: 4202,
      paused: 0,
    });
  });

  it('deduplicates in-flight counts per scope and reuses them for 15 seconds', async () => {
    const { source, jobs, scope } = makeSource({ backlog: 4 });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const counts = () => source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(reader));
      const [first, second] = await Promise.all([counts(), counts()]);
      expect(first.queued).toBe(6);
      expect(second).toEqual(first);
      expect(jobs.countBacklog).toHaveBeenCalledTimes(1);
      now.mockReturnValue(15_999);
      await counts();
      expect(jobs.countBacklog).toHaveBeenCalledTimes(1);
      scope.visibleIdsOrAll.mockResolvedValueOnce([6]);
      await counts();
      expect(jobs.countBacklog).toHaveBeenCalledTimes(2);
      now.mockReturnValue(16_000);
      await counts();
      expect(jobs.countBacklog).toHaveBeenCalledTimes(3);
    } finally {
      now.mockRestore();
    }
  });

  it('shows waiting books as paused, and no backlog, while the server switch is off', async () => {
    const { source } = makeSource({ serverEnabled: false, backlog: 50 });
    expect(await source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(reader))).toMatchObject({ queue: 3, queued: 0, paused: 2 });
    expect((await listed({}, { serverEnabled: false })).item).toMatchObject({ status: 'paused', reason: 'server_disabled', position: null });
  });

  it('maps each stored state', async () => {
    expect((await listed({})).item).toMatchObject({ status: 'queued', position: 2, createdAt: AT.toISOString() });
    expect((await listed({ status: 'running', stage: 'aligning', progress: 40, rank: 0, lastAttemptAt: LATER })).item).toMatchObject({
      status: 'running',
      kind: 'scheduled',
      phase: 'aligning',
      percent: 40,
      startedAt: LATER.toISOString(),
    });
    expect((await listed({ status: 'failed', errorCode: 'inference_failed', failedAt: LATER, rank: 0 })).item).toMatchObject({
      status: 'failed',
      reason: 'inference_failed',
      finishedAt: LATER.toISOString(),
    });
    expect((await listed({ status: 'failed', errorCode: null, rank: 0 })).item.reason).toBe('error');
    expect((await listed({ status: 'ready', indexedAt: LATER, rank: 0 })).item).toMatchObject({
      status: 'completed',
      finishedAt: LATER.toISOString(),
    });
    expect((await listed({})).item.requester).toBeNull();
  });

  it.each([
    [null, 0, 'backlog-head'],
    [AT, 1, null],
  ] as const)('exposes rank one with pinnedAt %s even without move actions', async (pinnedAt, pinnedCount, kind) => {
    const { source, jobs } = makeSource();
    const viewer = viewerOf(reader);
    jobs.pageForJobs.mockResolvedValue([page({ rank: 1, pinnedAt, pinnedCount })]);
    const [row] = await source.list(query('queue'), viewer);
    expect(row?.item).toMatchObject({ status: 'queued', kind, position: 1 });
    expect(source.actions(row!, viewer).actions).toEqual(['cancel']);
  });

  it('names the book through upstream book subjects, checking reach unless the viewer sees every library', async () => {
    const limited = makeSource({ visible: [5] });
    await limited.source.describe([rowOf({})], viewerOf(reader));
    expect(limited.subjects.describe).toHaveBeenCalledWith([12], { user: reader, manages: false });
    const everything = makeSource({ visible: null });
    const found = await everything.source.describe([rowOf({})], viewerOf(superuser));
    expect(everything.subjects.describe).toHaveBeenCalledWith([12], { user: superuser, manages: true });
    expect(found.get('12')).toMatchObject({ label: 'Dune', url: '/book/12' });
  });

  it('points a book held by the server switch at the setting that turns it back on', async () => {
    const off = makeSource({ serverEnabled: false });
    const held = await off.source.describe([rowOf({}, 'paused')], viewerOf(reader));
    expect(held.get('12')).toEqual({ label: 'Dune', byline: 'Frank Herbert', url: '/settings/fork', image: null });
    expect(off.repo.isServerEnabled).not.toHaveBeenCalled();

    const on = makeSource({ serverEnabled: true });
    expect((await on.source.describe([rowOf({})], viewerOf(reader))).get('12')).toMatchObject({ label: 'Dune', url: '/book/12' });

    const other = makeSource({ serverEnabled: false });
    other.subjects.describe.mockResolvedValue(
      new Map([
        [12, { label: 'Dune', byline: 'Frank Herbert', url: '/book/12', image: null }],
        [13, { label: 'Emma', byline: 'Jane Austen', url: '/book/13', image: null }],
      ]),
    );
    const found = await other.source.describe([rowOf({ status: 'failed' }), rowOf({ bookId: 13, status: 'running' })], viewerOf(reader));
    expect(found.get('12')).toMatchObject({ label: 'Dune', url: '/book/12' });
    expect(found.get('13')).toMatchObject({ label: 'Emma', url: '/book/13' });
    expect(other.repo.isServerEnabled).not.toHaveBeenCalled();
  });

  it('leaves an unreachable book unnamed', async () => {
    const { source, subjects } = makeSource();
    subjects.describe.mockResolvedValue(new Map());
    expect((await source.describe([rowOf({})], viewerOf(reader))).has('12')).toBe(false);
  });

  it('offers Cancel on running builds to admins and Retry on failures to edition sync users', () => {
    const { source } = makeSource();
    expect(source.actions(rowOf({ status: 'running' }), viewerOf(operator))).toEqual({ actions: ['cancel'], note: null });
    expect(source.actions(rowOf({ status: 'running' }), viewerOf(reader))).toEqual({ actions: [], note: 'edition-sync-admin' });
    expect(source.actions(rowOf({ status: 'failed' }), viewerOf(reader)).actions).toEqual(['retry']);
    expect(source.actions(rowOf({ status: 'ready' }), viewerOf(reader)).actions).toEqual([]);
    expect(source.actions(rowOf({ status: 'failed' }), viewerOf(operator)).actions).toEqual([]);
    expect(source.actions(rowOf({ status: 'queued' }), viewerOf(superuser)).actions).toEqual(['move-to-top', 'move-up', 'cancel']);
    expect(source.actions(rowOf({ rank: 1 }), viewerOf(reader)).actions).toEqual(['move-down', 'cancel']);
    expect(source.actions(rowOf({ rank: 3, pinnedAt: null }), viewerOf(reader)).actions).toEqual(['move-to-top', 'move-up', 'cancel']);
    expect(source.actions(rowOf({}, 'paused'), viewerOf(superuser)).actions).toEqual([]);
  });

  it('offers Start only on the first job, to an admin, while no run is active', async () => {
    const { source, jobs, repo, scheduler } = makeSource();
    const viewer = viewerOf(superuser);
    jobs.pageForJobs.mockResolvedValue([page({ rank: 1 }), page({ bookId: 13, rank: 2 })]);
    scheduler.activeTrigger.mockReturnValue(null);
    const [first, second] = await source.list(query('queue'), viewer);
    expect(source.actions(first!, viewer).actions).toContain('start');
    expect(source.actions(second!, viewer).actions).not.toContain('start');
    expect(source.actions(first!, viewerOf(reader)).actions).not.toContain('start');
    expect(repo.findNextQueuedBook).not.toHaveBeenCalled();
    const [history] = await source.list(query('history'), viewer);
    expect(source.actions(history!, viewer).actions).not.toContain('start');
    repo.isServerEnabled.mockResolvedValueOnce(false);
    const [paused] = await source.list(query('queue'), viewer);
    expect(source.actions(paused!, viewer).actions).not.toContain('start');
    scheduler.activeTrigger.mockReturnValue('scheduled');
    const [busy] = await source.list(query('queue'), viewer);
    expect(source.actions(busy!, viewer).actions).not.toContain('start');
  });

  describe('act', () => {
    it('checks other users before cancelling and leaves preferences untouched on refusal', async () => {
      const { source, jobs, repo, bookState } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'queued', retryRequested: false, pinned: false }]);
      repo.isWantedByAnotherUser.mockResolvedValueOnce(true);
      expect(await source.act('cancel', ['12'], viewerOf(reader))).toEqual([{ id: '12', outcome: 'refused', status: 'queued' }]);
      expect(repo.isWantedByAnotherUser).toHaveBeenCalledWith(12, reader.id);
      expect(bookState.setSyncEnabled).not.toHaveBeenCalled();
      expect(await source.act('cancel', ['12'], viewerOf(reader))).toEqual([{ id: '12', outcome: 'done', status: 'cancelled' }]);
      expect(bookState.setSyncEnabled).toHaveBeenCalledWith(reader, 12, false);
    });

    it.each(['move-up', 'move-to-top', 'cancel', 'start'] as const)('refreshes the backlog count after %s succeeds', async (action) => {
      const { source, jobs, scheduler } = makeSource({ backlog: 4 });
      scheduler.activeTrigger.mockReturnValue(null);
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'queued', retryRequested: false, pinned: false }]);
      const viewer = viewerOf(superuser);
      const counts = () => source.counts({ owner: null, cutoffAt: CUTOFF }, viewer);
      expect((await counts()).queued).toBe(6);
      jobs.countBacklog.mockResolvedValue(3);
      expect(await source.act(action, ['12'], viewer)).toMatchObject([{ outcome: 'done' }]);
      expect((await counts()).queued).toBe(5);
    });

    it('discards an in-flight backlog count after a successful queued action', async () => {
      const { source, jobs } = makeSource({ backlog: 3 });
      const viewer = viewerOf(reader);
      const counts = () => source.counts({ owner: null, cutoffAt: CUTOFF }, viewer);
      let resolveOld!: (count: number) => void;
      jobs.countBacklog.mockReturnValueOnce(new Promise((resolve) => (resolveOld = resolve)));
      const oldCount = counts();
      await vi.waitFor(() => expect(jobs.countBacklog).toHaveBeenCalledTimes(1));
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'queued', retryRequested: false, pinned: false }]);
      await source.act('cancel', ['12'], viewer);
      expect((await counts()).queued).toBe(5);
      resolveOld(4);
      await oldCount;
      expect((await counts()).queued).toBe(5);
      expect(jobs.countBacklog).toHaveBeenCalledTimes(2);
    });

    it('delegates reordering and skips when the neighbour is gone', async () => {
      const { source, jobs, bookState } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'queued', retryRequested: false, pinned: true }]);
      expect(await source.act('move-up', ['12'], viewerOf(reader))).toEqual([{ id: '12', outcome: 'done', status: 'queued' }]);
      expect(bookState.reorderQueuedBook).toHaveBeenCalledWith(reader, 12, true, 'move-up', expect.anything());
      expect(await source.act('move-to-top', ['12'], viewerOf(reader))).toMatchObject([{ outcome: 'done' }]);
      expect(bookState.reorderQueuedBook).toHaveBeenLastCalledWith(reader, 12, true, 'move-to-top', expect.anything());
      expect(await source.act('prioritize', ['12'], viewerOf(reader))).toMatchObject([{ outcome: 'skipped' }]);
      expect(bookState.reorderQueuedBook).toHaveBeenCalledTimes(2);
      bookState.reorderQueuedBook.mockResolvedValueOnce(false);
      expect(await source.act('move-down', ['12'], viewerOf(reader))).toEqual([{ id: '12', outcome: 'skipped', status: 'queued' }]);
    });

    it('starts the first job for an admin and skips a concurrent start or change to the head', async () => {
      const { source, jobs, scheduler } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'queued', retryRequested: false, pinned: false }]);
      scheduler.activeTrigger.mockReturnValue(null);
      expect(await source.act('start', ['12'], viewerOf(reader))).toEqual([{ id: '12', outcome: 'refused', status: 'queued' }]);
      expect(scheduler.startManualRun).not.toHaveBeenCalled();
      expect(await source.act('start', ['12'], viewerOf(superuser))).toEqual([{ id: '12', outcome: 'done', status: 'running' }]);
      expect(scheduler.startManualRun).toHaveBeenCalledWith(12);
      expect(await source.act('start', ['12'], viewerOf(operator))).toEqual([{ id: '12', outcome: 'done', status: 'running' }]);
      scheduler.startManualRun.mockRejectedValueOnce(new ConflictException());
      expect(await source.act('start', ['12'], viewerOf(superuser))).toEqual([{ id: '12', outcome: 'skipped', status: 'queued' }]);
    });

    it('retries a failed book as the viewer and skips a completed book in the same request', async () => {
      const { source, jobs, bookState } = makeSource();
      jobs.findActionRows.mockResolvedValue([
        { bookId: 12, status: 'failed', retryRequested: false, pinned: false },
        { bookId: 13, status: 'ready', retryRequested: false, pinned: false },
      ]);
      expect(await source.act('retry', ['12', '13'], viewerOf(reader))).toEqual([
        { id: '12', outcome: 'done', status: 'queued' },
        { id: '13', outcome: 'skipped', status: 'completed' },
      ]);
      expect(jobs.findActionRows).toHaveBeenCalledWith([12, 13], { libraryIds: [5], contentFilters: null, runningOnly: false });
      expect(bookState.retry).toHaveBeenCalledWith(reader, 12);
      expect(bookState.retry).toHaveBeenCalledTimes(1);
    });

    it('stops the run for an admin, and refuses anyone else', async () => {
      const { source, jobs, scheduler } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'running', retryRequested: false, pinned: false }]);
      expect(await source.act('cancel', ['12'], viewerOf(reader))).toEqual([{ id: '12', outcome: 'refused', status: 'running' }]);
      expect(scheduler.stop).not.toHaveBeenCalled();
      expect(await source.act('cancel', ['12'], viewerOf(operator))).toEqual([{ id: '12', outcome: 'done', status: null }]);
      expect(scheduler.stop).toHaveBeenCalledTimes(1);
    });

    it.each([13, null])('skips a stale running row when the scheduler current book is %s', async (currentBookId) => {
      const { source, jobs, scheduler } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'running', retryRequested: false, pinned: false }]);
      scheduler.currentBookId.mockReturnValue(currentBookId);
      expect(await source.act('cancel', ['12'], viewerOf(operator))).toEqual([{ id: '12', outcome: 'skipped', status: 'running' }]);
      expect(scheduler.stop).not.toHaveBeenCalled();
    });

    it('answers not-found outside the viewer scope, for bad ids, and for builds an admin-only viewer is not shown', async () => {
      const { source, jobs, bookState } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'failed', retryRequested: false, pinned: false }]);
      expect(await source.act('retry', ['12', '99', 'nope'], viewerOf(operator))).toEqual([
        { id: '12', outcome: 'not-found', status: null },
        { id: '99', outcome: 'not-found', status: null },
        { id: 'nope', outcome: 'not-found', status: null },
      ]);
      expect(bookState.retry).not.toHaveBeenCalled();
    });

    it('reads nothing for a viewer without access to the type', async () => {
      const { source, jobs } = makeSource();
      expect(await source.act('retry', ['12', 'invalid'], { user: stranger, access: { own: false, all: false } })).toEqual([
        { id: '12', outcome: 'not-found', status: null },
        { id: 'invalid', outcome: 'not-found', status: null },
      ]);
      expect(jobs.findActionRows).not.toHaveBeenCalled();
    });

    it('skips what does not apply and turns refusals into outcomes', async () => {
      const { source, jobs, bookState } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'failed', retryRequested: true, pinned: true }]);
      expect(await source.act('retry', ['12'], viewerOf(reader))).toEqual([{ id: '12', outcome: 'skipped', status: 'queued' }]);
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'failed', retryRequested: false, pinned: false }]);
      bookState.retry.mockRejectedValueOnce(new BadRequestException('Edition sync is turned off on this server'));
      expect((await source.act('retry', ['12'], viewerOf(reader)))[0]).toMatchObject({ outcome: 'refused', status: 'failed' });
      bookState.retry.mockRejectedValueOnce(new NotFoundException());
      expect((await source.act('retry', ['12'], viewerOf(reader)))[0]).toEqual({ id: '12', outcome: 'not-found', status: null });
    });

    it('logs a failed action with the viewer, duration, error class and a sanitized message', async () => {
      const { source, jobs, bookState } = makeSource();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'failed', retryRequested: false, pinned: false }]);
      bookState.retry.mockRejectedValueOnce(new TypeError('bad "quote"'));
      expect((await source.act('retry', ['12'], viewerOf(reader)))[0]).toMatchObject({ outcome: 'error' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[edition_sync\.jobs_action\] \[fail\] bookId=12 userId=7 action=retry durationMs=\d+ errorClass=TypeError error="bad \\"quote\\"" - /,
        ),
      );
      warn.mockRestore();
    });
  });
});
