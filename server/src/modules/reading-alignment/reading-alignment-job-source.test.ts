import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Permission, type JobView } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import type { WhisperAlignmentJobActionRow, WhisperAlignmentJobPageRow } from './reading-alignment-job-page.repository';
import { ReadingAlignmentJobSource, type WhisperAlignmentJobRow } from './reading-alignment-job-source';
import { INTERRUPTED_BUILD_ERROR } from './reading-alignment.repository';

const CREATED = new Date('2026-11-15T10:00:00.000Z');
const UPDATED = new Date('2026-11-15T11:00:00.000Z');
const CUTOFF = new Date('2026-11-08T12:00:00.000Z');

function user(id: number, permissions: Permission[] = [], isSuperuser = false, contentFilters: unknown = null): RequestUser {
  return { id, active: true, isSuperuser, permissions, contentFilters } as unknown as RequestUser;
}

const editor = user(7, [Permission.LibraryEditMetadata]);
const reader = user(8, []);
const superuser = user(1, [], true);

function page(change: Partial<WhisperAlignmentJobPageRow> = {}): WhisperAlignmentJobPageRow {
  return {
    id: 4,
    bookId: 12,
    status: 'building',
    samplesDone: 30,
    samplesTotal: 120,
    error: null,
    createdAt: CREATED,
    updatedAt: UPDATED,
    key: { prefix: [0, 0], suffix: [1], id: 4 },
    ...change,
  };
}

function stored(change: Partial<WhisperAlignmentJobActionRow> = {}): WhisperAlignmentJobActionRow {
  return {
    id: 4,
    bookId: 12,
    audioBookId: 12,
    status: 'building',
    audioContentHash: 'a',
    epubContentHash: 'e',
    whisperModel: 'base.en',
    sampleIntervalSec: 1200,
    clipSeconds: 15,
    ...change,
  };
}

