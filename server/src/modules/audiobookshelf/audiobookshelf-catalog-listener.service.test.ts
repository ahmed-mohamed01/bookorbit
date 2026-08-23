import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AchievementEventsService, ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED } from '../achievement/achievement-events.service';
import { AudiobookshelfCatalogListenerService } from './audiobookshelf-catalog-listener.service';
import { AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS } from './audiobookshelf.constants';

const mockRepo = {
  findSettings: vi.fn(),
};

const mockSyncService = {
  sync: vi.fn(),
};

const mockUserService = {
  findByIdWithPermissions: vi.fn(),
};

const configuredSettings = { enabled: true, serverUrl: 'https://abs.example.com', apiToken: 'tok' };

function eligibleUser(userId = 1) {
  return { id: userId, active: true, isSuperuser: true, permissions: [] };
}

function makeService(events: AchievementEventsService) {
  return new AudiobookshelfCatalogListenerService(events, mockRepo as any, mockSyncService as any, mockUserService as any);
}

describe('AudiobookshelfCatalogListenerService', () => {
  let events: AchievementEventsService;
  let service: AudiobookshelfCatalogListenerService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    mockRepo.findSettings.mockResolvedValue(configuredSettings);
    mockSyncService.sync.mockResolvedValue(undefined);
    mockUserService.findByIdWithPermissions.mockResolvedValue(eligibleUser());

    events = new AchievementEventsService();
    service = makeService(events);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function emitCatalogChanged(userId = 1, libraryId = 7) {
    events.emit(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, { userId, libraryId });
  }

  it('schedules a reconcile sync after the debounce window', async () => {
    emitCatalogChanged();

    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS - 1);
    expect(mockSyncService.sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(mockSyncService.sync).toHaveBeenCalledTimes(1);
    expect(mockSyncService.sync).toHaveBeenCalledWith(eligibleUser(), { reconcile: true });
  });

  it('collapses a burst of events for the same user into a single sync', async () => {
    emitCatalogChanged(1);
    await vi.advanceTimersByTimeAsync(5_000);
    emitCatalogChanged(1);
    await vi.advanceTimersByTimeAsync(5_000);
    emitCatalogChanged(1);

    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(mockSyncService.sync).toHaveBeenCalledTimes(1);
  });

  it('runs an independent sync per distinct user', async () => {
    mockUserService.findByIdWithPermissions.mockImplementation((id: number) => Promise.resolve(eligibleUser(id)));

    emitCatalogChanged(1);
    emitCatalogChanged(2);
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(mockSyncService.sync).toHaveBeenCalledTimes(2);
  });

  it('does not sync when the user is not configured', async () => {
    mockRepo.findSettings.mockResolvedValue({ enabled: false, serverUrl: null, apiToken: null });

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(mockUserService.findByIdWithPermissions).not.toHaveBeenCalled();
    expect(mockSyncService.sync).not.toHaveBeenCalled();
  });

  it('does not sync when findSettings fails', async () => {
    mockRepo.findSettings.mockRejectedValue(new Error('db down'));

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(mockSyncService.sync).not.toHaveBeenCalled();
  });

  it('does not sync when the user is ineligible (inactive)', async () => {
    mockUserService.findByIdWithPermissions.mockResolvedValue({ ...eligibleUser(), active: false });

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(mockSyncService.sync).not.toHaveBeenCalled();
  });

  it('does not sync when the user resolves to null', async () => {
    mockUserService.findByIdWithPermissions.mockResolvedValue(null);

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(mockSyncService.sync).not.toHaveBeenCalled();
  });

  it('does not sync when resolving the user throws', async () => {
    mockUserService.findByIdWithPermissions.mockRejectedValue(new Error('lookup failed'));

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(mockSyncService.sync).not.toHaveBeenCalled();
  });

  it('swallows a ConflictException from an in-flight sync without warning', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    mockSyncService.sync.mockRejectedValue(new ConflictException('sync already running'));

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(mockSyncService.sync).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a sanitized warning for a non-Conflict sync failure', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    mockSyncService.sync.mockRejectedValue(new Error('boom'));

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[abs.catalog_match] [fail] userId=1'));
  });

  it('clears pending timers and unsubscribes on module destroy', async () => {
    const removeListenerSpy = vi.spyOn(events, 'removeListener');

    emitCatalogChanged();
    service.onModuleDestroy();

    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);

    expect(mockSyncService.sync).not.toHaveBeenCalled();
    expect(removeListenerSpy).toHaveBeenCalledWith(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, expect.any(Function));
    expect(events.listenerCount(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED)).toBe(0);
  });
});
