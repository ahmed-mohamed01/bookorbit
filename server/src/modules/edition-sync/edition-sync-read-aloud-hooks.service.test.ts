import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import type { EditionSyncProvenance, ReadAloudWorkerRequest } from '@bookorbit/types';
import type { ReadAloudJobRow } from '../../db/schema';
import { ReadAloudWorkerClientService } from '../read-aloud/read-aloud-worker-client.service';
import { ReadAloudWorkspace } from '../read-aloud/read-aloud-workspace.service';
import { EditionSyncIndexStoreService } from './edition-sync-index-store.service';
import { EditionSyncReadAloudHooksService } from './edition-sync-read-aloud-hooks.service';
import { EditionSyncRepository } from './edition-sync.repository';
import { provenanceFile } from './edition-sync-provenance';
import type { EditionSyncBookFileRef } from './edition-sync.types';

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof import('node:fs/promises')>()), stat: vi.fn() }));

describe('EditionSyncReadAloudHooksService', () => {
  let service: EditionSyncReadAloudHooksService;
  const file = (id: number): EditionSyncBookFileRef => ({
    id,
    bookId: 7,
    absolutePath: `/books/${id}`,
    format: id === 1 ? 'epub' : 'mp3',
    role: 'content',
    sizeBytes: 10,
    fileHash: 'hash',
    mtime: new Date(0),
    durationSeconds: null,
    mediaOverlayAvailable: false,
  });
  const files = [file(1), file(2)];
  const provenance = {
    bookId: 7,
    epub: provenanceFile(files[0]!),
    audio: [{ ...provenanceFile(files[1]!), order: 0 }],
    language: 'en',
    granularity: 'sentence',
    model: 'quartznet15x5',
    decisions: { chapters: {}, audio: [] },
    chunks: [{ name: '00001.mp3', size: 5, sha256: 'a'.repeat(64) }],
    audioEntries: [{ href: 'OPS/audio.mp3', chunk: '00001.mp3', size: 5 }],
  } as unknown as EditionSyncProvenance;
  const job = { id: 'job-id', bookId: 7, decisions: { chapters: {}, audio: [] } } as unknown as ReadAloudJobRow;
  const request = {
    epubPath: '/books/1',
    audioPaths: ['/books/2'],
    workDir: '/work/job-id',
    language: 'en',
    granularity: 'sentence',
    model: 'quartznet15x5',
    decisions: { chapters: {}, audio: [] },
  } as unknown as ReadAloudWorkerRequest;
  const repo = {
    findIndexRow: vi.fn(),
    findBookFilesByIds: vi.fn(),
    findIndexRowByWorkerJobId: vi.fn(),
    findWorkerJobIdsKeepingWork: vi.fn(),
    upsertIndexRow: vi.fn(),
    findExpiredWorkerJobIds: vi.fn(),
    clearWorkerJobIds: vi.fn(),
  };
  const store = { capture: vi.fn(), verifyProvenance: vi.fn(), copyIndex: vi.fn(), resolveCaptureSources: vi.fn(), removeSupersededIndex: vi.fn() };
  const workspace = { ensure: vi.fn(), remove: vi.fn() };
  const worker = { healthState: vi.fn() };
  beforeEach(async () => {
    vi.resetAllMocks();
    repo.findIndexRow.mockResolvedValue({ status: 'ready', provenance });
    repo.findBookFilesByIds.mockResolvedValue(files);
    store.resolveCaptureSources.mockResolvedValue({ epub: files[0], audio: [files[1]] });
    store.verifyProvenance.mockResolvedValue({ valid: true });
    worker.healthState.mockResolvedValue({ state: 'ok', health: { version: 'test' } });
    vi.mocked(stat).mockResolvedValue({ size: 10, mtimeMs: 0 } as Awaited<ReturnType<typeof stat>>);
    const module = await Test.createTestingModule({
      providers: [
        EditionSyncReadAloudHooksService,
        { provide: EditionSyncRepository, useValue: repo },
        { provide: EditionSyncIndexStoreService, useValue: store },
        { provide: ReadAloudWorkspace, useValue: workspace },
        { provide: ReadAloudWorkerClientService, useValue: worker },
      ],
    }).compile();
    service = module.get(EditionSyncReadAloudHooksService);
  });
  it('uses full alignment when a fingerprinted index meets a worker without metadata replay', async () => {
    repo.findIndexRow.mockResolvedValue({
      status: 'ready',
      provenance: { ...provenance, epub: { ...provenance.epub, chapterFingerprint: 'b'.repeat(64) } },
    });
    expect(await service.prepareRequest(job, request)).toBe(request);
    expect(store.copyIndex).not.toHaveBeenCalled();
  });

  it('passes the source chapter fingerprint only to a worker advertising metadata replay', async () => {
    repo.findIndexRow.mockResolvedValue({
      status: 'ready',
      provenance: { ...provenance, epub: { ...provenance.epub, chapterFingerprint: 'b'.repeat(64) } },
    });
    worker.healthState.mockResolvedValue({ state: 'ok', health: { version: 'test', rebuildMetadata: true } });
    expect(await service.prepareRequest(job, request)).toMatchObject({ rebuild: { chapterFingerprint: 'b'.repeat(64) } });
  });

  it('copies a matching index and extends only the worker request', async () => {
    expect(await service.prepareRequest(job, request)).toEqual({
      ...request,
      rebuild: {
        indexEntry: 'index.epub',
        reportEntry: 'bookorbit-timings/report.json',
        chunks: provenance.chunks,
        sourceEntries: [],
        audioEntries: [{ href: 'OPS/audio.mp3', chunk: '00001.mp3' }],
      },
    });
    expect(store.copyIndex).toHaveBeenCalledWith(7, '/work/job-id/index.epub');
  });
  it('marks ready against the time sources started being snapshotted', async () => {
    const before = Date.now();
    store.capture.mockResolvedValue({ indexPath: '/new', indexBytes: 10, provenance: { report: {}, workerVersion: 'test' } });
    await service.prepareRequest(job, request);
    const after = Date.now();
    await service.onOutputValidated(job, request);
    const since = repo.upsertIndexRow.mock.calls[0][2] as Date;
    expect(since).toBeInstanceOf(Date);
    expect(since.getTime()).toBeGreaterThanOrEqual(before);
    expect(since.getTime()).toBeLessThanOrEqual(after);
  });
  it('passes source entries to the worker', async () => {
    const sourceEntries = [{ href: 'OPS/image.png', size: 5, crc32: 123 }];
    repo.findIndexRow.mockResolvedValue({ status: 'ready', indexPath: '/index', provenance: { ...provenance, sourceEntries } });
    expect(await service.prepareRequest(job, request)).toMatchObject({ rebuild: { sourceEntries } });
  });
  it('uses full alignment for changed inputs, decisions, stale or absent indexes', async () => {
    expect(await service.prepareRequest(job, { ...request, language: 'fr' })).toEqual({ ...request, language: 'fr' });
    expect(await service.prepareRequest({ ...job, decisions: { chapters: { 'a.xhtml': 'excluded' }, audio: [] } }, request)).toBe(request);
    store.verifyProvenance.mockResolvedValue({ valid: false });
    expect(await service.prepareRequest(job, request)).toBe(request);
    repo.findIndexRow.mockResolvedValue(null);
    expect(await service.prepareRequest(job, request)).toBe(request);
    expect(store.copyIndex).not.toHaveBeenCalled();
  });
  it('never lets capture or rebuild preparation failures fail an upstream job', async () => {
    store.copyIndex.mockRejectedValue(new Error('disk failure'));
    expect(await service.prepareRequest(job, request)).toBe(request);
    store.capture.mockRejectedValue(new Error('capture failure'));
    await expect(service.onOutputValidated(job, request)).resolves.toBeUndefined();
    expect(repo.upsertIndexRow).not.toHaveBeenCalled();
  });
  it('keeps fork jobs and sweeps expired folders in bounded batches', async () => {
    repo.findIndexRowByWorkerJobId.mockResolvedValue({ bookId: 7, status: 'running' });
    repo.findWorkerJobIdsKeepingWork.mockResolvedValue(['kept']);
    repo.findExpiredWorkerJobIds.mockResolvedValue(['old']);
    expect(await service.ownsWorkerJob('job')).toBe(true);
    expect(await service.keepWorkFolders()).toEqual(['kept']);
    await service.sweepExpiredWork();
    expect(workspace.remove).toHaveBeenCalledWith('old');
    expect(repo.clearWorkerJobIds).toHaveBeenCalledWith(['old']);
    expect(repo.clearWorkerJobIds.mock.invocationCallOrder[0]).toBeGreaterThan(workspace.remove.mock.invocationCallOrder[0]!);
    expect(repo.findExpiredWorkerJobIds).toHaveBeenCalledWith(expect.any(Date), 200);
  });
  it('skips capture without preparation and consumes the prepared snapshot once', async () => {
    await service.onOutputValidated(job, request);
    expect(store.capture).not.toHaveBeenCalled();
    repo.findIndexRow.mockResolvedValue(null);
    store.capture.mockResolvedValue({ indexPath: '/new', indexBytes: 10, provenance: { report: {}, workerVersion: 'test' } });
    await service.prepareRequest(job, request);
    await service.onOutputValidated(job, request);
    expect(store.capture).toHaveBeenCalledWith(expect.objectContaining({ sources: { epub: files[0], audio: [files[1]] } }));
    await service.onOutputValidated(job, request);
    expect(store.capture).toHaveBeenCalledTimes(1);
  });
  it('sweeps a 201-folder backlog in two batches and forgets failed removals too', async () => {
    const first = Array.from({ length: 200 }, (_, i) => String(i));
    repo.findExpiredWorkerJobIds.mockResolvedValueOnce(first).mockResolvedValueOnce(['last']);
    workspace.remove.mockRejectedValueOnce(new Error('disk'));
    await service.sweepExpiredWork();
    expect(workspace.remove).toHaveBeenCalledTimes(201);
    expect(repo.clearWorkerJobIds).toHaveBeenNthCalledWith(1, first);
    expect(repo.clearWorkerJobIds).toHaveBeenNthCalledWith(2, ['last']);
    expect(repo.findExpiredWorkerJobIds).toHaveBeenCalledTimes(2);
  });
  it('removes a superseded index after upserting a captured replacement', async () => {
    repo.findIndexRow.mockResolvedValue({ status: 'stale', indexPath: '/old' });
    store.capture.mockResolvedValue({ indexPath: '/new', indexBytes: 10, provenance: { report: {}, workerVersion: 'test' } });
    await service.prepareRequest(job, request);
    await service.onOutputValidated(job, request);
    expect(store.removeSupersededIndex).toHaveBeenCalledWith(7, '/old', '/new');
    expect(store.removeSupersededIndex.mock.invocationCallOrder[0]).toBeGreaterThan(repo.upsertIndexRow.mock.invocationCallOrder[0]!);
  });
  it('evicts the oldest snapshot after 50 prepared jobs', async () => {
    repo.findIndexRow.mockResolvedValue(null);
    for (let i = 0; i < 51; i++) await service.prepareRequest({ ...job, id: String(i) }, request);
    await service.onOutputValidated({ ...job, id: '0' }, request);
    expect(store.capture).not.toHaveBeenCalled();
  });
  it('releases a worker job whose index row is no longer running', async () => {
    for (const status of ['stale', 'failed', 'ready']) {
      repo.findIndexRowByWorkerJobId.mockResolvedValue({ bookId: 7, status, workerJobId: 'job' });
      expect(await service.ownsWorkerJob('job')).toBe(false);
    }
    repo.findIndexRowByWorkerJobId.mockResolvedValue(null);
    expect(await service.ownsWorkerJob('job')).toBe(false);
  });
  it('never captures an upstream job that excluded chapters or audio', async () => {
    repo.findIndexRow.mockResolvedValue(null);
    store.capture.mockResolvedValue({ indexPath: '/new', indexBytes: 10, provenance: { report: {}, workerVersion: 'test' } });
    const partial = { ...request, decisions: { chapters: { 'a.xhtml': 'excluded' }, audio: [] } } as unknown as ReadAloudWorkerRequest;
    await service.prepareRequest(job, partial);
    await service.onOutputValidated(job, partial);
    const trimmed = { ...request, decisions: { chapters: {}, audio: [{ path: '/books/2', excluded: true }] } } as unknown as ReadAloudWorkerRequest;
    await service.prepareRequest(job, trimmed);
    await service.onOutputValidated(job, trimmed);
    expect(store.capture).not.toHaveBeenCalled();
    expect(repo.upsertIndexRow).not.toHaveBeenCalled();
  });
  it('runs a full alignment when the EPUB on disk changed since the catalog last saw it', async () => {
    vi.mocked(stat).mockResolvedValue({ size: 11, mtimeMs: 0 } as Awaited<ReturnType<typeof stat>>);
    expect(await service.prepareRequest(job, request)).toBe(request);
    vi.mocked(stat).mockResolvedValue({ size: 10, mtimeMs: 5 } as Awaited<ReturnType<typeof stat>>);
    expect(await service.prepareRequest(job, request)).toBe(request);
    expect(stat).toHaveBeenCalledWith('/books/1');
    expect(store.copyIndex).not.toHaveBeenCalled();
  });
  it('rebuilds when the EPUB mtime differs from the catalog only below a millisecond', async () => {
    vi.mocked(stat).mockResolvedValue({ size: 10, mtimeMs: 0.656, mtime: new Date(1) } as Awaited<ReturnType<typeof stat>>);
    expect(await service.prepareRequest(job, request)).not.toBe(request);
    expect(store.copyIndex).toHaveBeenCalled();
  });
  it('runs a full alignment when the worker would refuse the rebuild request', async () => {
    for (const href of ['OPS/./audio.mp3', 'OPS/a:b.mp3', 'OPS//audio.mp3']) {
      repo.findIndexRow.mockResolvedValue({
        status: 'ready',
        provenance: { ...provenance, audioEntries: [{ href, chunk: '00001.mp3', size: 5 }] },
      });
      expect(await service.prepareRequest(job, request)).toBe(request);
    }
    expect(store.copyIndex).not.toHaveBeenCalled();
  });
});
