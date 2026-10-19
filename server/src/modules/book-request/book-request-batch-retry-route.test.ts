import { ForbiddenException } from '@nestjs/common';

import { BookRequestAdminController } from './book-request-admin.controller';
import { BookRequestSelfFulfilController } from './book-request-self-fulfil.controller';

const user = { id: 5 } as never;

describe('batch retry routes', () => {
  it('self route refuses a non-owner before retrying anything', async () => {
    const service = { assertCanFulfil: vi.fn().mockRejectedValue(new ForbiddenException('You cannot fulfil this book request')), getOne: vi.fn() };
    const batches = { retry: vi.fn() };
    const controller = Object.assign(Object.create(BookRequestSelfFulfilController.prototype), { service, batches });

    await expect(controller.retryBatch(21, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(batches.retry).not.toHaveBeenCalled();
  });

  it('self route retries and returns the refreshed request for the owner', async () => {
    const service = { assertCanFulfil: vi.fn().mockResolvedValue({}), getOne: vi.fn().mockResolvedValue({ id: 21 }) };
    const batches = { retry: vi.fn().mockResolvedValue(undefined) };
    const controller = Object.assign(Object.create(BookRequestSelfFulfilController.prototype), { service, batches });

    await expect(controller.retryBatch(21, user)).resolves.toEqual({ id: 21 });
    expect(batches.retry).toHaveBeenCalledWith(user, 21);
  });

  it('admin route retries without an ownership check', async () => {
    const service = { getOne: vi.fn().mockResolvedValue({ id: 21 }) };
    const batches = { retry: vi.fn().mockResolvedValue(undefined) };
    const controller = Object.assign(Object.create(BookRequestAdminController.prototype), { service, batches });

    await expect(controller.retryBatch(21, user)).resolves.toEqual({ id: 21 });
    expect(batches.retry).toHaveBeenCalledWith(user, 21);
  });
});
