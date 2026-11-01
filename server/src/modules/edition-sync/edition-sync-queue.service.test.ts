import { checkEditionSyncSources } from './edition-sync-source-check';
vi.mock('./edition-sync-source-check', () => ({ checkEditionSyncSources: vi.fn() }));
import { describe, expect, it, vi } from 'vitest';

import { EDITION_SYNC_CLEAR_BATCH_SIZE } from './edition-sync.constants';
import { EditionSyncQueueService } from './edition-sync-queue.service';

function setup() {
  vi.mocked(checkEditionSyncSources).mockResolvedValue({ valid: true });
  const repo = {
    findNextQueuedBook: vi.fn().mockResolvedValue({ bookId: 4, pinned: true }),
    findIndexRow: vi.fn().mockResolvedValue(null),
    claimIndexRow: vi.fn().mockResolvedValue({ bookId: 4, status: 'running' }),
    clearRecheck: vi.fn().mockResolvedValue(undefined),
    markStale: vi.fn().mockResolvedValue(undefined),
    findUnused: vi.fn().mockResolvedValue([]),
    deleteUnusedIndexRow: vi.fn().mockResolvedValue(true),
  };
  const indexStore = {
    verifyProvenance: vi.fn().mockResolvedValue({ valid: true }),
    removeIndexFile: vi.fn().mockResolvedValue(1000),
  };
  const workspace = {
    dir: vi.fn((id: string) => `/work/${id}`),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(null),
  };
  const overlaySource = { invalidateBook: vi.fn() };
  const service = new EditionSyncQueueService(repo as never, indexStore as never, workspace as never, overlaySource as never);
  return { service, repo, indexStore, workspace, overlaySource };
}

