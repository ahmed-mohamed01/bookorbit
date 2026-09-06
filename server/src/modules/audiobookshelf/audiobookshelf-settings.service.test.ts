import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureSafeUrl } from '../../common/utils/ssrf.utils';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';

vi.mock('../../common/utils/ssrf.utils', () => ({
  ensureSafeUrl: vi.fn().mockResolvedValue(undefined),
}));

const mockedEnsureSafeUrl = vi.mocked(ensureSafeUrl);

const mockRepo = {
  findSettings: vi.fn(),
  userHasAudiobookshelfSyncPermission: vi.fn(),
  upsertSettings: vi.fn(),
  updateSettings: vi.fn(),
  deleteSettings: vi.fn(),
  findLibraryFolderPaths: vi.fn(),
  clearMatchMemoForUnmatched: vi.fn(),
};

const mockClient = {
  testConnection: vi.fn(),
  getLibraries: vi.fn(),
};

const mockLibraryService = {
  findAccessibleLibraryIds: vi.fn(),
};

const mockUser = { id: 1, isSuperuser: false, active: true, permissions: [], contentFilters: undefined };

function makeService() {
  return new AudiobookshelfSettingsService(mockRepo as any, mockClient as any, mockLibraryService as any);
}

function configuredRow(overrides: Record<string, unknown> = {}) {
  return {
    serverUrl: 'https://abs.example.com',
    apiToken: 'secret-token',
    enabled: true,
    syncStatus: true,
    syncPosition: true,
    syncSessions: true,
    excludedLibraryIds: [],
    pathMappings: [],
    lastSyncedAt: null,
    lastSyncError: null,
    staleCount: 0,
    ...overrides,
  };
}

