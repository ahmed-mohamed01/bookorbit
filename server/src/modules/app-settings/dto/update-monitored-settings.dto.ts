import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

import { MAX_MONITORED_SYNC_INTERVAL_HOURS, MIN_MONITORED_SYNC_INTERVAL_HOURS } from '../../../common/constants/app-settings.constants';

export class UpdateMonitoredSettingsDto {
  @IsInt()
  @Min(1)
  @Max(1440)
  refreshCooldownMinutes: number;

  @IsOptional()
  @IsBoolean()
  syncEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(MIN_MONITORED_SYNC_INTERVAL_HOURS)
  @Max(MAX_MONITORED_SYNC_INTERVAL_HOURS)
  syncIntervalHours?: number;
}
