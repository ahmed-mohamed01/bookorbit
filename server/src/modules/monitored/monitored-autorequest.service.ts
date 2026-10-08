import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isWorkVisible, MONITORED_FORMATS } from '@bookorbit/types';
import type { MonitoredAuthorConfig, MonitoredFormat, MonitoredWork } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookRequestService } from '../book-request/book-request.service';
import { MonitoredStoreService } from './monitored-store.service';
import { releaseDateRange } from './release-window';

type AutoRequestOptions = { autoGrab?: boolean; deferAutomation?: boolean };
type FanOutResult = { created: number; skipped: number; failed: number };
type Candidate = { work: MonitoredWork; format: MonitoredFormat; releaseStart: string };

export type ThrottledSubmitOutcome<C, T> =
  | { candidate: C; status: 'fulfilled'; value: T }
  | { candidate: C; status: 'rejected'; reason: unknown; destinationRefusal: boolean }
  | { candidate: C; status: 'stopped' };

const FAN_OUT_CONCURRENCY = 3;
const DESTINATION_ERROR_CODES = new Set(['SUBMIT_DESTINATION_REQUIRED', 'SUBMIT_DEFAULT_LIBRARY_UNREACHABLE']);

/** The formats a monitor files requests for on its own: none while paused. */
export function autoRequestFormats(monitor: MonitoredAuthorConfig): MonitoredFormat[] {
  if (monitor.paused) return [];
  return MONITORED_FORMATS.filter((format) => {
    const mode = monitor.formats[format].mode;
    return mode === 'auto-all' || mode === 'auto-upcoming';
  });
}

/** Everything that makes a (work, format) requestable apart from its release date. */
export function isRequestable(work: MonitoredWork, format: MonitoredFormat): boolean {
  return (
    isWorkVisible(work) &&
    work.monitorState === 'monitoring' &&
    work.monitorFormats?.[format] !== false &&
    !work.ownedFormats.includes(format) &&
    work.matchedBookIds?.[format] == null &&
    work.requestIds[format] == null
  );
}

/**
 * A day-precise date is due from that day. A month or year date is due only once its whole range
 * has passed, the same rule as the watcher's `releaseDueSql`: a request filed on the first of a
 * month-dated book searches trackers for weeks for a book that is not out.
 */
export function releaseDue(range: { start: string; end: string }, today: string): boolean {
  return range.start === range.end ? range.start <= today : range.end < today;
}

export function isDestinationRefusal(error: unknown): boolean {
  if (!(error instanceof BadRequestException)) return false;
  const response = error.getResponse();
  if (typeof response !== 'object' || response === null || !('errorCode' in response)) return false;
  return DESTINATION_ERROR_CODES.has(String(response.errorCode));
}

/**
 * Runs `submit` over the candidates a few at a time, in order. Only the first chunk may start
 * automation straight away (`deferred` is true after it), so one pass cannot fire a burst of
 * searches. A destination refusal means every later candidate of that format would be refused the
 * same way, so they are stopped rather than submitted.
 */
export async function submitThrottled<C extends { format: MonitoredFormat }, T>(
  candidates: C[],
  submit: (candidate: C, deferred: boolean) => Promise<T>,
): Promise<ThrottledSubmitOutcome<C, T>[]> {
  const outcomes: ThrottledSubmitOutcome<C, T>[] = [];
  const stoppedFormats = new Set<MonitoredFormat>();
  for (let chunkStart = 0; chunkStart < candidates.length; chunkStart += FAN_OUT_CONCURRENCY) {
    const chunk = candidates.slice(chunkStart, chunkStart + FAN_OUT_CONCURRENCY).map((candidate, offset) => ({
      candidate,
      deferred: chunkStart + offset >= FAN_OUT_CONCURRENCY,
    }));
    const active = chunk.filter(({ candidate }) => !stoppedFormats.has(candidate.format));
    const results = await Promise.allSettled(active.map(({ candidate, deferred }) => submit(candidate, deferred)));
    const settled = new Map(active.map((entry, index) => [entry, results[index]]));
    for (const entry of chunk) {
      const { candidate } = entry;
      const result = settled.get(entry);
      if (!result) {
        outcomes.push({ candidate, status: 'stopped' });
      } else if (result.status === 'fulfilled') {
        outcomes.push({ candidate, status: 'fulfilled', value: result.value });
      } else {
        const destinationRefusal = isDestinationRefusal(result.reason);
        if (destinationRefusal) stoppedFormats.add(candidate.format);
        outcomes.push({ candidate, status: 'rejected', reason: result.reason, destinationRefusal });
      }
    }
  }
  return outcomes;
}

@Injectable()
export class MonitoredAutoRequestService {
  private readonly logger = new Logger(MonitoredAutoRequestService.name);

  constructor(
    private readonly bookRequests: BookRequestService,
    private readonly store: MonitoredStoreService,
  ) {}

