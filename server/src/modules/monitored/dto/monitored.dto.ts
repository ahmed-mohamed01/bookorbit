import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  MONITORED_AUTHOR_LIST_SORTS,
  MONITORED_BOOK_LIST_SORTS,
  MONITORED_FORMATS,
  MONITORED_LIST_ORDERS,
  MONITORED_RELEASE_FILTERS,
  MONITORED_RELEASE_LIST_SORTS,
  MONITORED_SORTS,
  MONITOR_MODES,
} from '@bookorbit/types';
import type {
  MonitorMode,
  MonitoredAuthorListSort,
  MonitoredBookListSort,
  MonitoredFormat,
  MonitoredListOrder,
  MonitoredReleaseFilter,
  MonitoredReleaseListSort,
  MonitoredSort,
  MonitoredWorkPatch,
} from '@bookorbit/types';

// Postgres integer columns are int4; anything larger overflows in the driver rather than the DTO.
const MAX_INT4 = 2147483647;

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

  @IsOptional()
  @IsBoolean()
  isShared?: boolean;

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

  @IsOptional()
  @IsBoolean()
  isShared?: boolean;
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
}

class MonitoredPageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
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
  @IsIn(MONITORED_RELEASE_LIST_SORTS)
  sort?: MonitoredReleaseListSort = 'date';

  override order: MonitoredListOrder = 'asc';

  @IsOptional()
  @IsIn(MONITORED_RELEASE_FILTERS)
  filter?: MonitoredReleaseFilter = 'all';
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

export class MonitoredSearchQueryDto {
  @IsString()
  @MaxLength(500)
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
