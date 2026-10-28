import { Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { ScanGateway } from '../scanner/scan.gateway';
import { EditionLinkRepository } from './edition-link.repository';

/**
 * Tells a reader's open pages that a book's work changed, over the same socket event a progress write
 * sends, without the achievement-bus event: that one drives trackers and integrations off real reading.
 */
@Injectable()
export class WorkEventsService {
  private readonly logger = new Logger(WorkEventsService.name);

  constructor(
    private readonly gateway: ScanGateway,
    private readonly links: EditionLinkRepository,
  ) {}

  async notifyBooksChanged(userId: number, bookIds: readonly number[], audioBookIds: readonly number[] = []): Promise<void> {
    const ids = [...new Set(bookIds)];
    if (ids.length === 0) return;
    try {
      const audio = new Set(audioBookIds);
      const percentages = await this.links.findReadingPercentages(
        userId,
        ids.map((bookId) => ({ bookId, audio: audio.has(bookId) })),
      );
      for (const bookId of ids) {
        this.gateway.emitBookProgressChanged({ userId, bookId, progress: percentages.get(bookId) ?? 0, source: 'web_reader' });
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[work.notify] [fail] userId=${userId} bookCount=${ids.length} durationMs=0 errorClass=${errorClass} error="${sanitizeLogValue(message)}" - work change notification failed`,
      );
    }
  }
}
