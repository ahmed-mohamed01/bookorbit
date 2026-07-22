import { Permission } from '@bookorbit/types';
import type { ContentFilterRules, UserSettings } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { resolveTimeZone } from '../../common/utils/timezone.utils';
import type { LibraryService } from '../library/library.service';
import type { AudiobookshelfUserSetting } from './schema/audiobookshelf.schema';

/**
 * True when a resolved user is allowed to run an Audiobookshelf sync: active, and either a superuser
 * or holding the AudiobookshelfSync permission. Callers resolve the user (findByIdWithPermissions)
 * and handle the not-found/null case themselves, then gate on this predicate.
 */
export function isEligibleSyncUser(user: RequestUser): boolean {
  if (!user.active) return false;
  return user.isSuperuser || user.permissions.includes(Permission.AudiobookshelfSync);
}

/**
 * True when a user's settings are complete enough to sync: enabled with a non-empty server URL and
 * API token. Callers that must reject an incomplete config throw their own error guarded by this.
 */
export function isAbsSyncConfigured(settings: Pick<AudiobookshelfUserSetting, 'enabled' | 'serverUrl' | 'apiToken'> | null | undefined): boolean {
  return Boolean(settings?.enabled && settings.serverUrl && settings.apiToken);
}

/**
 * Standard log descriptor for a caught error: the concrete constructor name and a sanitized message,
 * matching the `errorClass=... error="..."` fields used across the ABS `[fail]` log lines.
 */
export function describeError(err: unknown): { errorClass: string; error: string } {
  const errorClass = err instanceof Error ? err.constructor.name : 'Error';
  const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
  return { errorClass, error };
}

/**
 * The book-access scope for a resolved user: the libraries they can see and, for non-superusers, the
 * content filters to apply. Superusers get no filters (undefined).
 */
export async function buildBookAccessScope(
  user: RequestUser,
  libraryService: LibraryService,
): Promise<{ libraryIds: number[]; contentFilters?: ContentFilterRules }> {
  return {
    libraryIds: await libraryService.findAccessibleLibraryIds(user),
    contentFilters: user.isSuperuser ? undefined : user.contentFilters,
  };
}

/** The user's configured IANA time zone, falling back to UTC. */
export function resolveUserTimeZone(user: RequestUser): string {
  return resolveTimeZone((user.settings as unknown as UserSettings | undefined)?.timezone, 'UTC');
}
