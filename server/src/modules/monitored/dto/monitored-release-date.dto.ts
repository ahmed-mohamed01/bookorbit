import { IsIn, IsString, Matches, MaxLength, Validate, ValidateIf, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';
import { MONITORED_FORMATS } from '@bookorbit/types';
import type { MonitoredFormat, SetMonitoredReleaseDatePayload } from '@bookorbit/types';

import { isPublishedDateKey } from '../../../common/utils/published-date.utils';

@ValidatorConstraint({ name: 'calendarDateKey', async: false })
class CalendarDateKeyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isPublishedDateKey(value);
  }

  defaultMessage(): string {
    return 'releaseDate must be a real calendar date';
  }
}

export class MonitoredWorkParamsDto {
  @IsString()
  @MaxLength(200)
  workId!: string;
}

export class MonitoredWorkFormatParamsDto extends MonitoredWorkParamsDto {
  @IsIn(MONITORED_FORMATS)
  format!: MonitoredFormat;
}

export class SetMonitoredReleaseDateDto implements SetMonitoredReleaseDatePayload {
  // Null is the owner handing the format back to the probe, so it skips the date checks rather than
  // failing them.
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @Validate(CalendarDateKeyConstraint)
  releaseDate!: string | null;
}
