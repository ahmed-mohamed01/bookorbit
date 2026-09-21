import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MonitoredSettings } from '@bookorbit/types';

import { DB } from '../../db';
import * as dbSchema from '../../db/schema';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { MonitoredReleaseProbeStore } from './monitored-release-probe-store.service';
import {
  DEFAULT_MONITORED_REFRESH_COOLDOWN_MINUTES,
  DEFAULT_MONITORED_RELEASE_PROBE_ENABLED,
  DEFAULT_MONITORED_SYNC_ENABLED,
  DEFAULT_MONITORED_SYNC_INTERVAL_HOURS,
  LEGACY_MONITORED_SETTING_KEYS,
  MAX_MONITORED_REFRESH_COOLDOWN_MINUTES,
  MAX_MONITORED_SYNC_INTERVAL_HOURS,
  MIN_MONITORED_REFRESH_COOLDOWN_MINUTES,
  MIN_MONITORED_SYNC_INTERVAL_HOURS,
} from './monitored-settings.constants';
import { monitoredSettings } from './schema/monitored.schema';

type Db = NodePgDatabase<typeof dbSchema>;

@Injectable()
export class MonitoredSettingsService {
  private readonly logger = new Logger(MonitoredSettingsService.name);
  private cached: MonitoredSettings | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly appSettings: AppSettingsService,
    private readonly releaseProbeStore: MonitoredReleaseProbeStore,
  ) {}

  async getMonitoredSettings(): Promise<MonitoredSettings> {
    if (this.cached) return this.cached;

    let row = await this.readSettings();
    if (!row) {
      const seeded = await this.legacySettings();
      await this.db
        .insert(monitoredSettings)
        .values({ id: 1, ...seeded })
        .onConflictDoNothing();
      row = await this.readSettings();
    }
    if (!row) throw new ServiceUnavailableException('Monitored settings could not be initialized');

    this.cached = {
      refreshCooldownMinutes: row.refreshCooldownMinutes,
      syncEnabled: row.syncEnabled,
      syncIntervalHours: row.syncIntervalHours,
      releaseProbeEnabled: row.releaseProbeEnabled,
    };
    return this.cached;
  }

  async setMonitoredSettings(provided: Partial<MonitoredSettings> & Pick<MonitoredSettings, 'refreshCooldownMinutes'>): Promise<MonitoredSettings> {
    const current = await this.getMonitoredSettings();
    const settings = { ...current, ...provided };
    this.validate(settings);

    const startedAt = Date.now();
    const deleted = await this.db.transaction(async (tx) => {
      const count = settings.releaseProbeEnabled ? 0 : await this.releaseProbeStore.clearAll(tx);
      await tx
        .insert(monitoredSettings)
        .values({ id: 1, ...settings })
        .onConflictDoUpdate({
          target: monitoredSettings.id,
          set: settings,
        });
      return count;
    });
    this.cached = settings;
    if (deleted > 0) {
      this.logger.log(
        `[monitored.release_probe.disabled] [end] durationMs=${Date.now() - startedAt} deleted=${deleted} - release probe rows removed`,
      );
    }
    return settings;
  }

  private async readSettings() {
    const [row] = await this.db.select().from(monitoredSettings).where(eq(monitoredSettings.id, 1)).limit(1);
    return row;
  }

  private async legacySettings(): Promise<MonitoredSettings> {
    const values = await this.appSettings.getValues(Object.values(LEGACY_MONITORED_SETTING_KEYS));
    const refreshCooldownMinutes = Number(values.get(LEGACY_MONITORED_SETTING_KEYS.refreshCooldownMinutes));
    const syncIntervalHours = Number(values.get(LEGACY_MONITORED_SETTING_KEYS.syncIntervalHours));
    const syncEnabled = values.get(LEGACY_MONITORED_SETTING_KEYS.syncEnabled);
    return {
      refreshCooldownMinutes:
        Number.isInteger(refreshCooldownMinutes) &&
        refreshCooldownMinutes >= MIN_MONITORED_REFRESH_COOLDOWN_MINUTES &&
        refreshCooldownMinutes <= MAX_MONITORED_REFRESH_COOLDOWN_MINUTES
          ? refreshCooldownMinutes
          : DEFAULT_MONITORED_REFRESH_COOLDOWN_MINUTES,
      syncEnabled: syncEnabled === 'true' ? true : syncEnabled === 'false' ? false : DEFAULT_MONITORED_SYNC_ENABLED,
      syncIntervalHours:
        Number.isInteger(syncIntervalHours) &&
        syncIntervalHours >= MIN_MONITORED_SYNC_INTERVAL_HOURS &&
        syncIntervalHours <= MAX_MONITORED_SYNC_INTERVAL_HOURS
          ? syncIntervalHours
          : DEFAULT_MONITORED_SYNC_INTERVAL_HOURS,
      releaseProbeEnabled: DEFAULT_MONITORED_RELEASE_PROBE_ENABLED,
    };
  }

  private validate(settings: MonitoredSettings): void {
    if (
      !Number.isInteger(settings.refreshCooldownMinutes) ||
      settings.refreshCooldownMinutes < MIN_MONITORED_REFRESH_COOLDOWN_MINUTES ||
      settings.refreshCooldownMinutes > MAX_MONITORED_REFRESH_COOLDOWN_MINUTES
    ) {
      throw new BadRequestException('Monitored refresh cooldown must be an integer from 1 to 1440 minutes');
    }
    if (typeof settings.syncEnabled !== 'boolean') {
      throw new BadRequestException('Monitored sync enabled must be a boolean');
    }
    if (typeof settings.releaseProbeEnabled !== 'boolean') {
      throw new BadRequestException('Monitored release probe enabled must be a boolean');
    }
    if (
      !Number.isInteger(settings.syncIntervalHours) ||
      settings.syncIntervalHours < MIN_MONITORED_SYNC_INTERVAL_HOURS ||
      settings.syncIntervalHours > MAX_MONITORED_SYNC_INTERVAL_HOURS
    ) {
      throw new BadRequestException('Monitored sync interval must be an integer from 1 to 168 hours');
    }
  }
}
