import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type {
  MoveWebSerialJobInput,
  MoveWebSerialJobResult,
  WebSerialJobStatus,
  WebSerialMoveCandidate,
  WebSerialMoveCandidates,
} from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { EngineSeries } from './engines/web-serial-engine';
import { WebSerialsCatalogService } from './web-serials-catalog.service';
import { WebSerialJobsService } from './web-serials-jobs.service';
import { WebSerialsJobRunnerService } from './web-serials-job-runner.service';
import { describeError } from './web-serials-log.utils';
import { resolveWebSerialAuthors } from './web-serials-metadata.utils';
import {
  carriedVolumes,
  countAvailableMembers,
  isFullyAvailable,
  countMembers,
  describeMoveUnit,
  indexSavedUnits,
  type MoveItemInput,
  type MoveUnit,
} from './web-serials-move.utils';
import { assertValidSelection, selectUnits, sequenceKey } from './web-serials-selection.utils';
import { parseSeriesKey, seriesCoverPath } from './web-serials-series-key.utils';
import { MAX_SOURCE_CANDIDATES, sameSource } from './web-serials-source.utils';
import { ACTIVE_STATUSES, WebSerialsRepository, type WebSerialJobWithLibrary, type WebSerialMoveItem } from './web-serials.repository';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from './web-serials-error.utils';

const MOVE_EVENT = 'web_serials.job_move';
const MAX_MOVE_SEQUENCES = 5_000;
const MOVE_SETTLE_TIMEOUT_MS = 15_000;
const MOVE_SETTLE_POLL_MS = 250;

