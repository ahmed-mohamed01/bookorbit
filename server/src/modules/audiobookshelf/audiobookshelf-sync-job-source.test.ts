import { Logger } from '@nestjs/common';
import { Permission, type JobView } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import { AudiobookshelfSyncJobSource } from './audiobookshelf-sync-job-source';
import type { AudiobookshelfActiveSync } from './audiobookshelf-sync.service';

const CUTOFF = new Date('2026-11-08T12:00:00.000Z');
const SYNCED = new Date('2026-11-15T10:00:00.000Z');
const FAILED = new Date('2026-11-15T11:00:00.000Z');

function user(id: number, permissions: Permission[] = [], isSuperuser = false): RequestUser {
  return { id, name: `User ${id}`, active: true, isSuperuser, permissions } as unknown as RequestUser;
}

const listener = user(7, [Permission.AudiobookshelfSync]);
const operator = user(3, [Permission.ManageAppSettings]);
const superuser = user(1, [], true);

function settings(change: Record<string, unknown> = {}) {
  return {
    enabled: true,
    serverUrl: 'http://abs.local',
    apiToken: 'token',
    lastRunFinishedAt: SYNCED,
    lastRunKind: 'poll',
    lastRunError: null,
    ...change,
  };
}

function makeSource(stored: ReturnType<typeof settings> | null = settings(), active: AudiobookshelfActiveSync | null = null) {
  const registry = new JobSourceRegistry();
  const repo = {
    findSettings: vi.fn<(userId: number) => Promise<ReturnType<typeof settings> | undefined>>(() => Promise.resolve(stored ?? undefined)),
  };
  const sync = { activeRun: vi.fn(() => active), sync: vi.fn(() => Promise.resolve({})) };
  const coordinator = { isSyncRunning: vi.fn(() => false) };
  const source = new AudiobookshelfSyncJobSource(registry, repo as never, sync as never, coordinator as never);
  source.onModuleInit();
  return { source, registry, repo, sync, coordinator };
}

function viewerOf(who: RequestUser) {
  return { user: who, access: { own: who.isSuperuser || who.permissions.includes(Permission.AudiobookshelfSync), all: false } };
}

function query(view: JobView, owner: { id: number; ownerless: boolean } | null) {
  return { view, owner, cutoffAt: CUTOFF, after: null, typeIndex: 16, limit: 51 };
}

