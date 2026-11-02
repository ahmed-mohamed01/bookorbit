import type {
  EditionSyncBookSyncMode,
  EditionSyncDisabledReason,
  EditionSyncEffectiveReason,
  EditionSyncIndexStatus,
  EditionSyncOverride,
  EditionSyncStoredIndexStatus,
} from '@bookorbit/types';

export interface EditionSyncPolicySettings {
  effectiveEnabled: boolean;
  disabledReason: EditionSyncDisabledReason | null;
  bookSyncMode: EditionSyncBookSyncMode;
}

export interface EditionSyncDecision {
  syncEnabled: boolean;
  effectiveReason: EditionSyncEffectiveReason | null;
}

export function resolveEditionSyncSettings(input: {
  serverEnabled: boolean;
  hasPermission: boolean;
  enabled: boolean;
  bookSyncMode: EditionSyncBookSyncMode;
}): EditionSyncPolicySettings {
  const disabledReason: EditionSyncDisabledReason | null = !input.serverEnabled
    ? 'server_disabled'
    : !input.hasPermission
      ? 'permission_denied'
      : !input.enabled
        ? 'user_disabled'
        : null;
  return { effectiveEnabled: disabledReason === null, disabledReason, bookSyncMode: input.bookSyncMode };
}

export function normalizeEditionSyncOverride(value: string | null | undefined): EditionSyncOverride {
  return value === 'included' || value === 'excluded' ? value : null;
}

/** Same rule as Hardcover: the toggle stores only the deviation from the user's book sync mode. */
export function resolveEditionSyncOverrideForToggle(bookSyncMode: EditionSyncBookSyncMode, syncEnabled: boolean): EditionSyncOverride {
  if (bookSyncMode === 'selected_only') return syncEnabled ? 'included' : null;
  return syncEnabled ? null : 'excluded';
}

export function resolveEditionSyncDecision(input: {
  settings: EditionSyncPolicySettings;
  eligible: boolean;
  override: EditionSyncOverride;
}): EditionSyncDecision {
  if (!input.settings.effectiveEnabled) {
    return { syncEnabled: false, effectiveReason: input.settings.disabledReason ?? 'user_disabled' };
  }
  if (!input.eligible) return { syncEnabled: false, effectiveReason: 'not_eligible' };
  if (input.override === 'excluded') return { syncEnabled: false, effectiveReason: 'excluded' };
  if (input.override === 'included') return { syncEnabled: true, effectiveReason: null };
  if (input.settings.bookSyncMode === 'all_eligible') return { syncEnabled: true, effectiveReason: null };
  return { syncEnabled: false, effectiveReason: 'not_selected' };
}

/**
 * The status a reader sees. `queued` is derived: a wanted, eligible book whose row is missing,
 * stale, or failed with a retry requested. A stale row that never held an index (a pin) reads as queued.
 */
export function resolveEditionSyncIndexStatus(input: {
  stored: EditionSyncStoredIndexStatus | null;
  retryRequested: boolean;
  everIndexed: boolean;
  queueable: boolean;
}): EditionSyncIndexStatus {
  switch (input.stored) {
    case 'running':
    case 'ready':
      return input.stored;
    case 'failed':
      return input.retryRequested && input.queueable ? 'queued' : 'failed';
    case 'stale':
      if (!input.everIndexed) return input.queueable ? 'queued' : 'none';
      return 'stale';
    default:
      return input.queueable ? 'queued' : 'none';
  }
}

/** Scheduled runs stop starting new books once the window closes; pinned books ignore it. */
export function isWindowOpen(windowUntil: Date | null, now: Date): boolean {
  return windowUntil === null || now.getTime() < windowUntil.getTime();
}

export function computeWindowUntil(trigger: 'scheduled' | 'manual' | 'toggle', startedAt: Date, runHours: number): Date | null {
  return trigger === 'scheduled' ? new Date(startedAt.getTime() + runHours * 60 * 60_000) : null;
}
