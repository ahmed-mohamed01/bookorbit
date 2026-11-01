import { validate } from 'class-validator';
import { UpdateEditionSyncAdminSettingsDto } from './dto/edition-sync.dto';
import { describe, expect, it, vi } from 'vitest';

import { PermissionService } from '../../common/services/permission.service';
import type { RequestUser } from '../../common/types/request-user';
import { EditionSyncSettingsService } from './edition-sync-settings.service';

const permitted = { id: 7, isSuperuser: false, permissions: ['edition_sync'] } as unknown as RequestUser;
const unpermitted = { id: 8, isSuperuser: false, permissions: [] } as unknown as RequestUser;

function setup(row: { enabled: boolean; bookSyncMode: 'all_eligible' | 'selected_only' } | null = null) {
  const repo = {
    findUserSettings: vi.fn().mockResolvedValue(row && { userId: 7, ...row, updatedAt: new Date() }),
    upsertUserSettings: vi
      .fn()
      .mockImplementation((userId: number, patch: Record<string, unknown>) =>
        Promise.resolve({ userId, enabled: false, bookSyncMode: 'all_eligible', updatedAt: new Date(), ...patch }),
      ),
    findAdminSettings: vi.fn().mockResolvedValue({
      id: 1,
      onFilesChanged: 'next_run',
      cronExpression: '0 2 * * *',
      runHours: 8,
      updatedAt: new Date('2026-11-01T00:00:00Z'),
      updatedByUserId: null,
    }),
    updateAdminSettings: vi.fn().mockImplementation((patch: Record<string, unknown>) =>
      Promise.resolve({
        id: 1,
        onFilesChanged: 'next_run',
        cronExpression: '0 2 * * *',
        runHours: 8,
        updatedAt: new Date('2026-11-01T00:00:00Z'),
        updatedByUserId: 7,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      }),
    ),
  };
  const scheduler = { syncSchedule: vi.fn().mockReturnValue(true) };
  const overlaySource = { invalidate: vi.fn() };
  const service = new EditionSyncSettingsService(repo as never, new PermissionService(), scheduler as never, overlaySource as never);
  return { service, repo, scheduler, overlaySource };
}

describe('EditionSyncSettingsService', () => {
  it('defaults to off for a user without a row', async () => {
    const { service } = setup();
    await expect(service.getSettings(permitted)).resolves.toEqual({
      enabled: false,
      effectiveEnabled: false,
      disabledReason: 'user_disabled',
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
      onFilesChanged: 'next_run',
      cronExpression: null,
      runHours: 4,
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(repo.updateAdminSettings).toHaveBeenCalledWith({ cronExpression: null, runHours: 4, onFilesChanged: undefined }, 7);
    expect(scheduler.syncSchedule).toHaveBeenCalledWith(null);
  });

  it('reads admin settings', async () => {
    const { service } = setup();
    await expect(service.getAdminSettings()).resolves.toEqual({
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
