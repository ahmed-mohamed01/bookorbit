import { Injectable, Logger } from '@nestjs/common';

import type { AbsHistoryRebuildPreview, AbsHistoryRebuildResult, AbsHistoryRebuildSample } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { resolveTimeZone, toDateKeyInTimeZone } from '../../common/utils/timezone.utils';
import { LibraryService } from '../library/library.service';
import { ReadingAttemptService } from '../user-book-status/reading-attempt.service';
import { WorkEventsService } from './work-events.service';
import { type AbsHistoryGroup, type AbsHistoryPlanEntry, planAbsHistoryRebuild, planAttemptMerge } from './work.utils';
import { WorkRepository } from './work.repository';
import type { ReadingStateScope } from '../user-book-status/reading-state-scope-source';
import { WorkScopeService } from './work-scope.service';

const MERGE_ALL_BATCH = 200;
const ABS_BATCH = 200;
const ABS_SAMPLE_LIMIT = 20;

export interface DetachContext {
  bookId: number;
  remainingBookIds: number[];
  /** Readers whose history sat on the leaving book, which the remaining work now needs a copy of. */
  carryOver: number[];
  readers: number[];
}

/**
 * Keeps a work's reading history in one place: folds a joining book's attempts into the canonical
 * book, hands a leaving book a copy of the history, and replaces imported duplicates.
 */
@Injectable()
export class WorkStateService {
  private readonly logger = new Logger(WorkStateService.name);

  constructor(
    private readonly repo: WorkRepository,
    private readonly scope: WorkScopeService,
    private readonly attempts: ReadingAttemptService,
    private readonly libraryService: LibraryService,
    private readonly events: WorkEventsService,
  ) {}

  /** Never fails the caller: the link is already written, so a failed fold is logged and retried by the next one. */
  async mergeWorkState(memberBookIds: readonly number[]): Promise<number> {
    const startedAt = Date.now();
    const ids = [...new Set(memberBookIds)];
    if (ids.length < 2) return 0;
    try {
      const readers = await this.repo.findUserIdsWithAttempts(ids);
      let merged = 0;
      for (const userId of readers) {
        if (await this.mergeForUser(userId, ids)) merged++;
      }
      this.logger.log(
        `[work.state_merge] [end] bookId=${ids[0]} memberCount=${ids.length} durationMs=${Date.now() - startedAt} readers=${readers.length} merged=${merged} - work state merged`,
      );
      return merged;
    } catch (err) {
      this.logFail('work.state_merge', `bookId=${ids[0]} memberCount=${ids.length}`, startedAt, err, 'work state merge failed');
      return 0;
    }
  }

