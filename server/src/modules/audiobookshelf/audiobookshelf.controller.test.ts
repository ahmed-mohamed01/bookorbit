import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Permission } from '@bookorbit/types';

import { AudiobookshelfController } from './audiobookshelf.controller';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';

const mockSettingsService = {
  getSettings: vi.fn(),
  getLibraries: vi.fn(),
  upsertSettings: vi.fn(),
  disconnectUser: vi.fn(),
  testConnection: vi.fn(),
};

const mockSyncService = {
  sync: vi.fn(),
  fullResync: vi.fn(),
};

const mockUser = { id: 1, isSuperuser: false, permissions: [] };

function makeController() {
  return new AudiobookshelfController(mockSettingsService as never, mockSyncService as never);
}

describe('AudiobookshelfController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires the AudiobookshelfSync permission at the class level', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, AudiobookshelfController)).toBe(Permission.AudiobookshelfSync);
  });

  it('getSettings delegates to the settings service with the user id', async () => {
    mockSettingsService.getSettings.mockResolvedValue({ enabled: true });
    const result = await makeController().getSettings(mockUser as never);
    expect(result).toEqual({ enabled: true });
    expect(mockSettingsService.getSettings).toHaveBeenCalledWith(1);
  });

  it('getLibraries delegates to the settings service with the user id', async () => {
    mockSettingsService.getLibraries.mockResolvedValue([{ id: 'lib-1' }]);
    const result = await makeController().getLibraries(mockUser as never);
    expect(result).toEqual([{ id: 'lib-1' }]);
    expect(mockSettingsService.getLibraries).toHaveBeenCalledWith(1);
  });

  it('upsertSettings threads the user id and dto body', async () => {
    const dto = { serverUrl: 'https://abs.example', apiToken: 'tok', enabled: true };
    mockSettingsService.upsertSettings.mockResolvedValue({ enabled: true });
    const result = await makeController().upsertSettings(mockUser as never, dto as never);
    expect(result).toEqual({ enabled: true });
    expect(mockSettingsService.upsertSettings).toHaveBeenCalledWith(1, dto);
  });

  it('disconnectUser delegates to the settings service', async () => {
    mockSettingsService.disconnectUser.mockResolvedValue(undefined);
    await makeController().disconnectUser(mockUser as never);
    expect(mockSettingsService.disconnectUser).toHaveBeenCalledWith(1);
  });

  it('testConnection threads the user id and dto body', async () => {
    const dto = { serverUrl: 'https://abs.example', apiToken: 'tok' };
    mockSettingsService.testConnection.mockResolvedValue({ ok: true });
    const result = await makeController().testConnection(mockUser as never, dto as never);
    expect(result).toEqual({ ok: true });
    expect(mockSettingsService.testConnection).toHaveBeenCalledWith(1, dto);
  });

  it('sync delegates to the sync service with the whole user', async () => {
    mockSyncService.sync.mockResolvedValue({ started: true });
    const result = await makeController().sync(mockUser as never);
    expect(result).toEqual({ started: true });
    expect(mockSyncService.sync).toHaveBeenCalledWith(mockUser);
  });

  it('fullResync delegates to the sync service with the whole user', async () => {
    mockSyncService.fullResync.mockResolvedValue({ started: true });
    const result = await makeController().fullResync(mockUser as never);
    expect(result).toEqual({ started: true });
    expect(mockSyncService.fullResync).toHaveBeenCalledWith(mockUser);
  });
});