describe('EditionSyncQueueService.claimNext', () => {
  it('claims the next book under a fresh worker job id', async () => {
    const { service, repo } = setup();
    const claim = await service.claimNext({ pinnedOnly: true });
    expect(repo.findNextQueuedBook).toHaveBeenCalledWith({ pinnedOnly: true });
    expect(claim).toMatchObject({ bookId: 4, pinned: true });
    expect(claim?.workerJobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(repo.claimIndexRow).toHaveBeenCalledWith(4, claim?.workerJobId, expect.any(Date), null);
  });

  it('reuses the previous job id while its work folder exists, so the worker resumes', async () => {
    const { service, repo, workspace } = setup();
    repo.findIndexRow.mockResolvedValue({ bookId: 4, status: 'stale', workerJobId: 'old-job' });
    workspace.inspect.mockResolvedValue({ isDirectory: () => true });
    await expect(service.claimNext({ pinnedOnly: false })).resolves.toMatchObject({ workerJobId: 'old-job' });
  });

  it.each([
    { status: 'stale', invalidatedReason: 'audio_changed' },
    { status: 'failed', invalidatedReason: 'files_changed' },
    { status: 'stale', invalidatedReason: 'interrupted', filesChangedAt: new Date(2000), lastAttemptAt: new Date(1000) },
  ])('discards changed source work before replacing its job id: %o', async (row) => {
    const { service, repo, workspace } = setup();
    repo.findIndexRow.mockResolvedValue({ bookId: 4, workerJobId: 'old-job', ...row });
    workspace.inspect.mockResolvedValue({ isDirectory: () => true });
    const claim = await service.claimNext({ pinnedOnly: false });
    expect(claim?.workerJobId).not.toBe('old-job');
    expect(workspace.remove).toHaveBeenCalledWith('old-job');
    expect(workspace.remove.mock.invocationCallOrder[0]).toBeLessThan(repo.claimIndexRow.mock.invocationCallOrder[0]);
  });

  it('starts fresh when the old folder is gone', async () => {
    const { service, repo } = setup();
    repo.findIndexRow.mockResolvedValue({ bookId: 4, status: 'failed', workerJobId: 'old-job' });
    const claim = await service.claimNext({ pinnedOnly: false });
    expect(claim?.workerJobId).not.toBe('old-job');
  });

  it('returns null when the queue is empty or another claim won', async () => {
    const { service, repo } = setup();
    repo.claimIndexRow.mockResolvedValueOnce(null);
    await expect(service.claimNext({ pinnedOnly: false })).resolves.toBeNull();
    repo.findNextQueuedBook.mockResolvedValueOnce(null);
    await expect(service.claimNext({ pinnedOnly: false })).resolves.toBeNull();
  });
});

describe('EditionSyncQueueService.ensureValid', () => {
  it('keeps a ready index that matches its files and clears a recheck flag', async () => {
    const { service, repo } = setup();
    repo.findIndexRow.mockResolvedValue({ bookId: 4, status: 'ready', invalidatedAt: new Date() });
    await expect(service.ensureValid(4)).resolves.toBe(true);
    expect(repo.clearRecheck).toHaveBeenCalledWith(4);
  });

  it('marks a changed book stale so it is queued again', async () => {
    const { service, repo, overlaySource } = setup();
    repo.findIndexRow.mockResolvedValue({ bookId: 4, status: 'ready', invalidatedAt: null });
    vi.mocked(checkEditionSyncSources).mockResolvedValue({ valid: false, reason: 'audio_changed' });
    await expect(service.ensureValid(4)).resolves.toBe(false);
    expect(repo.markStale).toHaveBeenCalledWith(4, 'audio_changed');
    expect(overlaySource.invalidateBook).toHaveBeenCalledWith(4);
  });

  it('is false without a ready row and does not verify', async () => {
    const { service, indexStore } = setup();
    await expect(service.ensureValid(4)).resolves.toBe(false);
    expect(indexStore.verifyProvenance).not.toHaveBeenCalled();
  });
});

describe('EditionSyncQueueService.clearUnused', () => {
  it('deletes files and rows in batches that advance by book id, counting freed bytes', async () => {
    const { service, repo, indexStore } = setup();
    const fullBatch = Array.from({ length: EDITION_SYNC_CLEAR_BATCH_SIZE }, (_, i) => ({
      bookId: i + 1,
      status: 'ready',
      indexPath: `/lib/${i + 1}.bookorbit-timings`,
      indexBytes: 1000,
      workerJobId: null,
    }));
    repo.findUnused
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce([{ bookId: 900, status: 'failed', indexPath: null, indexBytes: null, workerJobId: 'job' }]);

    await expect(service.clearUnused()).resolves.toEqual({
      deleted: EDITION_SYNC_CLEAR_BATCH_SIZE + 1,
      freedBytes: EDITION_SYNC_CLEAR_BATCH_SIZE * 1000,
    });
    expect(repo.findUnused).toHaveBeenNthCalledWith(2, EDITION_SYNC_CLEAR_BATCH_SIZE, EDITION_SYNC_CLEAR_BATCH_SIZE);
    expect(indexStore.removeIndexFile).toHaveBeenCalledTimes(EDITION_SYNC_CLEAR_BATCH_SIZE);
    expect(repo.deleteUnusedIndexRow.mock.invocationCallOrder[0]).toBeLessThan(indexStore.removeIndexFile.mock.invocationCallOrder[0]);
    expect(repo.deleteUnusedIndexRow).toHaveBeenCalledWith(900, { status: 'failed', indexPath: null });
  });

  it('keeps going after a file removal fails following row deletion', async () => {
    const { service, repo, indexStore } = setup();
    repo.findUnused.mockResolvedValueOnce([
      { bookId: 1, status: 'ready', indexPath: '/a', indexBytes: 5, workerJobId: null },
      { bookId: 2, status: 'ready', indexPath: '/b', indexBytes: 5, workerJobId: null },
    ]);
    indexStore.removeIndexFile.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValueOnce(5);

    await expect(service.clearUnused()).resolves.toEqual({ deleted: 1, freedBytes: 5 });
    expect(repo.deleteUnusedIndexRow).toHaveBeenCalledTimes(2);
    expect(repo.deleteUnusedIndexRow).toHaveBeenCalledWith(2, { status: 'ready', indexPath: '/b' });
  });
  it('does not count or invalidate a row that was claimed or pinned during deletion', async () => {
    const { service, repo, indexStore, overlaySource } = setup();
    repo.findUnused.mockResolvedValueOnce([{ bookId: 1, status: 'ready', indexPath: '/a' }]);
    indexStore.removeIndexFile.mockResolvedValue(0);
    repo.deleteUnusedIndexRow.mockResolvedValue(false);
    expect(await service.clearUnused()).toEqual({ deleted: 0, freedBytes: 0 });
    expect(overlaySource.invalidateBook).not.toHaveBeenCalled();
    expect(indexStore.removeIndexFile).not.toHaveBeenCalled();
  });
});
