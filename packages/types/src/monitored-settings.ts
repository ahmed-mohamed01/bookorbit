export interface MonitoredSettings {
  refreshCooldownMinutes: number;
  /** Whether the background sweep refreshes monitored catalogs from the bibliography providers. */
  syncEnabled: boolean;
  /** How stale a monitor's catalog must be before the sweep picks it up. */
  syncIntervalHours: number;
  /** Whether the background probe checks each format's own release date for upcoming and recent works. */
  releaseProbeEnabled: boolean;
}

export type UpdateMonitoredSettingsRequest = MonitoredSettings;
