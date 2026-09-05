import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { Permission } from '@bookorbit/types';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { MonitoredController } from './monitored.controller';
import { MonitoredCoverService } from './monitored-cover.service';
import { MonitoredService } from './monitored.service';

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, createReadStream: vi.fn(() => ({ stream: true })) };
});

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return { ...actual, stat: vi.fn() };
});

async function makeController(service: Record<string, unknown>, coverService: Record<string, unknown> = {}) {
  const module = await Test.createTestingModule({
    controllers: [MonitoredController],
    providers: [
      { provide: MonitoredService, useValue: service },
      { provide: MonitoredCoverService, useValue: coverService },
    ],
  }).compile();
  return module.get(MonitoredController);
}

function makeReply() {
  const headers: Record<string, unknown> = {};
  const reply = { status: vi.fn(), header: vi.fn(), type: vi.fn(), send: vi.fn() };
  reply.status.mockImplementation(() => reply);
  reply.header.mockImplementation((key: string, value: unknown) => {
    headers[key] = value;
    return reply;
  });
  reply.type.mockImplementation(() => reply);
  reply.send.mockImplementation(() => reply);
  return { reply, headers, asFastifyReply: reply as unknown as FastifyReply };
}

describe('MonitoredController', () => {
  it.each([
    'createAuthor',
    'updateAuthor',
    'deleteAuthor',
    'refreshAuthor',
    'createBook',
    'updateBook',
    'deleteBook',
    'updateWork',
    'requestFromWork',
    'searchWorkReleases',
    'grabWorkRelease',
  ] as const)('gates %s with BookRequestAccess', (method) => {
    expect(Reflect.getMetadata(PERMISSION_KEY, MonitoredController.prototype[method])).toBe(Permission.BookRequestAccess);
  });

  it('returns 404 when an author is not visible to the caller', async () => {
    const service = {
      getAuthor: vi.fn().mockRejectedValue(new NotFoundException('Monitored author not found')),
    };
    const module = await Test.createTestingModule({
      controllers: [MonitoredController],
      providers: [
        { provide: MonitoredService, useValue: service },
        { provide: MonitoredCoverService, useValue: {} },
      ],
    }).compile();
    const controller = module.get(MonitoredController);

    await expect(
      controller.getAuthor('foreign-private', { sort: 'releaseDate', order: 'desc', includeHidden: false }, { id: 1 } as RequestUser),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('does not gate the monitored portrait route behind a permission', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, MonitoredController.prototype.getAuthorPortrait)).toBeUndefined();
  });

  it('forwards validated list queries and the current user to the service', async () => {
    const listAuthors = vi.fn();
    const listBooks = vi.fn();
    const listReleases = vi.fn();
    const controller = await makeController({ listAuthors, listBooks, listReleases });
    const user = { id: 7 } as RequestUser;
    const authorsQuery = { page: 1, size: 25, sort: 'progress', order: 'desc' } as const;
    const booksQuery = { page: 2, size: 50, sort: 'author', order: 'asc' } as const;
    const releasesQuery = { page: 3, size: 100, sort: 'date', order: 'desc', filter: 'soon' } as const;

    await Promise.all([
      controller.listAuthors(user, authorsQuery),
      controller.listBooks(user, booksQuery),
      controller.listReleases(user, releasesQuery),
    ]);

    expect(listAuthors).toHaveBeenCalledWith(user, authorsQuery);
    expect(listBooks).toHaveBeenCalledWith(user, booksQuery);
    expect(listReleases).toHaveBeenCalledWith(user, releasesQuery);
  });

  it('passes the current user id to monitored cover fetching', async () => {
    const getCover = vi.fn().mockResolvedValue({ buffer: Buffer.from('cover'), contentType: 'image/jpeg' });
    const controller = await makeController({}, { getCover });
    const { reply, asFastifyReply } = makeReply();

    await controller.getCover({ url: 'https://assets.hardcover.app/cover.jpg' }, { id: 7 } as RequestUser, asFastifyReply);

    expect(getCover).toHaveBeenCalledWith('https://assets.hardcover.app/cover.jpg', 7);
    expect(reply.send).toHaveBeenCalledWith(Buffer.from('cover'));
  });

  it('returns a 404 payload when a monitored author has no portrait', async () => {
    const getAuthorPortraitPath = vi.fn().mockResolvedValue(null);
    const controller = await makeController({ getAuthorPortraitPath });
    const { reply, asFastifyReply } = makeReply();

    await controller.getAuthorPortrait('monitor-1', { id: 1 } as RequestUser, asFastifyReply);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ message: 'No portrait for monitored author monitor-1' });
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it('returns the portrait 404 payload when the file disappears before stat', async () => {
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const controller = await makeController({ getAuthorPortraitPath: vi.fn().mockResolvedValue('/data/authors/7/photo.png') });
    const { reply, asFastifyReply } = makeReply();

    await controller.getAuthorPortrait('monitor-1', { id: 1 } as RequestUser, asFastifyReply);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ message: 'No portrait for monitored author monitor-1' });
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it('streams the monitored portrait with cache and content headers', async () => {
    vi.mocked(stat).mockResolvedValue({ mtimeMs: 1234 } as never);
    vi.mocked(createReadStream).mockReturnValue({ stream: true } as never);
    const getAuthorPortraitPath = vi.fn().mockResolvedValue('/data/authors/7/photo.png');
    const controller = await makeController({ getAuthorPortraitPath });
    const { reply, headers, asFastifyReply } = makeReply();
    const user = { id: 1 } as RequestUser;

    await controller.getAuthorPortrait('monitor-1', user, asFastifyReply);

    expect(getAuthorPortraitPath).toHaveBeenCalledWith('monitor-1', user);
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(headers['ETag']).toBe('"1234"');
    expect(reply.type).toHaveBeenCalledWith('image/png');
    expect(createReadStream).toHaveBeenCalledWith('/data/authors/7/photo.png');
    expect(reply.send).toHaveBeenCalledWith({ stream: true });
  });
});
