import { ValidationPipe } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { EditionSyncBookListQueryDto, UpdateEditionSyncAdminSettingsDto, UpdateEditionSyncBookStateDto, UpsertEditionSyncSettingsDto } from './dto';
import { EditionSyncController } from './edition-sync.controller';

type Handler = keyof EditionSyncController;

function permissionOf(handler: Handler): unknown {
  return Reflect.getMetadata(PERMISSION_KEY, EditionSyncController.prototype[handler]) ?? Reflect.getMetadata(PERMISSION_KEY, EditionSyncController);
}

async function errors<T extends object>(cls: new () => T, body: Record<string, unknown>): Promise<string[]> {
  const result = await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true });
  return result.map((error) => error.property);
}

describe('EditionSyncController', () => {
  it('gates the user routes by edition_sync', () => {
    for (const handler of [
      'getSettings',
      'upsertSettings',
      'getBookState',
      'updateBookState',
      'runBookNow',
      'retryBook',
      'retryFailedBooks',
    ] as Handler[]) {
      expect(permissionOf(handler), handler).toBe(Permission.EditionSync);
    }
  });

  it('gates the admin routes by manage_app_settings', () => {
    for (const handler of ['getAdminStatus', 'getAdminSettings', 'updateAdminSettings', 'startRun', 'stopRun', 'clearUnused'] as Handler[]) {
      expect(permissionOf(handler), handler).toBe(Permission.ManageAppSettings);
    }
  });

  it('passes the user and book to the services', async () => {
    const state = { bookId: 3 };
    const bookState = {
      getState: vi.fn().mockResolvedValue(state),
      setSyncEnabled: vi.fn().mockResolvedValue(state),
      runNow: vi.fn().mockResolvedValue(state),
      retry: vi.fn().mockResolvedValue(state),
    };
    const user = { id: 7 } as never;
    const controller = new EditionSyncController({} as never, bookState as never, {} as never, {} as never, {} as never);

    await controller.getBookState(user, 3);
    await controller.updateBookState(user, 3, { syncEnabled: true });
    await controller.runBookNow(user, 3);
    await controller.retryBook(user, 3);
    expect(bookState.getState).toHaveBeenCalledWith(user, 3);
    expect(bookState.setSyncEnabled).toHaveBeenCalledWith(user, 3, true);
    expect(bookState.runNow).toHaveBeenCalledWith(user, 3);
    expect(bookState.retry).toHaveBeenCalledWith(user, 3);
  });
});

describe('edition-sync DTOs', () => {
  it('validates user settings', async () => {
    expect(await errors(UpsertEditionSyncSettingsDto, { enabled: true, bookSyncMode: 'selected_only' })).toEqual([]);
    expect(await errors(UpsertEditionSyncSettingsDto, { bookSyncMode: 'everything' })).toEqual(['bookSyncMode']);
    expect(await errors(UpsertEditionSyncSettingsDto, { enabled: 'yes' })).toEqual(['enabled']);
  });

  it('requires a boolean book toggle', async () => {
    expect(await errors(UpdateEditionSyncBookStateDto, { syncEnabled: false })).toEqual([]);
    expect(await errors(UpdateEditionSyncBookStateDto, {})).toEqual(['syncEnabled']);
  });

  it('accepts a five-field cron, null for Never, and 1 to 24 run hours', async () => {
    expect(await errors(UpdateEditionSyncAdminSettingsDto, { cronExpression: '0 2 * * *', runHours: 8 })).toEqual([]);
    expect(await errors(UpdateEditionSyncAdminSettingsDto, { cronExpression: null })).toEqual([]);
    expect(await errors(UpdateEditionSyncAdminSettingsDto, { cronExpression: '0 0 2 * * *' })).toEqual(['cronExpression']);
    expect(await errors(UpdateEditionSyncAdminSettingsDto, { cronExpression: 'nightly' })).toEqual(['cronExpression']);
    expect(await errors(UpdateEditionSyncAdminSettingsDto, { runHours: 0 })).toEqual(['runHours']);
    expect(await errors(UpdateEditionSyncAdminSettingsDto, { runHours: 25 })).toEqual(['runHours']);
    expect(await errors(UpdateEditionSyncAdminSettingsDto, { runHours: 1.5 })).toEqual(['runHours']);
  });
});

it('validates the optional server switch as a boolean', async () => {
  for (const enabled of [true, false]) expect(await errors(UpdateEditionSyncAdminSettingsDto, { enabled })).toEqual([]);
  for (const enabled of [null, 'true', 1]) expect(await errors(UpdateEditionSyncAdminSettingsDto, { enabled })).toEqual(['enabled']);
  expect(await errors(UpdateEditionSyncAdminSettingsDto, {})).toEqual([]);
});

it('validates the books query through the global validation pipe', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const metadata = { type: 'query' as const, metatype: EditionSyncBookListQueryDto };
  for (const value of [{ filter: 'bad' }, { page: '0' }, { page: '100001' }]) {
    await expect(pipe.transform(value, metadata)).rejects.toMatchObject({ status: 400 });
  }
  expect(await pipe.transform({ q: ' text ', page: '2' }, metadata)).toMatchObject({ q: 'text', page: 2, filter: 'all' });
  const list = { list: vi.fn().mockResolvedValue({ items: [] }) };
  const controller = new EditionSyncController({} as never, {} as never, {} as never, {} as never, list as never);
  const user = { id: 7 } as never;
  const query = new EditionSyncBookListQueryDto();
  await controller.listBooks(user, query);
  expect(list.list).toHaveBeenCalledWith(user, query);
  expect(Reflect.getMetadata('path', EditionSyncController.prototype.listBooks)).toBe('books');
  expect(permissionOf('listBooks')).toBe(Permission.EditionSync);
});

it('routes bulk retry to the current user and returns HTTP 200', async () => {
  const bookState = { retryFailed: vi.fn().mockResolvedValue({ retried: 2 }) };
  const controller = new EditionSyncController({} as never, bookState as never, {} as never, {} as never, {} as never);
  const user = { id: 7 } as never;
  expect(await controller.retryFailedBooks(user)).toEqual({ retried: 2 });
  expect(bookState.retryFailed).toHaveBeenCalledWith(user);
  expect(Reflect.getMetadata('path', EditionSyncController.prototype.retryFailedBooks)).toBe('books/retry-failed');
  expect(Reflect.getMetadata('method', EditionSyncController.prototype.retryFailedBooks)).toBe(1);
  expect(Reflect.getMetadata('__httpCode__', EditionSyncController.prototype.retryFailedBooks)).toBe(200);
});
