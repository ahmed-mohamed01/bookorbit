import { describe, expect, it } from 'vitest';

import {
  computeWindowUntil,
  isWindowOpen,
  resolveEditionSyncDecision,
  resolveEditionSyncIndexStatus,
  resolveEditionSyncOverrideForToggle,
  resolveEditionSyncSettings,
} from './edition-sync-policy';

const on = resolveEditionSyncSettings({ serverEnabled: true, hasPermission: true, enabled: true, bookSyncMode: 'all_eligible' });
const selectedOnly = resolveEditionSyncSettings({ serverEnabled: true, hasPermission: true, enabled: true, bookSyncMode: 'selected_only' });

describe('resolveEditionSyncSettings', () => {
  it.each([
    [false, true, false, 'permission_denied'],
    [false, false, false, 'permission_denied'],
    [true, false, false, 'user_disabled'],
    [true, true, true, null],
  ] as const)('permission=%s enabled=%s -> effective=%s reason=%s', (hasPermission, enabled, effectiveEnabled, disabledReason) => {
    expect(resolveEditionSyncSettings({ serverEnabled: true, hasPermission, enabled, bookSyncMode: 'all_eligible' })).toEqual({
      effectiveEnabled,
      disabledReason,
      bookSyncMode: 'all_eligible',
    });
  });
});

describe('resolveEditionSyncDecision', () => {
  it.each([
    [
      'permission denied',
      resolveEditionSyncSettings({ serverEnabled: true, hasPermission: false, enabled: true, bookSyncMode: 'all_eligible' }),
      true,
      'included',
      false,
      'permission_denied',
    ],
    [
      'user disabled',
      resolveEditionSyncSettings({ serverEnabled: true, hasPermission: true, enabled: false, bookSyncMode: 'all_eligible' }),
      true,
      'included',
      false,
      'user_disabled',
    ],
    ['not eligible beats an include', on, false, 'included', false, 'not_eligible'],
    ['excluded', on, true, 'excluded', false, 'excluded'],
    ['included in selected-only mode', selectedOnly, true, 'included', true, null],
    ['all eligible, no override', on, true, null, true, null],
    ['selected only, no override', selectedOnly, true, null, false, 'not_selected'],
  ] as const)('%s', (_label, settings, eligible, override, syncEnabled, effectiveReason) => {
    expect(resolveEditionSyncDecision({ settings, eligible, override })).toEqual({ syncEnabled, effectiveReason });
  });
});

describe('resolveEditionSyncOverrideForToggle', () => {
  it.each([
    ['all_eligible', true, null],
    ['all_eligible', false, 'excluded'],
    ['selected_only', true, 'included'],
    ['selected_only', false, null],
  ] as const)('%s toggled %s stores %s', (mode, enabled, expected) => {
    expect(resolveEditionSyncOverrideForToggle(mode, enabled)).toBe(expected);
  });
});

describe('resolveEditionSyncIndexStatus', () => {
  it.each([
    [null, false, false, true, 'queued'],
    [null, false, false, false, 'none'],
    ['running', false, false, true, 'running'],
    ['ready', false, true, true, 'ready'],
    ['failed', false, false, true, 'failed'],
    ['failed', true, false, true, 'queued'],
    ['failed', true, false, false, 'failed'],
    ['stale', false, true, true, 'stale'],
    ['stale', false, false, true, 'queued'],
    ['stale', false, false, false, 'none'],
  ] as const)('stored=%s retry=%s everIndexed=%s queueable=%s -> %s', (stored, retryRequested, everIndexed, queueable, expected) => {
    expect(resolveEditionSyncIndexStatus({ stored, retryRequested, everIndexed, queueable })).toBe(expected);
  });
});

describe('run window', () => {
  const start = new Date('2026-11-01T02:00:00Z');

  it('gives scheduled runs a window of runHours and manual or toggle runs none', () => {
    expect(computeWindowUntil('scheduled', start, 8)?.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(computeWindowUntil('manual', start, 8)).toBeNull();
    expect(computeWindowUntil('toggle', start, 8)).toBeNull();
  });

  it('is open before the end and closed from the end on; no window is always open', () => {
    const until = new Date('2026-11-01T10:00:00Z');
    expect(isWindowOpen(until, new Date('2026-11-01T09:59:59Z'))).toBe(true);
    expect(isWindowOpen(until, until)).toBe(false);
    expect(isWindowOpen(null, new Date('2030-01-01T00:00:00Z'))).toBe(true);
  });
});

it('prioritizes the server switch over permission and user settings', () => {
  expect(resolveEditionSyncSettings({ serverEnabled: false, hasPermission: false, enabled: false, bookSyncMode: 'all_eligible' })).toMatchObject({
    effectiveEnabled: false,
    disabledReason: 'server_disabled',
  });
});
