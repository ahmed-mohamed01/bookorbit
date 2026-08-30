import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import type {
  AudiobookshelfBookStateBucket,
  AudiobookshelfCleanupPayload,
  AudiobookshelfConnectionTestPayload,
  AudiobookshelfExclusionPayload,
  AudiobookshelfLinkBookPayload,
  AudiobookshelfPathMapping,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types';

const AUDIOBOOKSHELF_BOOK_STATE_BUCKETS: AudiobookshelfBookStateBucket[] = ['linked', 'needs-review', 'unmatched'];
const PATH_PREFIX_MAX_LENGTH = 500;

const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AudiobookshelfPathMappingDto implements AudiobookshelfPathMapping {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_PREFIX_MAX_LENGTH)
  absPrefix!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_PREFIX_MAX_LENGTH)
  localPrefix!: string;
}

export class UpsertAudiobookshelfSettingsDto implements UpsertAudiobookshelfSettingsPayload {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  serverUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  apiToken?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  syncStatus?: boolean;

  @IsOptional()
  @IsBoolean()
  syncPosition?: boolean;

  @IsOptional()
  @IsBoolean()
  syncSessions?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(255, { each: true })
  excludedLibraryIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AudiobookshelfPathMappingDto)
  pathMappings?: AudiobookshelfPathMappingDto[];
}

export class TestAudiobookshelfConnectionDto implements AudiobookshelfConnectionTestPayload {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  serverUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  apiToken?: string;
}

export class ListAudiobookshelfBookStatesDto {
  @IsIn(AUDIOBOOKSHELF_BOOK_STATE_BUCKETS)
  bucket!: AudiobookshelfBookStateBucket;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page?: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;
}

export class LinkAudiobookshelfBookDto implements AudiobookshelfLinkBookPayload {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  bookId!: number;
}

export class UpdateAudiobookshelfExclusionDto implements AudiobookshelfExclusionPayload {
  @IsBoolean()
  syncExcluded!: boolean;
}

export class CleanupAudiobookshelfStaleDto implements AudiobookshelfCleanupPayload {
  @IsOptional()
  @IsBoolean()
  includeManuallyUnlinked?: boolean;
}
