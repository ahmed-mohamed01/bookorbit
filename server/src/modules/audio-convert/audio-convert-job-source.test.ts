import { ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Permission, type JobView } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import type { AudioConvertJobActionRow, AudioConvertJobPageRow } from './audio-convert-job-page.repository';
import { AudioConvertJobSource, type AudioConvertJobSourceRow } from './audio-convert-job-source';

const JOB_ID = '3f2a7c1e-0b5d-4e8a-9c3f-1d2e3f4a5b6c';
const CREATED = new Date('2026-11-15T10:00:00.000Z');
const FINISHED = new Date('2026-11-15T11:00:00.000Z');
const CUTOFF = new Date('2026-11-08T12:00:00.000Z');

function user(id: number, permissions: Permission[] = [], isSuperuser = false): RequestUser {
  return { id, active: true, isSuperuser, permissions } as unknown as RequestUser;
}

const librarian = user(7, [Permission.ManageLibraries]);
const operator = user(3, [Permission.ManageAppSettings]);
const superuser = user(1, [], true);

function page(change: Partial<AudioConvertJobPageRow> = {}): AudioConvertJobPageRow {
  return {
    id: JOB_ID,
    bookId: 12,
    libraryId: 5,
    userId: librarian.id,
    trigger: 'manual',
    status: 'queued',
    stage: 'ready',
    progress: null,
    errorCode: null,
    createdAt: CREATED,
    startedAt: null,
    finishedAt: null,
    ownerName: 'Sam Whitfield',
    rank: 2,
    key: { prefix: [1, 2], suffix: [1], id: JOB_ID },
    ...change,
  };
}

function stored(change: Partial<AudioConvertJobActionRow> = {}): AudioConvertJobActionRow {
  return { id: JOB_ID, bookId: 12, libraryId: 5, userId: librarian.id, status: 'queued', stage: 'ready', ...change };
}

function makeSource(editable: number[] | null = [5]) {
  const registry = new JobSourceRegistry();
  const jobs = {
    pageForJobs: vi.fn((): Promise<AudioConvertJobPageRow[]> => Promise.resolve([])),
    countForJobs: vi.fn(() => Promise.resolve({ queue: 3, needsYou: 0, failed: 1, running: 1, queued: 1, paused: 1 })),
    findActionRows: vi.fn((): Promise<AudioConvertJobActionRow[]> => Promise.resolve([stored()])),
  };
  const service = {
    stopBook: vi.fn(() => Promise.resolve({ cancelled: true })),
    convertNow: vi.fn(() => Promise.resolve({})),
  };
  const subjects = {
    describe: vi.fn(() =>
      Promise.resolve(new Map([[12, { label: 'Dune', byline: 'Frank Herbert', url: '/book/12', image: '/api/v1/books/12/thumbnail' }]])),
    ),
  };
  const scope = {
    seesAllLibraries: vi.fn(() => editable === null),
    editableIds: vi.fn(() => Promise.resolve(editable ?? [])),
  };
  const source = new AudioConvertJobSource(registry, jobs as never, service as never, subjects as never, scope as never);
  source.onModuleInit();
  return { source, registry, jobs, service, subjects, scope };
}

const viewerOf = (who: RequestUser) => ({ user: who, access: { own: true, all: true } });

function query(view: JobView, owner: { id: number; ownerless: boolean } | null) {
  return { view, owner, cutoffAt: CUTOFF, after: null, typeIndex: 12, limit: 51 };
}

async function listed(change: Partial<AudioConvertJobPageRow>) {
  const { source, jobs } = makeSource();
  jobs.pageForJobs.mockResolvedValue([page(change)]);
  const [row] = await source.list(query('queue', null), viewerOf(librarian));
  return row!;
}

function rowOf(change: Partial<AudioConvertJobPageRow>): AudioConvertJobSourceRow {
  const job = page(change);
  return { nativeId: job.id, key: job.key, job, item: {} as never };
}

