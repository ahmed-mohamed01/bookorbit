import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type {
  AudiobookshelfConnectionTestResult,
  AudiobookshelfLibrariesResponse,
  AudiobookshelfSettings,
  AudiobookshelfSyncDisabledReason,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types';

import { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { parseAndNormalizeServerUrl } from './audiobookshelf-url.utils';

@Injectable()
export class AudiobookshelfSettingsService {
  private readonly logger = new Logger(AudiobookshelfSettingsService.name);

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
  ) {}

  async getSettings(userId: number): Promise<AudiobookshelfSettings> {
    const [row, hasSyncPermission] = await Promise.all([this.repo.findSettings(userId), this.repo.userHasAudiobookshelfSyncPermission(userId)]);

    const tokenConfigured = Boolean(row?.apiToken);
    const configComplete = Boolean(row?.serverUrl) && tokenConfigured;
    const enabled = row?.enabled ?? false;

    return {
      serverUrl: row?.serverUrl ?? null,
      tokenConfigured,
      enabled,
      effectiveEnabled: hasSyncPermission && configComplete && enabled,
      disabledReason: this.resolveDisabledReason({ hasSyncPermission, configComplete, enabled }),
      syncStatus: row?.syncStatus ?? true,
      syncPosition: row?.syncPosition ?? true,
      syncSessions: row?.syncSessions ?? true,
      excludedLibraryIds: row?.excludedLibraryIds ?? [],
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
      lastSyncError: row?.lastSyncError ?? null,
    };
  }

  async upsertSettings(userId: number, payload: UpsertAudiobookshelfSettingsPayload): Promise<AudiobookshelfSettings> {
    const existing = await this.repo.findSettings(userId);

    let normalizedUrl: string | undefined;
    if (payload.serverUrl !== undefined) {
      normalizedUrl = parseAndNormalizeServerUrl(payload.serverUrl.trim()) ?? undefined;
      if (!normalizedUrl) {
        throw new BadRequestException('Audiobookshelf server URL must be a valid http or https URL');
      }
    }

    const rawToken = payload.apiToken !== undefined ? payload.apiToken.trim() : undefined;

    if (!existing) {
      if (!normalizedUrl) throw new BadRequestException('Server URL is required to connect Audiobookshelf');
      if (!rawToken) throw new BadRequestException('API token is required to connect Audiobookshelf');
    }

    const data: Parameters<typeof this.repo.upsertSettings>[1] = {};
    // Both server_url and api_token are NOT NULL. PostgreSQL validates the INSERT values before
    // ON CONFLICT, so carry existing values into the insert side even on the update path.
    data.serverUrl = normalizedUrl ?? existing!.serverUrl;
    data.apiToken = rawToken ?? existing!.apiToken;
    if (payload.enabled !== undefined) data.enabled = payload.enabled;
    if (payload.syncStatus !== undefined) data.syncStatus = payload.syncStatus;
    if (payload.syncPosition !== undefined) data.syncPosition = payload.syncPosition;
    if (payload.syncSessions !== undefined) data.syncSessions = payload.syncSessions;
    if (payload.excludedLibraryIds !== undefined) {
      data.excludedLibraryIds = [...new Set(payload.excludedLibraryIds.map((id) => id.trim()))];
    }

    await this.repo.upsertSettings(userId, data);
    this.logger.log(`[abs.settings] [end] userId=${userId} enabled=${data.enabled ?? existing?.enabled ?? true} - settings saved`);
    return this.getSettings(userId);
  }

  async disconnectUser(userId: number): Promise<void> {
    const existing = await this.repo.findSettings(userId);
    if (!existing) throw new NotFoundException('Audiobookshelf integration not configured');
    await this.repo.deleteSettings(userId);
    this.logger.log(`[abs.settings] [end] userId=${userId} - user disconnected`);
  }

  async testConnection(userId: number, payload: { serverUrl?: string; apiToken?: string }): Promise<AudiobookshelfConnectionTestResult> {
    const existing = await this.repo.findSettings(userId);

    let serverUrl: string | undefined;
    if (payload.serverUrl !== undefined) {
      serverUrl = parseAndNormalizeServerUrl(payload.serverUrl.trim()) ?? undefined;
      if (!serverUrl) {
        return { success: false, error: 'The Audiobookshelf server URL is invalid' };
      }
    } else {
      serverUrl = existing?.serverUrl;
    }

    const token = payload.apiToken?.trim() || existing?.apiToken;

    if (!serverUrl || !token) {
      return { success: false, error: 'Server URL and API token are required to test the connection' };
    }

    return this.client.testConnection(userId, serverUrl, token);
  }

  async getLibraries(userId: number): Promise<AudiobookshelfLibrariesResponse> {
    const settings = await this.repo.findSettings(userId);
    if (!settings?.serverUrl || !settings.apiToken) {
      throw new BadRequestException('Audiobookshelf sync is not configured');
    }
    const response = await this.client.getLibraries(userId, settings.serverUrl, settings.apiToken);
    const excluded = new Set(settings.excludedLibraryIds);
    return {
      libraries: response.libraries
        .filter((library) => library.mediaType === 'book')
        .map((library) => ({ ...library, excluded: excluded.has(library.id) })),
    };
  }

  private resolveDisabledReason(input: {
    hasSyncPermission: boolean;
    configComplete: boolean;
    enabled: boolean;
  }): AudiobookshelfSyncDisabledReason | null {
    if (!input.hasSyncPermission) return 'permission_denied';
    if (!input.configComplete) return 'missing_config';
    if (!input.enabled) return 'user_disabled';
    return null;
  }
}
