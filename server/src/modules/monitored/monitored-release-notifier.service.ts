import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@bookorbit/types';
import type { MonitoredAuthorConfig } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { NotificationService } from '../notification/notification.service';
import type { MonitoredDueRelease } from './monitored-store.service';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Upstream stores notification titles in a varchar(255) and every other caller passes a constant;
 * a catalog title can be four times that, and an insert that overflows is retried every hour.
 */
const MAX_TITLE_LENGTH = 200;

function clampTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 3)}...` : title;
}

/**
 * Says only as much about the date as the catalog actually knows. A provider that gave us a year
 * gets "in 2026"; only a full date earns "on 2026-09-10".
 */
function describeReleaseDate(storedDate: string): string {
  if (storedDate.length === 4) return `in ${storedDate}`;
  if (storedDate.length === 7) {
    const month = MONTHS[Number(storedDate.slice(5, 7)) - 1];
    return month ? `in ${month} ${storedDate.slice(0, 4)}` : `in ${storedDate}`;
  }
  return `on ${storedDate}`;
}

/**
 * Tells the one person who asked that a book they monitor has reached its release date.
 *
 * Monitored lists are strictly per-user, so the audience is always the monitor's owner - there is
 * no approver queue or subscriber fan-out to resolve. A failed notification releases its ledger
 * lease so the next tick can try it again.
 */
@Injectable()
export class MonitoredReleaseNotifier {
  private readonly logger = new Logger(MonitoredReleaseNotifier.name);

  constructor(private readonly notifications: NotificationService) {}

  /**
   * One notification per work: the formats that became due together are named in one message,
   * the way the Releases tab folds sibling format rows into one card. `releases` is never empty and
   * every entry belongs to the same work.
   */
  async notifyRelease(monitor: MonitoredAuthorConfig, releases: MonitoredDueRelease[]): Promise<void> {
    const [first] = releases;
    await this.notifications.notify({
      type: NotificationType.MonitoredReleaseAvailable,
      title: `${clampTitle(first.title)} is out now`,
      message: this.describeMessage(monitor, releases),
      actionUrl: `/monitored/authors/${monitor.id}`,
      meta: {
        monitorAuthorId: monitor.id,
        workId: first.workId,
        formats: releases.map((release) => release.format),
        releaseDates: Object.fromEntries(releases.map((release) => [release.format, release.storedDate])),
      },
      scope: { kind: 'user', userId: monitor.ownerUserId },
    });
  }

  logDispatchFailure(monitor: MonitoredAuthorConfig, releases: MonitoredDueRelease[], startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    const formats = releases.map((release) => release.format).join(',');
    this.logger.warn(
      `[monitored.release.notify] [fail] monitorId="${sanitizeLogValue(monitor.id)}" userId=${monitor.ownerUserId} workId="${sanitizeLogValue(releases[0].workId)}" formats=${formats} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - release notification dispatch failed`,
    );
  }

  private describeMessage(monitor: MonitoredAuthorConfig, releases: MonitoredDueRelease[]): string {
    const [first, ...rest] = releases;
    const subject = `${this.describeWork(first)} by ${monitor.authorName}`;
    if (rest.every((release) => release.storedDate === first.storedDate)) {
      const formats = releases.map((release) => release.format).join(' and ');
      return `The ${formats} of ${subject} released ${describeReleaseDate(first.storedDate)}.`;
    }
    const others = rest.map((release) => `the ${release.format} released ${describeReleaseDate(release.storedDate)}`).join(', ');
    return `The ${first.format} of ${subject} released ${describeReleaseDate(first.storedDate)}, and ${others}.`;
  }

  private describeWork(release: MonitoredDueRelease): string {
    if (!release.seriesName) return release.title;
    const position = release.seriesIndex ? ` #${release.seriesIndex}` : '';
    return `${release.title} (${release.seriesName}${position})`;
  }
}
