import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type {
  AudiobookshelfConnectionTestResult,
  AudiobookshelfLibrariesResponse,
  AudiobookshelfPathMapping,
  AudiobookshelfSettings,
  AudiobookshelfSyncDisabledReason,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { ensureSafeUrl, type SafeRemoteHostOptions } from '../../common/utils/ssrf.utils';
import { LibraryService } from '../library/library.service';
import { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { isMappablePathPrefix, normalizeMatchPath } from './audiobookshelf-match.utils';
import { buildBookAccessScope } from './audiobookshelf-user.utils';
import { audiobookshelfSafeRemoteHostOptions, parseAndNormalizeServerUrl } from './audiobookshelf-url.utils';

/**
 * Stores prefixes in the same canonical form the matcher compares in, so a mapping saved as
 * `/audiobooks/` behaves identically to one saved as `/audiobooks`. Rows the matcher could never
 * apply are dropped, and a repeated ABS prefix keeps its first row (the later one could never win
 * the longest-prefix contest anyway). Saving such a row is rejected outright; dropping here keeps a
 * legacy stored row from breaking the change comparison.
 */
function normalizePathMappings(mappings: AudiobookshelfPathMapping[]): AudiobookshelfPathMapping[] {
  const normalized: AudiobookshelfPathMapping[] = [];
  const seen = new Set<string>();
  for (const mapping of mappings) {
    const absPrefix = normalizeMatchPath(mapping.absPrefix);
    const localPrefix = normalizeMatchPath(mapping.localPrefix);
    if (!absPrefix || !localPrefix || seen.has(absPrefix)) continue;
    if (!isMappablePathPrefix(absPrefix) || !isMappablePathPrefix(localPrefix)) continue;
    seen.add(absPrefix);
    normalized.push({ absPrefix, localPrefix });
  }
  return normalized;
}

/**
 * A prefix of `/` matches every absolute path but rewrites nothing, so the matcher would probe the
 * raw Audiobookshelf path as if it were a local one. Rejected at the boundary rather than dropped,
 * so a user who typed it is told instead of silently getting a mapping that never fires.
 */
function assertMappablePathMappings(mappings: AudiobookshelfPathMapping[]): void {
  for (const mapping of mappings) {
    if (!isMappablePathPrefix(mapping.absPrefix) || !isMappablePathPrefix(mapping.localPrefix)) {
      throw new BadRequestException('Path prefix must contain at least one folder segment');
    }
  }
}

/**
 * Compares two mapping sets by meaning rather than by storage order: the matcher picks the longest
 * matching ABS prefix, so reordering the same rows changes nothing and must not count as a change.
 * The stored side is re-normalized first, so a row written before canonicalization landed does not
 * read as a change on its own.
 */
function samePathMappings(left: AudiobookshelfPathMapping[], right: AudiobookshelfPathMapping[]): boolean {
  const canonical = (mappings: AudiobookshelfPathMapping[]) =>
    JSON.stringify(
      normalizePathMappings(mappings)
        .map((mapping) => [mapping.absPrefix, mapping.localPrefix])
        .sort(),
    );
  return canonical(left) === canonical(right);
}

@Injectable()
export class AudiobookshelfSettingsService {
  private readonly logger = new Logger(AudiobookshelfSettingsService.name);
  private readonly safeRemoteHostOptions: SafeRemoteHostOptions;

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly libraryService: LibraryService,
  ) {
    this.safeRemoteHostOptions = audiobookshelfSafeRemoteHostOptions();
  }

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
      pathMappings: row?.pathMappings ?? [],
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
      lastSyncError: row?.lastSyncError ?? null,
      staleCount: row?.staleCount ?? 0,
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
      await this.assertSafeServerUrl(normalizedUrl);
    }

    const rawToken = payload.apiToken !== undefined ? payload.apiToken.trim() : undefined;

    if (!existing) {
      if (!normalizedUrl) throw new BadRequestException('Server URL is required to connect Audiobookshelf');
      if (!rawToken) throw new BadRequestException('API token is required to connect Audiobookshelf');
    }

    const data: Parameters<typeof this.repo.updateSettings>[1] = {};
    if (normalizedUrl !== undefined) data.serverUrl = normalizedUrl;
    if (rawToken !== undefined) data.apiToken = rawToken;
    if (payload.enabled !== undefined) data.enabled = payload.enabled;
    if (payload.syncStatus !== undefined) data.syncStatus = payload.syncStatus;
    if (payload.syncPosition !== undefined) data.syncPosition = payload.syncPosition;
    if (payload.syncSessions !== undefined) data.syncSessions = payload.syncSessions;
    if (payload.excludedLibraryIds !== undefined) {
      data.excludedLibraryIds = [...new Set(payload.excludedLibraryIds.map((id) => id.trim()))];
    }
    if (payload.pathMappings !== undefined) {
      assertMappablePathMappings(payload.pathMappings);
      data.pathMappings = normalizePathMappings(payload.pathMappings);
    }

    if (existing) {
      const updated = await this.repo.updateSettings(userId, data);
      if (!updated) throw new NotFoundException('Audiobookshelf integration no longer configured');
    } else {
      await this.repo.upsertSettings(userId, data);
    }
    this.logger.log(`[abs.settings] [end] userId=${userId} enabled=${data.enabled ?? existing?.enabled ?? true} - settings saved`);

    // New mappings can resolve items the path tier previously could not, and the negative-match memo
    // would otherwise keep every scheduled sync skipping them until the user forces a rescan.
    if (existing && data.pathMappings && !samePathMappings(existing.pathMappings ?? [], data.pathMappings)) {
      const reset = await this.repo.clearMatchMemoForUnmatched(userId);
      this.logger.log(`[abs.settings] [end] userId=${userId} resetMatchMemo=${reset} - path mappings changed, unmatched match memo cleared`);
    }

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

    try {
      await this.assertSafeServerUrl(serverUrl);
    } catch {
      return { success: false, error: 'The Audiobookshelf server URL is invalid' };
    }

    return this.client.testConnection(userId, serverUrl, token);
  }

  /**
   * The user's Audiobookshelf book libraries plus the BookOrbit folder roots they can access. Both
   * sides ship together because the connection card offers them as pick-lists for one folder mapping.
   */
  async getLibraries(user: RequestUser): Promise<AudiobookshelfLibrariesResponse> {
    const settings = await this.repo.findSettings(user.id);
    if (!settings?.serverUrl || !settings.apiToken) {
      throw new BadRequestException('Audiobookshelf sync is not configured');
    }
    const [response, localFolderPaths] = await Promise.all([
      this.client.getLibraries(user.id, settings.serverUrl, settings.apiToken),
      this.findLocalFolderPaths(user),
    ]);
    return {
      libraries: response.libraries
        .filter((library) => library.mediaType === 'book')
        .map(({ id, name, mediaType, folderPaths }) => ({ id, name, mediaType, folderPaths })),
      localFolderPaths,
    };
  }

  private async findLocalFolderPaths(user: RequestUser): Promise<string[]> {
    const { libraryIds } = await buildBookAccessScope(user, this.libraryService);
    return this.repo.findLibraryFolderPaths(libraryIds);
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

  private async assertSafeServerUrl(serverUrl: string): Promise<void> {
    await ensureSafeUrl(serverUrl, this.safeRemoteHostOptions);
  }
}
