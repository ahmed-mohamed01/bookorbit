import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MonitoredSettingsService } from './monitored-settings.service';

const defaults = { refreshCooldownMinutes: 10, syncEnabled: true, syncIntervalHours: 12 };

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
  };
  const appSettings = { getValues: vi.fn().mockResolvedValue(new Map<string, string>()) };
  return { service: new MonitoredSettingsService(db as never, appSettings as never), db, appSettings, insertBuilder };
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
    const seeded = { refreshCooldownMinutes: 45, syncEnabled: false, syncIntervalHours: 24 };
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
    const current = { refreshCooldownMinutes: 10, syncEnabled: false, syncIntervalHours: 24 };
    const { service, insertBuilder } = harness([current]);

    await expect(service.setMonitoredSettings({ refreshCooldownMinutes: 45 })).resolves.toEqual({
      refreshCooldownMinutes: 45,
      syncEnabled: false,
      syncIntervalHours: 24,
    });
    expect(insertBuilder.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: { refreshCooldownMinutes: 45, syncEnabled: false, syncIntervalHours: 24 } }),
    );
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
});
