import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { EditionLinkController } from './edition-link.controller';
import { EditionLinkService } from './edition-link.service';

describe('EditionLinkController', () => {
  let controller: EditionLinkController;
  let service: {
    getForBook: ReturnType<typeof vi.fn>;
    searchCandidates: ReturnType<typeof vi.fn>;
    link: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
  };

  const user = { id: 7 } as RequestUser;

  beforeEach(async () => {
    service = {
      getForBook: vi.fn(),
      searchCandidates: vi.fn(),
      link: vi.fn(),
      unlink: vi.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [EditionLinkController],
      providers: [{ provide: EditionLinkService, useValue: service }],
    }).compile();
    controller = module.get(EditionLinkController);
  });

  it.each([
    ['getForBook', 'for-book/:bookId', RequestMethod.GET],
    ['searchCandidates', 'candidates/:bookId', RequestMethod.GET],
    ['link', 'link/:bookId', RequestMethod.POST],
    ['unlink', 'link/:bookId', RequestMethod.DELETE],
  ] as const)('keeps the expected %s route contract', (method, path, requestMethod) => {
    expect(Reflect.getMetadata(PATH_METADATA, EditionLinkController)).toBe('edition-links');
    expect(Reflect.getMetadata(PATH_METADATA, EditionLinkController.prototype[method])).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, EditionLinkController.prototype[method])).toBe(requestMethod);
  });

  it('delegates all HTTP operations to the service', async () => {
    const link = { id: 1 };
    service.getForBook.mockResolvedValue({ link: null, proposed: null, counterpart: null, role: null, members: null });
    service.searchCandidates.mockResolvedValue([]);
    service.link.mockResolvedValue(link);
    service.unlink.mockResolvedValue(link);

    await controller.getForBook(user, 10);
    await controller.searchCandidates(user, 10, { q: 'Dune' });
    await controller.link(user, 10, { counterpartId: 20 });
    await controller.unlink(user, 10);

    expect(service.getForBook).toHaveBeenCalledWith(user, 10);
    expect(service.searchCandidates).toHaveBeenCalledWith(user, 10, 'Dune');
    expect(service.link).toHaveBeenCalledWith(user, 10, 20);
    expect(service.unlink).toHaveBeenCalledWith(user, 10);
  });

  it('serializes the DB row to the shared wire contract (Date -> ISO string, nullable createdBy)', async () => {
    // A deleted creator leaves createdBy null (FK is ON DELETE SET NULL), and createdAt is a Date on the
    // row but an ISO string on the wire. This asserts the mapper actually performs both, and that
    // getForBook wraps the mapped link - the exact shape the client's shared contract expects.
    const row = { id: 5, textBookId: 10, audioBookId: 20, readAlongBookId: null, createdBy: null, createdAt: new Date('2026-01-02T03:04:05.000Z') };
    const expected = { id: 5, textBookId: 10, audioBookId: 20, readAlongBookId: null, createdBy: null, createdAt: '2026-01-02T03:04:05.000Z' };
    const counterpart = { id: 20, title: 'Dune', authorName: 'Frank Herbert' };
    service.getForBook.mockResolvedValue({ link: row, proposed: null, counterpart, role: 'text', members: null });
    service.link.mockResolvedValue(row);
    service.unlink.mockResolvedValue(row);

    expect(await controller.link(user, 10, { counterpartId: 20 })).toEqual(expected);
    expect(await controller.unlink(user, 10)).toEqual(expected);
    expect(await controller.getForBook(user, 10)).toEqual({ link: expected, proposed: null, counterpart, role: 'text', members: null });
  });

  it('carries the read-along member, role and member summaries through to the wire contract', async () => {
    const row = { id: 5, textBookId: 10, audioBookId: 20, readAlongBookId: 30, createdBy: 7, createdAt: new Date('2026-01-02T03:04:05.000Z') };
    const members = {
      text: {
        id: 10,
        title: 'Dune',
        authorName: 'Frank Herbert',
        progress: { percentage: 40, updatedAt: '2026-09-01T00:00:00.000Z' },
        narrationPercentage: null,
      },
      audio: { id: 20, title: 'Dune (audiobook)', authorName: 'Frank Herbert', progress: null, narrationPercentage: null },
      readAlong: { id: 30, title: 'Dune (read-along)', authorName: 'Frank Herbert', progress: null, narrationPercentage: 61 },
    };
    service.getForBook.mockResolvedValue({ link: row, proposed: null, counterpart: null, role: 'readAlong', members });

    const result = await controller.getForBook(user, 30);

    expect(result.link?.readAlongBookId).toBe(30);
    expect(result.role).toBe('readAlong');
    expect(result.members).toEqual(members);
  });
});
