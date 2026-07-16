export type AudiobookshelfSyncDisabledReason = "permission_denied" | "missing_config" | "user_disabled";

export interface AudiobookshelfSettings {
  serverUrl: string | null;
  tokenConfigured: boolean;
  enabled: boolean;
  effectiveEnabled: boolean;
  disabledReason: AudiobookshelfSyncDisabledReason | null;
  syncStatus: boolean;
  syncPosition: boolean;
  syncSessions: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface UpsertAudiobookshelfSettingsPayload {
  serverUrl?: string;
  apiToken?: string;
  enabled?: boolean;
  syncStatus?: boolean;
  syncPosition?: boolean;
  syncSessions?: boolean;
}

export interface AudiobookshelfConnectionTestPayload {
  serverUrl?: string;
  apiToken?: string;
}

export interface AudiobookshelfConnectionTestResult {
  success: boolean;
  username?: string;
  error?: string;
}
