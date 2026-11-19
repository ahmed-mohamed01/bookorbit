import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
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
    key: { prefix: [1, 2], suffix: [1], id: 12 },
    ...change,
  };
}

function makeSource(options: { visible?: number[] | null; serverEnabled?: boolean; backlog?: number } = {}) {
  const registry = new JobSourceRegistry();
  const jobs = {
    pageForJobs: vi.fn((): Promise<EditionSyncJobPageRow[]> => Promise.resolve([])),
    countForJobs: vi.fn(() => Promise.resolve({ running: 1, pinned: 2, failed: 3 })),
    countBacklog: vi.fn(() => Promise.resolve(options.backlog ?? 0)),
    findActionRows: vi.fn((): Promise<EditionSyncJobActionRow[]> => Promise.resolve([])),
  };
  const repo = { isServerEnabled: vi.fn(() => Promise.resolve(options.serverEnabled ?? true)) };
  const bookState = { retry: vi.fn(() => Promise.resolve({})) };
  const scheduler = {
    activeTrigger: vi.fn(() => 'scheduled' as const),
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

function rowOf(change: Partial<EditionSyncJobPageRow>): EditionSyncJobSourceRow {
  const job = page(change);
  return { nativeId: String(job.bookId), key: job.key, bucket: { kind: 'book', job }, item: {} as never };
}

async function listed(change: Partial<EditionSyncJobPageRow>, options: { serverEnabled?: boolean } = {}) {
  const { source, jobs } = makeSource(options);
  jobs.pageForJobs.mockResolvedValue([page(change)]);
  const [row] = await source.list(query('queue'), viewerOf(reader));
  return row!;
}

describe('EditionSyncJobSource', () => {
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

  it('shows someone who only manages the server the running build and the backlog, as the admin status does', async () => {
    const { source, jobs } = makeSource();
    await source.list(query('queue'), viewerOf(operator));
    expect(jobs.pageForJobs).toHaveBeenCalledWith(expect.objectContaining({ runningOnly: true }));
    await source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(operator));
    expect(jobs.countForJobs).toHaveBeenCalledWith(expect.objectContaining({ runningOnly: true }), CUTOFF);
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

  it('ends the Queue with one row for the books no run has pinned, linking to the settings queue', async () => {
    const { source, jobs } = makeSource({ backlog: 4200 });
    jobs.pageForJobs.mockResolvedValue([page()]);
    const rows = await source.list(query('queue', { id: reader.id, ownerless: true }), viewerOf(reader));
    expect(rows.map((row) => row.nativeId)).toEqual(['12', 'backlog']);
    expect(rows[1]!.item).toMatchObject({ shape: 'queue', status: 'queued', total: 4200, kind: 'backlog' });
    const subjects = await source.describe(rows, viewerOf(reader));
    expect(subjects.get('backlog')).toEqual({ label: null, byline: null, url: '/settings/fork', image: null });
  });

  it('pages past the backlog row without reading books again, and reuses its count briefly', async () => {
    const { source, jobs } = makeSource({ backlog: 10 });
    const after = { prefix: [1, 2_147_483_647], suffix: [0], id: 'backlog', typeIndex: 13 };
    expect(await source.list({ ...query('queue'), after }, viewerOf(reader))).toEqual([]);
    expect(jobs.pageForJobs).not.toHaveBeenCalled();
    await source.list(query('queue'), viewerOf(reader));
    expect(jobs.countBacklog).toHaveBeenCalledTimes(1);
  });

  it('counts the backlog once and matches the list', async () => {
    const { source } = makeSource({ backlog: 4200 });
    expect(await source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(reader))).toEqual({
      queue: 4,
      needsYou: 0,
      failed: 3,
      running: 1,
      queued: 3,
      paused: 0,
    });
  });

  it.each(['cold', 'expired'])('shares a %s backlog query between a concurrent Queue page and counts', async (cacheState) => {
    vi.useFakeTimers();
    try {
      const { source, jobs } = makeSource({ backlog: 10 });
      const viewer = viewerOf(reader);
      const countQuery = { owner: null, cutoffAt: CUTOFF };
      if (cacheState === 'expired') {
        await source.counts(countQuery, viewer);
        vi.setSystemTime(Date.now() + 15_000);
        jobs.countBacklog.mockClear();
      }
      const { promise, resolve } = Promise.withResolvers<number>();
      jobs.countBacklog.mockReturnValue(promise);
      const list = source.list(query('queue'), viewer);
      const counts = source.counts(countQuery, viewer);
      await vi.advanceTimersByTimeAsync(0);
      resolve(25);
      const [rows, result] = await Promise.all([list, counts]);
      expect(rows[0]?.item.total).toBe(25);
      expect(result.queue).toBe(4);
      expect(jobs.countBacklog).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a new backlog query after a rejected one', async () => {
    const { source, jobs } = makeSource({ backlog: 10 });
    const viewer = viewerOf(reader);
    jobs.countBacklog.mockRejectedValueOnce(new Error('count failed'));
    await expect(source.list(query('queue'), viewer)).rejects.toThrow('count failed');
    expect((await source.list(query('queue'), viewer))[0]?.item.total).toBe(10);
    expect(jobs.countBacklog).toHaveBeenCalledTimes(2);
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

  it('names the book through upstream book subjects, checking reach unless the viewer sees every library', async () => {
    const limited = makeSource({ visible: [5] });
    await limited.source.describe([rowOf({})], viewerOf(reader));
    expect(limited.subjects.describe).toHaveBeenCalledWith([12], { user: reader, manages: false });
    const everything = makeSource({ visible: null });
    const found = await everything.source.describe([rowOf({})], viewerOf(superuser));
    expect(everything.subjects.describe).toHaveBeenCalledWith([12], { user: superuser, manages: true });
    expect(found.get('12')).toMatchObject({ label: 'Dune', url: '/book/12' });
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
    expect(source.actions(rowOf({ status: 'queued' }), viewerOf(superuser)).actions).toEqual([]);
  });

  describe('act', () => {
    it('retries a failed book as the viewer and skips a completed book in the same request', async () => {
      const { source, jobs, bookState } = makeSource();
      jobs.findActionRows.mockResolvedValue([
        { bookId: 12, status: 'failed', retryRequested: false },
        { bookId: 13, status: 'ready', retryRequested: false },
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
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'running', retryRequested: false }]);
      expect(await source.act('cancel', ['12'], viewerOf(reader))).toEqual([{ id: '12', outcome: 'refused', status: 'running' }]);
      expect(scheduler.stop).not.toHaveBeenCalled();
      expect(await source.act('cancel', ['12'], viewerOf(operator))).toEqual([{ id: '12', outcome: 'done', status: null }]);
      expect(scheduler.stop).toHaveBeenCalledTimes(1);
    });

    it.each([13, null])('skips a stale running row when the scheduler current book is %s', async (currentBookId) => {
      const { source, jobs, scheduler } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'running', retryRequested: false }]);
      scheduler.currentBookId.mockReturnValue(currentBookId);
      expect(await source.act('cancel', ['12'], viewerOf(operator))).toEqual([{ id: '12', outcome: 'skipped', status: 'running' }]);
      expect(scheduler.stop).not.toHaveBeenCalled();
    });

    it('answers not-found outside the viewer scope, for bad ids, and for builds an admin-only viewer is not shown', async () => {
      const { source, jobs, bookState } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'failed', retryRequested: false }]);
      expect(await source.act('retry', ['12', '99', 'nope'], viewerOf(operator))).toEqual([
        { id: '12', outcome: 'not-found', status: null },
        { id: '99', outcome: 'not-found', status: null },
        { id: 'nope', outcome: 'not-found', status: null },
      ]);
      expect(bookState.retry).not.toHaveBeenCalled();
    });

    it('reads nothing for a viewer without access to the type', async () => {
      const { source, jobs } = makeSource();
      expect(await source.act('retry', ['12', 'backlog'], { user: stranger, access: { own: false, all: false } })).toEqual([
        { id: '12', outcome: 'not-found', status: null },
        { id: 'backlog', outcome: 'not-found', status: null },
      ]);
      expect(jobs.findActionRows).not.toHaveBeenCalled();
    });

    it('skips what does not apply and turns refusals into outcomes', async () => {
      const { source, jobs, bookState } = makeSource();
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'failed', retryRequested: true }]);
      expect(await source.act('retry', ['12'], viewerOf(reader))).toEqual([{ id: '12', outcome: 'skipped', status: 'queued' }]);
      expect(await source.act('retry', ['backlog'], viewerOf(reader))).toEqual([{ id: 'backlog', outcome: 'skipped', status: null }]);
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'failed', retryRequested: false }]);
      bookState.retry.mockRejectedValueOnce(new BadRequestException('Edition sync is turned off on this server'));
      expect((await source.act('retry', ['12'], viewerOf(reader)))[0]).toMatchObject({ outcome: 'refused', status: 'failed' });
      bookState.retry.mockRejectedValueOnce(new NotFoundException());
      expect((await source.act('retry', ['12'], viewerOf(reader)))[0]).toEqual({ id: '12', outcome: 'not-found', status: null });
    });

    it('logs a failed action with the viewer, duration, error class and a sanitized message', async () => {
      const { source, jobs, bookState } = makeSource();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jobs.findActionRows.mockResolvedValue([{ bookId: 12, status: 'failed', retryRequested: false }]);
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
