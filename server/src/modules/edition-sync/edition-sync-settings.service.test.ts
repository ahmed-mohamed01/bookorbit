import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';

import { PermissionService } from '../../common/services/permission.service';
import type { RequestUser } from '../../common/types/request-user';
import { UpdateEditionSyncAdminSettingsDto } from './dto/edition-sync.dto';
import { EditionSyncSettingsService } from './edition-sync-settings.service';

const permitted = { id: 7, isSuperuser: false, permissions: ['edition_sync'] } as unknown as RequestUser;
const unpermitted = { id: 8, isSuperuser: false, permissions: [] } as unknown as RequestUser;

function setup(row: { enabled: boolean; bookSyncMode: 'all_eligible' | 'selected_only' } | null = null) {
  const repo = {
    findUserSettings: vi.fn().mockResolvedValue(row && { userId: 7, ...row, updatedAt: new Date() }),
    upsertUserSettings: vi.fn().mockImplementation((userId: number, patch: Record<string, unknown>) =>
      Promise.resolve({
        userId,
        enabled: true,
        bookSyncMode: 'all_eligible',
        updatedAt: new Date(),
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      }),
    ),
    isServerEnabled: vi.fn().mockResolvedValue(true),
    findAdminSettings: vi.fn().mockResolvedValue({
      id: 1,
      enabled: true,
      onFilesChanged: 'next_run',
      cronExpression: '0 2 * * *',
      runHours: 8,
      updatedAt: new Date('2026-11-01T00:00:00Z'),
      updatedByUserId: null,
    }),
    updateAdminSettings: vi.fn().mockImplementation((patch: Record<string, unknown>) =>
      Promise.resolve({
        id: 1,
        enabled: true,
        onFilesChanged: 'next_run',
        cronExpression: '0 2 * * *',
        runHours: 8,
        updatedAt: new Date('2026-11-01T00:00:00Z'),
        updatedByUserId: 7,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      }),
    ),
  };
  const scheduler = { stop: vi.fn().mockResolvedValue({}), syncSchedule: vi.fn().mockReturnValue(true) };
  const overlaySource = { invalidate: vi.fn() };
  const service = new EditionSyncSettingsService(repo as never, new PermissionService(), scheduler as never, overlaySource as never);
  return { service, repo, scheduler, overlaySource };
}