describe('AudiobookshelfSettingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnsureSafeUrl.mockResolvedValue(undefined as never);
    mockRepo.userHasAudiobookshelfSyncPermission.mockResolvedValue(true);
    mockRepo.clearMatchMemoForUnmatched.mockResolvedValue(0);
  });

  describe('getSettings', () => {
    it('never returns the raw apiToken and exposes only tokenConfigured', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());

      const result = await makeService().getSettings(1);

      // Security invariant: the token itself must never leave the service.
      expect(result).not.toHaveProperty('apiToken');
      expect((result as any).apiToken).toBeUndefined();
      expect(result.tokenConfigured).toBe(true);
      expect(result.serverUrl).toBe('https://abs.example.com');
      expect(JSON.stringify(result)).not.toContain('secret-token');
    });

    it('returns defaults with missing_config when no row exists', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      const result = await makeService().getSettings(1);

      expect(result.serverUrl).toBeNull();
      expect(result.tokenConfigured).toBe(false);
      expect(result.enabled).toBe(false);
      expect(result.effectiveEnabled).toBe(false);
      expect(result.disabledReason).toBe('missing_config');
      expect(result.excludedLibraryIds).toEqual([]);
      expect(result.lastSyncedAt).toBeNull();
    });

    it('reports effectiveEnabled true when configured, enabled and permitted', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());

      const result = await makeService().getSettings(1);

      expect(result.effectiveEnabled).toBe(true);
      expect(result.disabledReason).toBeNull();
    });

    it('maps disabledReason to user_disabled when configured but paused', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow({ enabled: false }));

      const result = await makeService().getSettings(1);

      expect(result.enabled).toBe(false);
      expect(result.effectiveEnabled).toBe(false);
      expect(result.disabledReason).toBe('user_disabled');
    });

    it('maps disabledReason to permission_denied when the user lacks the sync permission', async () => {
      mockRepo.userHasAudiobookshelfSyncPermission.mockResolvedValue(false);
      mockRepo.findSettings.mockResolvedValue(configuredRow());

      const result = await makeService().getSettings(1);

      expect(result.effectiveEnabled).toBe(false);
      expect(result.disabledReason).toBe('permission_denied');
    });

    it('maps disabledReason to missing_config when a token is present but the URL is not', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow({ serverUrl: null }));

      const result = await makeService().getSettings(1);

      expect(result.tokenConfigured).toBe(true);
      expect(result.disabledReason).toBe('missing_config');
    });

    it('exposes the stored stale count, defaulting to zero without a row', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow({ staleCount: 4930 }));
      await expect(makeService().getSettings(1)).resolves.toMatchObject({ staleCount: 4930 });

      mockRepo.findSettings.mockResolvedValue(undefined);
      await expect(makeService().getSettings(1)).resolves.toMatchObject({ staleCount: 0 });
    });

    it('serializes lastSyncedAt to an ISO string', async () => {
      const syncedAt = new Date('2026-01-02T03:04:05Z');
      mockRepo.findSettings.mockResolvedValue(configuredRow({ lastSyncedAt: syncedAt }));

      const result = await makeService().getSettings(1);

      expect(result.lastSyncedAt).toBe(syncedAt.toISOString());
    });
  });

  describe('upsertSettings', () => {
    it('creates a new row and validates the URL via ensureSafeUrl', async () => {
      mockRepo.findSettings.mockResolvedValueOnce(undefined).mockResolvedValue(configuredRow());
      mockRepo.upsertSettings.mockResolvedValue(configuredRow());

      const result = await makeService().upsertSettings(1, { serverUrl: 'https://abs.example.com/', apiToken: 'secret-token' });

      expect(mockedEnsureSafeUrl).toHaveBeenCalledTimes(1);
      expect(mockedEnsureSafeUrl).toHaveBeenCalledWith('https://abs.example.com', expect.any(Object));
      expect(mockRepo.upsertSettings).toHaveBeenCalledWith(1, { serverUrl: 'https://abs.example.com', apiToken: 'secret-token' });
      expect(mockRepo.updateSettings).not.toHaveBeenCalled();
      expect(result.tokenConfigured).toBe(true);
    });

    it('updates an existing row via updateSettings', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());
      mockRepo.updateSettings.mockResolvedValue(configuredRow({ enabled: false }));

      await makeService().upsertSettings(1, { enabled: false });

      expect(mockRepo.updateSettings).toHaveBeenCalledWith(1, { enabled: false });
      expect(mockRepo.upsertSettings).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the row disappears during update', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());
      mockRepo.updateSettings.mockResolvedValue(undefined);

      await expect(makeService().upsertSettings(1, { enabled: false })).rejects.toThrow(NotFoundException);
    });

    it('dedupes excludedLibraryIds and trims them', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());
      mockRepo.updateSettings.mockResolvedValue(configuredRow());

      await makeService().upsertSettings(1, { excludedLibraryIds: [' a ', 'a', 'b'] });

      expect(mockRepo.updateSettings).toHaveBeenCalledWith(1, { excludedLibraryIds: ['a', 'b'] });
    });

    it('persists path mappings and reads them back on the settings response', async () => {
      const pathMappings = [{ absPrefix: '/audiobooks', localPrefix: '/books' }];
      mockRepo.findSettings.mockResolvedValueOnce(configuredRow()).mockResolvedValue(configuredRow({ pathMappings }));
      mockRepo.updateSettings.mockResolvedValue(configuredRow({ pathMappings }));

      const result = await makeService().upsertSettings(1, { pathMappings });

      expect(mockRepo.updateSettings).toHaveBeenCalledWith(1, { pathMappings });
      expect(result.pathMappings).toEqual(pathMappings);
    });

    it('stores path prefixes canonicalized and drops a repeated ABS prefix', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());
      mockRepo.updateSettings.mockResolvedValue(configuredRow());

      await makeService().upsertSettings(1, {
        pathMappings: [
          { absPrefix: ' /audiobooks// ', localPrefix: '/books/' },
          { absPrefix: '/audiobooks', localPrefix: '/other' },
        ],
      });

      expect(mockRepo.updateSettings).toHaveBeenCalledWith(1, { pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }] });
    });

    it('rejects a mapping rooted at the filesystem root, which would never translate anything', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());

      await expect(makeService().upsertSettings(1, { pathMappings: [{ absPrefix: '/', localPrefix: '/books' }] })).rejects.toThrow(
        BadRequestException,
      );
      await expect(makeService().upsertSettings(1, { pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/' }] })).rejects.toThrow(
        /at least one folder segment/i,
      );
      await expect(makeService().upsertSettings(1, { pathMappings: [{ absPrefix: '/audiobooks//', localPrefix: '  /  ' }] })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRepo.updateSettings).not.toHaveBeenCalled();
    });

    it('rejects a mapping whose prefix is blank on either side', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());

      await expect(makeService().upsertSettings(1, { pathMappings: [{ absPrefix: '   ', localPrefix: '/books' }] })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRepo.updateSettings).not.toHaveBeenCalled();
    });

    it('defaults pathMappings to an empty list when no row exists', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      const result = await makeService().getSettings(1);

      expect(result.pathMappings).toEqual([]);
    });

    it('clears the negative-match memo for unmatched rows when the mappings actually change', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow({ pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }] }));
      mockRepo.updateSettings.mockResolvedValue(configuredRow());
      mockRepo.clearMatchMemoForUnmatched.mockResolvedValue(12);

      await makeService().upsertSettings(1, { pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/media/books' }] });

      expect(mockRepo.clearMatchMemoForUnmatched).toHaveBeenCalledWith(1);
    });

    it('leaves the memo alone when the saved mappings are the same set in another order', async () => {
      const stored = [
        { absPrefix: '/audiobooks', localPrefix: '/books' },
        { absPrefix: '/podcasts', localPrefix: '/media/podcasts' },
      ];
      mockRepo.findSettings.mockResolvedValue(configuredRow({ pathMappings: stored }));
      mockRepo.updateSettings.mockResolvedValue(configuredRow({ pathMappings: stored }));

      await makeService().upsertSettings(1, {
        pathMappings: [
          { absPrefix: '/podcasts/', localPrefix: '/media/podcasts' },
          { absPrefix: '/audiobooks', localPrefix: '/books/' },
        ],
      });

      expect(mockRepo.clearMatchMemoForUnmatched).not.toHaveBeenCalled();
    });

    it('leaves the memo alone when the save does not touch the mappings at all', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow({ pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }] }));
      mockRepo.updateSettings.mockResolvedValue(configuredRow());

      await makeService().upsertSettings(1, { enabled: false });

      expect(mockRepo.clearMatchMemoForUnmatched).not.toHaveBeenCalled();
    });

    it('does not clear a memo for a first-time connection, which has no state rows yet', async () => {
      mockRepo.findSettings.mockResolvedValueOnce(undefined).mockResolvedValue(configuredRow());
      mockRepo.upsertSettings.mockResolvedValue(configuredRow());

      await makeService().upsertSettings(1, {
        serverUrl: 'https://abs.example.com',
        apiToken: 'secret-token',
        pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }],
      });

      expect(mockRepo.clearMatchMemoForUnmatched).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for an invalid server URL', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      await expect(makeService().upsertSettings(1, { serverUrl: 'not-a-url', apiToken: 'tok' })).rejects.toThrow(BadRequestException);
      expect(mockRepo.upsertSettings).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when a non-http(s) scheme is used', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      await expect(makeService().upsertSettings(1, { serverUrl: 'ftp://abs.example.com', apiToken: 'tok' })).rejects.toThrow(BadRequestException);
    });

    it('rejects an unsafe (SSRF) server URL surfaced by ensureSafeUrl', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      mockedEnsureSafeUrl.mockRejectedValueOnce(new BadRequestException('URL resolves to a private or local address'));

      await expect(makeService().upsertSettings(1, { serverUrl: 'https://169.254.169.254', apiToken: 'tok' })).rejects.toThrow(BadRequestException);
      expect(mockRepo.upsertSettings).not.toHaveBeenCalled();
    });

    it('requires a server URL when creating a first-time row', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      await expect(makeService().upsertSettings(1, { apiToken: 'tok' })).rejects.toThrow(BadRequestException);
    });

    it('requires an API token when creating a first-time row', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      await expect(makeService().upsertSettings(1, { serverUrl: 'https://abs.example.com' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('testConnection', () => {
    it('returns success and username from a good client response', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      mockClient.testConnection.mockResolvedValue({ success: true, username: 'alice' });

      const result = await makeService().testConnection(1, { serverUrl: 'https://abs.example.com/', apiToken: 'tok' });

      expect(result).toEqual({ success: true, username: 'alice' });
      expect(mockClient.testConnection).toHaveBeenCalledWith(1, 'https://abs.example.com', 'tok');
    });

    it('maps a client failure through unchanged', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      mockClient.testConnection.mockResolvedValue({ success: false, error: 'Audiobookshelf rejected the API token' });

      const result = await makeService().testConnection(1, { serverUrl: 'https://abs.example.com', apiToken: 'tok' });

      expect(result).toEqual({ success: false, error: 'Audiobookshelf rejected the API token' });
    });

    it('falls back to stored server URL and token', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());
      mockClient.testConnection.mockResolvedValue({ success: true, username: 'bob' });

      await makeService().testConnection(1, {});

      expect(mockClient.testConnection).toHaveBeenCalledWith(1, 'https://abs.example.com', 'secret-token');
    });

    it('returns a failure without calling the client when URL or token is missing', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      const result = await makeService().testConnection(1, { serverUrl: 'https://abs.example.com' });

      expect(result.success).toBe(false);
      expect(mockClient.testConnection).not.toHaveBeenCalled();
    });

    it('returns a failure for an invalid server URL', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      const result = await makeService().testConnection(1, { serverUrl: 'not-a-url', apiToken: 'tok' });

      expect(result.success).toBe(false);
      expect(mockClient.testConnection).not.toHaveBeenCalled();
    });

    it('returns a failure when the URL is rejected by the SSRF guard', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      mockedEnsureSafeUrl.mockRejectedValueOnce(new BadRequestException('private'));

      const result = await makeService().testConnection(1, { serverUrl: 'https://169.254.169.254', apiToken: 'tok' });

      expect(result.success).toBe(false);
      expect(mockClient.testConnection).not.toHaveBeenCalled();
    });
  });

  describe('getLibraries', () => {
    it('returns book libraries with their folder paths and the accessible local folder roots', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());
      mockLibraryService.findAccessibleLibraryIds.mockResolvedValue([3, 5]);
      mockRepo.findLibraryFolderPaths.mockResolvedValue(['/books', '/media/books']);
      mockClient.getLibraries.mockResolvedValue({
        libraries: [
          { id: 'lib-1', name: 'Audiobooks', mediaType: 'book', folderPaths: ['/audiobooks'] },
          { id: 'lib-2', name: 'Podcasts', mediaType: 'podcast', folderPaths: ['/podcasts'] },
        ],
      });

      const result = await makeService().getLibraries(mockUser as any);

      expect(result).toEqual({
        libraries: [{ id: 'lib-1', name: 'Audiobooks', mediaType: 'book', folderPaths: ['/audiobooks'] }],
        localFolderPaths: ['/books', '/media/books'],
      });
      expect(mockLibraryService.findAccessibleLibraryIds).toHaveBeenCalledWith(mockUser);
      expect(mockRepo.findLibraryFolderPaths).toHaveBeenCalledWith([3, 5]);
    });

    it('throws BadRequestException when the integration is not configured', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      await expect(makeService().getLibraries(mockUser as any)).rejects.toThrow(BadRequestException);
      expect(mockClient.getLibraries).not.toHaveBeenCalled();
      expect(mockRepo.findLibraryFolderPaths).not.toHaveBeenCalled();
    });
  });

  describe('disconnectUser', () => {
    it('throws NotFoundException when not configured', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);

      await expect(makeService().disconnectUser(1)).rejects.toThrow(NotFoundException);
      expect(mockRepo.deleteSettings).not.toHaveBeenCalled();
    });

    it('deletes settings when configured', async () => {
      mockRepo.findSettings.mockResolvedValue(configuredRow());
      mockRepo.deleteSettings.mockResolvedValue(undefined);

      await makeService().disconnectUser(1);

      expect(mockRepo.deleteSettings).toHaveBeenCalledWith(1);
    });
  });
});
