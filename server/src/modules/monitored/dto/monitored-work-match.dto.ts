import { IsIn, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { MONITORED_MATCH_DECISIONS } from '@bookorbit/types';
import type { MonitoredMatchDecision, MonitoredWorkMatchPayload } from '@bookorbit/types';

export class SetMonitoredWorkMatchDto implements MonitoredWorkMatchPayload {
  @IsIn(MONITORED_MATCH_DECISIONS)
  decision!: MonitoredMatchDecision;

  // `automatic` drops every answer for the format, so it names no book; the others must.
  @ValidateIf((object: SetMonitoredWorkMatchDto) => object.decision !== 'automatic' || object.bookId !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  bookId?: number;
}
