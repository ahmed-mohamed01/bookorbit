import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AchievementEventsService, ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED } from '../achievement/achievement-events.service';
import { AUDIOBOOKSHELF_CATALOG_MATCH_MAX_RETRIES, AudiobookshelfCatalogListenerService } from './audiobookshelf-catalog-listener.service';
import { AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS, AUDIOBOOKSHELF_CATALOG_MATCH_FOLLOW_UP_DELAYS_MS } from './audiobookshelf.constants';

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

  it('runs follow-up reconciles so items ABS indexes later still get matched', async () => {
    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(1);

    for (const [index, delayMs] of AUDIOBOOKSHELF_CATALOG_MATCH_FOLLOW_UP_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(mockSyncService.sync).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSyncService.sync).toHaveBeenCalledTimes(index + 2);
      expect(mockSyncService.sync).toHaveBeenLastCalledWith(eligibleUser(), { reconcile: true });
    }

    await vi.advanceTimersByTimeAsync(Math.max(...AUDIOBOOKSHELF_CATALOG_MATCH_FOLLOW_UP_DELAYS_MS) * 2);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(AUDIOBOOKSHELF_CATALOG_MATCH_FOLLOW_UP_DELAYS_MS.length + 1);
  });

  it('restarts the follow-up passes when the catalog changes again', async () => {
    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_FOLLOW_UP_DELAYS_MS[0]!);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(2);

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(3);

    const followUpTotal = AUDIOBOOKSHELF_CATALOG_MATCH_FOLLOW_UP_DELAYS_MS.reduce((sum, delayMs) => sum + delayMs, 0);
    await vi.advanceTimersByTimeAsync(followUpTotal);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(3 + AUDIOBOOKSHELF_CATALOG_MATCH_FOLLOW_UP_DELAYS_MS.length);
  });

  it('keeps running follow-up passes after a non-Conflict failure', async () => {
    mockSyncService.sync.mockRejectedValueOnce(new Error('boom'));

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(1);

    const followUpTotal = AUDIOBOOKSHELF_CATALOG_MATCH_FOLLOW_UP_DELAYS_MS.reduce((sum, delayMs) => sum + delayMs, 0);
    await vi.advanceTimersByTimeAsync(followUpTotal * 2);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(1 + AUDIOBOOKSHELF_CATALOG_MATCH_FOLLOW_UP_DELAYS_MS.length);
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

  it('retries the reconcile after a busy lock instead of dropping it', async () => {
    mockSyncService.sync.mockRejectedValueOnce(new ConflictException('sync already running')).mockResolvedValueOnce(undefined);

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(2);
    expect(mockSyncService.sync).toHaveBeenLastCalledWith(eligibleUser(), { reconcile: true });

    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS * 3);
    expect(mockSyncService.sync).toHaveBeenCalledTimes(2);
  });

  it('gives up with a warning when the lock stays busy past the retry limit', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    mockSyncService.sync.mockRejectedValue(new ConflictException('sync already running'));

    emitCatalogChanged();
    await vi.advanceTimersByTimeAsync(AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS * (AUDIOBOOKSHELF_CATALOG_MATCH_MAX_RETRIES + 3));

    expect(mockSyncService.sync).toHaveBeenCalledTimes(AUDIOBOOKSHELF_CATALOG_MATCH_MAX_RETRIES + 1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[abs.catalog_match] [fail] userId=1'));
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
