import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';
import type { AudiobookshelfRepository } from './audiobookshelf.repository';

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    userId: 42,
    serverUrl: 'https://abs.example.com',
    apiToken: 'stored-token',
    enabled: true,
    syncStatus: true,
    syncPosition: true,
    syncSessions: true,
    excludedLibraryIds: [],
    lastSyncedAt: null,
    lastSyncError: null,
    lastSessionWatermark: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('AudiobookshelfSettingsService', () => {
  let repo: {
    findSettings: ReturnType<typeof vi.fn>;
    upsertSettings: ReturnType<typeof vi.fn>;
    deleteSettings: ReturnType<typeof vi.fn>;
    userHasAudiobookshelfSyncPermission: ReturnType<typeof vi.fn>;
  };
  let client: { testConnection: ReturnType<typeof vi.fn>; getLibraries: ReturnType<typeof vi.fn> };
  let service: AudiobookshelfSettingsService;

  beforeEach(() => {
    repo = {
      findSettings: vi.fn(),
      upsertSettings: vi.fn().mockResolvedValue(makeRow()),
      deleteSettings: vi.fn().mockResolvedValue(undefined),
      userHasAudiobookshelfSyncPermission: vi.fn().mockResolvedValue(true),
    };
    client = { testConnection: vi.fn(), getLibraries: vi.fn() };
    service = new AudiobookshelfSettingsService(repo as unknown as AudiobookshelfRepository, client as unknown as AudiobookshelfClientService);
  });

  describe('getSettings', () => {
    it('never returns the raw token, only tokenConfigured', async () => {
      repo.findSettings.mockResolvedValue(makeRow());
      const settings = await service.getSettings(42);
      expect(settings).not.toHaveProperty('apiToken');
      expect(JSON.stringify(settings)).not.toContain('stored-token');
      expect(settings.tokenConfigured).toBe(true);
      expect(settings.serverUrl).toBe('https://abs.example.com');
      expect(settings.effectiveEnabled).toBe(true);
      expect(settings.excludedLibraryIds).toEqual([]);
      expect(settings.disabledReason).toBeNull();
    });

    it('reports missing_config when no settings exist', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      const settings = await service.getSettings(42);
      expect(settings.tokenConfigured).toBe(false);
      expect(settings.serverUrl).toBeNull();
      expect(settings.effectiveEnabled).toBe(false);
      expect(settings.disabledReason).toBe('missing_config');
    });

    it('reports permission_denied when the user lacks the sync permission', async () => {
      repo.findSettings.mockResolvedValue(makeRow());
      repo.userHasAudiobookshelfSyncPermission.mockResolvedValue(false);
      const settings = await service.getSettings(42);
      expect(settings.effectiveEnabled).toBe(false);
      expect(settings.disabledReason).toBe('permission_denied');
    });

    it('reports user_disabled when configured but disabled', async () => {
      repo.findSettings.mockResolvedValue(makeRow({ enabled: false }));
      const settings = await service.getSettings(42);
      expect(settings.disabledReason).toBe('user_disabled');
    });
  });

  describe('upsertSettings', () => {
    it('requires url and token on first save', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      await expect(service.upsertSettings(42, { apiToken: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.upsertSettings(42, { serverUrl: 'https://abs.example.com' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-http(s) server URL', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      await expect(service.upsertSettings(42, { serverUrl: 'ftp://abs.example.com', apiToken: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsertSettings).not.toHaveBeenCalled();
    });

    it('normalizes the server URL (strips trailing slash) on save', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      await service.upsertSettings(42, { serverUrl: 'https://abs.example.com/', apiToken: 'abc' });
      expect(repo.upsertSettings).toHaveBeenCalledWith(42, expect.objectContaining({ serverUrl: 'https://abs.example.com' }));
    });

    it('carries existing url and token into the insert values when only a toggle changes', async () => {
      repo.findSettings.mockResolvedValue(makeRow());
      await service.upsertSettings(42, { syncSessions: false });
      expect(repo.upsertSettings).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ serverUrl: 'https://abs.example.com', apiToken: 'stored-token', syncSessions: false }),
      );
    });

    it('normalizes and deduplicates excluded library ids', async () => {
      repo.findSettings.mockResolvedValue(makeRow());
      await service.upsertSettings(42, { excludedLibraryIds: [' blinkist ', 'fiction', 'blinkist'] });
      expect(repo.upsertSettings).toHaveBeenCalledWith(42, expect.objectContaining({ excludedLibraryIds: ['blinkist', 'fiction'] }));
    });
  });

  describe('getLibraries', () => {
    it('returns book libraries with their exclusion state', async () => {
      repo.findSettings.mockResolvedValue(makeRow({ excludedLibraryIds: ['blinkist'] }));
      client.getLibraries.mockResolvedValue({
        libraries: [
          { id: 'fiction', name: 'Fiction', mediaType: 'book', provider: 'audible' },
          { id: 'blinkist', name: 'Blinkist', mediaType: 'book', provider: 'audible' },
          { id: 'podcasts', name: 'Podcasts', mediaType: 'podcast', provider: 'rss' },
        ],
      });

      await expect(service.getLibraries(42)).resolves.toEqual({
        libraries: [
          { id: 'fiction', name: 'Fiction', mediaType: 'book', provider: 'audible', excluded: false },
          { id: 'blinkist', name: 'Blinkist', mediaType: 'book', provider: 'audible', excluded: true },
        ],
      });
    });
  });

  describe('disconnectUser', () => {
    it('throws when nothing is configured', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      await expect(service.disconnectUser(42)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deletes existing settings', async () => {
      repo.findSettings.mockResolvedValue(makeRow());
      await service.disconnectUser(42);
      expect(repo.deleteSettings).toHaveBeenCalledWith(42);
    });
  });

  describe('testConnection', () => {
    it('falls back to stored url and token when payload omits them', async () => {
      repo.findSettings.mockResolvedValue(makeRow());
      client.testConnection.mockResolvedValue({ success: true, username: 'ada' });
      const result = await service.testConnection(42, {});
      expect(client.testConnection).toHaveBeenCalledWith(42, 'https://abs.example.com', 'stored-token');
      expect(result).toEqual({ success: true, username: 'ada' });
    });

    it('uses the payload url and token when provided', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      client.testConnection.mockResolvedValue({ success: true, username: 'ada' });
      await service.testConnection(42, { serverUrl: 'https://other.example.com/', apiToken: 'live-token' });
      expect(client.testConnection).toHaveBeenCalledWith(42, 'https://other.example.com', 'live-token');
    });

    it('returns a clean error when config is incomplete', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      const result = await service.testConnection(42, {});
      expect(result.success).toBe(false);
      expect(client.testConnection).not.toHaveBeenCalled();
    });

    it('returns a clean error for an invalid payload URL without calling the client', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      const result = await service.testConnection(42, { serverUrl: 'ftp://x', apiToken: 'abc' });
      expect(result.success).toBe(false);
      expect(client.testConnection).not.toHaveBeenCalled();
    });
  });
});
