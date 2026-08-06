import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { ReadingAlignmentController } from './reading-alignment.controller';

const USER = { id: 42, isSuperuser: false } as RequestUser;
const BOOK_ID = 7;

function build() {
  const resolveService = { resolveResume: vi.fn() };
  const statusService = { requestBuild: vi.fn(), getStatus: vi.fn() };
  const controller = new ReadingAlignmentController(resolveService as never, statusService as never);
  return { controller, resolveService, statusService };
}

describe('ReadingAlignmentController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET cross-format resume delegates the book ID and target to the resolve service', async () => {
    const { controller, resolveService } = build();
    resolveService.resolveResume.mockResolvedValue({ available: false });

    const result = await controller.getCrossFormatResume(BOOK_ID, { target: 'ebook' }, USER);

    expect(resolveService.resolveResume).toHaveBeenCalledWith(BOOK_ID, USER, 'ebook');
    expect(result).toEqual({ available: false });
  });

  it('POST build delegates to the status service and returns its result', async () => {
    const { controller, statusService } = build();
    statusService.requestBuild.mockResolvedValue({ status: 'building' });

    const result = await controller.requestBuild(BOOK_ID, {}, USER);

    expect(statusService.requestBuild).toHaveBeenCalledWith(BOOK_ID, USER, false);
    expect(result).toEqual({ status: 'building' });
  });

  it('POST build forwards force=true when the query flag is set', async () => {
    const { controller, statusService } = build();
    statusService.requestBuild.mockResolvedValue({ status: 'building' });

    await controller.requestBuild(BOOK_ID, { force: true }, USER);

    expect(statusService.requestBuild).toHaveBeenCalledWith(BOOK_ID, USER, true);
  });

  it('POST build propagates a Forbidden from the service', async () => {
    const { controller, statusService } = build();
    statusService.requestBuild.mockRejectedValue(new ForbiddenException());
    await expect(controller.requestBuild(BOOK_ID, {}, USER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('GET alignment delegates to the status service and returns its result', async () => {
    const { controller, statusService } = build();
    statusService.getStatus.mockResolvedValue({ status: 'none' });

    const result = await controller.getAlignmentStatus(BOOK_ID, USER);

    expect(statusService.getStatus).toHaveBeenCalledWith(BOOK_ID, USER);
    expect(result).toEqual({ status: 'none' });
  });

  it('GET alignment propagates a Forbidden from the service', async () => {
    const { controller, statusService } = build();
    statusService.getStatus.mockRejectedValue(new ForbiddenException());
    await expect(controller.getAlignmentStatus(BOOK_ID, USER)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
