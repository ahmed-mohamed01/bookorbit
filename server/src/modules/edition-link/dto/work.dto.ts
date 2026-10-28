import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { EditionLinkMatchBucket, WorkPositionSync } from '@bookorbit/types';

const BUCKETS: readonly EditionLinkMatchBucket[] = ['linked_ok', 'linked_suspect', 'conflict', 'strong', 'weak'];
const POSITION_SYNC: readonly WorkPositionSync[] = ['off', 'precise', 'rough'];

export class AddWorkMemberDto {
  @IsInt()
  @Min(1)
  bookId: number;
}

export class UpdateEditionLinkSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  shareReadingState?: boolean;

  @IsOptional()
  @IsBoolean()
  sameTypeAsOneWork?: boolean;

  @IsOptional()
  @IsIn(POSITION_SYNC)
  positionSync?: WorkPositionSync;

  @IsOptional()
  @IsBoolean()
  autoLinkStrong?: boolean;
}

export class StartMatchScanDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  libraryId?: number;
}

export class ListMatchesQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0),
  )
  @ArrayMaxSize(BUCKETS.length)
  @IsIn(BUCKETS, { each: true })
  bucket?: EditionLinkMatchBucket[];

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 50;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  libraryId?: number;
}
