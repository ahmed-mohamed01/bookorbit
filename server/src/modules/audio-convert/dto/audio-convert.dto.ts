import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import {
  AUDIO_CONVERT_BACKUP_DAYS_MAX,
  AUDIO_CONVERT_BACKUP_DAYS_MIN,
  AUDIO_CONVERT_BITRATES,
  AUDIO_CONVERT_CODECS,
  type AudioConvertBitrate,
  type AudioConvertBookRunRequest,
  type AudioConvertChannels,
  type AudioConvertCodec,
  type AudioConvertPlanStatus,
  type AudioConvertRunRequest,
  type UpdateAudioConvertSettingsPayload,
} from '@bookorbit/types';

const PLAN_STATUSES = ['can_convert', 'waiting', 'converted', 'cannot'] as const;

/**
 * Optional but not nullable: `@IsOptional` would let `null` through to a NOT NULL column (a 500); this
 * skips only a missing field, so `null` fails validation with a 400.
 */
const IsOmittable = () => ValidateIf((_, value) => value !== undefined);

export class AudioConvertEncoderDto implements AudioConvertBookRunRequest {
  @IsOmittable()
  @IsIn(AUDIO_CONVERT_CODECS)
  codec?: AudioConvertCodec;

  @IsOmittable()
  @IsIn(AUDIO_CONVERT_BITRATES)
  bitrate?: AudioConvertBitrate;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn([1, 2])
  channels?: AudioConvertChannels;
}

export class AudioConvertRunDto extends AudioConvertEncoderDto implements AudioConvertRunRequest {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50_000)
  @IsInt({ each: true })
  excludeBookIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50_000)
  @IsInt({ each: true })
  includeBookIds?: number[];

  /** Same matching as the preview's `search`. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;
}

export class UpdateAudioConvertSettingsDto extends AudioConvertEncoderDto implements UpdateAudioConvertSettingsPayload {
  @IsOmittable()
  @IsBoolean()
  enabled?: boolean;

  @IsOmittable()
  @IsBoolean()
  autoConvert?: boolean;

  @IsOmittable()
  @IsBoolean()
  embedChapters?: boolean;

  @IsOmittable()
  @IsBoolean()
  embedMetadata?: boolean;

  @IsOmittable()
  @IsInt()
  @Min(AUDIO_CONVERT_BACKUP_DAYS_MIN)
  @Max(AUDIO_CONVERT_BACKUP_DAYS_MAX)
  backupDays?: number;
}

export class AudioConvertPreviewQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize = 50;

  @IsOptional()
  @IsIn(PLAN_STATUSES)
  status?: AudioConvertPlanStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;
}
