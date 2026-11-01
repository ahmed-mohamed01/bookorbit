import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEpubMediaOverlayPlaylistFromFile } from '../reader/epub/epub-media-overlay';
import { readAloudConfig } from '../../config/config';
import { AudioPlayOrderService } from '../audiobook-chapters/audio-play-order.service';
import { ReadAloudWorkerClientService, WorkerJobNotFoundError, WorkerUnreachableError } from '../read-aloud/read-aloud-worker-client.service';
import { ReadAloudWorkspace } from '../read-aloud/read-aloud-workspace.service';
import { EditionSyncIndexStoreService } from './edition-sync-index-store.service';
import { EditionSyncIndexerService } from './edition-sync-indexer.service';
import { EditionSyncSourcesChangedError } from './edition-sync-provenance';
import { EditionSyncOverlaySourceService } from './edition-sync-overlay-source.service';
import { EditionSyncRepository } from './edition-sync.repository';

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => {
    vi.advanceTimersByTime(ms);
    return Promise.resolve();
  },
}));
vi.mock('./edition-sync-index-store.service', () => ({ EditionSyncIndexStoreService: class EditionSyncIndexStoreService {} }));
vi.mock('../reader/epub/epub-media-overlay', () => ({ buildEpubMediaOverlayPlaylistFromFile: vi.fn().mockResolvedValue({ items: [{}] }) }));