function makeSource(editable: number[] | null = [5]) {
  const registry = new JobSourceRegistry();
  const jobs = {
    pageForJobs: vi.fn((): Promise<WhisperAlignmentJobPageRow[]> => Promise.resolve([])),
    countForJobs: vi.fn(() => Promise.resolve({ queue: 1, needsYou: 0, failed: 2, running: 1, queued: 0, paused: 0 })),
    findActionRows: vi.fn((): Promise<WhisperAlignmentJobActionRow[]> => Promise.resolve([stored()])),
  };
  const statusService = {
    cancelBuild: vi.fn(() => Promise.resolve()),
    requestBuild: vi.fn(() => Promise.resolve({ status: 'failed' })),
    rebuildCouldChange: vi.fn(() => Promise.resolve(false)),
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
  const source = new ReadingAlignmentJobSource(registry, jobs as never, statusService as never, subjects as never, scope as never);
  source.onModuleInit();
  return { source, registry, jobs, statusService, subjects, scope };
}

function viewerOf(who: RequestUser) {
  return { user: who, access: { own: false, all: who.isSuperuser || who.permissions.includes(Permission.LibraryEditMetadata) } };
}

function query(view: JobView, owner: { id: number; ownerless: boolean } | null = null) {
  return { view, owner, cutoffAt: CUTOFF, after: null, typeIndex: 17, limit: 51 };
}

function rowOf(change: Partial<WhisperAlignmentJobPageRow>): WhisperAlignmentJobRow {
  const job = page(change);
  return { nativeId: String(job.id), key: job.key, job, item: {} as never };
}

describe('ReadingAlignmentJobSource', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('registers itself as ownerless work seen by those who may build', () => {
    const { source, registry } = makeSource();
    expect(registry.get('whisper-alignment')).toBe(source);
    expect(source.access(editor)).toEqual({ own: false, all: true });
    expect(source.access(superuser)).toEqual({ own: false, all: true });
    expect(source.access(reader)).toEqual({ own: false, all: false });
  });

  it('reads only the libraries the viewer may edit, and every library for one who sees them all', async () => {
    const limited = makeSource([5, 6]);
    await limited.source.list(query('queue'), viewerOf(editor));
    expect(limited.jobs.pageForJobs).toHaveBeenCalledWith(expect.objectContaining({ libraryIds: [5, 6], contentFilters: null }));
    await limited.source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(editor));
    expect(limited.jobs.countForJobs).toHaveBeenCalledWith({ libraryIds: [5, 6], contentFilters: null }, CUTOFF);

    const all = makeSource(null);
    await all.source.list(query('history'), viewerOf(superuser));
    expect(all.jobs.pageForJobs).toHaveBeenCalledWith(expect.objectContaining({ libraryIds: null }));
  });

  it("applies the viewer's content filter to list, counts and action rows, and none for a superuser", async () => {
    const filters = { excludeTagIds: [4] };
    const filtered = user(9, [Permission.LibraryEditMetadata], false, filters);
    const { source, jobs } = makeSource([5]);
    await source.list(query('failed'), viewerOf(filtered));
    await source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(filtered));
    await source.act('cancel', ['4'], viewerOf(filtered));
    const scope = { libraryIds: [5], contentFilters: filters };
    expect(jobs.pageForJobs).toHaveBeenCalledWith(expect.objectContaining(scope));
    expect(jobs.countForJobs).toHaveBeenCalledWith(scope, CUTOFF);
    expect(jobs.findActionRows).toHaveBeenCalledWith([4], scope);

    const all = makeSource(null);
    const filteredSuperuser = user(1, [], true, filters);
    await all.source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(filteredSuperuser));
    expect(all.jobs.countForJobs).toHaveBeenCalledWith({ libraryIds: null, contentFilters: null }, CUTOFF);
  });

  it('reads nothing for a read of one account without ownerless work, or for a viewer who may not build', async () => {
    const { source, jobs } = makeSource();
    expect(await source.list(query('queue', { id: 7, ownerless: false }), viewerOf(editor))).toEqual([]);
    expect(await source.list(query('queue'), viewerOf(reader))).toEqual([]);
    expect(await source.counts({ owner: null, cutoffAt: CUTOFF }, viewerOf(reader))).toMatchObject({ queue: 0, failed: 0 });
    expect(jobs.pageForJobs).not.toHaveBeenCalled();
    expect(jobs.countForJobs).not.toHaveBeenCalled();
  });

  it('shows a running build with its samples done of total and no requester', async () => {
    const { source, jobs } = makeSource();
    jobs.pageForJobs.mockResolvedValue([page()]);
    const [row] = await source.list(query('queue'), viewerOf(editor));
    expect(row).toMatchObject({ nativeId: '4', item: { status: 'running', done: 30, total: 120, requester: null, finishedAt: null } });
  });

  it('maps finished rows to their status and reason', async () => {
    const { source, jobs } = makeSource();
    jobs.pageForJobs.mockResolvedValue([
      page({ id: 1, status: 'ready' }),
      page({ id: 2, status: 'failed', error: 'whisper exited' }),
      page({ id: 3, status: 'failed', error: INTERRUPTED_BUILD_ERROR }),
      page({ id: 5, status: 'unalignable' }),
    ]);
    const rows = await source.list(query('history'), viewerOf(editor));
    expect(rows.map((row) => [row.item.status, row.item.reason, row.item.finishedAt])).toEqual([
      ['completed', null, UPDATED.toISOString()],
      ['failed', 'error', UPDATED.toISOString()],
      ['failed', 'interrupted', UPDATED.toISOString()],
      ['failed', 'unalignable', UPDATED.toISOString()],
    ]);
  });

  it('names a book only as far as the viewer can reach it', async () => {
    const limited = makeSource([5]);
    await limited.source.describe([rowOf({})], viewerOf(editor));
    expect(limited.subjects.describe).toHaveBeenCalledWith([12], { user: editor, manages: false });

    const all = makeSource(null);
    const subjects = await all.source.describe([rowOf({})], viewerOf(superuser));
    expect(all.subjects.describe).toHaveBeenCalledWith([12], { user: superuser, manages: true });
    expect(subjects.get('4')).toMatchObject({ label: 'Dune' });
  });

  it('offers cancel on a running build and retry on a failed or unalignable one', () => {
    const { source } = makeSource();
    expect(source.actions(rowOf({ status: 'building' }))).toEqual({ actions: ['cancel'], note: null });
    expect(source.actions(rowOf({ status: 'failed' }))).toEqual({ actions: ['retry'], note: null });
    expect(source.actions(rowOf({ status: 'unalignable' }))).toEqual({ actions: ['retry'], note: null });
    expect(source.actions(rowOf({ status: 'ready' }))).toEqual({ actions: [], note: null });
  });

  it("cancels through the cancel route's service call, as the viewer", async () => {
    const { source, statusService, jobs } = makeSource();
    expect(await source.act('cancel', ['4'], viewerOf(editor))).toEqual([{ id: '4', outcome: 'done', status: 'cancelled' }]);
    expect(jobs.findActionRows).toHaveBeenCalledWith([4], { libraryIds: [5], contentFilters: null });
    expect(statusService.cancelBuild).toHaveBeenCalledWith(12, editor);
  });

  it("retries through the build route's service call, and skips when it starts nothing", async () => {
    const { source, statusService, jobs } = makeSource();
    jobs.findActionRows.mockResolvedValue([stored({ status: 'failed' })]);
    expect(await source.act('retry', ['4'], viewerOf(editor))).toEqual([{ id: '4', outcome: 'done', status: null }]);
    expect(statusService.requestBuild).toHaveBeenCalledWith(12, editor, false);

    statusService.requestBuild.mockResolvedValue({ status: 'busy' });
    expect(await source.act('retry', ['4'], viewerOf(editor))).toEqual([{ id: '4', outcome: 'skipped', status: 'failed' }]);
  });

  it('retries an unalignable build only when its files or build settings changed since', async () => {
    const { source, statusService, jobs } = makeSource();
    jobs.findActionRows.mockResolvedValue([stored({ status: 'unalignable', audioBookId: 13 })]);
    expect(await source.act('retry', ['4'], viewerOf(editor))).toEqual([{ id: '4', outcome: 'skipped', status: 'failed' }]);
    expect(statusService.rebuildCouldChange).toHaveBeenCalledWith(
      expect.objectContaining({ textBookId: 12, audioBookId: 13, audioContentHash: 'a' }),
    );
    expect(statusService.requestBuild).not.toHaveBeenCalled();

    statusService.rebuildCouldChange.mockResolvedValue(true);
    expect(await source.act('retry', ['4'], viewerOf(editor))).toEqual([{ id: '4', outcome: 'done', status: null }]);
    expect(statusService.requestBuild).toHaveBeenCalledWith(12, editor, false);
  });

  it('never asks whether a plain failure could change before retrying it', async () => {
    const { source, statusService, jobs } = makeSource();
    jobs.findActionRows.mockResolvedValue([stored({ status: 'failed' })]);
    await source.act('retry', ['4'], viewerOf(editor));
    expect(statusService.rebuildCouldChange).not.toHaveBeenCalled();
  });

  it('skips an action that does not apply to the row', async () => {
    const { source, statusService, jobs } = makeSource();
    jobs.findActionRows.mockResolvedValue([stored({ status: 'ready' })]);
    expect(await source.act('cancel', ['4'], viewerOf(editor))).toEqual([{ id: '4', outcome: 'skipped', status: 'completed' }]);
    expect(statusService.cancelBuild).not.toHaveBeenCalled();
  });

  it('reads a build outside reach, a bad id, or a viewer who may not build as missing', async () => {
    const { source, statusService, jobs } = makeSource();
    jobs.findActionRows.mockResolvedValue([]);
    expect(await source.act('cancel', ['4', 'abc'], viewerOf(editor))).toEqual([
      { id: '4', outcome: 'not-found', status: null },
      { id: 'abc', outcome: 'not-found', status: null },
    ]);
    jobs.findActionRows.mockClear();
    expect(await source.act('cancel', ['4'], viewerOf(reader))).toEqual([{ id: '4', outcome: 'not-found', status: null }]);
    expect(jobs.findActionRows).not.toHaveBeenCalled();
    expect(statusService.cancelBuild).not.toHaveBeenCalled();
  });

  it('turns the service refusals into outcomes', async () => {
    const { source, statusService } = makeSource();
    statusService.cancelBuild.mockRejectedValueOnce(new NotFoundException('This book has no alignment pair'));
    expect(await source.act('cancel', ['4'], viewerOf(editor))).toEqual([{ id: '4', outcome: 'not-found', status: null }]);
    statusService.cancelBuild.mockRejectedValueOnce(new ForbiddenException('No access'));
    expect(await source.act('cancel', ['4'], viewerOf(editor))).toEqual([{ id: '4', outcome: 'refused', status: 'running' }]);
    statusService.cancelBuild.mockRejectedValueOnce(new Error('db down'));
    expect(await source.act('cancel', ['4'], viewerOf(editor))).toEqual([{ id: '4', outcome: 'error', status: 'running' }]);
  });
});
