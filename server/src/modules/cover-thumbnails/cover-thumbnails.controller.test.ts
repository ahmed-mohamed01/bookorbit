import 'reflect-metadata';
import { Permission } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import type { CoverThumbnailBackfillService } from './cover-thumbnail-backfill.service';
import { CoverThumbnailsController } from './cover-thumbnails.controller';

describe('CoverThumbnailsController', () => {
  it('requires the manage app settings permission for every route', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, CoverThumbnailsController)).toBe(Permission.ManageAppSettings);
  });

  it('passes the switch and the run request through to the service with the caller', async () => {
    const user = { id: 3 } as RequestUser;
    const state = { enabled: false, running: null, lastRun: null };
    const service = {
      getState: vi.fn().mockResolvedValue(state),
      setEnabled: vi.fn().mockResolvedValue(state),
      startManual: vi.fn().mockResolvedValue(state),
    };
    const controller = new CoverThumbnailsController(service as unknown as CoverThumbnailBackfillService);

    await expect(controller.getState()).resolves.toBe(state);
    await expect(controller.update({ enabled: false }, user)).resolves.toBe(state);
    await expect(controller.run(user)).resolves.toBe(state);
    expect(service.setEnabled).toHaveBeenCalledWith(user, false);
    expect(service.startManual).toHaveBeenCalledWith(user);
  });
});