  async submitWorkRequest(
    user: RequestUser,
    monitor: MonitoredAuthorConfig,
    work: MonitoredWork,
    format: MonitoredFormat,
    opts: AutoRequestOptions = {},
  ): Promise<MonitoredWork> {
    const formatConfig = monitor.formats[format];
    const seriesIndexValue = work.seriesIndex == null ? Number.NaN : Number.parseFloat(work.seriesIndex);
    const result = await this.bookRequests.submit(
      {
        userId: monitor.ownerUserId,
        title: work.title,
        mediaKind: format,
        ...(work.subtitle ? { subtitle: work.subtitle } : {}),
        authors: [monitor.authorName],
        ...(work.seriesName ? { seriesName: work.seriesName } : {}),
        ...(Number.isInteger(seriesIndexValue) && seriesIndexValue >= 0 ? { seriesIndex: seriesIndexValue } : {}),
        ...(work.releaseYear ? { publishedYear: work.releaseYear } : {}),
        ...(work.coverUrl ? { coverUrl: work.coverUrl } : {}),
        providerKey: 'hardcover',
        providerId: work.providerWorkIds.hardcover,
        ...(formatConfig.libraryId ? { targetLibraryId: formatConfig.libraryId } : {}),
        ...(formatConfig.folderId ? { targetFolderId: formatConfig.folderId } : {}),
        ...(opts.autoGrab !== undefined ? { autoGrab: opts.autoGrab } : {}),
        ...(opts.deferAutomation !== undefined ? { deferAutomation: opts.deferAutomation } : {}),
      },
      user,
    );
    const patch = { requestIds: { [format]: result.request.id } };
    try {
      return await this.store.updateWorkUserState(work.id, patch, user);
    } catch {
      // The request row already exists, so losing this write drops the terminal-id block and a
      // cancelled request could be refiled by a later fan-out. Retry once, then log the request id
      // so the link is recoverable; while the request stays active, submit dedupe folds re-submits.
      try {
        return await this.store.updateWorkUserState(work.id, patch, user);
      } catch (error) {
        const errorClass = error instanceof Error ? error.name : 'Error';
        const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
        this.logger.warn(
          `[monitored.autorequest.persist] [fail] workId="${sanitizeLogValue(work.id)}" format=${format} requestId=${result.request.id} errorClass=${errorClass} error="${message}" - request id not persisted to monitored work`,
        );
        throw error;
      }
    }
  }

  async fanOut(monitor: MonitoredAuthorConfig, works: MonitoredWork[], user: RequestUser): Promise<FanOutResult> {
    const formats = autoRequestFormats(monitor);
    if (formats.length === 0) return { created: 0, skipped: 0, failed: 0 };

    let skipped = 0;
    const today = new Date().toISOString().slice(0, 10);
    const addedDay = monitor.addedAt.slice(0, 10);
    const candidates: Candidate[] = [];

    for (const work of works) {
      for (const format of formats) {
        const releaseDate = format === 'ebook' ? work.ebookReleaseDate : work.audioReleaseDate;
        const precision = format === 'ebook' ? work.ebookDatePrecision : work.audioDatePrecision;
        const range = releaseDate ? releaseDateRange(releaseDate, precision) : null;
        const mode = monitor.formats[format].mode;
        const qualifies = isRequestable(work, format) && range !== null && releaseDue(range, today) && (mode === 'auto-all' || range.end >= addedDay);
        if (qualifies && range) candidates.push({ work, format, releaseStart: range.start });
        else skipped++;
      }
    }

    candidates.sort((left, right) => right.releaseStart.localeCompare(left.releaseStart));
    if (candidates.length === 0) return { created: 0, skipped, failed: 0 };

    const startedAt = Date.now();
    this.logger.log(
      `[monitored.autorequest.fan_out] [start] monitorId="${sanitizeLogValue(monitor.id)}" userId=${user.id} candidates=${candidates.length} ebookMode=${monitor.formats.ebook.mode} audiobookMode=${monitor.formats.audiobook.mode} - auto-request fan-out started`,
    );

    let created = 0;
    let failed = 0;
    try {
      const outcomes = await submitThrottled(candidates, (candidate, deferred) =>
        this.submitWorkRequest(user, monitor, candidate.work, candidate.format, {
          // The auto_grab override feeds findDueForResearch even when instance auto-search is off; operators disable monitoring to stop that spend.
          autoGrab: true,
          ...(deferred ? { deferAutomation: true } : {}),
        }),
      );
      const refusalLogged = new Set<MonitoredFormat>();
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') {
          created++;
        } else if (outcome.status === 'stopped') {
          skipped++;
        } else {
          failed++;
          if (outcome.destinationRefusal && refusalLogged.has(outcome.candidate.format)) continue;
          if (outcome.destinationRefusal) refusalLogged.add(outcome.candidate.format);
          this.logSubmitFailure(monitor.id, outcome.candidate, outcome.reason);
        }
      }
    } catch (error) {
      failed++;
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.autorequest.fan_out] [fail] monitorId="${sanitizeLogValue(monitor.id)}" userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - auto-request fan-out failed`,
      );
    }

    this.logger.log(
      `[monitored.autorequest.fan_out] [end] monitorId="${sanitizeLogValue(monitor.id)}" userId=${user.id} durationMs=${Date.now() - startedAt} created=${created} skipped=${skipped} failed=${failed} - auto-request fan-out completed`,
    );
    return { created, skipped, failed };
  }

  private logSubmitFailure(monitorId: string, candidate: Candidate, error: unknown): void {
    const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[monitored.autorequest.submit] [fail] monitorId="${sanitizeLogValue(monitorId)}" workId="${sanitizeLogValue(candidate.work.id)}" format=${candidate.format} errorClass=${errorClass} error="${message}" - auto-request submit failed`,
    );
  }
}
