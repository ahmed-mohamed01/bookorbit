import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  MONITORED_BULK_REQUEST_FORMATS,
  MONITORED_AUTHOR_LIST_SORTS,
  MONITORED_BOOK_LIST_SORTS,
  MONITORED_FORMATS,
  MONITORED_LIST_ORDERS,
  MONITORED_MARK_KINDS,
  MONITORED_REVIEW_FLAGS,
  MONITORED_RELEASE_FILTERS,
  MONITORED_RELEASE_LIST_SORTS,
  MONITORED_SORTS,
  MONITORED_STATUS_FILTERS,
  MONITOR_MODES,
  MONITORED_WORK_BULK_LIMIT,
} from '@bookorbit/types';
import type {
  MonitorMode,
  MonitoredAuthorListSort,
  MonitoredBulkRequestFormat,
  MonitoredBulkRequestPayload,
  MonitoredBulkUpdatePayload,
  MonitoredBulkWorkPatch,
  MonitoredBookListSort,
  MonitoredFormat,
  MonitoredListOrder,
  MonitoredMarkKind,
  MonitoredReviewFlag,
  MonitoredReleaseFilter,
  MonitoredReleaseListSort,
  MonitoredSort,
  MonitoredStatusFilter,
  MonitoredWorkPatch,
} from '@bookorbit/types';

import { IsRequestSourceIds } from '../../../common/validation/request-source-ids.validation';

// Postgres integer columns are int4; anything larger overflows in the driver rather than the DTO.
const MAX_INT4 = 2147483647;

/** A comma-separated query value, as `status=missing,upcoming`, read as a de-duplicated list. */
function commaList({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

class MonitorFormatConfigDto {
  @IsIn(MONITOR_MODES)
  mode!: MonitorMode;

  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT4)
  libraryId: number | null = null;

  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT4)
  folderId: number | null = null;
}

class MonitorFormatsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => MonitorFormatConfigDto)
  ebook?: MonitorFormatConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MonitorFormatConfigDto)
  audiobook?: MonitorFormatConfigDto;
}

class MonitoredProviderIdsDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  hardcover?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  goodreads?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  audible?: string;
}

export class MonitorAuthorDto {
  @IsString()
  @MaxLength(500)
  authorName!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT4)
  localAuthorId?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => MonitoredProviderIdsDto)
  providerIds?: MonitoredProviderIdsDto;

  @IsObject()
  @ValidateNested()
  @Type(() => MonitorFormatsDto)
  formats!: MonitorFormatsDto;
}

export class UpdateMonitoredAuthorDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MonitorFormatsDto)
  formats?: MonitorFormatsDto;

  @IsOptional()
  @IsBoolean()
  paused?: boolean;
}

export class MonitoredAuthorDetailQueryDto {
  @IsOptional()
  @IsIn(MONITORED_SORTS)
  sort?: MonitoredSort = 'releaseDate';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  includeHidden?: boolean = false;

  /** Absent keeps every work the other options allow; present keeps only works matching one of these. */
  @IsOptional()
  @Transform(commaList)
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MONITORED_STATUS_FILTERS, { each: true })
  status?: MonitoredStatusFilter[];
}

function trimmed({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

class MonitoredPageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trimmed)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page?: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  size?: number = 50;

  @IsOptional()
  @IsIn(MONITORED_LIST_ORDERS)
  order?: MonitoredListOrder;
}

export class ListMonitoredAuthorsDto extends MonitoredPageQueryDto {
  @IsOptional()
  @IsIn(MONITORED_AUTHOR_LIST_SORTS)
  sort?: MonitoredAuthorListSort = 'name';

  override order: MonitoredListOrder = 'asc';
}

export class ListMonitoredBooksDto extends MonitoredPageQueryDto {
  @IsOptional()
  @IsIn(MONITORED_BOOK_LIST_SORTS)
  sort?: MonitoredBookListSort = 'added';

  override order: MonitoredListOrder = 'desc';
}

export class ListMonitoredReleasesDto extends MonitoredPageQueryDto {
  @IsOptional()
  @Transform(commaList)
  @IsArray()
  @IsIn(MONITORED_MARK_KINDS, { each: true })
  kinds?: MonitoredMarkKind[];

  @IsOptional()
  @Transform(commaList)
  @IsArray()
  @IsIn(MONITORED_REVIEW_FLAGS, { each: true })
  more?: MonitoredReviewFlag[];

  @IsOptional()
  @IsIn(MONITORED_RELEASE_LIST_SORTS)
  sort?: MonitoredReleaseListSort = 'date';

  override order: MonitoredListOrder = 'asc';

  @IsOptional()
  @IsIn(MONITORED_RELEASE_FILTERS)
  filter?: MonitoredReleaseFilter = 'all';

