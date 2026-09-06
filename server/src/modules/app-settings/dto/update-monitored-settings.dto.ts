import { IsInt, Max, Min } from 'class-validator';

export class UpdateMonitoredSettingsDto {
  @IsInt()
  @Min(1)
  @Max(1440)
  refreshCooldownMinutes: number;
}
