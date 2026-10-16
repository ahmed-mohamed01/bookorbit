import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Permission } from '@bookorbit/types';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { BookRequestSourcesController } from './book-request-sources.controller';

describe('BookRequestSourcesController', () => {
  it('gates the route on requester access and returns the safe source list', async () => {
    const sources = [{ id: 2, name: 'Library Genesis', delivery: 'file', mediaKinds: ['ebook'] }];
    const sourceService = { list: vi.fn().mockResolvedValue(sources) };
    const controller = new BookRequestSourcesController(sourceService as never);

    expect(Reflect.getMetadata(PATH_METADATA, BookRequestSourcesController)).toBe('book-request-sources');
    expect(Reflect.getMetadata(METHOD_METADATA, BookRequestSourcesController.prototype.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PERMISSION_KEY, BookRequestSourcesController)).toBe(Permission.BookRequestAccess);
    await expect(controller.list()).resolves.toEqual(sources);
    expect(sourceService.list).toHaveBeenCalledTimes(1);
  });
});
