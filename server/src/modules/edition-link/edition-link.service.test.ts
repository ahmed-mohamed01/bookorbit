import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EMPTY_CONTENT_FILTER_RULES } from '@bookorbit/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { EditionLinkRepository } from './edition-link.repository';
import { EditionLinkService } from './edition-link.service';

describe('EditionLinkService', () => {
  let service: EditionLinkService;
  let repo: {
    findLinkForBook: ReturnType<typeof vi.fn>;
    getBookModality: ReturnType<typeof vi.fn>;
    findCounterpartCandidates: ReturnType<typeof vi.fn>;
    insertLink: ReturnType<typeof vi.fn>;
    deleteLinkForBook: ReturnType<typeof vi.fn>;
  };
  let bookService: { verifyBookAccess: ReturnType<typeof vi.fn> };
  let libraryService: { findAccessibleLibraryIds: ReturnType<typeof vi.fn> };

  const user = {
    id: 7,
    isSuperuser: false,
    contentFilters: EMPTY_CONTENT_FILTER_RULES,
  } as RequestUser;
  const linkRow = {
    id: 9,
    textBookId: 10,
    audioBookId: 20,
    createdBy: 7,
    createdAt: new Date('2026-07-24T12:00:00.000Z'),
  };

  beforeEach(async () => {
    repo = {
      findLinkForBook: vi.fn().mockResolvedValue(undefined),
      getBookModality: vi.fn(),
      findCounterpartCandidates: vi.fn().mockResolvedValue([]),
      insertLink: vi.fn().mockResolvedValue(linkRow),
      deleteLinkForBook: vi.fn().mockResolvedValue(linkRow),
    };
    bookService = {
      verifyBookAccess: vi.fn().mockResolvedValue(undefined),
    };
    libraryService = {
      findAccessibleLibraryIds: vi.fn().mockResolvedValue([1, 2]),
    };

    const module = await Test.createTestingModule({
      providers: [
        EditionLinkService,
        { provide: EditionLinkRepository, useValue: repo },
        { provide: BookService, useValue: bookService },
        { provide: LibraryService, useValue: libraryService },
      ],
    }).compile();
    service = module.get(EditionLinkService);

    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('proposes the top plausible counterpart for an unlinked book', async () => {
    const candidate = { bookId: 20, title: 'Dune', authorName: 'Frank Herbert', score: 100 };
    repo.getBookModality.mockResolvedValue('text');
    repo.findCounterpartCandidates.mockResolvedValue([candidate]);

    await expect(service.getForBook(user, 10)).resolves.toEqual({
      link: null,
      proposed: candidate,
    });
    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(10, user);
    expect(repo.findCounterpartCandidates).toHaveBeenCalledWith({
      bookId: 10,
      modality: 'text',
      accessibleLibraryIds: [1, 2],
      contentFilters: EMPTY_CONTENT_FILTER_RULES,
      query: undefined,
    });
  });

  it('returns an existing link without computing a proposal', async () => {
    repo.findLinkForBook.mockResolvedValue(linkRow);

    await expect(service.getForBook(user, 10)).resolves.toEqual({
      link: linkRow,
      proposed: null,
    });
    expect(repo.getBookModality).not.toHaveBeenCalled();
    expect(repo.findCounterpartCandidates).not.toHaveBeenCalled();
  });

  it('links opposite modalities with text and audio orientation', async () => {
    repo.getBookModality.mockResolvedValueOnce('audio').mockResolvedValueOnce('text');

    await expect(service.link(user, 20, 10)).resolves.toEqual(linkRow);
    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(20, user);
    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(10, user);
    expect(repo.insertLink).toHaveBeenCalledWith(10, 20, 7);
  });

  it('rejects same-modality links', async () => {
    repo.getBookModality.mockResolvedValue('text');

    await expect(service.link(user, 10, 11)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.insertLink).not.toHaveBeenCalled();
  });

  it('rejects a book that is already linked', async () => {
    repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
    repo.findLinkForBook.mockResolvedValueOnce(linkRow).mockResolvedValueOnce(undefined);

    await expect(service.link(user, 10, 20)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.insertLink).not.toHaveBeenCalled();
  });

  it('rejects a concurrent unique conflict reported by the repository', async () => {
    repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
    repo.insertLink.mockResolvedValue(undefined);

    await expect(service.link(user, 10, 20)).rejects.toBeInstanceOf(ConflictException);
  });

  it('propagates ownership failures before linking', async () => {
    const forbidden = new ForbiddenException('No access to this library');
    bookService.verifyBookAccess.mockRejectedValueOnce(forbidden);

    await expect(service.link(user, 10, 20)).rejects.toBe(forbidden);
    expect(repo.getBookModality).not.toHaveBeenCalled();
    expect(repo.insertLink).not.toHaveBeenCalled();
  });

  it('unlinks an accessible book and returns the removed link', async () => {
    repo.findLinkForBook.mockResolvedValue(linkRow);

    await expect(service.unlink(user, 10)).resolves.toEqual(linkRow);
    // Access is verified on both sides of the pair (bookId 10 and its counterpart 20).
    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(10, user);
    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(20, user);
    expect(repo.deleteLinkForBook).toHaveBeenCalledWith(10);
  });

  it('rejects unlink when no link exists', async () => {
    repo.deleteLinkForBook.mockResolvedValue(undefined);

    await expect(service.unlink(user, 10)).rejects.toBeInstanceOf(NotFoundException);
  });
});