  async mergeAllForUser(userId: number): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[work.state_merge_all] [start] userId=${userId} - merging every work for reader`);
    try {
      let afterLinkId = 0;
      let works = 0;
      for (;;) {
        const linkIds = await this.repo.findLinkIdsWithUserAttempts(userId, afterLinkId, MERGE_ALL_BATCH);
        if (linkIds.length === 0) break;
        const members = await this.repo.findMemberBookIdsByLinks(linkIds);
        for (const bookIds of members.values()) {
          if (bookIds.length >= 2 && (await this.mergeForUser(userId, bookIds))) works++;
        }
        afterLinkId = linkIds[linkIds.length - 1]!;
      }
      this.logger.log(`[work.state_merge_all] [end] userId=${userId} durationMs=${Date.now() - startedAt} works=${works} - every work merged`);
    } catch (err) {
      this.logFail('work.state_merge_all', `userId=${userId}`, startedAt, err, 'merging every work failed');
    }
  }

  /** Before a book leaves: copies the history it shares onto it, while it still resolves to the work. */
  async prepareDetach(bookId: number): Promise<DetachContext> {
    const memberIds = (await this.repo.findWorkMembersByBook(bookId)).map((member) => member.bookId);
    const remainingBookIds = memberIds.filter((id) => id !== bookId);
    const context: DetachContext = { bookId, remainingBookIds, carryOver: [], readers: [] };
    if (memberIds.length < 2) return context;

    for (const userId of await this.repo.findUserIdsWithAttempts(memberIds)) {
      const resolved = await this.scope.resolveScope(userId, bookId);
      if (!resolved) continue;
      context.readers.push(userId);
      if (resolved.canonicalBookId === bookId) context.carryOver.push(userId);
      else await this.repo.copyAttempts(userId, resolved.canonicalBookId, bookId);
    }
    return context;
  }

  /** After the book left: the remaining work takes a copy when the leaver held the history, then both rebuild. */
  async finishDetach(context: DetachContext): Promise<void> {
    if (context.readers.length === 0) return;
    this.scope.invalidate();
    const anchor = context.remainingBookIds[0];
    for (const userId of context.readers) {
      const remainingCanonical = anchor === undefined ? null : await this.scope.canonicalBookId(userId, anchor);
      if (remainingCanonical !== null && context.carryOver.includes(userId)) {
        await this.repo.copyAttempts(userId, context.bookId, remainingCanonical);
      }
      await this.attempts.rebuildProjection(userId, context.bookId);
      if (remainingCanonical !== null) await this.attempts.rebuildProjection(userId, remainingCanonical);
    }
  }

  async previewAbsHistory(user: RequestUser): Promise<AbsHistoryRebuildPreview> {
    const window = this.yearWindow(user);
    let worksWithAbsFinish = 0;
    let attemptsToReplace = 0;
    let worksUntouched = 0;
    let replacedThisYear = 0;
    const samples: AbsHistoryRebuildSample[] = [];
    await this.walkAbsPlan(user.id, (entries) => {
      for (const entry of entries) {
        worksWithAbsFinish++;
        attemptsToReplace += entry.replaced.length;
        if (entry.replaced.length === 0) worksUntouched++;
        replacedThisYear += entry.replaced.filter(
          (attempt) => attempt.endedOn !== null && attempt.endedOn >= window.from && attempt.endedOn < window.until,
        ).length;
        if (entry.replaced.length > 0 && samples.length < ABS_SAMPLE_LIMIT) {
          samples.push({
            bookId: entry.canonicalBookId,
            title: null,
            absEndedOn: entry.absEndedOn,
            replacedEndedOn: entry.replaced.map((attempt) => attempt.endedOn).filter((day): day is string => day !== null),
          });
        }
      }
    });
    const titles = await this.repo.findVariantDetails(samples.map((sample) => sample.bookId));
    const titleById = new Map(titles.map((row) => [row.bookId, row.title]));
    const before = await this.countReadThisYear(user, window);
    return {
      worksWithAbsFinish,
      attemptsToReplace,
      worksUntouched,
      booksReadThisYearBefore: before,
      booksReadThisYearAfter: Math.max(0, before - replacedThisYear),
      samples: samples.map((sample) => ({ ...sample, title: titleById.get(sample.bookId) ?? null })),
    };
  }

  async rebuildAbsHistory(user: RequestUser): Promise<AbsHistoryRebuildResult> {
    const startedAt = Date.now();
    this.logger.log(`[work.abs_history_rebuild] [start] userId=${user.id} - audiobookshelf history rebuild started`);
    let worksRebuilt = 0;
    let attemptsReplaced = 0;
    try {
      await this.walkAbsPlan(user.id, async (entries) => {
        const touched = entries.filter((entry) => entry.replaced.length > 0);
        const ids = touched.flatMap((entry) => entry.replaced.map((attempt) => attempt.id));
        for (let offset = 0; offset < ids.length; offset += ABS_BATCH) {
          attemptsReplaced += await this.repo.softDeleteAttempts(user.id, ids.slice(offset, offset + ABS_BATCH));
        }
        for (const entry of touched) {
          await this.attempts.rebuildProjection(user.id, entry.canonicalBookId);
          worksRebuilt++;
        }
        await this.events.notifyBooksChanged(
          user.id,
          touched.flatMap((entry) => [entry.canonicalBookId, ...entry.replaced.map((attempt) => attempt.bookId)]),
        );
      });
      this.logger.log(
        `[work.abs_history_rebuild] [end] userId=${user.id} durationMs=${Date.now() - startedAt} worksRebuilt=${worksRebuilt} attemptsReplaced=${attemptsReplaced} - audiobookshelf history rebuild completed`,
      );
      return { worksRebuilt, attemptsReplaced };
    } catch (err) {
      this.logFail('work.abs_history_rebuild', `userId=${user.id}`, startedAt, err, 'audiobookshelf history rebuild failed');
      throw err;
    }
  }

  private async mergeForUser(userId: number, memberBookIds: readonly number[]): Promise<boolean> {
    let resolved: ReadingStateScope | null = null;
    for (const bookId of memberBookIds) {
      resolved = await this.scope.resolveScope(userId, bookId);
      if (resolved) break;
    }
    if (!resolved) return false;
    const canonicalBookId = resolved.canonicalBookId;
    const attempts = await this.repo.findAttempts(userId, [canonicalBookId, ...resolved.mirrorBookIds]);
    await this.repo.applyAttemptMerge(userId, canonicalBookId, planAttemptMerge(canonicalBookId, attempts));
    await this.attempts.rebuildProjection(userId, canonicalBookId);
    return true;
  }

  private async walkAbsPlan(userId: number, onBatch: (entries: AbsHistoryPlanEntry[]) => void | Promise<void>): Promise<void> {
    const seen = new Set<number>();
    let afterBookId = 0;
    for (;;) {
      const bookIds = await this.repo.findAbsFinishedBookIds(userId, afterBookId, ABS_BATCH);
      if (bookIds.length === 0) break;
      afterBookId = bookIds[bookIds.length - 1]!;
      await this.scope.resolveMany(userId, bookIds);
      const groups: AbsHistoryGroup[] = [];
      for (const bookId of bookIds) {
        const shared = await this.scope.resolveScope(userId, bookId);
        const canonicalBookId = shared?.canonicalBookId ?? bookId;
        if (canonicalBookId !== bookId || seen.has(canonicalBookId)) continue;
        seen.add(canonicalBookId);
        groups.push({ canonicalBookId, memberBookIds: [canonicalBookId, ...(shared?.mirrorBookIds ?? [])] });
      }
      if (groups.length === 0) continue;
      const completed = await this.repo.findCompletedAttempts(
        userId,
        groups.flatMap((group) => group.memberBookIds),
      );
      await onBatch(planAbsHistoryRebuild(groups, completed));
    }
  }

  private yearWindow(user: RequestUser): { from: string; until: string } {
    const year = Number(toDateKeyInTimeZone(new Date(), resolveTimeZone(user.settings?.timezone, 'UTC')).slice(0, 4));
    return { from: `${year}-01-01`, until: `${year + 1}-01-01` };
  }

  private async countReadThisYear(user: RequestUser, window: { from: string; until: string }): Promise<number> {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    return this.repo.countCompletedBetween(user.id, libraryIds, window.from, window.until, user.isSuperuser ? undefined : user.contentFilters);
  }

  private logFail(event: string, ids: string, startedAt: number, err: unknown, message: string): void {
    const errorClass = err instanceof Error ? err.name : 'UnknownError';
    const errorMessage = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `[${event}] [fail] ${ids} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - ${message}`,
    );
  }
}
