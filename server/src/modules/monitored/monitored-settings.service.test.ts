import { BadRequestException, Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MonitoredSettingsService } from './monitored-settings.service';

const defaults = { refreshCooldownMinutes: 10, syncEnabled: true, syncIntervalHours: 12, releaseProbeEnabled: true };

function harness(rows: Array<typeof defaults | undefined> = [defaults]) {
  const selectBuilder = { from: vi.fn(), where: vi.fn(), limit: vi.fn() };
  selectBuilder.from.mockReturnValue(selectBuilder);
  selectBuilder.where.mockReturnValue(selectBuilder);
  for (const row of rows) selectBuilder.limit.mockResolvedValueOnce(row ? [row] : []);

  const insertBuilder = { values: vi.fn(), onConflictDoNothing: vi.fn(), onConflictDoUpdate: vi.fn() };
  insertBuilder.values.mockReturnValue(insertBuilder);
  insertBuilder.onConflictDoNothing.mockResolvedValue(undefined);
  insertBuilder.onConflictDoUpdate.mockResolvedValue(undefined);

  const db = {
    select: vi.fn().mockReturnValue(selectBuilder),
    insert: vi.fn().mockReturnValue(insertBuilder),
    transaction: vi.fn(
      (callback: (tx: { insert: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }) => unknown) =>
        callback({ insert: vi.fn().mockReturnValue(insertBuilder), execute: vi.fn(), delete: vi.fn() }),
    ),
  };
  const appSettings = { getValues: vi.fn().mockResolvedValue(new Map<string, string>()) };
  const releaseProbeStore = { clearAll: vi.fn().mockResolvedValue(3) };
  return {
    service: new MonitoredSettingsService(db as never, appSettings as never, releaseProbeStore as never),
    db,
    appSettings,
    insertBuilder,
    releaseProbeStore,
  };
}

