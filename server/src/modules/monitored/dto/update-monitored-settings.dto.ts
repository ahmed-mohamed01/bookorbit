import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

import {
  MAX_MONITORED_REFRESH_COOLDOWN_MINUTES,
  MAX_MONITORED_SYNC_INTERVAL_HOURS,
  MIN_MONITORED_REFRESH_COOLDOWN_MINUTES,
  MIN_MONITORED_SYNC_INTERVAL_HOURS,
} from '../monitored-settings.constants';

export class UpdateMonitoredSettingsDto {
  @IsInt()
  @Min(MIN_MONITORED_REFRESH_COOLDOWN_MINUTES)
  @Max(MAX_MONITORED_REFRESH_COOLDOWN_MINUTES)
  refreshCooldownMinutes: number;

  @IsOptional()
  @IsBoolean()
  syncEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(MIN_MONITORED_SYNC_INTERVAL_HOURS)
  @Max(MAX_MONITORED_SYNC_INTERVAL_HOURS)
  syncIntervalHours?: number;

  @IsOptional()
  @IsBoolean()
  releaseProbeEnabled?: boolean;
}
