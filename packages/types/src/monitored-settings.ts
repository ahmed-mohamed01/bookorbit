export interface MonitoredSettings {
  refreshCooldownMinutes: number;
  /** Whether the background sweep refreshes monitored catalogs from the bibliography providers. */
  syncEnabled: boolean;
  /** How stale a monitor's catalog must be before the sweep picks it up. */
  syncIntervalHours: number;
}

export type UpdateMonitoredSettingsRequest = MonitoredSettings;
