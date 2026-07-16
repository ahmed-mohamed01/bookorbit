import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

import type { AudiobookshelfConnectionTestPayload, UpsertAudiobookshelfSettingsPayload } from '@bookorbit/types';

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
