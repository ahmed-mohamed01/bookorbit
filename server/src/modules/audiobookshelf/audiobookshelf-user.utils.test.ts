import { Permission } from '@bookorbit/types';
import { describe, it, expect } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { describeError, isAbsSyncConfigured, isEligibleSyncUser, resolveUserTimeZone } from './audiobookshelf-user.utils';

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 1,
    username: 'reader',
    name: 'Reader',
    email: 'reader@example.com',
    active: true,
    isSuperuser: false,
    isDefaultPassword: false,
    tokenVersion: 0,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    permissions: [],
    contentFilters: {} as RequestUser['contentFilters'],
    ...overrides,
  };
}

describe('isEligibleSyncUser', () => {
  it('is false for an inactive user even with the permission', () => {
    const user = makeUser({ active: false, permissions: [Permission.AudiobookshelfSync] });
    expect(isEligibleSyncUser(user)).toBe(false);
  });

  it('is true for an active superuser regardless of permissions', () => {
    const user = makeUser({ isSuperuser: true, permissions: [] });
    expect(isEligibleSyncUser(user)).toBe(true);
  });

  it('is true for an active non-superuser holding the AudiobookshelfSync permission', () => {
    const user = makeUser({ permissions: [Permission.AudiobookshelfSync] });
    expect(isEligibleSyncUser(user)).toBe(true);
  });

  it('is false for an active non-superuser without the permission', () => {
    const user = makeUser({ permissions: [] });
    expect(isEligibleSyncUser(user)).toBe(false);
  });
});

describe('isAbsSyncConfigured', () => {
  const full = { enabled: true, serverUrl: 'https://abs.example.com', apiToken: 'token-123' };

  it('is false for null or undefined settings', () => {
    expect(isAbsSyncConfigured(null)).toBe(false);
    expect(isAbsSyncConfigured(undefined)).toBe(false);
  });

  it('is false when disabled', () => {
    expect(isAbsSyncConfigured({ ...full, enabled: false })).toBe(false);
  });

  it('is false for an empty server url', () => {
    expect(isAbsSyncConfigured({ ...full, serverUrl: '' })).toBe(false);
  });

  it('is false for an empty api token', () => {
    expect(isAbsSyncConfigured({ ...full, apiToken: '' })).toBe(false);
  });

  it('is true when fully configured', () => {
    expect(isAbsSyncConfigured(full)).toBe(true);
  });
});

describe('describeError', () => {
  it('uses the constructor name and a sanitized message for an Error', () => {
    const result = describeError(new TypeError('bad "value"\nsecond line'));
    expect(result.errorClass).toBe('TypeError');
    // sanitizeLogValue collapses newlines and escapes quotes
    expect(result.error).toBe('bad \\"value\\" second line');
  });

  it('uses errorClass "Error" and String(x) for a non-Error value', () => {
    const result = describeError('plain string failure');
    expect(result.errorClass).toBe('Error');
    expect(result.error).toBe('plain string failure');
  });

  it('stringifies and sanitizes a non-Error object value', () => {
    const result = describeError(42);
    expect(result.errorClass).toBe('Error');
    expect(result.error).toBe('42');
  });
});

describe('resolveUserTimeZone', () => {
  it('returns the user configured IANA time zone', () => {
    const user = makeUser({ settings: { timezone: 'America/New_York' } });
    expect(resolveUserTimeZone(user)).toBe('America/New_York');
  });

  it('falls back to UTC when the timezone is missing', () => {
    expect(resolveUserTimeZone(makeUser({ settings: {} }))).toBe('UTC');
  });

  it('falls back to UTC when settings has no timezone value', () => {
    const user = makeUser({ settings: { timezone: undefined } });
    expect(resolveUserTimeZone(user)).toBe('UTC');
  });
});