@Injectable()
export class WebSerialJobMoveService {
  private readonly logger = new Logger(WebSerialJobMoveService.name);

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly catalog: WebSerialsCatalogService,
    private readonly jobs: WebSerialJobsService,
    private readonly runner: WebSerialsJobRunnerService,
  ) {}

  async getMoveCandidates(id: number, user: RequestUser): Promise<WebSerialMoveCandidates> {
    const job = await this.jobs.getAccessibleJob(id, user);
    this.assertMangaMove(job);
    const remaining = await this.remainingMoveUnits(job);
    if (remaining.length === 0) throw new ConflictException(codedError('Nothing left to move.', WebSerialErrorCode.MoveNothingLeft));
    const remainingTotal = countMembers(remaining);

    const found = await this.catalog.findMangaSourceCandidates({
      sourceTitle: job.title,
      sourceName: job.sourceName,
      query: job.metadata.match?.title?.trim() || job.title,
      matchId: job.metadata.match?.id ?? job.metadata.override?.matchId ?? null,
    });
    const candidates = found.candidates
      .map(({ hit, seriesKey, series, confidence }): WebSerialMoveCandidate | null => {
        const available = new Set(series.units.map((unit) => sequenceKey(unit.sequence)));
        const remainingAvailable = countAvailableMembers(remaining, available);
        if (remainingAvailable === 0) return null;
        return {
          seriesKey,
          title: hit.title,
          sourceName: hit.sourceName,
          coverUrl: hit.remoteCoverPath ? seriesCoverPath(seriesKey) : null,
          confidence,
          remainingAvailable,
          remainingTotal,
        };
      })
      .filter((candidate) => candidate !== null);

    candidates.sort(
      (left, right) =>
        Number(right.confidence === 'same_series') - Number(left.confidence === 'same_series') ||
        right.remainingAvailable - left.remainingAvailable ||
        left.title.localeCompare(right.title),
    );
    return { remainingTotal, candidates: candidates.slice(0, MAX_SOURCE_CANDIDATES), failedSources: found.failedSources };
  }

  async moveJob(id: number, input: MoveWebSerialJobInput, user: RequestUser): Promise<MoveWebSerialJobResult> {
    const startedAt = Date.now();
    let targetSource = 'unknown';
    let moved = 0;
    let missing = 0;
    let pausedByMove = false;
    let queueOrder = 0;
    try {
      const job = await this.jobs.getAccessibleJob(id, user);
      queueOrder = job.queueOrder;
      this.assertMangaMove(job);
      const targetKey = parseSeriesKey(input.seriesKey);
      if (targetKey.kind !== 'manga')
        throw new BadRequestException(codedError('The target must be a manga series.', WebSerialErrorCode.MoveTargetNotManga));
      if (input.seriesKey === job.seriesKey)
        throw new BadRequestException(codedError('Choose a different source.', WebSerialErrorCode.MoveSameSource));

      const targetSeries = await this.catalog.loadSeries('manga', targetKey.remoteId, input.seriesKey);
      targetSource = targetSeries.sourceName;
      if (sameSource(targetSource, job.sourceName))
        throw new BadRequestException(codedError('Choose a different source.', WebSerialErrorCode.MoveSameSource));
      this.logger.log(`[${MOVE_EVENT}] [start] jobId=${id} targetSource="${sanitizeLogValue(targetSource)}" moved=0 missing=0 - job move started`);
      const planned = await this.remainingMoveUnits(job);
      if (planned.length === 0) throw new ConflictException(codedError('Nothing left to move.', WebSerialErrorCode.MoveNothingLeft));
      this.pickMovedUnits(planned, targetSeries);

      const settleDeadline = Date.now() + MOVE_SETTLE_TIMEOUT_MS;
      let expectedStatus: WebSerialJobStatus = job.status;
      if (ACTIVE_STATUSES.includes(job.status)) {
        if (await this.repo.pauseJob(id)) {
          pausedByMove = true;
          expectedStatus = 'paused';
          this.runner.interruptChapterFetch(id);
        } else {
          const current = await this.repo.getJobStatus(id);
          if (!current || ACTIVE_STATUSES.includes(current))
            throw new ConflictException(codedError('The download is busy; try again in a moment.', WebSerialErrorCode.MoveBusy));
          expectedStatus = current;
        }
      }
      if (!(await this.runner.waitForJobToSettle(id, Math.max(0, settleDeadline - Date.now())))) {
        throw new ConflictException(codedError('The download is busy; try again in a moment.', WebSerialErrorCode.MoveBusy));
      }
      await this.waitForMoveSettle(id, settleDeadline);
      const settledStatus = await this.repo.getJobStatus(id);
      if (!settledStatus || ACTIVE_STATUSES.includes(settledStatus)) {
        throw new ConflictException(codedError('The download is busy; try again in a moment.', WebSerialErrorCode.MoveBusy));
      }
      if (settledStatus !== expectedStatus) {
        throw new ConflictException(
          codedError('The download changed while it was being moved; check it and try again.', WebSerialErrorCode.MoveChanged),
        );
      }
      await this.materializeMoveItems(job);

      const remaining = await this.remainingMoveUnits(job);
      if (remaining.length === 0) throw new ConflictException(codedError('Nothing left to move.', WebSerialErrorCode.MoveNothingLeft));
      const { movedUnits, missingUnits } = this.pickMovedUnits(remaining, targetSeries);
      moved = movedUnits.length;
      missing = missingUnits.length;

      const sequences = uniqueSequences(movedUnits.flatMap((unit) => unit.members));
      assertValidSelection({ mode: 'list', sequences });
      const selectedUnits = selectUnits(targetSeries, job.packaging, { mode: 'list', sequences }, carriedVolumes(movedUnits, targetSeries.units));
      if (selectedUnits.length === 0)
        throw new ConflictException(codedError('That source does not have any remaining chapters.', WebSerialErrorCode.MoveNoChapters));
      const metadata = job.metadata;
      const finalAuthors = resolveWebSerialAuthors(targetSeries, metadata);
      const target = await this.repo.moveJob({
        sourceJobId: id,
        sourceExpectedStatus: settledStatus,
        movedItemIds: movedUnits.map((unit) => unit.id),
        missingItemIds: missingUnits.map((unit) => unit.id),
        sourceMessage: `Remaining chapters moved to ${targetSource}.`,
        movedError: `Moved to ${targetSource}.`,
        missingError: `Not available on ${targetSource}.`,
        targetJob: {
          userId: job.userId,
          kind: 'manga',
          seriesKey: input.seriesKey,
          seriesUrl: targetSeries.sourceUrl,
          title: targetSeries.title.slice(0, 1000),
          author: finalAuthors.join(', ').slice(0, 1000) || null,
          sourceName: targetSource.slice(0, 255),
          packaging: job.packaging,
          selection: { mode: 'list', sequences },
          skipImported: true,
          targetLibraryId: job.targetLibraryId,
          targetFolderId: job.targetFolderId,
          status: 'queued',
          engineState: { hasCover: targetSeries.remoteCoverPath !== null, units: selectedUnits },
          metadata,
        },
      });
      if (!target) throw new ConflictException(codedError('The download is busy; try again in a moment.', WebSerialErrorCode.MoveBusy));
      pausedByMove = false;
      await this.jobs.discardWorkDir(id);
      const result = { from: await this.jobs.requireJob(id, user), to: await this.jobs.requireJob(target.id, user) };
      this.logger.log(
        `[${MOVE_EVENT}] [end] jobId=${id} targetSource="${sanitizeLogValue(targetSource)}" durationMs=${Date.now() - startedAt} moved=${moved} missing=${missing} - job move completed`,
      );
      return result;
    } catch (error) {
      if (pausedByMove) await this.repo.restoreAfterMove(id, queueOrder).catch(() => undefined);
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${MOVE_EVENT}] [fail] jobId=${id} targetSource="${sanitizeLogValue(targetSource)}" durationMs=${Date.now() - startedAt} moved=${moved} missing=${missing} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - job move failed`,
      );
      throw error;
    }
  }

  /** A unit moves only when every chapter it needs is on the target; a partly available volume stays behind as missing. */
  private pickMovedUnits(remaining: MoveUnit[], targetSeries: EngineSeries): { movedUnits: MoveUnit[]; missingUnits: MoveUnit[] } {
    const available = new Set(targetSeries.units.map((unit) => sequenceKey(unit.sequence)));
    const movedUnits = remaining.filter((unit) => isFullyAvailable(unit, available));
    if (movedUnits.length === 0)
      throw new ConflictException(codedError('That source does not have any remaining chapters.', WebSerialErrorCode.MoveNoChapters));
    return { movedUnits, missingUnits: remaining.filter((unit) => !movedUnits.includes(unit)) };
  }

  private assertMangaMove(job: WebSerialJobWithLibrary): void {
    if (job.kind !== 'manga')
      throw new BadRequestException(codedError('Moving novels between sites is not supported yet.', WebSerialErrorCode.MoveNovelUnsupported));
  }

  private async remainingMoveUnits(job: WebSerialJobWithLibrary): Promise<MoveUnit[]> {
    const units = await this.repo.findJobUnits(job.id);
    const saved = indexSavedUnits(units);
    const describe = (items: MoveItemInput[]) => items.map((item) => describeMoveUnit(item, saved.byKey, saved.bySequence));
    const items: WebSerialMoveItem[] = await this.repo.findMoveItems(job.id, MAX_MOVE_SEQUENCES + 1);
    if (items.length > MAX_MOVE_SEQUENCES)
      throw new BadRequestException(
        codedError('Too many chapters are left to move at once.', WebSerialErrorCode.MoveTooMany, { limit: MAX_MOVE_SEQUENCES }),
      );
    if (items.length > 0) return this.boundedMoveUnits(describe(items));
    const counts = await this.repo.countItemsByStatus(job.id);
    if (Object.values(counts).some((count) => (count ?? 0) > 0)) return [];
    if (units.length > MAX_MOVE_SEQUENCES)
      throw new BadRequestException(
        codedError('Too many chapters are left to move at once.', WebSerialErrorCode.MoveTooMany, { limit: MAX_MOVE_SEQUENCES }),
      );
    return this.boundedMoveUnits(describe(units.map((unit, index) => ({ id: -(index + 1), sequence: unit.sequence, unitKey: unit.unitKey }))));
  }

  private boundedMoveUnits(units: MoveUnit[]): MoveUnit[] {
    if (countMembers(units) > MAX_MOVE_SEQUENCES)
      throw new BadRequestException(
        codedError('Too many chapters are left to move at once.', WebSerialErrorCode.MoveTooMany, { limit: MAX_MOVE_SEQUENCES }),
      );
    return units;
  }

  private async materializeMoveItems(job: WebSerialJobWithLibrary): Promise<void> {
    const counts = await this.repo.countItemsByStatus(job.id);
    if (Object.values(counts).some((count) => (count ?? 0) > 0)) return;
    const units = await this.repo.findJobUnits(job.id);
    await this.repo.insertItems(
      units.map((unit) => ({
        jobId: job.id,
        unitKey: unit.unitKey,
        label: unit.label.slice(0, 1000),
        sequence: unit.sequence,
        remoteRef: { unit, handle: null },
      })),
    );
    await this.repo.refreshCounters(job.id);
  }

  private async waitForMoveSettle(jobId: number, deadline: number): Promise<void> {
    while (Date.now() <= deadline) {
      const [status, inFlight] = await Promise.all([this.repo.getJobStatus(jobId), this.repo.hasInFlightItems(jobId)]);
      if (status === undefined) throw new NotFoundException(codedError('Download not found', WebSerialErrorCode.JobNotFound));
      if (!ACTIVE_STATUSES.includes(status) && !inFlight) return;
      await this.sleep(MOVE_SETTLE_POLL_MS);
    }
    throw new ConflictException(codedError('The download is busy; try again in a moment.', WebSerialErrorCode.MoveBusy));
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function uniqueSequences(sequences: string[]): string[] {
  const seen = new Set<string>();
  return sequences.filter((sequence) => {
    const key = sequenceKey(sequence);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
