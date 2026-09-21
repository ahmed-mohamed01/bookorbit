export const DEFAULT_MONITORED_REFRESH_COOLDOWN_MINUTES = 10;
export const DEFAULT_MONITORED_SYNC_ENABLED = true;
export const DEFAULT_MONITORED_SYNC_INTERVAL_HOURS = 12;
export const DEFAULT_MONITORED_RELEASE_PROBE_ENABLED = true;
export const MIN_MONITORED_REFRESH_COOLDOWN_MINUTES = 1;
export const MAX_MONITORED_REFRESH_COOLDOWN_MINUTES = 1440;
export const MIN_MONITORED_SYNC_INTERVAL_HOURS = 1;
export const MAX_MONITORED_SYNC_INTERVAL_HOURS = 168;

export const LEGACY_MONITORED_SETTING_KEYS = {
  refreshCooldownMinutes: 'monitored_refresh_cooldown_minutes',
  syncEnabled: 'monitored_sync_enabled',
  syncIntervalHours: 'monitored_sync_interval_hours',
} as const;