describe('AudiobookshelfSyncJobSource', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('registers itself and shows each account only its own sync, never everyone else', () => {
    const { source, registry } = makeSource();
    expect(registry.get('audiobookshelf-sync')).toBe(source);
    expect(source.access(listener)).toEqual({ own: true, all: false });
    expect(source.access(superuser)).toEqual({ own: true, all: false });
    expect(source.access(operator)).toEqual({ own: false, all: false });
  });

  it("reads only the viewer's own settings row, whatever owner the read names", async () => {
    const { source, repo } = makeSource(settings(), { kind: 'poll', startedAt: SYNCED });
    expect(await source.list(query('queue', { id: 99, ownerless: false }), viewerOf(listener))).toEqual([]);
    expect(await source.list(query('queue', { id: 7, ownerless: false }), viewerOf(listener))).toHaveLength(1);
    expect(await source.list(query('queue', null), viewerOf(listener))).toHaveLength(1);
    expect(repo.findSettings.mock.calls.every(([id]) => id === 7)).toBe(true);
    expect(await source.list(query('queue', { id: 3, ownerless: false }), viewerOf(operator))).toEqual([]);
  });

  it('shows the running sync in Queue with its kind and its owner', async () => {
    const { source } = makeSource(settings(), { kind: 'full', startedAt: SYNCED });
    const [row] = await source.list(query('queue', { id: 7, ownerless: false }), viewerOf(listener));
    expect(row).toMatchObject({
      nativeId: 'running',
      item: { status: 'running', kind: 'full', requester: { id: 7, name: 'User 7' }, startedAt: SYNCED.toISOString() },
    });
    expect(source.actions(row!)).toEqual({ actions: [], note: null });
  });

  it('puts the last successful sync in History', async () => {
    const { source } = makeSource();
    const [row] = await source.list(query('history', { id: 7, ownerless: false }), viewerOf(listener));
    expect(row?.item).toMatchObject({ status: 'completed', finishedAt: SYNCED.toISOString() });
    expect(await source.list(query('failed', { id: 7, ownerless: false }), viewerOf(listener))).toEqual([]);
    expect(await source.list(query('queue', { id: 7, ownerless: false }), viewerOf(listener))).toEqual([]);
  });

  it('shows a recent failure in Failed with a retry, and a failure with sync off without one', async () => {
    const failing = makeSource(settings({ lastRunError: 'offline', lastRunFinishedAt: FAILED }));
    const [row] = await failing.source.list(query('failed', { id: 7, ownerless: false }), viewerOf(listener));
    expect(row?.item).toMatchObject({ status: 'failed', reason: 'error', finishedAt: FAILED.toISOString() });
    expect(failing.source.actions(row!)).toEqual({ actions: ['retry'], note: null });
    expect(await failing.source.counts({ owner: { id: 7, ownerless: false }, cutoffAt: CUTOFF }, viewerOf(listener))).toMatchObject({
      failed: 1,
      queue: 0,
    });

    const off = makeSource(settings({ enabled: false, lastRunError: 'unauthorized', lastRunFinishedAt: FAILED }));
    const [offRow] = await off.source.list(query('failed', { id: 7, ownerless: false }), viewerOf(listener));
    expect(offRow?.item.reason).toBe('sync-off');
    expect(off.source.actions(offRow!)).toEqual({ actions: [], note: null });
  });

  it('moves a failure older than the window into History', async () => {
    const { source } = makeSource(settings({ lastRunError: 'offline', lastRunFinishedAt: FAILED }));
    const aged = { cutoffAt: new Date('2026-11-20T00:00:00.000Z') };
    expect(await source.list({ ...query('failed', { id: 7, ownerless: false }), ...aged }, viewerOf(listener))).toEqual([]);
    expect(await source.list({ ...query('history', { id: 7, ownerless: false }), ...aged }, viewerOf(listener))).toHaveLength(1);
  });

  it('keeps a failed run in Failed at the same time and key whatever the hot tier and settings writes do', async () => {
    const stored = settings({ lastRunKind: 'full', lastRunError: 'offline', lastRunFinishedAt: FAILED });
    const { source } = makeSource(stored);
    const [before] = await source.list(query('failed', { id: 7, ownerless: false }), viewerOf(listener));

    Object.assign(stored, {
      lastSyncedAt: new Date('2026-11-15T11:00:30.000Z'),
      lastSyncError: null,
      updatedAt: new Date('2026-11-15T11:05:00.000Z'),
    });
    const [after] = await source.list(query('failed', { id: 7, ownerless: false }), viewerOf(listener));

    expect(after).toEqual(before);
    expect(after?.item).toMatchObject({ status: 'failed', kind: 'full', finishedAt: FAILED.toISOString() });
    expect(source.actions(after!)).toEqual({ actions: ['retry'], note: null });
    expect(await source.list(query('history', { id: 7, ownerless: false }), viewerOf(listener))).toEqual([]);
    expect(await source.counts({ owner: { id: 7, ownerless: false }, cutoffAt: CUTOFF }, viewerOf(listener))).toMatchObject({ failed: 1 });
  });

  it('moves the row to History once a later full, reconcile or poll run succeeds', async () => {
    const stored = settings({ lastRunError: 'offline', lastRunFinishedAt: FAILED });
    const { source } = makeSource(stored);
    const later = new Date('2026-11-15T11:15:00.000Z');
    Object.assign(stored, { lastRunError: null, lastRunFinishedAt: later, lastRunKind: 'reconcile' });

    expect(await source.list(query('failed', { id: 7, ownerless: false }), viewerOf(listener))).toEqual([]);
    const [row] = await source.list(query('history', { id: 7, ownerless: false }), viewerOf(listener));
    expect(row?.item).toMatchObject({ status: 'completed', kind: 'reconcile', finishedAt: later.toISOString() });
    expect(await source.counts({ owner: { id: 7, ownerless: false }, cutoffAt: CUTOFF }, viewerOf(listener))).toMatchObject({ failed: 0 });
  });

  it('gives the last row a key that holds between pages, so the next page neither repeats nor skips it', async () => {
    const stored = settings();
    const { source } = makeSource(stored);
    const [first] = await source.list(query('history', { id: 7, ownerless: false }), viewerOf(listener));
    Object.assign(stored, { lastSyncedAt: new Date('2026-11-15T10:00:30.000Z'), updatedAt: new Date('2026-11-15T10:01:00.000Z') });
    const [again] = await source.list(query('history', { id: 7, ownerless: false }), viewerOf(listener));
    expect(again?.key).toEqual(first?.key);

    const after = { ...first!.key, typeIndex: 16 };
    expect(await source.list({ ...query('history', { id: 7, ownerless: false }), after }, viewerOf(listener))).toEqual([]);
  });

  it('shows no last row before any full, reconcile or poll run has recorded its end', async () => {
    const { source } = makeSource(settings({ lastRunFinishedAt: null, lastRunKind: null }));
    expect(await source.list(query('history', { id: 7, ownerless: false }), viewerOf(listener))).toEqual([]);
    expect(await source.list(query('failed', { id: 7, ownerless: false }), viewerOf(listener))).toEqual([]);
  });

  it('has no rows for an account that never set sync up', async () => {
    const { source } = makeSource(null);
    expect(await source.list(query('history', { id: 7, ownerless: false }), viewerOf(listener))).toEqual([]);
    expect(await source.counts({ owner: { id: 7, ownerless: false }, cutoffAt: CUTOFF }, viewerOf(listener))).toMatchObject({ queue: 0, failed: 0 });
  });

  it("retries a failed sync for the viewer's own account in the background", async () => {
    const { source, sync } = makeSource(settings({ lastRunError: 'offline', lastRunFinishedAt: FAILED }));
    expect(await source.act('retry', ['last'], viewerOf(listener))).toEqual([{ id: 'last', outcome: 'done', status: 'running' }]);
    expect(sync.sync).toHaveBeenCalledWith(listener);
  });

  it('skips a retry while a sync runs, when sync is off, or when the last sync did not fail', async () => {
    const running = makeSource(settings({ lastRunError: 'offline', lastRunFinishedAt: FAILED }));
    running.coordinator.isSyncRunning.mockReturnValue(true);
    expect(await running.source.act('retry', ['last'], viewerOf(listener))).toEqual([{ id: 'last', outcome: 'skipped', status: 'failed' }]);

    const off = makeSource(settings({ enabled: false, lastRunError: 'unauthorized', lastRunFinishedAt: FAILED }));
    expect(await off.source.act('retry', ['last'], viewerOf(listener))).toEqual([{ id: 'last', outcome: 'skipped', status: 'failed' }]);

    const fine = makeSource();
    expect(await fine.source.act('retry', ['last'], viewerOf(listener))).toEqual([{ id: 'last', outcome: 'skipped', status: 'completed' }]);
    for (const made of [running, off, fine]) expect(made.sync.sync).not.toHaveBeenCalled();
  });

  it('reads unknown ids, a missing run and a viewer without the permission as missing', async () => {
    const { source, sync, repo } = makeSource(settings({ lastRunError: 'offline', lastRunFinishedAt: FAILED }));
    expect(await source.act('cancel', ['running', 'other'], viewerOf(listener))).toEqual([
      { id: 'running', outcome: 'not-found', status: null },
      { id: 'other', outcome: 'not-found', status: null },
    ]);
    repo.findSettings.mockClear();
    expect(await source.act('retry', ['last'], viewerOf(operator))).toEqual([{ id: 'last', outcome: 'not-found', status: null }]);
    expect(repo.findSettings).not.toHaveBeenCalled();
    expect(sync.sync).not.toHaveBeenCalled();
  });
});
