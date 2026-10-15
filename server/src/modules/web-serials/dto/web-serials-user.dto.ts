import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import type {
  MoveWebSerialJobInput,
  RecordWebSerialPublishedRequestInput,
  WebSerialKind,
  ResolveWebSerialUrlInput,
  UpdateWebSerialNovelProvidersInput,
  WebSerialJobScope,
  WebSerialPackaging,
} from '@bookorbit/types';
import { SERIES_KEY_FORMAT } from '../web-serials-series-key.utils';

const SEQUENCE_PATTERN = /^[0-9]+([.][0-9]+)?$/;
const PACKAGINGS: WebSerialPackaging[] = ['chapter', 'volume', 'series'];

const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimStringArray = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.map((entry) => (typeof entry === 'string' ? entry.trim() : entry)) : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === '1' || value === 'true' || value === true ? true : value === '0' || value === 'false' || value === false ? false : value;

/** `refresh=1` skips the server's cached answer and asks the sources again. */
export class RefreshWebSerialsDto {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  refresh?: boolean;
}

export class SearchWebSerialsDto extends RefreshWebSerialsDto {
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @IsIn(['manga', 'novel', 'all'])
  kind?: 'manga' | 'novel' | 'all';

  /** `index`: novels answer from the light novel index only, without asking any source live. */
  @IsOptional()
  @IsIn(['index', 'full'])
  phase?: 'index' | 'full';
}

/** Autocomplete over the light novel index; a query under two characters gets no suggestions. */
export class SuggestWebSerialsDto {
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @IsIn(['novel'])
  kind?: 'novel';
}

/** The series-database id a source series was found for; presets the match instead of guessing it from the title. */
export class SeriesMatchDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,12}$/)
  matchId?: string;
}

export class ResolveWebSerialUrlDto implements ResolveWebSerialUrlInput {
  @Transform(trimString)
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  url!: string;
}

export class WebSerialSelectionDto {
  @IsIn(['all', 'range', 'list'])
  mode!: 'all' | 'range' | 'list';

  @ValidateIf((o: WebSerialSelectionDto) => o.mode === 'range')
  @IsString()
  @Matches(SEQUENCE_PATTERN)
  @MaxLength(20)
  fromSequence?: string;

  @ValidateIf((o: WebSerialSelectionDto) => o.mode === 'range')
  @IsString()
  @Matches(SEQUENCE_PATTERN)
  @MaxLength(20)
  toSequence?: string;

  @ValidateIf((o: WebSerialSelectionDto) => o.mode === 'list')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  @Matches(SEQUENCE_PATTERN, { each: true })
  @MaxLength(20, { each: true })
  sequences?: string[];
}

export class WebSerialMetadataOverrideDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(/^\d+$/)
  @MaxLength(20)
  matchId?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trimStringArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(255, { each: true })
  authors?: string[];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trimStringArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(255, { each: true })
  artists?: string[];
}

export class CreateWebSerialJobDto {
  @IsString()
  @IsNotEmpty()
  @Matches(SERIES_KEY_FORMAT)
  seriesKey!: string;

  @IsIn(PACKAGINGS)
  packaging!: WebSerialPackaging;

  @ValidateNested()
  @Type(() => WebSerialSelectionDto)
  selection!: WebSerialSelectionDto;

  @IsOptional()
  @IsBoolean()
  skipImported?: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  libraryId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  folderId?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => WebSerialMetadataOverrideDto)
  metadata?: WebSerialMetadataOverrideDto;
}

export class ListWebSerialJobsDto {
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: WebSerialJobScope;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class WebSerialJobScopeDto {
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: WebSerialJobScope;
}

export class MoveWebSerialJobDto implements MoveWebSerialJobInput {
  @IsString()
  @IsNotEmpty()
  @Matches(SERIES_KEY_FORMAT)
  seriesKey!: string;
}

export class UpdateWebSerialNovelProvidersDto implements UpdateWebSerialNovelProvidersInput {
  @Transform(trimStringArray)
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  disabledDomains!: string[];
}

const KINDS: WebSerialKind[] = ['manga', 'novel'];

export class ListWebSerialPublishedRequestsDto {
  @IsIn(KINDS)
  kind!: WebSerialKind;

  @IsString()
  @Matches(/^\d{1,12}$/)
  matchId!: string;
}

export class RecordWebSerialPublishedRequestDto implements RecordWebSerialPublishedRequestInput {
  @IsIn(KINDS)
  kind!: WebSerialKind;

  @IsString()
  @Matches(/^\d{1,12}$/)
  matchId!: string;

  @IsString()
  @Matches(/^\d{1,3}$/)
  volume!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  bookRequestId!: number;
}

export class WebSerialDiscoverParamsDto {
  @IsIn(KINDS)
  kind!: WebSerialKind;

  @Matches(/^\d{1,12}$/)
  matchId!: string;
}

export class WebSerialSeriesKeyParamsDto {
  @Matches(SERIES_KEY_FORMAT)
  seriesKey!: string;
}