  /** Optional status buckets; hidden is accepted for compatibility and ignored. */
  @IsOptional()
  @Transform(commaList)
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MONITORED_STATUS_FILTERS, { each: true })
  status?: MonitoredStatusFilter[];
}

export class ListOwnedMonitoredAuthorIdsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page?: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  size?: number = 200;
}

export const MONITORED_LOCAL_AUTHOR_LOOKUP_LIMIT = 200;

export class LookupMonitoredLocalAuthorsDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .map(Number)
      : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MONITORED_LOCAL_AUTHOR_LOOKUP_LIMIT)
  @IsInt({ each: true })
  @Min(1, { each: true })
  authorIds!: number[];
}

export class MonitoredSearchQueryDto {
  @IsString()
  @MaxLength(500)
  q!: string;
}

export const MONITORED_CATALOG_SEARCH_DEFAULT_LIMIT = 3;

export class MonitoredCatalogSearchQueryDto {
  @IsString()
  // The title trigram index forms no trigram at two characters, so a two-char query scans the whole
  // instance's catalog; three is the shortest query the index can narrow.
  @MinLength(3)
  @MaxLength(200)
  @Transform(trimmed)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit: number = MONITORED_CATALOG_SEARCH_DEFAULT_LIMIT;
}

export class HardcoverSearchQueryDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  @Transform(trimmed)
  q!: string;
}

export class CreateMonitoredBookDto {
  @IsString()
  @MaxLength(100)
  monitorAuthorId!: string;

  @IsString()
  @MaxLength(200)
  workId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MONITORED_FORMATS, { each: true })
  formats!: MonitoredFormat[];
}

export class UpdateMonitoredBookDto {
  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MONITORED_FORMATS, { each: true })
  formats?: MonitoredFormat[];
}

export class SearchWorkReleasesDto {
  @IsIn(MONITORED_FORMATS)
  format!: MonitoredFormat;
}

export class UpdateMonitoredWorkDto implements MonitoredWorkPatch {
  @IsOptional()
  @IsBoolean()
  monitorEbook?: boolean;

  @IsOptional()
  @IsBoolean()
  monitorAudiobook?: boolean;

  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @IsOptional()
  @Equals(true)
  automaticVisibility?: true;

  // IsOptional would let an explicit null through, which the store reads as a mark.
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(MONITORED_MARK_KINDS)
  kind?: MonitoredMarkKind;
}

class BulkRequestSourcesDto {
  @IsOptional()
  @IsRequestSourceIds()
  ebook?: number[] | null;

  @IsOptional()
  @IsRequestSourceIds()
  audiobook?: number[] | null;
}

function IsBulkWorkIds(): PropertyDecorator {
  return applyDecorators(
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(MONITORED_WORK_BULK_LIMIT),
    ArrayUnique(),
    IsString({ each: true }),
    MaxLength(200, { each: true }),
  );
}

export class BulkRequestWorksDto implements MonitoredBulkRequestPayload {
  @IsBulkWorkIds()
  workIds!: string[];

  @IsIn(MONITORED_BULK_REQUEST_FORMATS)
  format!: MonitoredBulkRequestFormat;

  @IsOptional()
  @IsBoolean()
  autoDownload?: boolean;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BulkRequestSourcesDto)
  sources?: BulkRequestSourcesDto;
}

export class BulkWorkPatchDto implements MonitoredBulkWorkPatch {
  @IsOptional()
  @IsBoolean()
  monitorEbook?: boolean;

  @IsOptional()
  @IsBoolean()
  monitorAudiobook?: boolean;

  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @IsOptional()
  @Equals(true)
  automaticVisibility?: true;

  // IsOptional would let an explicit null through, which the store reads as a mark.
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(MONITORED_MARK_KINDS)
  kind?: MonitoredMarkKind;
}

export class BulkUpdateWorksDto implements MonitoredBulkUpdatePayload {
  @IsBulkWorkIds()
  workIds!: string[];

  @IsObject()
  @ValidateNested()
  @Type(() => BulkWorkPatchDto)
  patch!: BulkWorkPatchDto;
}

export class GrabWorkReleaseDto {
  @IsIn(MONITORED_FORMATS)
  format!: MonitoredFormat;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT4)
  indexerId!: number;

  @IsString()
  @MaxLength(2048)
  releaseGuid!: string;
}

export class RequestFromWorkDto {
  @IsIn(MONITORED_FORMATS)
  format!: MonitoredFormat;

  @IsOptional()
  @IsBoolean()
  autoDownload?: boolean;
}

export class MonitoredCoverQueryDto {
  @IsUrl({ protocols: ['http', 'https'], require_tld: true })
  @MaxLength(2048)
  url!: string;
}

export class MonitoredMatchHoldersQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT4)
  bookId!: number;
}
