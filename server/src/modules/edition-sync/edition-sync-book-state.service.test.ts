import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { EDITION_SYNC_SERVER_DISABLED_MESSAGE } from './edition-sync.constants';
import { EditionSyncBookStateService } from './edition-sync-book-state.service';

const user = { id: 7, isSuperuser: false, permissions: ['edition_sync'] } as unknown as RequestUser;

function setup(
  options: {
    effectiveEnabled?: boolean;
    serverEnabled?: boolean;
    mode?: 'all_eligible' | 'selected_only';
    row?: Record<string, unknown> | null;
    eligible?: boolean;
    readyAlignment?: boolean;
    withoutAlignmentStatus?: boolean;
  } = {},
) {
  const repo = {
    findEligibility: vi
      .fn()
      .mockResolvedValue({ bookId: 10, eligible: options.eligible ?? true, editionCount: 2, hasReadAlong: false, hasAudio: true, libraryId: 1 }),
    findActiveRun: vi.fn().mockResolvedValue(null),
    findReadAloudMode: vi.fn().mockResolvedValue('auto'),
    findOverride: vi.fn().mockResolvedValue(null),
    isWanted: vi.fn().mockResolvedValue(true),
    findIndexRow: vi.fn().mockResolvedValue(options.row ?? null),
    setOverride: vi.fn().mockResolvedValue(undefined),
    retryFailedBooks: vi.fn().mockResolvedValue(3),
    pinBook: vi.fn().mockResolvedValue(undefined),
    findQueuePosition: vi.fn().mockResolvedValue(142),
    findBookFileIdByPath: vi.fn().mockResolvedValue(55),
    updateIndexRow: vi.fn().mockImplementation((_bookId: number, patch: Record<string, unknown>) => Promise.resolve({ ...options.row, ...patch })),
  };
  const books = { verifyBookAccess: vi.fn().mockResolvedValue(undefined) };
  const effectiveEnabled = options.effectiveEnabled ?? true;
  const settings = {
    getSettings: vi.fn().mockResolvedValue({
      enabled: effectiveEnabled,
      effectiveEnabled,
      disabledReason: options.serverEnabled === false ? 'server_disabled' : effectiveEnabled ? null : 'user_disabled',
      bookSyncMode: options.mode ?? 'all_eligible',
    }),
  };
  const queue = { ensureValid: vi.fn().mockResolvedValue(true) };
  const scheduler = { poke: vi.fn(), nextRunAt: vi.fn().mockReturnValue(new Date('2026-11-02T02:00:00Z')) };
  const overlaySource = { invalidate: vi.fn() };
  const alignmentStatus = { hasReadyAlignment: vi.fn().mockResolvedValue(options.readyAlignment ?? false) };
  const service = new EditionSyncBookStateService(
    repo as never,
    books as never,
    settings as never,
    queue as never,
    scheduler as never,
    overlaySource as never,
    options.withoutAlignmentStatus ? undefined : (alignmentStatus as never),
  );
  return { service, repo, books, queue, scheduler, overlaySource, alignmentStatus };
}