describe('EditionSyncIndexerService', () => {
  let service: EditionSyncIndexerService;
  const repo = { findIndexSource: vi.fn(), findIndexRow: vi.fn(), updateIndexRow: vi.fn(), markRunningStale: vi.fn() };
  const overlaySource = { invalidateBook: vi.fn() };
  const worker = { healthState: vi.fn(), start: vi.fn(), status: vi.fn(), cancel: vi.fn() };
  const workspace = { ensure: vi.fn(), dir: vi.fn(), outputPath: vi.fn(), remove: vi.fn() };
  const store = { capture: vi.fn(), removeSupersededIndex: vi.fn() };
  const playOrder = { resolveAudioPlayOrder: vi.fn() };
  const claim = { bookId: 7, workerJobId: 'job-id', pinned: false };
  const running = { status: 'running', stage: 'aligning', progress: 60, events: [] };
  const completed = { ...running, status: 'completed' };
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(buildEpubMediaOverlayPlaylistFromFile).mockResolvedValue({ items: [{}] } as never);
    repo.findIndexSource.mockResolvedValue({
      bookId: 7,
      language: 'en',
      epub: { absolutePath: '/books/book.epub', sizeBytes: 10 },
      audio: [
        { id: 2, absolutePath: '/books/b.mp3', sizeBytes: 30, durationSeconds: 20 },
        { id: 3, absolutePath: '/books/a.mp3', sizeBytes: 20, durationSeconds: 10 },
      ],
    });
    repo.findIndexRow.mockResolvedValue({ attemptCount: 1, lastAttemptAt: new Date(1234) });
    worker.healthState.mockResolvedValue({ state: 'ok', health: { libraryRoots: ['/books'], version: 'test' } });
    worker.start.mockResolvedValue(completed);
    worker.cancel.mockResolvedValue({ status: 'cancelled' });
    workspace.dir.mockReturnValue('/work/job-id');
    workspace.outputPath.mockReturnValue('/work/job-id/output.epub');
    store.capture.mockResolvedValue({
      indexPath: '/books/book.bookorbit-timings',
      indexBytes: 10,
      provenance: { workerVersion: 'test', report: { sentences: 10, matchedSentences: 9 } },
    });
    playOrder.resolveAudioPlayOrder.mockResolvedValue([{ fileId: 3 }, { fileId: 2 }]);
    const module = await Test.createTestingModule({
      providers: [
        EditionSyncIndexerService,
        { provide: EditionSyncOverlaySourceService, useValue: overlaySource },
        { provide: EditionSyncRepository, useValue: repo },
        { provide: ReadAloudWorkerClientService, useValue: worker },
        { provide: ReadAloudWorkspace, useValue: workspace },
        { provide: EditionSyncIndexStoreService, useValue: store },
        { provide: AudioPlayOrderService, useValue: playOrder },
        { provide: readAloudConfig.KEY, useValue: { maxOutputBytes: 10000 } },
      ],
    }).compile();
    service = module.get(EditionSyncIndexerService);
    vi.useFakeTimers();
    vi.spyOn(service as unknown as { isMounted(path: string, roots: string[]): Promise<boolean> }, 'isMounted').mockResolvedValue(true);
  });
  afterEach(() => vi.useRealTimers());
  async function run(shouldYield = vi.fn().mockResolvedValue(false)) {
    const promise = service.indexBook(claim, { shouldYield, shouldStop: () => false });
    await vi.runAllTimersAsync();
    return promise;
  }
  it('submits upstream options in audio play order, captures and removes successful work', async () => {
    const result = await run();
    expect(result.status, result.error ?? '').toBe('ready');
    expect(worker.start).toHaveBeenCalledWith(
      expect.objectContaining({
        audioPaths: ['/books/a.mp3', '/books/b.mp3'],
        sourceBytes: 60,
        audioDurationSeconds: 30,
        granularity: 'sentence',
        decisions: { chapters: {}, audio: [] },
        resumeFrom: null,
      }),
    );
    expect(workspace.remove).toHaveBeenCalledWith('job-id');
    expect(overlaySource.invalidateBook).toHaveBeenCalledWith(7);
    expect(repo.updateIndexRow).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ status: 'ready', pinnedAt: null, attemptCount: 0 }),
      new Date(1234),
    );
    expect(service.currentWorkerJobId).toBeNull();
  });
  it('preserves work and records explicit worker failures without automatic retry', async () => {
    worker.start.mockResolvedValue({ ...running, status: 'failed', errorCode: 'inference_failed', error: 'empty audio source' });
    expect((await run()).status).toBe('failed');
    expect(repo.updateIndexRow).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ status: 'failed', errorCode: 'inference_failed', retryRequested: false }),
    );
    expect(workspace.remove).not.toHaveBeenCalled();
  });
  it('yields to upstream work and marks the row resumable', async () => {
    worker.start.mockResolvedValue(running);
    const shouldYield = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    expect((await run(shouldYield)).status).toBe('yielded');
    expect(worker.cancel).toHaveBeenCalledWith('job-id');
    expect(repo.markRunningStale).toHaveBeenCalledWith(7, 'yielded');
    expect(repo.updateIndexRow).not.toHaveBeenCalledWith(7, expect.objectContaining({ attemptCount: 2 }));
    expect(workspace.remove).not.toHaveBeenCalled();
  });
  it('handles worker-side cancellation', async () => {
    worker.start.mockResolvedValue({ ...running, status: 'cancelled', errorCode: null, error: null });
    expect((await run()).status).toBe('cancelled');
    expect(repo.markRunningStale).toHaveBeenCalledWith(7, 'interrupted');
  });
  it('resubmits a lost job and retries transient network errors with backoff', async () => {
    worker.start.mockRejectedValueOnce(new WorkerUnreachableError('offline')).mockResolvedValueOnce(running).mockResolvedValue(completed);
    worker.status.mockRejectedValueOnce(new WorkerJobNotFoundError('job-id'));
    expect((await run()).status).toBe('ready');
    expect(worker.start).toHaveBeenCalledTimes(3);
  });
  it('bounds lost-job resubmissions and marks a retryable failure', async () => {
    worker.start.mockResolvedValue(running);
    worker.status.mockRejectedValue(new WorkerJobNotFoundError('job-id'));
    expect((await run()).status).toBe('failed');
    expect(worker.start).toHaveBeenCalledTimes(4);
    expect(repo.updateIndexRow).toHaveBeenLastCalledWith(7, expect.objectContaining({ status: 'failed', retryRequested: true }));
  });
  it('counts initial health failures toward the transient attempt limit', async () => {
    worker.healthState.mockResolvedValue({ state: 'unreachable' });
    repo.findIndexRow.mockResolvedValue({ attemptCount: 4 });
    const result = await run();
    expect(result.errorCode).toBe('worker_unavailable');
    expect(repo.updateIndexRow).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'failed', attemptCount: 5 }));
    expect(repo.updateIndexRow).toHaveBeenLastCalledWith(7, expect.objectContaining({ retryRequested: false }));
    expect(worker.start).not.toHaveBeenCalled();
  });
  it('bounds the unreachable window', async () => {
    worker.start.mockRejectedValue(new WorkerUnreachableError('offline'));
    expect((await run()).errorCode).toBe('worker_unavailable');
    expect(worker.start.mock.calls.length).toBeLessThan(100);
  });
  it('marks changed capture sources stale instead of failed', async () => {
    store.capture.mockRejectedValue(new EditionSyncSourcesChangedError('audio_changed'));
    expect((await run()).status).toBe('failed');
    expect(repo.markRunningStale).toHaveBeenCalledWith(7, 'audio_changed');
    expect(repo.updateIndexRow.mock.calls.some(([, patch]) => patch.status === 'failed')).toBe(false);
  });
  it('honours a stop that arrived during the claim before submitting', async () => {
    const result = await service.indexBook(claim, { shouldYield: () => Promise.resolve(false), shouldStop: () => true });
    expect(result.status).toBe('cancelled');
    expect(repo.markRunningStale).toHaveBeenCalledWith(7, 'interrupted');
    expect(worker.start).not.toHaveBeenCalled();
  });
  it('removes the superseded index after recording the replacement', async () => {
    repo.findIndexRow.mockResolvedValue({ attemptCount: 1, indexPath: '/books/old.bookorbit-timings' });
    expect((await run()).status).toBe('ready');
    expect(store.removeSupersededIndex).toHaveBeenCalledWith(7, '/books/old.bookorbit-timings', '/books/book.bookorbit-timings');
    expect(store.removeSupersededIndex.mock.invocationCallOrder[0]).toBeGreaterThan(repo.updateIndexRow.mock.invocationCallOrder.at(-1)!);
  });
});
