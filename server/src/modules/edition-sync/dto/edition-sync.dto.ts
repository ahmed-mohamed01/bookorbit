import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import {
  EDITION_SYNC_BOOK_SYNC_MODES,
  EDITION_SYNC_FILES_CHANGED_MODES,
  EDITION_SYNC_RUN_HOURS_MAX,
  EDITION_SYNC_RUN_HOURS_MIN,
  type EditionSyncBookSyncMode,
  type EditionSyncFilesChangedMode,
  type UpdateEditionSyncAdminSettingsPayload,
  type UpdateEditionSyncBookStatePayload,
  type UpsertEditionSyncSettingsPayload,
} from '@bookorbit/types';

import { IsEditionSyncCronExpression } from './edition-sync-cron.validator';

export class UpsertEditionSyncSettingsDto implements UpsertEditionSyncSettingsPayload {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(EDITION_SYNC_BOOK_SYNC_MODES)
  bookSyncMode?: EditionSyncBookSyncMode;
}

export class UpdateEditionSyncBookStateDto implements UpdateEditionSyncBookStatePayload {
  @IsBoolean()
  syncEnabled!: boolean;
}

export class UpdateEditionSyncAdminSettingsDto implements UpdateEditionSyncAdminSettingsPayload {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(EDITION_SYNC_FILES_CHANGED_MODES)
  onFilesChanged?: EditionSyncFilesChangedMode;

  /** null means Never (manual runs only); IsOptional lets null through. */
  @IsOptional()
  @IsEditionSyncCronExpression()
  cronExpression?: string | null;

  @IsOptional()
  @IsInt()
  @Min(EDITION_SYNC_RUN_HOURS_MIN)
  @Max(EDITION_SYNC_RUN_HOURS_MAX)
  runHours?: number;
}
