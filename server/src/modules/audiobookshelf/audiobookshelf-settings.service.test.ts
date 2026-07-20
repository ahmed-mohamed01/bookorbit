import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';
import type { AudiobookshelfRepository } from './audiobookshelf.repository';

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    userId: 42,
    serverUrl: 'https://198.51.100.10',
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function makeConfig(nodeEnv = 'production', audiobookshelfAllowLocalServers = false): ConfigService {
  return {
    get: vi.fn((key: string) => {
      if (key === 'app.nodeEnv') return nodeEnv;
      if (key === 'app.audiobookshelfAllowLocalServers') return audiobookshelfAllowLocalServers;
      return undefined;
    }),
  } as unknown as ConfigService;
}

describe('AudiobookshelfSettingsService', () => {
  let repo: {
    findSettings: ReturnType<typeof vi.fn>;
    upsertSettings: ReturnType<typeof vi.fn>;
    updateSettings: ReturnType<typeof vi.fn>;
    deleteSettings: ReturnType<typeof vi.fn>;
    userHasAudiobookshelfSyncPermission: ReturnType<typeof vi.fn>;
  };
  let client: { testConnection: ReturnType<typeof vi.fn>; getLibraries: ReturnType<typeof vi.fn> };
  let service: AudiobookshelfSettingsService;

  beforeEach(() => {
    repo = {
      findSettings: vi.fn(),
      upsertSettings: vi.fn().mockResolvedValue(makeRow()),
      updateSettings: vi.fn().mockResolvedValue(makeRow()),
      deleteSettings: vi.fn().mockResolvedValue(undefined),
      userHasAudiobookshelfSyncPermission: vi.fn().mockResolvedValue(true),
    };
    client = { testConnection: vi.fn(), getLibraries: vi.fn() };
    service = new AudiobookshelfSettingsService(
      repo as unknown as AudiobookshelfRepository,
      client as unknown as AudiobookshelfClientService,
      makeConfig(),
    );
  });

  describe('getSettings', () => {
    it('never returns the raw token, only tokenConfigured', async () => {
      repo.findSettings.mockResolvedValue(makeRow());
      const settings = await service.getSettings(42);
      expect(settings).not.toHaveProperty('apiToken');
      expect(JSON.stringify(settings)).not.toContain('stored-token');
      expect(settings.tokenConfigured).toBe(true);
      expect(settings.serverUrl).toBe('https://198.51.100.10');
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
      await expect(service.upsertSettings(42, { serverUrl: 'https://198.51.100.10' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-http(s) server URL', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      await expect(service.upsertSettings(42, { serverUrl: 'ftp://abs.example.com', apiToken: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsertSettings).not.toHaveBeenCalled();
      expect(repo.updateSettings).not.toHaveBeenCalled();
    });

    it('rejects a link-local metadata URL even when private ABS servers are enabled', async () => {
      service = new AudiobookshelfSettingsService(
        repo as unknown as AudiobookshelfRepository,
        client as unknown as AudiobookshelfClientService,
        makeConfig('production', true),
      );
      repo.findSettings.mockResolvedValue(undefined);

      await expect(service.upsertSettings(42, { serverUrl: 'http://169.254.169.254', apiToken: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsertSettings).not.toHaveBeenCalled();
    });

    it('allows a private LAN ABS URL under the production toggle', async () => {
      service = new AudiobookshelfSettingsService(
        repo as unknown as AudiobookshelfRepository,
        client as unknown as AudiobookshelfClientService,
        makeConfig('production', true),
      );
      repo.findSettings.mockResolvedValue(undefined);

      await service.upsertSettings(42, { serverUrl: 'http://192.168.1.20:13378/', apiToken: 'abc' });

      expect(repo.upsertSettings).toHaveBeenCalledWith(42, expect.objectContaining({ serverUrl: 'http://192.168.1.20:13378' }));
    });

    it('normalizes the server URL (strips trailing slash) on save', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      await service.upsertSettings(42, { serverUrl: 'https://198.51.100.10/', apiToken: 'abc' });
      expect(repo.upsertSettings).toHaveBeenCalledWith(42, expect.objectContaining({ serverUrl: 'https://198.51.100.10' }));
      expect(repo.updateSettings).not.toHaveBeenCalled();
    });

    it('updates only supplied fields when existing settings change', async () => {
      repo.findSettings.mockResolvedValue(makeRow());
      await service.upsertSettings(42, { syncSessions: false });
      expect(repo.updateSettings).toHaveBeenCalledWith(42, { syncSessions: false });
      expect(repo.upsertSettings).not.toHaveBeenCalled();
    });

    it('does not carry stale token values into concurrent partial PATCH updates', async () => {
      repo.findSettings.mockResolvedValue(makeRow({ apiToken: 'old-token' }));

      await Promise.all([
        service.upsertSettings(42, { serverUrl: 'https://198.51.100.11/' }),
        service.upsertSettings(42, { apiToken: 'fresh-token' }),
      ]);

      expect(repo.updateSettings).toHaveBeenCalledWith(42, { serverUrl: 'https://198.51.100.11' });
      expect(repo.updateSettings).toHaveBeenCalledWith(42, { apiToken: 'fresh-token' });
      expect(repo.upsertSettings).not.toHaveBeenCalled();
    });

    it('normalizes and deduplicates excluded library ids', async () => {
      repo.findSettings.mockResolvedValue(makeRow());
      await service.upsertSettings(42, { excludedLibraryIds: [' blinkist ', 'fiction', 'blinkist'] });
      expect(repo.updateSettings).toHaveBeenCalledWith(42, { excludedLibraryIds: ['blinkist', 'fiction'] });
    });

    it('rejects without logging success when a stale PATCH loses a race to DELETE', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      repo.findSettings.mockResolvedValueOnce(makeRow());
      repo.updateSettings.mockResolvedValueOnce(undefined);

      await expect(service.upsertSettings(42, { syncSessions: false })).rejects.toBeInstanceOf(NotFoundException);

      expect(repo.updateSettings).toHaveBeenCalledWith(42, { syncSessions: false });
      expect(repo.upsertSettings).not.toHaveBeenCalled();
      expect(repo.userHasAudiobookshelfSyncPermission).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('settings saved'));
      logSpy.mockRestore();
    });

    it('preserves final stored state for controlled concurrent partial PATCH updates', async () => {
      let stored = makeRow({ serverUrl: 'https://198.51.100.12', apiToken: 'old-token', syncStatus: true });
      const firstUpdate = deferred<void>();
      const secondUpdate = deferred<void>();
      const statefulRepo = {
        findSettings: vi.fn(() => Promise.resolve({ ...stored })),
        upsertSettings: vi.fn(),
        updateSettings: vi.fn(async (_userId: number, data: Record<string, unknown>) => {
          await ('serverUrl' in data ? firstUpdate.promise : secondUpdate.promise);
          stored = { ...stored, ...data, updatedAt: new Date() };
          return { ...stored };
        }),
        deleteSettings: vi.fn(),
        userHasAudiobookshelfSyncPermission: vi.fn().mockResolvedValue(true),
      };
      const statefulService = new AudiobookshelfSettingsService(
        statefulRepo as unknown as AudiobookshelfRepository,
        client as unknown as AudiobookshelfClientService,
        makeConfig(),
      );

      const urlPatch = statefulService.upsertSettings(42, { serverUrl: 'https://198.51.100.11/' });
      const tokenPatch = statefulService.upsertSettings(42, { apiToken: 'fresh-token' });
      await Promise.resolve();
      secondUpdate.resolve();
      await expect(tokenPatch).resolves.toMatchObject({ serverUrl: 'https://198.51.100.12', tokenConfigured: true });
      firstUpdate.resolve();
      await expect(urlPatch).resolves.toMatchObject({ serverUrl: 'https://198.51.100.11', tokenConfigured: true });

      expect(stored).toMatchObject({
        serverUrl: 'https://198.51.100.11',
        apiToken: 'fresh-token',
        syncStatus: true,
      });
      expect(statefulRepo.upsertSettings).not.toHaveBeenCalled();
    });

    it('preserves deletion when a controlled PATCH loses to DELETE', async () => {
      let stored: ReturnType<typeof makeRow> | undefined = makeRow();
      const updateGate = deferred<void>();
      const statefulRepo = {
        findSettings: vi.fn(() => Promise.resolve(stored ? { ...stored } : undefined)),
        upsertSettings: vi.fn(),
        updateSettings: vi.fn(async (_userId: number, data: Record<string, unknown>) => {
          await updateGate.promise;
          if (!stored) return undefined;
          stored = { ...stored, ...data, updatedAt: new Date() };
          return { ...stored };
        }),
        deleteSettings: vi.fn(() => {
          stored = undefined;
        }),
        userHasAudiobookshelfSyncPermission: vi.fn().mockResolvedValue(true),
      };
      const statefulService = new AudiobookshelfSettingsService(
        statefulRepo as unknown as AudiobookshelfRepository,
        client as unknown as AudiobookshelfClientService,
        makeConfig(),
      );

      const patch = statefulService.upsertSettings(42, { syncSessions: false });
      await Promise.resolve();
      await statefulService.disconnectUser(42);
      updateGate.resolve();

      await expect(patch).rejects.toBeInstanceOf(NotFoundException);
      expect(stored).toBeUndefined();
      expect(statefulRepo.upsertSettings).not.toHaveBeenCalled();
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
      expect(client.testConnection).toHaveBeenCalledWith(42, 'https://198.51.100.10', 'stored-token');
      expect(result).toEqual({ success: true, username: 'ada' });
    });

    it('uses the payload url and token when provided', async () => {
      repo.findSettings.mockResolvedValue(undefined);
      client.testConnection.mockResolvedValue({ success: true, username: 'ada' });
      await service.testConnection(42, { serverUrl: 'https://198.51.100.13/', apiToken: 'live-token' });
      expect(client.testConnection).toHaveBeenCalledWith(42, 'https://198.51.100.13', 'live-token');
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

    it('rejects a stored link-local metadata URL without calling the client', async () => {
      service = new AudiobookshelfSettingsService(
        repo as unknown as AudiobookshelfRepository,
        client as unknown as AudiobookshelfClientService,
        makeConfig('production', true),
      );
      repo.findSettings.mockResolvedValue(makeRow({ serverUrl: 'http://169.254.169.254' }));

      await expect(service.testConnection(42, {})).resolves.toEqual({
        success: false,
        error: 'The Audiobookshelf server URL is invalid',
      });
      expect(client.testConnection).not.toHaveBeenCalled();
    });
  });
});