describe('EditionSyncBookStateService.getState', () => {
  it('reports pin, run and edition facts', async () => {
    const { service, repo } = setup({ row: { status: 'stale', pinnedAt: new Date() } });
    repo.findActiveRun.mockResolvedValue({ id: 1 } as never);
    expect(await service.getState(user, 10)).toMatchObject({ pinned: true, runActive: true, hasAudio: true, hasReadAlong: false });
  });

  it('suppresses Whisper when upstream sync is disabled', async () => {
    const { service, repo } = setup({ row: { status: 'failed' }, readyAlignment: true });
    repo.findReadAloudMode.mockResolvedValue('disabled');
    expect((await service.getState(user, 10)).index.whisperFallback).toBe(false);
  });

  it('checks book access first', async () => {
    const { service, books, repo } = setup();
    books.verifyBookAccess.mockRejectedValueOnce(new NotFoundException());
    await expect(service.getState(user, 10)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.findEligibility).not.toHaveBeenCalled();
  });

  it('shows a wanted book with no index as queued with its position and the next run', async () => {
    const { service } = setup();
    const state = await service.getState(user, 10);
    expect(state).toMatchObject({ syncEnabled: true, wanted: true, canRunNow: true, canRetry: false, editionCount: 2 });
    expect(state.index).toMatchObject({ status: 'queued', queuePosition: 142, nextRunAt: '2026-11-02T02:00:00.000Z' });
  });

  it('verifies a ready index and links the scanned file on first read', async () => {
    const row = {
      bookId: 10,
      status: 'ready',
      indexFileId: null,
      indexPath: '/b/book.bookorbit-timings',
      indexedAt: new Date(),
      report: { totals: { sentences: 433, matchedSentences: 430 } },
    };
    const { service, queue, repo } = setup({ row });
    const state = await service.getState(user, 10);
    expect(queue.ensureValid).toHaveBeenCalledWith(10);
    expect(repo.updateIndexRow).toHaveBeenCalledWith(10, { indexFileId: 55 });
    expect(state.index).toMatchObject({ status: 'ready', indexFileId: 55, sentences: 433, matchedSentences: 430, queuePosition: null });
  });

  it('reports the EPUB the ready index was aligned to from its provenance', async () => {
    const row = { bookId: 10, status: 'ready', indexFileId: 3, indexPath: '/x', provenance: { epub: { bookFileId: 21 } } };
    const { service } = setup({ row });
    expect((await service.getState(user, 10)).index.epubFileId).toBe(21);
  });

  it('reports no aligned EPUB for an older index without provenance', async () => {
    const { service } = setup({ row: { bookId: 10, status: 'ready', indexFileId: 3, indexPath: '/x', provenance: null } });
    expect((await service.getState(user, 10)).index.epubFileId).toBeNull();
  });

  const failedRow = {
    bookId: 10,
    status: 'failed',
    errorCode: 'audio_processing_failed',
    lastError: 'empty audio',
    failedAt: new Date(),
    attemptCount: 1,
  };

  it('shows a failed run with a ready Whisper alignment as the fallback, and a retry', async () => {
    const { service, alignmentStatus } = setup({ row: failedRow, readyAlignment: true });
    const state = await service.getState(user, 10);
    expect(alignmentStatus.hasReadyAlignment).toHaveBeenCalledWith(10, 7);
    expect(state.index).toMatchObject({ status: 'failed', whisperFallback: true, errorCode: 'audio_processing_failed' });
    expect(state).toMatchObject({ canRetry: true, canRunNow: false });
  });

  it('shows a failed run without a ready alignment as no fallback, still with a retry', async () => {
    const { service } = setup({ row: failedRow, readyAlignment: false });
    const state = await service.getState(user, 10);
    expect(state.index).toMatchObject({ status: 'failed', whisperFallback: false });
    expect(state).toMatchObject({ canRetry: true, canRunNow: false });
  });

  it('reports no fallback when the alignment status service is not installed', async () => {
    const { service } = setup({ row: failedRow, withoutAlignmentStatus: true });
    const state = await service.getState(user, 10);
    expect(state.index).toMatchObject({ status: 'failed', whisperFallback: false });
  });

  it('does not ask for an alignment unless the status is failed', async () => {
    const rows = [null, { bookId: 10, status: 'ready', indexFileId: 3, indexPath: '/x' }, { bookId: 10, status: 'running' }];
    for (const row of rows) {
      const { service, alignmentStatus } = setup({ row, readyAlignment: true });
      const state = await service.getState(user, 10);
      expect(state.index.whisperFallback).toBe(false);
      expect(alignmentStatus.hasReadyAlignment).not.toHaveBeenCalled();
    }
  });

  it('does not ask for an alignment when the user has sync off for a failed book', async () => {
    const { service, alignmentStatus } = setup({ row: failedRow, readyAlignment: true, effectiveEnabled: false });
    const state = await service.getState(user, 10);
    expect(state.index.whisperFallback).toBe(false);
    expect(alignmentStatus.hasReadyAlignment).not.toHaveBeenCalled();
  });

  it('reports the policy reason when the user has sync off', async () => {
    const { service } = setup({ effectiveEnabled: false });
    const state = await service.getState(user, 10);
    expect(state).toMatchObject({ syncEnabled: false, effectiveReason: 'user_disabled', canRunNow: false });
  });
});

