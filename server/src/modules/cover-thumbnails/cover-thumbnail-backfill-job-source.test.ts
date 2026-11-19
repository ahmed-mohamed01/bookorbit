import { Logger } from '@nestjs/common';
import { Permission, type CoverThumbnailBackfillRun, type CoverThumbnailBackfillState, type JobView } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import { CoverThumbnailBackfillJobSource } from './cover-thumbnail-backfill-job-source';

const STARTED = '2026-11-15T10:00:00.000Z';
const FINISHED = '2026-11-15T10:05:00.000Z';
const CUTOFF = new Date('2026-11-08T12:00:00.000Z');

function user(id: number, permissions: Permission[] = [], isSuperuser = false): RequestUser {
  return { id, active: true, isSuperuser, permissions } as unknown as RequestUser;
}

const operator = user(3, [Permission.ManageAppSettings]);
const librarian = user(7, [Permission.ManageLibraries]);

function lastRun(change: Partial<CoverThumbnailBackfillRun> = {}): CoverThumbnailBackfillRun {
  return {
    trigger: 'schedule',
    outcome: 'completed',
    startedAt: STARTED,
    finishedAt: FINISHED,
    durationMs: 300_000,
    scanned: 1200,
    missing: 40,
    made: 38,
    unresolved: 2,
    ...change,
  };
}

const RUNNING: CoverThumbnailBackfillState = {
  enabled: true,
  running: { trigger: 'manual', startedAt: '2026-11-16T09:00:00.000Z', total: 1200, scanned: 300, missing: 4, made: 4, unresolved: 0 },
  lastRun: lastRun(),
};

function makeSource(state: CoverThumbnailBackfillState) {
  const registry = new JobSourceRegistry();
  const backfill = { getState: vi.fn(() => Promise.resolve(state)), stopRun: vi.fn(() => true) };
  const source = new CoverThumbnailBackfillJobSource(registry, backfill as never);
  source.onModuleInit();
  return { source, registry, backfill };
}

function viewerOf(who: RequestUser) {
  const access = { own: false, all: who.isSuperuser || who.permissions.includes(Permission.ManageAppSettings) };
  return { user: who, access };
}

function query(view: JobView, owner: { id: number; ownerless: boolean } | null = null) {
  return { view, owner, cutoffAt: CUTOFF, after: null, typeIndex: 15, limit: 51 };
}

describe('CoverThumbnailBackfillJobSource', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('registers itself and is seen only by those who manage the server', () => {
    const { source, registry } = makeSource(RUNNING);
    expect(registry.get('cover-thumbnail-backfill')).toBe(source);
    expect(source.access(operator)).toEqual({ own: false, all: true });
    expect(source.access(user(1, [], true))).toEqual({ own: false, all: true });
    expect(source.access(librarian)).toEqual({ own: false, all: false });
  });

  it('shows the running run in Queue with how many covers it has checked of how many', async () => {
    const { source } = makeSource(RUNNING);
    const [row] = await source.list(query('queue'), viewerOf(operator));
    expect(row).toMatchObject({
      nativeId: `run-${Date.parse(RUNNING.running!.startedAt)}`,
      item: { status: 'running', kind: 'manual', done: 300, total: 1200, requester: null },
    });
    expect(source.actions(row!)).toEqual({ actions: ['cancel'], note: null });
  });

  it('reads nothing for a read that leaves out ownerless work, or for a viewer who may not see it', async () => {
    const { source, backfill } = makeSource(RUNNING);
    expect(await source.list(query('queue', { id: 3, ownerless: false }), viewerOf(operator))).toEqual([]);
    expect(await source.list(query('queue'), viewerOf(librarian))).toEqual([]);
    expect(await source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(librarian))).toMatchObject({ queue: 0, failed: 0 });
    expect(backfill.getState).not.toHaveBeenCalled();
  });

  it('puts the last finished run in History, counting covers it could not read', async () => {
    const { source } = makeSource({ ...RUNNING, running: null });
    const [row] = await source.list(query('history'), viewerOf(operator));
    expect(row?.item).toMatchObject({ status: 'completed', finishedAt: FINISHED, extra: { failed: 2 } });
    expect(source.actions(row!)).toEqual({ actions: [], note: null });
    expect(await source.list(query('queue'), viewerOf(operator))).toEqual([]);
  });

  it('shows a stopped run as cancelled and a recent failure in Failed until it ages out', async () => {
    const stopped = makeSource({ enabled: true, running: null, lastRun: lastRun({ outcome: 'stopped' }) });
    expect((await stopped.source.list(query('history'), viewerOf(operator)))[0]?.item).toMatchObject({ status: 'cancelled', reason: 'stopped' });

    const failed = makeSource({ enabled: true, running: null, lastRun: lastRun({ outcome: 'failed' }) });
    expect((await failed.source.list(query('failed'), viewerOf(operator)))[0]?.item).toMatchObject({ status: 'failed', reason: 'error' });
    expect(await failed.source.list(query('history'), viewerOf(operator))).toEqual([]);
    expect(await failed.source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(operator))).toMatchObject({ failed: 1, queue: 0 });

    const aged = { owner: null, cutoffAt: new Date('2026-11-20T00:00:00.000Z') };
    expect(await failed.source.list({ ...query('history'), ...aged }, viewerOf(operator))).toHaveLength(1);
    expect(await failed.source.list({ ...query('failed'), ...aged }, viewerOf(operator))).toEqual([]);
  });

  it('counts a running run once in Queue', async () => {
    const { source } = makeSource(RUNNING);
    expect(await source.counts({ owner: { id: 3, ownerless: true }, cutoffAt: CUTOFF }, viewerOf(operator))).toEqual({
      queue: 1,
      needsYou: 0,
      failed: 0,
      running: 1,
      queued: 0,
      paused: 0,
    });
  });

  it('skips the row once the cursor has passed it', async () => {
    const { source } = makeSource(RUNNING);
    const [row] = await source.list(query('queue'), viewerOf(operator));
    const after = { ...row!.key, typeIndex: 15 };
    expect(await source.list({ ...query('queue'), after }, viewerOf(operator))).toEqual([]);
  });

  it('cancels the running run through the stop that leaves the switch alone', async () => {
    const { source, backfill } = makeSource(RUNNING);
    const id = `run-${Date.parse(RUNNING.running!.startedAt)}`;
    expect(await source.act('cancel', [id], viewerOf(operator))).toEqual([{ id, outcome: 'done', status: null }]);
    expect(backfill.stopRun).toHaveBeenCalledWith(operator);

    backfill.stopRun.mockReturnValue(false);
    expect(await source.act('cancel', [id], viewerOf(operator))).toEqual([{ id, outcome: 'skipped', status: null }]);
  });

  it('skips the finished run, and reads unknown ids and other viewers as missing', async () => {
    const { source, backfill } = makeSource(RUNNING);
    const last = `run-${Date.parse(STARTED)}`;
    expect(await source.act('cancel', [last, 'run-1', 'bogus'], viewerOf(operator))).toEqual([
      { id: last, outcome: 'skipped', status: 'completed' },
      { id: 'run-1', outcome: 'not-found', status: null },
      { id: 'bogus', outcome: 'not-found', status: null },
    ]);
    const id = `run-${Date.parse(RUNNING.running!.startedAt)}`;
    expect(await source.act('cancel', [id], viewerOf(librarian))).toEqual([{ id, outcome: 'not-found', status: null }]);
    expect(backfill.stopRun).not.toHaveBeenCalled();
  });
});
