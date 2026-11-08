import { Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { ConsolidationTx } from './book-consolidation.repository';

export type { ConsolidationTx } from './book-consolidation.repository';

const MOVE_EVENT = 'book_consolidation.move_participant_rows';

/** A module whose tables hold rows about a book, moved onto the kept book before the merged-away one is deleted. */
export interface BookConsolidationParticipant {
  name: string;
  moveBookRows(tx: ConsolidationTx, keptBookId: number, sourceBookId: number): Promise<void>;
}

@Injectable()
export class BookConsolidationParticipants {
  private readonly logger = new Logger(BookConsolidationParticipants.name);
  private readonly registered: BookConsolidationParticipant[] = [];

  register(participant: BookConsolidationParticipant): void {
    this.registered.push(participant);
  }

  /** Runs one at a time because they share the merge's transaction; a failure rolls the whole merge back. */
  async moveAll(tx: ConsolidationTx, keptBookId: number, sourceBookId: number): Promise<void> {
    if (this.registered.length === 0) return;
    const startedAt = Date.now();
    this.logger.log(
      `[${MOVE_EVENT}] [start] keptBookId=${keptBookId} sourceBookId=${sourceBookId} participants=${this.registered.length} - moving participant rows`,
    );
    for (const participant of this.registered) {
      try {
        await participant.moveBookRows(tx, keptBookId, sourceBookId);
      } catch (error) {
        const errorClass = error instanceof Error ? error.name : 'Error';
        const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
        this.logger.error(
          `[${MOVE_EVENT}] [fail] keptBookId=${keptBookId} sourceBookId=${sourceBookId} participant=${participant.name} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - moving participant rows failed`,
        );
        throw error;
      }
    }
    this.logger.log(
      `[${MOVE_EVENT}] [end] keptBookId=${keptBookId} sourceBookId=${sourceBookId} durationMs=${Date.now() - startedAt} participants=${this.registered.length} - moved participant rows`,
    );
  }
}
