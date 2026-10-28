import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';

import type {
  EditionLinkMatch,
  EditionLinkMatchBook,
  EditionLinkMatchBucket,
  EditionLinkMatchDismissal,
  EditionLinkMatchListResponse,
  EditionLinkScanStatus,
  LinkAllStrongResult,
  WorkVariantRole,
} from '@bookorbit/types';
import { isAudioFormat, EBOOK_FORMAT_LIST } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { LibraryService } from '../library/library.service';
import { EditionLinkRepository, type MatchCandidate } from './edition-link.repository';
import { EditionLinkService } from './edition-link.service';
import { EditionLinkSettingsService } from './edition-link-settings.service';
import { READ_ALONG_OUTPUT_SOURCE, type ReadAlongOutputSource } from './read-along-output-source';
import type { EditionLinkMatchResult, EditionLinkMatchScan, NewEditionLinkMatchResult } from './schema/work.schema';
import { type MatchBookCardRow, type ScanBookRow, WorkMatchRepository } from './work-match.repository';
import {
  classifyMatch,
  detectConflicts,
  IDENTIFIER_SCORE,
  isPrefixOnlyTitle,
  languagesDiffer,
  proposedActionFor,
  type ScoredCandidate,
} from './work-match.utils';
import type { WorkMemberRankRow } from './work.repository';
import { WorkRepository } from './work.repository';
import { WorkService } from './work.service';

const SCAN_BATCH = 100;
const LINK_ALL_BATCH = 200;
const DISMISSAL_LIST_LIMIT = 200;
const BUCKETS: readonly EditionLinkMatchBucket[] = ['linked_ok', 'linked_suspect', 'conflict', 'strong', 'weak'];
const TEXT_FORMATS = new Set<string>(EBOOK_FORMAT_LIST);

type ScanRole = 'text' | 'audio' | 'readAlong';

interface BatchContext {
  user: RequestUser;
  libraryIds: number[];
  scanId: number;
  duplicatesAllowed: boolean;
  outputs: Set<number>;
  membersByBook: Map<number, WorkMemberRankRow>;
  membersByLink: Map<number, WorkMemberRankRow[]>;
  identifierTargets: Map<number, { bookId: number; formats: string[] }[]>;
  dismissed: Set<string>;
}

function roleOfFormats(formats: readonly string[]): 'text' | 'audio' | null {
  const audio = formats.some((format) => isAudioFormat(format));
  const text = formats.some((format) => TEXT_FORMATS.has(format));
  if (audio === text) return null;
  return audio ? 'audio' : 'text';
}

function pairKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

