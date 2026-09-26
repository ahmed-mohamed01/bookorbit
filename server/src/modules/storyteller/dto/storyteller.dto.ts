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
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import type {
  ReadAlongBuildRequest,
  StorytellerConnectionTestPayload,
  StorytellerPathMapping,
  StorytellerTransport,
  UpsertStorytellerSettingsPayload,
} from '@bookorbit/types';

const STORYTELLER_TRANSPORTS: StorytellerTransport[] = ['auto', 'shared-paths', 'api-transfer'];
const PATH_PREFIX_MAX_LENGTH = 500;

const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class StorytellerPathMappingDto implements StorytellerPathMapping {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_PREFIX_MAX_LENGTH)
  localPrefix!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_PREFIX_MAX_LENGTH)
  remotePrefix!: string;
}

export class TestStorytellerConnectionDto implements StorytellerConnectionTestPayload {
  @ValidateIf((o: TestStorytellerConnectionDto) => o.serverUrl !== undefined)
  @Transform(trimString)
  @IsString()
  @MaxLength(2048)
  serverUrl?: string;

  @ValidateIf((o: TestStorytellerConnectionDto) => o.username !== undefined)
  @Transform(trimString)
  @IsString()
  @MaxLength(255)
  username?: string;

  @ValidateIf((o: TestStorytellerConnectionDto) => o.password !== undefined)
  @IsString()
  @MaxLength(1024)
  password?: string;
}

export class UpsertStorytellerSettingsDto implements UpsertStorytellerSettingsPayload {
  @ValidateIf((o: UpsertStorytellerSettingsDto) => o.serverUrl !== undefined)
  @Transform(trimString)
  @IsString()
  @MaxLength(2048)
  serverUrl?: string;

  @ValidateIf((o: UpsertStorytellerSettingsDto) => o.username !== undefined)
  @IsString()
  @MaxLength(255)
  username?: string;

  @ValidateIf((o: UpsertStorytellerSettingsDto) => o.password !== undefined)
  @IsString()
  @MaxLength(1024)
  password?: string;

  @ValidateIf((o: UpsertStorytellerSettingsDto) => o.pathMappings !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StorytellerPathMappingDto)
  pathMappings?: StorytellerPathMappingDto[];

  // Nullable by design: null clears the stored target library/folder/collection.
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

  @ValidateIf((o: UpsertStorytellerSettingsDto) => o.transport !== undefined)
  @IsIn(STORYTELLER_TRANSPORTS)
  transport?: StorytellerTransport;

  @ValidateIf((o: UpsertStorytellerSettingsDto) => o.deleteRemoteAfterImport !== undefined)
  @IsBoolean()
  deleteRemoteAfterImport?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  collectionName?: string | null;
}

export class BuildReadAlongDto implements ReadAlongBuildRequest {
  @ValidateIf((o: BuildReadAlongDto) => o.force !== undefined)
  @IsBoolean()
  force?: boolean;

  // Not nullable, unlike the settings DTO's target fields: an explicit null here would read as "the
  // caller picked a library", silently discarding the configured target. Only omission is allowed,
  // so @IsOptional() (which skips null too) would be wrong.
  @ValidateIf((o: BuildReadAlongDto) => o.targetLibraryId !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetLibraryId?: number;

  @ValidateIf((o: BuildReadAlongDto) => o.targetFolderId !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetFolderId?: number;

  @ValidateIf((o: BuildReadAlongDto) => o.useExistingUuid !== undefined)
  @IsString()
  @MaxLength(64)
  useExistingUuid?: string;

  @ValidateIf((o: BuildReadAlongDto) => o.cleanUpRemote !== undefined)
  @IsBoolean()
  cleanUpRemote?: boolean;
}
