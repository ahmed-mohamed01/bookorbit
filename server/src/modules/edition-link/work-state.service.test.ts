import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EMPTY_CONTENT_FILTER_RULES } from '@bookorbit/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { ReadingAttemptService } from '../user-book-status/reading-attempt.service';
import { WorkEventsService } from './work-events.service';
import { WorkRepository } from './work.repository';
import { WorkScopeService } from './work-scope.service';
import { WorkStateService } from './work-state.service';

const user = { id: 7, isSuperuser: false, contentFilters: EMPTY_CONTENT_FILTER_RULES, settings: { timezone: 'UTC' } } as unknown as RequestUser;
const attempt = (id: number, bookId: number, fields: Record<string, unknown> = {}) => ({
  id,
  bookId,
  startedOn: null,
  endedOn: null,
  outcome: 'completed',
  origin: 'manual',
  ...fields,
});

describe('WorkStateService', () => {
  let service: WorkStateService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let scope: {
    resolveScope: ReturnType<typeof vi.fn>;
    resolveMany: ReturnType<typeof vi.fn>;
    canonicalBookId: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
  };
  let attempts: { rebuildProjection: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      findUserIdsWithAttempts: vi.fn().mockResolvedValue([7]),
      findAttempts: vi.fn().mockResolvedValue([]),
      applyAttemptMerge: vi.fn().mockResolvedValue(undefined),
      findWorkMembersByBook: vi.fn().mockResolvedValue([{ bookId: 10 }, { bookId: 20 }]),
      copyAttempts: vi.fn().mockResolvedValue(1),
      findAbsFinishedBookIds: vi.fn().mockResolvedValueOnce([20]).mockResolvedValue([]),
      findCompletedAttempts: vi.fn().mockResolvedValue([]),
      softDeleteAttempts: vi.fn().mockImplementation((_userId: number, ids: number[]) => Promise.resolve(ids.length)),
      findVariantDetails: vi.fn().mockResolvedValue([{ bookId: 20, title: 'Dune' }]),
      countCompletedBetween: vi.fn().mockResolvedValue(5),
    };
    scope = {
      resolveScope: vi.fn().mockResolvedValue({ canonicalBookId: 20, mirrorBookIds: [10] }),
      resolveMany: vi.fn().mockResolvedValue(new Map()),
      canonicalBookId: vi.fn().mockResolvedValue(10),
      invalidate: vi.fn(),
    };
    attempts = { rebuildProjection: vi.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        WorkStateService,
        { provide: WorkRepository, useValue: repo },
        { provide: WorkScopeService, useValue: scope },
        { provide: ReadingAttemptService, useValue: attempts },
        { provide: LibraryService, useValue: { findAccessibleLibraryIds: vi.fn().mockResolvedValue([1]) } },
        { provide: WorkEventsService, useValue: { notifyBooksChanged: vi.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(WorkStateService);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('moves a joining book attempts onto the canonical book and rebuilds the projection once', async () => {
    repo.findAttempts!.mockResolvedValue([
      attempt(1, 20, { origin: 'audiobookshelf', endedOn: '2026-03-01' }),
      attempt(2, 10, { origin: 'audiobookshelf', endedOn: '2026-03-01', startedOn: '2026-02-01' }),
      attempt(3, 10, { origin: 'kobo', endedOn: '2025-01-01' }),
    ]);

    await expect(service.mergeWorkState([10, 20])).resolves.toBe(1);

    expect(repo.findAttempts).toHaveBeenCalledWith(7, [20, 10]);
    expect(repo.applyAttemptMerge).toHaveBeenCalledWith(7, 20, { moveIds: [2, 3], deletes: [{ id: 1, keptId: 2 }] });
    expect(attempts.rebuildProjection).toHaveBeenCalledTimes(1);
    expect(attempts.rebuildProjection).toHaveBeenCalledWith(7, 20);
  });

  it('leaves the history alone for a reader who does not share reading state', async () => {
    scope.resolveScope.mockResolvedValue(null);

    await expect(service.mergeWorkState([10, 20])).resolves.toBe(0);
    expect(repo.applyAttemptMerge).not.toHaveBeenCalled();
  });

  it('copies the work history onto a leaving variant and rebuilds both sides', async () => {
    scope.resolveScope.mockResolvedValue({ canonicalBookId: 20, mirrorBookIds: [10] });
    repo.findWorkMembersByBook!.mockResolvedValue([{ bookId: 10 }, { bookId: 20 }, { bookId: 30 }]);
    scope.canonicalBookId.mockResolvedValue(20);

    const context = await service.prepareDetach(10);
    expect(repo.copyAttempts).toHaveBeenCalledWith(7, 20, 10);
    await service.finishDetach(context);

    expect(scope.invalidate).toHaveBeenCalled();
    expect(attempts.rebuildProjection).toHaveBeenCalledWith(7, 10);
    expect(attempts.rebuildProjection).toHaveBeenCalledWith(7, 20);
  });

  it('hands the remaining work a copy when the leaving book held the history', async () => {
    scope.resolveScope.mockResolvedValue({ canonicalBookId: 20, mirrorBookIds: [10] });
    scope.canonicalBookId.mockResolvedValue(10);

    const context = await service.prepareDetach(20);
    expect(repo.copyAttempts).not.toHaveBeenCalled();
    await service.finishDetach(context);

    expect(repo.copyAttempts).toHaveBeenCalledWith(7, 20, 10);
  });

  it('previews and rebuilds the Audiobookshelf history from one plan', async () => {
    const completed = [
      attempt(1, 20, { origin: 'audiobookshelf', endedOn: '2026-05-01' }),
      attempt(2, 10, { origin: 'migration', endedOn: `${new Date().getUTCFullYear()}-01-02` }),
    ];
    repo.findCompletedAttempts!.mockResolvedValue(completed);

    const preview = await service.previewAbsHistory(user);
    expect(preview).toMatchObject({
      worksWithAbsFinish: 1,
      attemptsToReplace: 1,
      worksUntouched: 0,
      booksReadThisYearBefore: 5,
      booksReadThisYearAfter: 4,
    });
    expect(preview.samples).toEqual([{ bookId: 20, title: 'Dune', absEndedOn: '2026-05-01', replacedEndedOn: [completed[1]!.endedOn] }]);

    repo.findAbsFinishedBookIds!.mockReset().mockResolvedValueOnce([20]).mockResolvedValue([]);
    await expect(service.rebuildAbsHistory(user)).resolves.toEqual({ worksRebuilt: 1, attemptsReplaced: 1 });
    expect(repo.softDeleteAttempts).toHaveBeenCalledWith(7, [2]);
    expect(attempts.rebuildProjection).toHaveBeenCalledWith(7, 20);
  });
});