describe('EditionSyncBookStateService.setSyncEnabled', () => {
  it('turning a book on with no index stores the override and pins it to start now', async () => {
    const { service, repo, scheduler, overlaySource } = setup({ mode: 'selected_only' });
    await service.setSyncEnabled(user, 10, true);
    expect(repo.setOverride).toHaveBeenCalledWith(7, 10, 'included');
    expect(overlaySource.invalidate).toHaveBeenCalledWith(7, 10);
    expect(repo.pinBook).toHaveBeenCalledWith(10, expect.any(Date), false);
    expect(scheduler.poke).toHaveBeenCalled();
  });

  it('does not pin a book that already has an index or failed', async () => {
    for (const status of ['ready', 'failed', 'running']) {
      const { service, repo } = setup({ row: { bookId: 10, status } });
      await service.setSyncEnabled(user, 10, true);
      expect(repo.pinBook).not.toHaveBeenCalled();
    }
  });

  it('turning off excludes the book in all-eligible mode and never pins', async () => {
    const { service, repo } = setup();
    await service.setSyncEnabled(user, 10, false);
    expect(repo.setOverride).toHaveBeenCalledWith(7, 10, 'excluded');
    expect(repo.pinBook).not.toHaveBeenCalled();
  });

  it('stores the override but does not pin while the user has sync off', async () => {
    const { service, repo } = setup({ effectiveEnabled: false });
    await service.setSyncEnabled(user, 10, true);
    expect(repo.setOverride).toHaveBeenCalled();
    expect(repo.pinBook).not.toHaveBeenCalled();
  });
});

describe('EditionSyncBookStateService run now and retry', () => {
  it('run now pins a queued book', async () => {
    const { service, repo, scheduler } = setup();
    await service.runNow(user, 10);
    expect(repo.pinBook).toHaveBeenCalledWith(10, expect.any(Date), false);
    expect(scheduler.poke).toHaveBeenCalled();
  });

  it('run now refuses a ready book', async () => {
    const { service } = setup({ row: { bookId: 10, status: 'ready', indexFileId: 3, indexPath: '/x' } });
    await expect(service.runNow(user, 10)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('retry pins a failed book with the retry flag', async () => {
    const { service, repo } = setup({ row: { bookId: 10, status: 'failed' } });
    await service.retry(user, 10);
    expect(repo.pinBook).toHaveBeenCalledWith(10, expect.any(Date), true);
  });

  it('retry refuses a book that did not fail', async () => {
    const { service } = setup();
    await expect(service.retry(user, 10)).rejects.toBeInstanceOf(BadRequestException);
  });
});

it.each(['runNow', 'retry'] as const)('rejects %s and does not pin while the server is disabled', async (method) => {
  const { service, repo } = setup({ effectiveEnabled: false, serverEnabled: false, row: { status: method === 'retry' ? 'failed' : 'stale' } });
  await expect(service[method](user, 10)).rejects.toThrow(new BadRequestException(EDITION_SYNC_SERVER_DISABLED_MESSAGE));
  expect(repo.pinBook).not.toHaveBeenCalled();
  expect(repo.isWanted).not.toHaveBeenCalled();
  expect(repo.findQueuePosition).not.toHaveBeenCalled();
});

it('does not pin a toggle-on book while the server is disabled', async () => {
  const { service, repo, scheduler } = setup({ effectiveEnabled: false, serverEnabled: false });
  await expect(service.setSyncEnabled(user, 10, true)).resolves.toMatchObject({ syncEnabled: false, effectiveReason: 'server_disabled' });
  expect(repo.pinBook).not.toHaveBeenCalled();
  expect(scheduler.poke).not.toHaveBeenCalled();
});

describe('retryFailed', () => {
  it('rejects when the server is disabled without updating or waking the scheduler', async () => {
    const { service, repo, scheduler } = setup({ serverEnabled: false });
    await expect(service.retryFailed(user)).rejects.toThrow(EDITION_SYNC_SERVER_DISABLED_MESSAGE);
    expect(repo.retryFailedBooks).not.toHaveBeenCalled();
    expect(scheduler.poke).not.toHaveBeenCalled();
  });
  it('returns the count, clears cached positions and wakes the scheduler', async () => {
    const { service, repo, scheduler } = setup();
    await service.getState(user, 10);
    expect(await service.retryFailed(user)).toEqual({ retried: 3 });
    expect(repo.retryFailedBooks).toHaveBeenCalledWith(user, expect.objectContaining({ effectiveEnabled: true }), expect.any(Date));
    expect(scheduler.poke).toHaveBeenCalledTimes(1);
    await service.getState(user, 10);
    expect(repo.findQueuePosition).toHaveBeenCalledTimes(2);
  });
  it('does not wake the scheduler when the update fails', async () => {
    const { service, repo, scheduler } = setup();
    repo.retryFailedBooks.mockRejectedValue(new BadRequestException('failed'));
    await expect(service.retryFailed(user)).rejects.toThrow('failed');
    expect(scheduler.poke).not.toHaveBeenCalled();
  });
});
