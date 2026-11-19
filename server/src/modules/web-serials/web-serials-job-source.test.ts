import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Permission, type JobView } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import type { WebSerialJobActionRow, WebSerialJobPageRow } from './web-serials-job-page.repository';
import { WebSerialsJobSource, type WebSerialJobSourceRow } from './web-serials-job-source';

const CREATED = new Date('2026-11-15T10:00:00.000Z');
const FINISHED = new Date('2026-11-15T11:00:00.000Z');

function user(id: number, permissions: Permission[] = [], isSuperuser = false): RequestUser {
  return { id, active: true, isSuperuser, permissions } as unknown as RequestUser;
}

const reader = user(7, [Permission.WebSerialAccess]);
const otherReader = user(8, [Permission.WebSerialAccess]);
const admin = user(2, [Permission.WebSerialAccess, Permission.ManageAppSettings]);
const settingsOnly = user(3, [Permission.ManageAppSettings]);
const superuser = user(1, [], true);

function page(change: Partial<WebSerialJobPageRow> = {}): WebSerialJobPageRow {
  return {
    id: 41,
    userId: reader.id,
    kind: 'manga',
    seriesKey: 'm:123',
    title: 'One Piece',
    author: 'Eiichiro Oda',
    status: 'queued',
    unitsTotal: 0,
    unitsDone: 0,
    unitsFailed: 0,
    unitsSkipped: 0,
    currentUnit: null,
    createdAt: CREATED,
    startedAt: null,
    finishedAt: null,
    updatedAt: CREATED,
    hasCover: true,
    ownerName: 'Sam Whitfield',
    rank: 2,
    ownRank: 2,
    key: { prefix: [1, 2], suffix: [1], id: 41 },
    ...change,
  };
}

function stored(change: Partial<WebSerialJobActionRow> = {}): WebSerialJobActionRow {
  return { id: 41, userId: reader.id, status: 'failed', ...change };
}

function makeSource() {
  const registry = new JobSourceRegistry();
  const jobs = {
    pageForJobs: vi.fn((): Promise<WebSerialJobPageRow[]> => Promise.resolve([])),
    countForJobs: vi.fn(() => Promise.resolve({ queue: 3, needsYou: 0, failed: 1, running: 1, queued: 1, paused: 1 })),
    findActionRows: vi.fn((): Promise<WebSerialJobActionRow[]> => Promise.resolve([stored()])),
  };
  const service = {
    cancelJob: vi.fn(() => Promise.resolve({ status: 'cancelled' })),
    pauseJob: vi.fn(() => Promise.resolve({ status: 'paused' })),
    resumeJob: vi.fn(() => Promise.resolve({ status: 'queued' })),
    retryJob: vi.fn(() => Promise.resolve({ status: 'queued' })),
    moveJobToTop: vi.fn(() => Promise.resolve({ status: 'queued' })),
  };
  const source = new WebSerialsJobSource(registry, jobs as never, service as never);
  source.onModuleInit();
  return { source, registry, jobs, service };
}

const viewerOf = (who: RequestUser, all = false) => ({ user: who, access: { own: true, all } });

function query(view: JobView, owner: { id: number; ownerless: boolean } | null) {
  return { view, owner, cutoffAt: new Date('2026-11-08T12:00:00.000Z'), after: null, typeIndex: 11, limit: 51 };
}

async function listed(change: Partial<WebSerialJobPageRow>) {
  const { source, jobs } = makeSource();
  jobs.pageForJobs.mockResolvedValue([page(change)]);
  const [row] = await source.list(query('queue', null));
  return row!;
}

function rowOf(change: Partial<WebSerialJobPageRow>): WebSerialJobSourceRow {
  const job = page(change);
  return { nativeId: String(job.id), key: job.key, job, item: {} as never };
}

