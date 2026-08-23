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
};

const mockClient = {
  testConnection: vi.fn(),
  getLibraries: vi.fn(),
};

const mockConfig = {
  get: vi.fn().mockReturnValue(undefined),
};

function makeService() {
  return new AudiobookshelfSettingsService(mockRepo as any, mockClient as any, mockConfig as any);
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
    lastSyncedAt: null,
    lastSyncError: null,
    ...overrides,
  };
}

describe('AudiobookshelfSettingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnsureSafeUrl.mockResolvedValue(undefined as never);
    mockRepo.userHasAudiobookshelfSyncPermission.mockResolvedValue(true);
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