describe('EditionSyncSettingsService', () => {
  it('defaults to on for a user without a row', async () => {
    const { service } = setup();
    await expect(service.getSettings(permitted)).resolves.toEqual({
      enabled: true,
      effectiveEnabled: true,
      disabledReason: null,
      bookSyncMode: 'all_eligible',
    });
  });

  it('is effective only with the permission', async () => {
    const { service } = setup({ enabled: true, bookSyncMode: 'selected_only' });
    await expect(service.getSettings(permitted)).resolves.toMatchObject({
      effectiveEnabled: true,
      disabledReason: null,
      bookSyncMode: 'selected_only',
    });
    await expect(service.getSettings(unpermitted)).resolves.toMatchObject({ effectiveEnabled: false, disabledReason: 'permission_denied' });
  });

  it('saves user settings and drops cached sync decisions', async () => {
    const { service, repo, overlaySource } = setup();
    await expect(service.upsertSettings(permitted, { enabled: true })).resolves.toMatchObject({ enabled: true, effectiveEnabled: true });
    expect(repo.upsertUserSettings).toHaveBeenCalledWith(7, { enabled: true, bookSyncMode: undefined });
    expect(overlaySource.invalidate).toHaveBeenCalledWith(7);
  });

  it('saves the schedule and re-registers the cron job; null means Never', async () => {
    const { service, repo, scheduler } = setup();
    await expect(service.updateAdminSettings(permitted, { cronExpression: null, runHours: 4 })).resolves.toEqual({
      enabled: true,
      onFilesChanged: 'next_run',
      cronExpression: null,
      runHours: 4,
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(repo.updateAdminSettings).toHaveBeenCalledWith({ enabled: undefined, cronExpression: null, runHours: 4, onFilesChanged: undefined }, 7);
    expect(scheduler.syncSchedule).toHaveBeenCalledWith(null, true);
  });

  it('reads admin settings', async () => {
    const { service } = setup();
    await expect(service.getAdminSettings()).resolves.toEqual({
      enabled: true,
      onFilesChanged: 'next_run',
      cronExpression: '0 2 * * *',
      runHours: 8,
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
  });
});

describe('files changed settings', () => {
  it.each(['next_run', 'immediate'])('validates and round trips %s', async (onFilesChanged) => {
    const dto = Object.assign(new UpdateEditionSyncAdminSettingsDto(), { onFilesChanged });
    expect(await validate(dto)).toEqual([]);
    const { service, repo } = setup();
    expect(await service.updateAdminSettings(permitted, dto)).toMatchObject({ onFilesChanged });
    expect(repo.updateAdminSettings).toHaveBeenCalledWith(expect.objectContaining({ onFilesChanged }), 7);
  });
  it('rejects unsupported modes', async () => {
    expect(await validate(Object.assign(new UpdateEditionSyncAdminSettingsDto(), { onFilesChanged: 'always' }))).not.toEqual([]);
  });
});

it('rejects a null file-change mode while allowing omission', async () => {
  expect(await validate(Object.assign(new UpdateEditionSyncAdminSettingsDto(), { onFilesChanged: null }))).not.toEqual([]);
  expect(await validate(new UpdateEditionSyncAdminSettingsDto())).toEqual([]);
});

it('keeps a scope-only first save enabled', async () => {
  const { service } = setup();
  await expect(service.upsertSettings(permitted, { bookSyncMode: 'selected_only' })).resolves.toMatchObject({
    enabled: true,
    effectiveEnabled: true,
    bookSyncMode: 'selected_only',
  });
});
it('disables scheduling, stops work and invalidates every overlay decision', async () => {
  const { service, scheduler, overlaySource, repo } = setup();
  await expect(service.updateAdminSettings(permitted, { enabled: false })).resolves.toMatchObject({ enabled: false });
  expect(scheduler.syncSchedule).toHaveBeenCalledWith('0 2 * * *', false);
  expect(scheduler.stop).toHaveBeenCalled();
  expect(overlaySource.invalidate).toHaveBeenCalledWith();
  repo.isServerEnabled.mockResolvedValue(false);
  await expect(service.getSettings(unpermitted)).resolves.toMatchObject({
    enabled: true,
    effectiveEnabled: false,
    disabledReason: 'server_disabled',
  });
});
it('restores the saved cron when enabled', async () => {
  const { service, scheduler, overlaySource, repo } = setup();
  repo.findAdminSettings.mockResolvedValue({ enabled: false } as never);
  await service.updateAdminSettings(permitted, { enabled: true });
  expect(scheduler.syncSchedule).toHaveBeenCalledWith('0 2 * * *', true);
  expect(overlaySource.invalidate).toHaveBeenCalledWith();
  expect(scheduler.stop).not.toHaveBeenCalled();
});
it('leaves the overlay cache and running work alone when the switch did not change', async () => {
  const { service, scheduler, overlaySource, repo } = setup();
  await service.updateAdminSettings(permitted, { runHours: 4 });
  expect(overlaySource.invalidate).not.toHaveBeenCalled();
  expect(scheduler.stop).not.toHaveBeenCalled();
  repo.findAdminSettings.mockResolvedValue({ enabled: false } as never);
  repo.updateAdminSettings.mockResolvedValueOnce({
    id: 1,
    enabled: false,
    onFilesChanged: 'next_run',
    cronExpression: null,
    runHours: 8,
    updatedAt: new Date(),
    updatedByUserId: 7,
  });
  await service.updateAdminSettings(permitted, { cronExpression: null });
  expect(overlaySource.invalidate).not.toHaveBeenCalled();
  expect(scheduler.stop).not.toHaveBeenCalled();
});