describe('WebSerialsJobSource', () => {
  it('registers itself as the web-serial type', () => {
    const { source, registry } = makeSource();
    expect(registry.get('web-serial')).toBe(source);
  });

  it("lets web serial users see their own downloads and admins everyone's, as the queue's scopes do", () => {
    const { source } = makeSource();
    expect(source.access(reader)).toEqual({ own: true, all: false });
    expect(source.access(admin)).toEqual({ own: true, all: true });
    expect(source.access(superuser)).toEqual({ own: true, all: true });
    expect(source.access(settingsOnly)).toEqual({ own: false, all: false });
    expect(source.access(user(9))).toEqual({ own: false, all: false });
    expect(source.access({ ...reader, active: false } as RequestUser)).toEqual({ own: false, all: false });
  });

  it("reads one account's downloads for an owner filter and every account's only for null", async () => {
    const { source, jobs } = makeSource();
    await source.list(query('queue', { id: reader.id, ownerless: false }));
    expect(jobs.pageForJobs).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'queue', owner: { id: reader.id }, limit: 51 }));
    await source.list(query('history', null));
    expect(jobs.pageForJobs).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'history', owner: null }));
  });

  it('counts through the repository with the same owner rule', async () => {
    const { source, jobs } = makeSource();
    const cutoffAt = new Date('2026-11-08T12:00:00.000Z');
    expect(await source.counts({ owner: { id: reader.id, ownerless: true }, cutoffAt })).toEqual({
      queue: 3,
      needsYou: 0,
      failed: 1,
      running: 1,
      queued: 1,
      paused: 1,
    });
    expect(jobs.countForJobs).toHaveBeenCalledWith({ id: reader.id }, cutoffAt);
    await source.counts({ owner: null, cutoffAt });
    expect(jobs.countForJobs).toHaveBeenLastCalledWith(null, cutoffAt);
  });

  it('maps each stored state, keeping the place in line and the unit counts', async () => {
    expect((await listed({ status: 'queued' })).item).toMatchObject({ status: 'queued', kind: 'manga', position: 2, finishedAt: null });
    expect((await listed({ status: 'importing', rank: 0, unitsTotal: 10, unitsDone: 3, unitsSkipped: 1, startedAt: CREATED })).item).toMatchObject({
      status: 'running',
      phase: 'importing',
      done: 4,
      total: 10,
      position: null,
      startedAt: CREATED.toISOString(),
    });
    expect(
      (
        await listed({
          status: 'running',
          rank: 0,
          currentUnit: { label: 'Ch 4', stage: 'fetching', chaptersDone: 1, chaptersTotal: 2, progress: 0.5 },
        })
      ).item,
    ).toMatchObject({ status: 'running', phase: 'fetching', done: null, total: null });
    expect((await listed({ status: 'paused', rank: 0 })).item).toMatchObject({ status: 'paused', position: null, reason: 'user' });
    expect((await listed({ status: 'completed_with_gaps', rank: 0, finishedAt: FINISHED })).item).toMatchObject({
      status: 'completed',
      reason: 'warnings',
      extra: null,
      finishedAt: FINISHED.toISOString(),
    });
    expect((await listed({ status: 'failed', rank: 0, finishedAt: FINISHED })).item).toMatchObject({ status: 'failed', reason: null });
    expect((await listed({ status: 'cancelled', rank: 0, finishedAt: null, updatedAt: FINISHED })).item).toMatchObject({
      status: 'cancelled',
      finishedAt: FINISHED.toISOString(),
    });
    expect((await listed({})).item.requester).toEqual({ id: reader.id, name: 'Sam Whitfield' });
  });

  it('reports the failed item count for a partially successful download', async () => {
    const { item } = await listed({ status: 'completed_with_gaps', rank: 0, unitsTotal: 5, unitsDone: 3, unitsFailed: 2, finishedAt: FINISHED });
    expect(item).toMatchObject({ status: 'completed', reason: null, done: 5, total: 5, extra: { failed: 2 } });
  });

  it('names the series from the job and links to the queue page', async () => {
    const { source } = makeSource();
    const found = await source.describe([rowOf({}), rowOf({ id: 42, hasCover: false, author: null })]);
    expect(found.get('41')).toEqual({
      label: 'One Piece',
      byline: 'Eiichiro Oda',
      url: '/web-serials?tab=queue',
      image: '/api/v1/web-serials/series/m:123/cover',
    });
    expect(found.get('42')).toMatchObject({ byline: null, image: null });
  });

  it('offers what the queue page offers for each state', () => {
    const { source } = makeSource();
    expect(source.actions(rowOf({ status: 'queued' }), viewerOf(reader)).actions).toEqual(['pause', 'move-to-top', 'cancel']);
    expect(source.actions(rowOf({ status: 'queued', ownRank: 1 }), viewerOf(reader)).actions).toEqual(['pause', 'cancel']);
    expect(source.actions(rowOf({ status: 'queued', ownRank: 1, rank: 3 }), viewerOf(admin, true)).actions).toEqual([
      'pause',
      'prioritize',
      'cancel',
    ]);
    expect(source.actions(rowOf({ status: 'running' }), viewerOf(reader)).actions).toEqual(['pause', 'cancel']);
    expect(source.actions(rowOf({ status: 'paused' }), viewerOf(reader)).actions).toEqual(['resume', 'cancel']);
    expect(source.actions(rowOf({ status: 'failed' }), viewerOf(reader)).actions).toEqual(['retry']);
    expect(source.actions(rowOf({ status: 'completed_with_gaps' }), viewerOf(reader)).actions).toEqual(['retry']);
    expect(source.actions(rowOf({ status: 'completed' }), viewerOf(reader)).actions).toEqual([]);
    expect(source.actions(rowOf({ status: 'failed' }), viewerOf(otherReader)).actions).toEqual([]);
  });

  describe('act', () => {
    it('retries through the queue service as the viewer', async () => {
      const { source, service } = makeSource();
      expect(await source.act('retry', ['41'], viewerOf(reader))).toEqual([{ id: '41', outcome: 'done', status: 'queued' }]);
      expect(service.retryJob).toHaveBeenCalledWith(41, reader);
    });

    it('cancels, pauses and resumes through the matching service methods', async () => {
      const { source, jobs, service } = makeSource();
      jobs.findActionRows.mockResolvedValue([stored({ status: 'running' })]);
      expect(await source.act('cancel', ['41'], viewerOf(reader))).toEqual([{ id: '41', outcome: 'done', status: 'cancelled' }]);
      expect(await source.act('pause', ['41'], viewerOf(reader))).toEqual([{ id: '41', outcome: 'done', status: 'paused' }]);
      jobs.findActionRows.mockResolvedValue([stored({ status: 'paused' })]);
      expect(await source.act('resume', ['41'], viewerOf(reader))).toEqual([{ id: '41', outcome: 'done', status: 'queued' }]);
      expect(service.cancelJob).toHaveBeenCalledWith(41, reader);
      expect(service.pauseJob).toHaveBeenCalledWith(41, reader);
      expect(service.resumeJob).toHaveBeenCalledWith(41, reader);
    });

    it('moves a queued job up only with the move its viewer may make', async () => {
      const { source, jobs, service } = makeSource();
      jobs.findActionRows.mockResolvedValue([stored({ status: 'queued' })]);
      expect((await source.act('move-to-top', ['41'], viewerOf(reader)))[0]).toMatchObject({ outcome: 'done' });
      expect((await source.act('prioritize', ['41'], viewerOf(reader)))[0]).toMatchObject({ outcome: 'skipped' });
      expect((await source.act('prioritize', ['41'], viewerOf(admin, true)))[0]).toMatchObject({ outcome: 'done' });
      expect(service.moveJobToTop).toHaveBeenCalledTimes(2);
    });

    it("answers not-found for someone else's download and for ids that are not jobs, without calling the service", async () => {
      const { source, jobs, service } = makeSource();
      expect(await source.act('retry', ['41', 'nope', '0'], viewerOf(otherReader))).toEqual([
        { id: '41', outcome: 'not-found', status: null },
        { id: 'nope', outcome: 'not-found', status: null },
        { id: '0', outcome: 'not-found', status: null },
      ]);
      expect(jobs.findActionRows).toHaveBeenCalledWith([41]);
      expect(service.retryJob).not.toHaveBeenCalled();
    });

    it("lets an admin act on someone else's download", async () => {
      const { source, service } = makeSource();
      expect((await source.act('retry', ['41'], viewerOf(admin, true)))[0]).toMatchObject({ outcome: 'done' });
      expect(service.retryJob).toHaveBeenCalledWith(41, admin);
    });

    it('skips an action that does not apply to the current state', async () => {
      const { source, service } = makeSource();
      expect(await source.act('pause', ['41'], viewerOf(reader))).toEqual([{ id: '41', outcome: 'skipped', status: 'failed' }]);
      expect(await source.act('dismiss', ['41'], viewerOf(reader))).toEqual([{ id: '41', outcome: 'skipped', status: 'failed' }]);
      expect(service.pauseJob).not.toHaveBeenCalled();
    });

    it("turns the service's refusals into outcomes", async () => {
      const { source, service } = makeSource();
      service.retryJob.mockRejectedValueOnce(new NotFoundException());
      expect((await source.act('retry', ['41'], viewerOf(reader)))[0]).toEqual({ id: '41', outcome: 'not-found', status: null });
      service.retryJob.mockRejectedValueOnce(new ForbiddenException());
      expect((await source.act('retry', ['41'], viewerOf(reader)))[0]).toMatchObject({ outcome: 'refused' });
      service.retryJob.mockRejectedValueOnce(new BadRequestException('too many'));
      expect((await source.act('retry', ['41'], viewerOf(reader)))[0]).toMatchObject({ outcome: 'refused' });
      service.retryJob.mockRejectedValueOnce(new ConflictException('not retryable'));
      expect((await source.act('retry', ['41'], viewerOf(reader)))[0]).toMatchObject({ outcome: 'skipped', status: 'failed' });
      service.retryJob.mockRejectedValueOnce(new Error('database is down'));
      expect((await source.act('retry', ['41'], viewerOf(reader)))[0]).toMatchObject({ outcome: 'error' });
    });

    it('logs a failed action with the viewer, duration, error class and a sanitized message', async () => {
      const { source, service } = makeSource();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      service.retryJob.mockRejectedValueOnce(new TypeError('bad "quote"'));
      await source.act('retry', ['41'], viewerOf(reader));
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[web_serials\.jobs_action\] \[fail\] jobId=41 userId=7 action=retry durationMs=\d+ errorClass=TypeError error="bad \\"quote\\"" - /,
        ),
      );
      warn.mockRestore();
    });
  });
});
