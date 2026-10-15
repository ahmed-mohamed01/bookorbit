import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import type {
  TestWebSerialEngineInput,
  UpdateWebSerialSettingsInput,
  WebSerialEngineConnectionInput,
  WebSerialExtensionRepoInput,
  WebSerialKind,
  WebSerialMangaExtensionQuery,
  WebSerialNovelEngine,
  WebSerialPackaging,
} from '@bookorbit/types';
import { WEB_SERIAL_KINDS } from '@bookorbit/types';

const NOVEL_PACKAGING: Extract<WebSerialPackaging, 'volume' | 'series'>[] = ['volume', 'series'];
const SOURCE_ID_PATTERN = /^[0-9]{1,24}$/;
const LANGUAGE_PATTERN = /^[A-Za-z0-9-]{1,16}$/;
const EXTENSION_PACKAGE_PATTERN = /^[a-z0-9_.]{3,200}$/;
const NOVEL_SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const optionalBoolean = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

class EngineConnectionDto implements WebSerialEngineConnectionInput {
  // Nullable by design: null or "" clears the stored value.
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2048)
  url?: string | null;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(255)
  username?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string | null;
}

export class MangaSettingsDto extends EngineConnectionDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  @Matches(SOURCE_ID_PATTERN, { each: true })
  sourceIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(LANGUAGE_PATTERN, { each: true })
  languages?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetLibraryId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetFolderId?: number | null;
}

export class NovelSettingsDto extends EngineConnectionDto {
  @IsOptional()
  @IsIn(['lnreader', 'lncrawl'] satisfies WebSerialNovelEngine[])
  engine?: WebSerialNovelEngine;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  searchDomains?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @Matches(NOVEL_SOURCE_ID_PATTERN, { each: true })
  sourceIds?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetLibraryId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetFolderId?: number | null;

  @IsOptional()
  @IsIn(NOVEL_PACKAGING)
  defaultPackaging?: Extract<WebSerialPackaging, 'volume' | 'series'>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(20000)
  indexDailyBudget?: number;
}

export class LookupSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateWebSerialSettingsDto implements UpdateWebSerialSettingsInput {
  @IsOptional()
  @ValidateNested()
  @Type(() => MangaSettingsDto)
  manga?: MangaSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NovelSettingsDto)
  novel?: NovelSettingsDto;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(6)
  maxConcurrentJobs?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => LookupSettingsDto)
  lookup?: LookupSettingsDto;
}

export class TestWebSerialEngineDto extends EngineConnectionDto implements TestWebSerialEngineInput {
  @IsIn(WEB_SERIAL_KINDS)
  kind!: WebSerialKind;

  @IsOptional()
  @IsIn(['lnreader', 'lncrawl'] satisfies WebSerialNovelEngine[])
  engine?: WebSerialNovelEngine;
}

export class NovelSourceParamsDto {
  @Matches(NOVEL_SOURCE_ID_PATTERN)
  id!: string;
}

export class NovelSourceQueryDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(50)
  lang?: string;
}

export class MangaExtensionQueryDto implements WebSerialMangaExtensionQuery {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  query?: string;

  @IsOptional()
  @Transform(trimString)
  @Matches(LANGUAGE_PATTERN)
  lang?: string;

  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  installed?: boolean;

  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  adult?: boolean;

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

export class MangaExtensionParamsDto {
  @Matches(EXTENSION_PACKAGE_PATTERN)
  pkgName!: string;
}

export class WebSerialExtensionRepoDto implements WebSerialExtensionRepoInput {
  @Transform(trimString)
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  url!: string;
}