/** The background scan that proposes works across a reader's libraries, and the actions on its results. */
@Injectable()
export class WorkMatchService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkMatchService.name);
  private readonly queue: { scanId: number; user: RequestUser }[] = [];
  private workerRunning = false;

  constructor(
    private readonly repo: WorkMatchRepository,
    private readonly works: WorkRepository,
    private readonly links: EditionLinkRepository,
    private readonly linkService: EditionLinkService,
    private readonly workService: WorkService,
    private readonly settings: EditionLinkSettingsService,
    private readonly libraryService: LibraryService,
    @Inject(READ_ALONG_OUTPUT_SOURCE) private readonly readAlongOutputs: ReadAlongOutputSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.repo.markInterruptedScansFailed();
  }

  async startScan(user: RequestUser, libraryId?: number): Promise<EditionLinkScanStatus> {
    const accessible = await this.libraryService.findAccessibleLibraryIds(user);
    if (libraryId !== undefined && !accessible.includes(libraryId)) throw new ForbiddenException('Library is not accessible');
    const scan = await this.repo.createScanUnlessActive(user.id, libraryId ?? null);
    if (!scan) throw new ConflictException('An edition link scan is already running');
    this.queue.push({ scanId: scan.id, user });
    void this.drainQueue();
    return this.toStatus(scan);
  }

  async getActiveScan(user: RequestUser): Promise<EditionLinkScanStatus> {
    const scan = await this.repo.findLatestScan(user.id);
    if (!scan) return this.idleStatus(await this.repo.countDismissals(user.id));
    return this.toStatus(scan);
  }

  async listMatches(
    user: RequestUser,
    query: { buckets: EditionLinkMatchBucket[]; libraryId?: number; page: number; pageSize: number },
  ): Promise<EditionLinkMatchListResponse> {
    const scan = await this.repo.findLatestScan(user.id, 'done');
    if (!scan) return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    const { items, total } = await this.repo.listResults(scan.id, query.buckets, query.libraryId, query.page, query.pageSize);
    const bookIds = [...new Set(items.flatMap((item) => [item.sourceBookId, item.targetBookId]))];
    const [cards, outputs, members] = await Promise.all([
      this.repo.findBookCards(user.id, bookIds),
      this.readAlongOutputs.findReadAlongOutputs(bookIds),
      this.works.findWorkMembersForBooks(bookIds),
    ]);
    const memberByBook = new Map(members.map((member) => [member.bookId, member]));
    const roleOf = (card: MatchBookCardRow | undefined, bookId: number): WorkVariantRole =>
      memberByBook.get(bookId)?.role ?? (outputs.has(bookId) ? 'readAlong' : (roleOfFormats(card?.formats ?? []) ?? 'text'));

    return {
      items: items.flatMap((item) => {
        const source = cards.get(item.sourceBookId);
        const target = cards.get(item.targetBookId);
        if (!source || !target) return [];
        const sourceLink = memberByBook.get(item.sourceBookId)?.linkId ?? null;
        const targetInSourceWork = sourceLink !== null && memberByBook.get(item.targetBookId)?.linkId === sourceLink;
        const match: EditionLinkMatch = {
          id: item.id,
          bucket: item.bucket,
          score: item.score,
          titleScore: item.titleScore,
          authorScore: item.authorScore,
          isbnMatch: item.isbnMatch,
          reason: item.reason,
          source: this.toMatchBook(source, roleOf(source, item.sourceBookId)),
          target: this.toMatchBook(target, roleOf(target, item.targetBookId)),
          targetRole: item.targetRole,
          linkId: sourceLink,
          proposedAction: proposedActionFor(item.bucket, targetInSourceWork),
          competingBookIds: item.competingBookIds,
        };
        return [match];
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async linkMatch(user: RequestUser, resultId: number): Promise<void> {
    const result = await this.repo.findResult(resultId, user.id);
    if (!result) throw new NotFoundException('Match not found');
    await this.applyResult(user, result);
  }

  async linkAllStrong(user: RequestUser): Promise<LinkAllStrongResult> {
    const startedAt = Date.now();
    this.logger.log(`[work.link_all_strong] [start] userId=${user.id} - linking every strong match`);
    const scan = await this.repo.findLatestScan(user.id, 'done');
    let linked = 0;
    let skipped = 0;
    if (scan) {
      let afterId = 0;
      for (;;) {
        const batch = await this.repo.findStrongUnlinked(scan.id, afterId, LINK_ALL_BATCH);
        if (batch.length === 0) break;
        afterId = batch[batch.length - 1]!.id;
        for (const result of batch) {
          if (await this.tryApply(user, result)) linked++;
          else skipped++;
        }
      }
    }
    this.logger.log(
      `[work.link_all_strong] [end] userId=${user.id} scanId=${scan?.id ?? 'none'} durationMs=${Date.now() - startedAt} linked=${linked} skipped=${skipped} - strong matches linked`,
    );
    return { linked, skipped };
  }

  async dismiss(user: RequestUser, resultId: number): Promise<void> {
    const result = await this.repo.findResult(resultId, user.id);
    if (!result) throw new NotFoundException('Match not found');
    const [low, high] =
      result.sourceBookId < result.targetBookId ? [result.sourceBookId, result.targetBookId] : [result.targetBookId, result.sourceBookId];
    await this.repo.insertDismissal(user.id, low, high);
  }

  async listDismissals(user: RequestUser): Promise<EditionLinkMatchDismissal[]> {
    const rows = await this.repo.listDismissals(user.id, DISMISSAL_LIST_LIMIT);
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  async restoreDismissal(user: RequestUser, bookIdA: number, bookIdB: number): Promise<void> {
    const [low, high] = bookIdA < bookIdB ? [bookIdA, bookIdB] : [bookIdB, bookIdA];
    if ((await this.repo.deleteDismissal(user.id, low, high)) === 0) throw new NotFoundException('Dismissed pair not found');
  }

  /** Re-checks a strong result against the current links, since a link made after the scan can claim either side. */
  private async tryApply(user: RequestUser, result: EditionLinkMatchResult): Promise<boolean> {
    try {
      const members = await this.works.findWorkMembersForBooks([result.sourceBookId, result.targetBookId]);
      const source = members.find((member) => member.bookId === result.sourceBookId);
      const target = members.find((member) => member.bookId === result.targetBookId);
      if (source && target && source.linkId === target.linkId) return false;
      if (result.targetRole !== 'duplicate' && source) return false;
      if (target && result.targetRole !== 'duplicate' && members.some((member) => member.linkId === target.linkId && member.role === 'text'))
        return false;
      await this.applyResult(user, result);
      return true;
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[work.link_all_strong] [fail] userId=${user.id} resultId=${result.id} durationMs=0 errorClass=${errorClass} error="${sanitizeLogValue(message)}" - strong match skipped`,
      );
      return false;
    }
  }

  private async applyResult(user: RequestUser, result: EditionLinkMatchResult): Promise<void> {
    const { sourceBookId, targetBookId } = result;
    let linkId: number | null;
    if (result.targetRole === 'duplicate') {
      linkId = (await this.workService.addMember(user, sourceBookId, targetBookId)).linkId;
    } else if ((await this.readAlongOutputs.findReadAlongOutputs([sourceBookId])).has(sourceBookId)) {
      linkId = (await this.linkService.attachReadAlongByUser(user, targetBookId, sourceBookId)).id;
    } else {
      const members = await this.works.findWorkMembersForBooks([sourceBookId, targetBookId]);
      const source = members.find((member) => member.bookId === sourceBookId);
      const target = members.find((member) => member.bookId === targetBookId);
      if (source && target && source.linkId === target.linkId) throw new ConflictException('These books are already one work');
      if (result.bucket === 'linked_suspect' && source) await this.linkService.unlink(user, sourceBookId);
      linkId = (await this.linkService.link(user, sourceBookId, targetBookId)).id;
    }
    await this.repo.markLinked(result.id, linkId);
  }

  private async drainQueue(): Promise<void> {
    if (this.workerRunning) return;
    this.workerRunning = true;
    try {
      for (;;) {
        const job = this.queue.shift();
        if (!job) break;
        await this.runScan(job.scanId, job.user);
      }
    } finally {
      this.workerRunning = false;
    }
  }

  async runScan(scanId: number, user: RequestUser): Promise<void> {
    const event = 'work.match_scan';
    const startedAt = Date.now();
    const scan = await this.repo.findScan(scanId);
    if (!scan) return;
    this.logger.log(`[${event}] [start] scanId=${scanId} userId=${user.id} libraryId=${scan.libraryId ?? 'all'} - edition link scan started`);
    try {
      const settings = await this.settings.get(user.id);
      const accessible = await this.libraryService.findAccessibleLibraryIds(user);
      const libraryIds = scan.libraryId === null ? accessible : accessible.filter((id) => id === scan.libraryId);
      const total = await this.repo.countScanBooks(libraryIds, user);
      await this.repo.updateScan(scanId, { total, processed: 0 });

      let processed = 0;
      let stored = 0;
      let afterBookId = 0;
      for (;;) {
        const batch = await this.repo.findScanBatch(libraryIds, user, afterBookId, SCAN_BATCH);
        if (batch.length === 0) break;
        afterBookId = batch[batch.length - 1]!.id;
        const context = await this.loadBatchContext(user, libraryIds, scanId, settings.sameTypeAsOneWork, batch);
        const rows: NewEditionLinkMatchResult[] = [];
        for (const book of batch) rows.push(...(await this.evaluateBook(book, context)));
        await this.repo.insertResults(rows);
        stored += rows.length;
        processed += batch.length;
        await this.repo.updateScan(scanId, { processed });
      }

      const conflicts = await this.markConflicts(scanId, settings.sameTypeAsOneWork);
      await this.repo.updateScan(scanId, { state: 'done', processed, finishedAt: new Date() });
      await this.repo.deleteOlderScans(user.id, scanId);
      const autoLinked = settings.autoLinkStrong ? (await this.linkAllStrong(user)).linked : 0;
      if (autoLinked > 0) await this.repo.updateScan(scanId, { autoLinked });
      this.logger.log(
        `[${event}] [end] scanId=${scanId} userId=${user.id} durationMs=${Date.now() - startedAt} total=${total} stored=${stored} conflicts=${conflicts} autoLinked=${autoLinked} - edition link scan completed`,
      );
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.updateScan(scanId, { state: 'failed', error: 'scan_failed', finishedAt: new Date() }).catch(() => undefined);
      this.logger.warn(
        `[${event}] [fail] scanId=${scanId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - edition link scan failed`,
      );
    }
  }

  private async loadBatchContext(
    user: RequestUser,
    libraryIds: number[],
    scanId: number,
    duplicatesAllowed: boolean,
    batch: ScanBookRow[],
  ): Promise<BatchContext> {
    const ids = batch.map((book) => book.id);
    const [outputs, members, identifiers, dismissed] = await Promise.all([
      this.readAlongOutputs.findReadAlongOutputs(ids),
      this.works.findWorkMembersForBooks(ids),
      this.repo.findIdentifierMatches(ids, libraryIds, user),
      this.repo.findDismissedPairs(user.id, ids),
    ]);
    const membersByLink = new Map<number, WorkMemberRankRow[]>();
    for (const member of members) membersByLink.set(member.linkId, [...(membersByLink.get(member.linkId) ?? []), member]);
    const identifierTargets = new Map<number, { bookId: number; formats: string[] }[]>();
    for (const row of identifiers) {
      identifierTargets.set(row.sourceBookId, [
        ...(identifierTargets.get(row.sourceBookId) ?? []),
        { bookId: row.targetBookId, formats: row.targetFormats },
      ]);
    }
    return {
      user,
      libraryIds,
      scanId,
      duplicatesAllowed,
      outputs,
      membersByBook: new Map(members.map((member) => [member.bookId, member])),
      membersByLink,
      identifierTargets,
      dismissed,
    };
  }

  private async evaluateBook(book: ScanBookRow, context: BatchContext): Promise<NewEditionLinkMatchResult[]> {
    const role: ScanRole | null = context.outputs.has(book.id) ? 'readAlong' : roleOfFormats(book.formats);
    if (role === 'readAlong') return this.evaluateReadAlong(book, context);
    if (role === null) return [];

    const rows: NewEditionLinkMatchResult[] = [];
    if (role === 'text') {
      const counterpart = await this.evaluateCandidates(book, context, 'audio');
      if (counterpart) rows.push(counterpart);
    }
    if (context.duplicatesAllowed) {
      const duplicate = await this.evaluateCandidates(book, context, role);
      if (duplicate) rows.push(duplicate);
    }
    return rows;
  }

  private async evaluateCandidates(
    book: ScanBookRow,
    context: BatchContext,
    candidateRole: 'text' | 'audio',
  ): Promise<NewEditionLinkMatchResult | null> {
    const duplicateMode = roleOfFormats(book.formats) === candidateRole;
    const found = await this.links.findMatchCandidates({
      bookId: book.id,
      candidateModality: candidateRole,
      anyTextFormat: duplicateMode,
      accessibleLibraryIds: context.libraryIds,
      contentFilters: context.user.isSuperuser ? undefined : context.user.contentFilters,
    });
    const candidates = this.withIdentifierMatches(book, found, context, candidateRole).filter(
      (candidate) =>
        !context.dismissed.has(pairKey(book.id, candidate.bookId)) &&
        !context.outputs.has(candidate.bookId) &&
        !languagesDiffer(book.language, candidate.language) &&
        (!duplicateMode || candidate.bookId > book.id),
    );
    const extraMembers = await this.works.findWorkMembersForBooks(
      candidates.map((candidate) => candidate.bookId).filter((id) => !context.membersByBook.has(id)),
    );
    const memberOf = (bookId: number) => context.membersByBook.get(bookId) ?? extraMembers.find((member) => member.bookId === bookId);
    const allMembers = [...context.membersByBook.values(), ...extraMembers];
    const sourceMember = context.membersByBook.get(book.id);

    const scored: ScoredCandidate[] = candidates.map((candidate) => {
      const targetMember = memberOf(candidate.bookId);
      const claimedBy =
        !duplicateMode && targetMember && targetMember.linkId !== sourceMember?.linkId
          ? (allMembers.find((member) => member.linkId === targetMember.linkId && member.role === 'text' && member.isPrimary)?.bookId ?? null)
          : null;
      return {
        bookId: candidate.bookId,
        score: candidate.score,
        titleScore: candidate.titleScore,
        authorScore: candidate.authorScore,
        isbnMatch: candidate.score === IDENTIFIER_SCORE,
        prefixOnly: isPrefixOnlyTitle(book.title, candidate.title),
        claimedBy,
      };
    });

    let linkedTargetId: number | null = null;
    if (sourceMember) {
      const sameWork = (context.membersByLink.get(sourceMember.linkId) ?? []).filter(
        (member) => member.bookId !== book.id && member.role === candidateRole,
      );
      if (duplicateMode) {
        if (scored.some((candidate) => sameWork.some((member) => member.bookId === candidate.bookId))) return null;
      } else {
        linkedTargetId = sameWork.find((member) => member.isPrimary)?.bookId ?? sameWork[0]?.bookId ?? null;
      }
    }
    const usable = duplicateMode ? scored.filter((candidate) => !memberOf(candidate.bookId)) : scored;
    const match = classifyMatch(linkedTargetId, usable);
    if (!match) return null;
    if (duplicateMode && match.bucket !== 'strong' && match.bucket !== 'weak') return null;
    return {
      scanId: context.scanId,
      userId: context.user.id,
      sourceBookId: book.id,
      targetBookId: match.targetBookId,
      targetRole: duplicateMode ? 'duplicate' : candidateRole,
      bucket: match.bucket,
      score: match.score,
      titleScore: match.titleScore,
      authorScore: match.authorScore,
      isbnMatch: match.isbnMatch,
      reason: match.reason,
      linkId: sourceMember?.linkId ?? null,
      competingBookIds: match.competingBookIds,
    };
  }

  private withIdentifierMatches(
    book: ScanBookRow,
    found: MatchCandidate[],
    context: BatchContext,
    candidateRole: 'text' | 'audio',
  ): MatchCandidate[] {
    const byId = new Map(found.map((candidate) => [candidate.bookId, candidate]));
    for (const target of context.identifierTargets.get(book.id) ?? []) {
      if (roleOfFormats(target.formats) !== candidateRole) continue;
      const existing = byId.get(target.bookId);
      byId.set(target.bookId, {
        bookId: target.bookId,
        title: existing?.title ?? null,
        authorNames: existing?.authorNames ?? [],
        language: existing?.language ?? null,
        score: IDENTIFIER_SCORE,
        titleScore: existing?.titleScore ?? 0,
        authorScore: existing?.authorScore ?? 0,
      });
    }
    return [...byId.values()];
  }

  private async evaluateReadAlong(book: ScanBookRow, context: BatchContext): Promise<NewEditionLinkMatchResult[]> {
    const pair = await this.readAlongOutputs.findSourcePair(book.id);
    if (!pair || context.dismissed.has(pairKey(book.id, pair.audioBookId))) return [];
    const member = context.membersByBook.get(book.id);
    const audioMember = (await this.works.findWorkMembersForBooks([pair.audioBookId])).find((entry) => entry.bookId === pair.audioBookId);
    const together = member !== undefined && audioMember?.linkId === member.linkId;
    const bucket: EditionLinkMatchBucket = together ? 'linked_ok' : member ? 'linked_suspect' : 'strong';
    return [
      {
        scanId: context.scanId,
        userId: context.user.id,
        sourceBookId: book.id,
        targetBookId: pair.audioBookId,
        targetRole: 'audio',
        bucket,
        score: 1,
        titleScore: 1,
        authorScore: 1,
        isbnMatch: false,
        reason: together
          ? 'read-along of this audiobook'
          : member
            ? `read-along of #${pair.audioBookId} but linked to work #${member.linkId}`
            : 'generated from this audiobook',
        linkId: member?.linkId ?? null,
        competingBookIds: [],
      },
    ];
  }

  private async markConflicts(scanId: number, duplicatesAllowed: boolean): Promise<number> {
    const claims = await this.repo.findStrongClaims(scanId);
    if (claims.length === 0) return 0;
    const sourceIds = [...new Set(claims.map((claim) => claim.sourceBookId))];
    const [summaries, authors] = await Promise.all([this.links.findBookSummaries(sourceIds), this.repo.findAuthorNames(sourceIds)]);
    const sources = new Map(sourceIds.map((id) => [id, { title: summaries.get(id)?.title ?? null, authorNames: authors.get(id) ?? [] }]));
    const conflicts = detectConflicts(claims, sources, duplicatesAllowed);
    for (const [resultId, competing] of conflicts) await this.repo.markConflict(resultId, competing);
    return conflicts.size;
  }

  private toMatchBook(card: MatchBookCardRow, role: WorkVariantRole): EditionLinkMatchBook {
    return {
      id: card.id,
      title: card.title,
      authorName: card.authorName,
      coverVersion: card.coverUpdatedAt ? new Date(card.coverUpdatedAt).toISOString() : null,
      libraryId: card.libraryId,
      libraryName: card.libraryName,
      formats: card.formats,
      role,
      seriesName: card.seriesName,
      seriesIndex: card.seriesIndex,
      isbn: card.isbn,
      readStatus: card.readStatus,
      progress: card.progress === null ? null : Number(card.progress),
    };
  }

  private async toStatus(scan: EditionLinkMatchScan): Promise<EditionLinkScanStatus> {
    const [buckets, dismissed] = await Promise.all([this.repo.countBuckets(scan.id), this.repo.countDismissals(scan.userId)]);
    const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, buckets.get(bucket) ?? 0])) as Record<EditionLinkMatchBucket, number>;
    return {
      state: scan.state,
      scanId: scan.id,
      processed: scan.processed,
      total: scan.total,
      startedAt: scan.startedAt.toISOString(),
      finishedAt: scan.finishedAt?.toISOString() ?? null,
      error: scan.error,
      counts,
      dismissed,
      autoLinked: scan.autoLinked,
    };
  }

  private idleStatus(dismissed: number): EditionLinkScanStatus {
    const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<EditionLinkMatchBucket, number>;
    return { state: 'idle', scanId: null, processed: 0, total: 0, startedAt: null, finishedAt: null, error: null, counts, dismissed, autoLinked: 0 };
  }
}
