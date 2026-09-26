import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Permission } from '@bookorbit/types';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { ReadingAlignmentController } from './reading-alignment.controller';

const USER = { id: 42, isSuperuser: false } as RequestUser;
const BOOK_ID = 7;

function build() {
  const resolveService = { resolveResume: vi.fn() };
  const statusService = { requestBuild: vi.fn(), getStatus: vi.fn(), cancelBuild: vi.fn() };
  const controller = new ReadingAlignmentController(resolveService as never, statusService as never);
  return { controller, resolveService, statusService };
}

describe('ReadingAlignmentController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET cross-format resume delegates the book ID to the resolve service', async () => {
    const { controller, resolveService } = build();
    resolveService.resolveResume.mockResolvedValue({ available: false });

    const result = await controller.getCrossFormatResume(BOOK_ID, USER);

    expect(resolveService.resolveResume).toHaveBeenCalledWith(BOOK_ID, USER);
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

  it('DELETE build delegates the cancel to the status service', async () => {
    const { controller, statusService } = build();
    statusService.cancelBuild.mockResolvedValue(undefined);

    await expect(controller.cancelBuild(BOOK_ID, USER)).resolves.toBeUndefined();

    expect(statusService.cancelBuild).toHaveBeenCalledWith(BOOK_ID, USER);
  });

  it('DELETE build is gated like the build request and answers 204', () => {
    const handler = ReadingAlignmentController.prototype.cancelBuild;

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('books/:bookId/build');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(204);
    expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe(Permission.LibraryEditMetadata);
  });

  it('GET alignment propagates a Forbidden from the service', async () => {
    const { controller, statusService } = build();
    statusService.getStatus.mockRejectedValue(new ForbiddenException());
    await expect(controller.getAlignmentStatus(BOOK_ID, USER)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