describe('MonitoredSettingsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns and caches the monitored-owned row', async () => {
    const { service, db, appSettings } = harness();

    await expect(service.getMonitoredSettings()).resolves.toEqual(defaults);
    await expect(service.getMonitoredSettings()).resolves.toEqual(defaults);

    expect(db.select).toHaveBeenCalledOnce();
    expect(appSettings.getValues).not.toHaveBeenCalled();
  });

  it('seeds an empty table from valid legacy app settings exactly once', async () => {
    const seeded = { refreshCooldownMinutes: 45, syncEnabled: false, syncIntervalHours: 24, releaseProbeEnabled: true };
    const { service, appSettings, insertBuilder } = harness([undefined, seeded]);
    appSettings.getValues.mockResolvedValue(
      new Map([
        ['monitored_refresh_cooldown_minutes', '45'],
        ['monitored_sync_enabled', 'false'],
        ['monitored_sync_interval_hours', '24'],
      ]),
    );

    await expect(service.getMonitoredSettings()).resolves.toEqual(seeded);

    expect(insertBuilder.values).toHaveBeenCalledWith({ id: 1, ...seeded });
    expect(insertBuilder.onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it('uses shipped defaults when legacy values are absent or invalid', async () => {
    const { service, appSettings, insertBuilder } = harness([undefined, defaults]);
    appSettings.getValues.mockResolvedValue(
      new Map([
        ['monitored_refresh_cooldown_minutes', '0'],
        ['monitored_sync_enabled', 'maybe'],
        ['monitored_sync_interval_hours', '169'],
      ]),
    );

    await service.getMonitoredSettings();

    expect(insertBuilder.values).toHaveBeenCalledWith({ id: 1, ...defaults });
  });

  it('keeps stored values when a partial update changes only the cooldown', async () => {
    const current = { refreshCooldownMinutes: 10, syncEnabled: false, syncIntervalHours: 24, releaseProbeEnabled: false };
    const { service, insertBuilder } = harness([current]);

    await expect(service.setMonitoredSettings({ refreshCooldownMinutes: 45 })).resolves.toEqual({
      refreshCooldownMinutes: 45,
      syncEnabled: false,
      syncIntervalHours: 24,
      releaseProbeEnabled: false,
    });
    expect(insertBuilder.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: { refreshCooldownMinutes: 45, syncEnabled: false, syncIntervalHours: 24, releaseProbeEnabled: false } }),
    );
  });

  it('round trips the release probe flag', async () => {
    const { service, insertBuilder } = harness();

    await expect(service.setMonitoredSettings({ refreshCooldownMinutes: 10, releaseProbeEnabled: false })).resolves.toEqual({
      ...defaults,
      releaseProbeEnabled: false,
    });
    expect(insertBuilder.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: { ...defaults, releaseProbeEnabled: false } }));
  });

  it('removes the probe rows when the flag is switched off', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, releaseProbeStore } = harness();

    await service.setMonitoredSettings({ refreshCooldownMinutes: 10, releaseProbeEnabled: false });

    expect(releaseProbeStore.clearAll).toHaveBeenCalledWith(
      expect.objectContaining({ insert: expect.any(Function), execute: expect.any(Function), delete: expect.any(Function) }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[monitored\.release_probe\.disabled\] \[end\] durationMs=\d+ deleted=3 - release probe rows removed$/),
    );
    log.mockRestore();
  });

  it('retries clearing probe rows on every save that remains disabled', async () => {
    const stored = { refreshCooldownMinutes: 10, syncEnabled: true, syncIntervalHours: 12, releaseProbeEnabled: false };
    const { service, releaseProbeStore } = harness([stored]);

    await service.setMonitoredSettings({ refreshCooldownMinutes: 45, releaseProbeEnabled: false });

    expect(releaseProbeStore.clearAll).toHaveBeenCalledWith(
      expect.objectContaining({ insert: expect.any(Function), execute: expect.any(Function), delete: expect.any(Function) }),
    );
  });

  it('leaves probe rows alone when the resulting setting is enabled', async () => {
    const { service, releaseProbeStore } = harness();

    await service.setMonitoredSettings({ refreshCooldownMinutes: 45, releaseProbeEnabled: true });

    expect(releaseProbeStore.clearAll).not.toHaveBeenCalled();
  });

  it('does not persist or cache a disabled setting when clearing rows fails', async () => {
    const { service, insertBuilder, releaseProbeStore } = harness();
    releaseProbeStore.clearAll.mockRejectedValueOnce(new Error('delete failed'));

    await expect(service.setMonitoredSettings({ refreshCooldownMinutes: 45, releaseProbeEnabled: false })).rejects.toThrow('delete failed');

    expect(insertBuilder.onConflictDoUpdate).not.toHaveBeenCalled();
    await expect(service.getMonitoredSettings()).resolves.toEqual(defaults);
  });

  it('clears rows and writes the disabled setting in one transaction without caching a failed write', async () => {
    const { service, db, insertBuilder, releaseProbeStore } = harness();
    insertBuilder.onConflictDoUpdate.mockRejectedValueOnce(new Error('write failed'));

    await expect(service.setMonitoredSettings({ refreshCooldownMinutes: 45, releaseProbeEnabled: false })).rejects.toThrow('write failed');

    expect(db.transaction).toHaveBeenCalledOnce();
    const transactionHandle = releaseProbeStore.clearAll.mock.calls[0]?.[0];
    expect(transactionHandle).toBeDefined();
    expect(transactionHandle.insert).toHaveBeenCalledWith(expect.anything());
    await expect(service.getMonitoredSettings()).resolves.toEqual(defaults);
  });

  it.each([0, 1441, 1.5])('rejects an invalid refresh cooldown of %s', async (refreshCooldownMinutes) => {
    const { service, insertBuilder } = harness();

    await expect(service.setMonitoredSettings({ ...defaults, refreshCooldownMinutes })).rejects.toThrow(BadRequestException);
    expect(insertBuilder.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it.each([0, 169, 1.5])('rejects an invalid sync interval of %s', async (syncIntervalHours) => {
    const { service, insertBuilder } = harness();

    await expect(service.setMonitoredSettings({ ...defaults, syncIntervalHours })).rejects.toThrow(BadRequestException);
    expect(insertBuilder.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean release probe flag', async () => {
    const { service, insertBuilder } = harness();

    await expect(service.setMonitoredSettings({ ...defaults, releaseProbeEnabled: 'yes' as unknown as boolean })).rejects.toThrow(
      BadRequestException,
    );
    expect(insertBuilder.onConflictDoUpdate).not.toHaveBeenCalled();
  });
});