describe('AudioConvertJobSource', () => {
  it('registers itself as the audio-convert type', () => {
    const { source, registry } = makeSource();
    expect(registry.get('audio-convert')).toBe(source);
  });

  it('shows the jobs to whoever may use the tool, which is whoever manages libraries', () => {
    const { source } = makeSource();
    expect(source.access(librarian)).toEqual({ own: true, all: true });
    expect(source.access(superuser)).toEqual({ own: true, all: true });
    expect(source.access(operator)).toEqual({ own: false, all: false });
    expect(source.access(user(9, [Permission.LibraryEditMetadata]))).toEqual({ own: false, all: false });
    expect(source.access({ ...librarian, active: false } as RequestUser)).toEqual({ own: false, all: false });
  });

  it('keeps every read to the libraries the viewer may edit, and to every library only for one who sees them all', async () => {
    const limited = makeSource([5, 6]);
    await limited.source.list(query('queue', { id: librarian.id, ownerless: true }), viewerOf(librarian));
    expect(limited.jobs.pageForJobs).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'queue', owner: { id: librarian.id, ownerless: true }, libraryIds: [5, 6], limit: 51 }),
    );
    expect(limited.scope.editableIds).toHaveBeenCalledWith(librarian);

    const everything = makeSource(null);
    await everything.source.list(query('history', null), viewerOf(superuser));
    expect(everything.jobs.pageForJobs).toHaveBeenCalledWith(expect.objectContaining({ view: 'history', owner: null, libraryIds: null }));
    expect(everything.scope.editableIds).not.toHaveBeenCalled();
  });

  it('counts with the same owner and library rule; the sidebar asks for the viewer alone', async () => {
    const { source, jobs } = makeSource([5]);
    expect(await source.counts({ owner: { id: librarian.id, ownerless: false }, cutoffAt: CUTOFF }, viewerOf(librarian))).toMatchObject({
      queue: 3,
      paused: 1,
    });
    expect(jobs.countForJobs).toHaveBeenCalledWith({ owner: { id: librarian.id, ownerless: false }, libraryIds: [5] }, CUTOFF);
  });

  it('maps each stored state', async () => {
    expect((await listed({ status: 'queued' })).item).toMatchObject({ status: 'queued', kind: 'manual', position: 2, reason: null });
    expect((await listed({ status: 'running', stage: 'converting', progress: 40, rank: 0, startedAt: CREATED })).item).toMatchObject({
      status: 'running',
      phase: 'converting',
      percent: 40,
      position: null,
      startedAt: CREATED.toISOString(),
    });
    expect((await listed({ status: 'waiting', stage: 'chapters', trigger: 'auto', rank: 0 })).item).toMatchObject({
      status: 'paused',
      reason: 'chapters',
      kind: 'auto',
    });
    expect((await listed({ status: 'success', rank: 0, finishedAt: FINISHED })).item).toMatchObject({
      status: 'completed',
      finishedAt: FINISHED.toISOString(),
    });
    expect((await listed({ status: 'failed', rank: 0, errorCode: 'ffmpeg_failed', finishedAt: FINISHED })).item).toMatchObject({
      status: 'failed',
      reason: 'ffmpeg_failed',
    });
    expect((await listed({ status: 'skipped', rank: 0, errorCode: null, finishedAt: FINISHED })).item).toMatchObject({
      status: 'cancelled',
      reason: 'skipped',
    });
    expect((await listed({ status: 'cancelled', rank: 0, finishedAt: FINISHED })).item).toMatchObject({ status: 'cancelled', reason: null });
    expect((await listed({ userId: null, ownerName: null })).item.requester).toBeNull();
    expect((await listed({ trigger: 'manual' })).item.requester).toEqual({ id: librarian.id, name: 'Sam Whitfield' });
  });

  it("shows an automatic job as nobody's, not as the admin who last saved the settings", async () => {
    expect((await listed({ trigger: 'auto', userId: operator.id, ownerName: 'Ops' })).item.requester).toBeNull();
  });

  it('names the book the way other book jobs do', async () => {
    const { source, subjects } = makeSource(null);
    const found = await source.describe([rowOf({})], viewerOf(superuser));
    expect(subjects.describe).toHaveBeenCalledWith([12], { user: superuser, manages: true });
    expect(found.get(JOB_ID)).toMatchObject({ label: 'Dune', url: '/book/12' });
  });

  it('checks a book is still reachable for a viewer who does not see every library', async () => {
    const { source, subjects } = makeSource([5]);
    await source.describe([rowOf({})], viewerOf(librarian));
    expect(subjects.describe).toHaveBeenCalledWith([12], { user: librarian, manages: false });
  });

  it('offers Stop while a job can still stop, and Convert now on a waiting book', () => {
    const { source } = makeSource();
    expect(source.actions(rowOf({ status: 'queued' })).actions).toEqual(['cancel']);
    expect(source.actions(rowOf({ status: 'running', stage: 'converting' })).actions).toEqual(['cancel']);
    expect(source.actions(rowOf({ status: 'running', stage: 'swapping' })).actions).toEqual([]);
    expect(source.actions(rowOf({ status: 'waiting', stage: 'metadata' })).actions).toEqual(['resume', 'cancel']);
    expect(source.actions(rowOf({ status: 'success' })).actions).toEqual([]);
  });

  describe('act', () => {
    it("cancels through the book's Stop, as the viewer", async () => {
      const { source, service } = makeSource();
      expect(await source.act('cancel', [JOB_ID], viewerOf(librarian))).toEqual([{ id: JOB_ID, outcome: 'done', status: 'cancelled' }]);
      expect(service.stopBook).toHaveBeenCalledWith(12, librarian);
    });

    it('leaves a running conversion to write its own end state', async () => {
      const { source, jobs } = makeSource();
      jobs.findActionRows.mockResolvedValue([stored({ status: 'running', stage: 'converting' })]);
      expect(await source.act('cancel', [JOB_ID], viewerOf(librarian))).toEqual([{ id: JOB_ID, outcome: 'done', status: null }]);
    });

    it('converts a waiting book now', async () => {
      const { source, jobs, service } = makeSource();
      jobs.findActionRows.mockResolvedValue([stored({ status: 'waiting', stage: 'metadata' })]);
      expect(await source.act('resume', [JOB_ID], viewerOf(librarian))).toEqual([{ id: JOB_ID, outcome: 'done', status: 'queued' }]);
      expect(service.convertNow).toHaveBeenCalledWith(JOB_ID, librarian);
    });

    it('reads jobs only in the libraries the viewer may edit, and answers not-found for the rest', async () => {
      const { source, jobs, service } = makeSource([6]);
      jobs.findActionRows.mockResolvedValue([]);
      expect(await source.act('cancel', [JOB_ID, 'nope'], viewerOf(librarian))).toEqual([
        { id: JOB_ID, outcome: 'not-found', status: null },
        { id: 'nope', outcome: 'not-found', status: null },
      ]);
      expect(jobs.findActionRows).toHaveBeenCalledWith([JOB_ID], [6]);
      expect(service.stopBook).not.toHaveBeenCalled();
    });

    it('reads nothing for a viewer without access to the type', async () => {
      const { source, jobs } = makeSource();
      expect(await source.act('cancel', [JOB_ID], { user: operator, access: { own: false, all: false } })).toEqual([
        { id: JOB_ID, outcome: 'not-found', status: null },
      ]);
      expect(jobs.findActionRows).not.toHaveBeenCalled();
    });

    it('skips what does not apply and turns refusals into outcomes', async () => {
      const { source, jobs, service } = makeSource();
      expect(await source.act('resume', [JOB_ID], viewerOf(librarian))).toEqual([{ id: JOB_ID, outcome: 'skipped', status: 'queued' }]);
      jobs.findActionRows.mockResolvedValue([stored({ status: 'running', stage: 'swapping' })]);
      expect((await source.act('cancel', [JOB_ID], viewerOf(librarian)))[0]).toMatchObject({ outcome: 'skipped', status: 'running' });
      jobs.findActionRows.mockResolvedValue([stored()]);
      service.stopBook.mockResolvedValueOnce({ cancelled: false });
      expect((await source.act('cancel', [JOB_ID], viewerOf(librarian)))[0]).toMatchObject({ outcome: 'skipped' });
      service.stopBook.mockRejectedValueOnce(new ForbiddenException());
      expect((await source.act('cancel', [JOB_ID], viewerOf(librarian)))[0]).toMatchObject({ outcome: 'refused' });
      service.stopBook.mockRejectedValueOnce(new NotFoundException());
      expect((await source.act('cancel', [JOB_ID], viewerOf(librarian)))[0]).toEqual({ id: JOB_ID, outcome: 'not-found', status: null });
      jobs.findActionRows.mockResolvedValue([stored({ status: 'waiting', stage: 'chapters' })]);
      service.convertNow.mockRejectedValueOnce(new ConflictException('lookup running'));
      expect((await source.act('resume', [JOB_ID], viewerOf(librarian)))[0]).toMatchObject({ outcome: 'skipped' });
      service.convertNow.mockRejectedValueOnce(new Error('database is down'));
      expect((await source.act('resume', [JOB_ID], viewerOf(librarian)))[0]).toMatchObject({ outcome: 'error' });
    });

    it('logs a failed action with the viewer, duration, error class and a sanitized message', async () => {
      const { source, jobs, service } = makeSource();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jobs.findActionRows.mockResolvedValue([stored({ status: 'waiting', stage: 'chapters' })]);
      service.convertNow.mockRejectedValueOnce(new TypeError('bad "quote"'));
      await source.act('resume', [JOB_ID], viewerOf(librarian));
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[audio_convert\.jobs_action\] \[fail\] jobId=\S+ bookId=12 userId=7 action=resume durationMs=\d+ errorClass=TypeError error="bad \\"quote\\"" - /,
        ),
      );
      warn.mockRestore();
    });
  });
});
