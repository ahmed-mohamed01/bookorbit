import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import type {
  AudiobookshelfBookStateBucket,
  AudiobookshelfConnectionTestPayload,
  AudiobookshelfExclusionPayload,
  AudiobookshelfLinkBookPayload,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types';

const AUDIOBOOKSHELF_BOOK_STATE_BUCKETS: AudiobookshelfBookStateBucket[] = ['linked', 'needs-review', 'unmatched'];

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
