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
    findBookSummaries: ReturnType<typeof vi.fn>;
    findMemberProgress: ReturnType<typeof vi.fn>;
    getBookModality: ReturnType<typeof vi.fn>;
    findCounterpartCandidates: ReturnType<typeof vi.fn>;
    insertLink: ReturnType<typeof vi.fn>;
    setReadAlongBook: ReturnType<typeof vi.fn>;
    deleteLink: ReturnType<typeof vi.fn>;
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
    readAlongBookId: null as number | null,
    createdBy: 7,
    createdAt: new Date('2026-07-24T12:00:00.000Z'),
  };
  const noProgress = { text: null, audio: null, readAlong: null, readAlongNarrationPercentage: null };

  beforeEach(async () => {
    repo = {
      findLinkForBook: vi.fn().mockResolvedValue(undefined),
      findBookSummaries: vi.fn().mockResolvedValue(new Map()),
      findMemberProgress: vi.fn().mockResolvedValue(noProgress),
      getBookModality: vi.fn(),
      findCounterpartCandidates: vi.fn().mockResolvedValue([]),
      insertLink: vi.fn().mockResolvedValue(linkRow),
      setReadAlongBook: vi.fn().mockResolvedValue(linkRow),
      deleteLink: vi.fn().mockResolvedValue(linkRow),
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
    const candidate = { bookId: 20, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 100 };
    repo.getBookModality.mockResolvedValue('text');
    repo.findCounterpartCandidates.mockResolvedValue([candidate]);

    await expect(service.getForBook(user, 10)).resolves.toEqual({
      link: null,
      proposed: candidate,
      counterpart: null,
      role: null,
      members: null,
    });
    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(10, user);
    expect(repo.findCounterpartCandidates).toHaveBeenCalledWith({
      bookId: 10,
      modality: 'text',
      accessibleLibraryIds: [1, 2],
      contentFilters: EMPTY_CONTENT_FILTER_RULES,
      query: undefined,
    });
    expect(repo.findBookSummaries).not.toHaveBeenCalled();
  });

  it('returns an existing link with its resolved counterpart summary', async () => {
    repo.findLinkForBook.mockResolvedValue(linkRow);
    repo.findBookSummaries.mockResolvedValue(
      new Map([
        [10, { id: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: '2026-03-01T00:00:00.000Z' }],
        [20, { id: 20, title: 'Dune (audiobook)', authorName: 'Frank Herbert', coverVersion: null }],
      ]),
    );

    await expect(service.getForBook(user, 10)).resolves.toEqual({
      link: linkRow,
      proposed: null,
      counterpart: { id: 20, title: 'Dune (audiobook)', authorName: 'Frank Herbert', coverVersion: null },
      role: 'text',
      members: {
        text: {
          id: 10,
          title: 'Dune',
          authorName: 'Frank Herbert',
          coverVersion: '2026-03-01T00:00:00.000Z',
          progress: null,
          narrationPercentage: null,
        },
        audio: { id: 20, title: 'Dune (audiobook)', authorName: 'Frank Herbert', coverVersion: null, progress: null, narrationPercentage: null },
        readAlong: null,
      },
    });
    expect(repo.findBookSummaries).toHaveBeenCalledWith([10, 20]);
    expect(repo.findMemberProgress).toHaveBeenCalledWith(7, { textBookId: 10, audioBookId: 20, readAlongBookId: null });
    expect(repo.getBookModality).not.toHaveBeenCalled();
    expect(repo.findCounterpartCandidates).not.toHaveBeenCalled();
  });

  it('hides the link and skips the counterpart summary when the counterpart is inaccessible', async () => {
    repo.findLinkForBook.mockResolvedValue(linkRow);
    bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundException());

    await expect(service.getForBook(user, 10)).resolves.toEqual({
      link: null,
      proposed: null,
      counterpart: null,
      role: null,
      members: null,
    });
    expect(repo.findBookSummaries).not.toHaveBeenCalled();
  });

  describe('three-way links', () => {
    const threeWayRow = { ...linkRow, readAlongBookId: 30 };
    const summaries: Record<number, { id: number; title: string; authorName: string; coverVersion: string | null }> = {
      10: { id: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null },
      20: { id: 20, title: 'Dune (audiobook)', authorName: 'Frank Herbert', coverVersion: null },
      30: { id: 30, title: 'Dune (read-along)', authorName: 'Frank Herbert', coverVersion: '2026-03-02T00:00:00.000Z' },
    };

    beforeEach(() => {
      repo.findLinkForBook.mockResolvedValue(threeWayRow);
      repo.findBookSummaries.mockResolvedValue(new Map(Object.values(summaries).map((summary) => [summary.id, summary])));
    });

    it('builds all three members with their progress', async () => {
      repo.findMemberProgress.mockResolvedValue({
        text: { percentage: 40, updatedAt: new Date('2026-09-01T00:00:00.000Z') },
        audio: { percentage: 12, updatedAt: new Date('2026-09-03T00:00:00.000Z') },
        readAlong: { percentage: 55, updatedAt: new Date('2026-09-02T00:00:00.000Z') },
        readAlongNarrationPercentage: 61,
      });

      const result = await service.getForBook(user, 10);

      expect(result.role).toBe('text');
      expect(result.members).toEqual({
        text: { ...summaries[10], progress: { percentage: 40, updatedAt: '2026-09-01T00:00:00.000Z' }, narrationPercentage: null },
        audio: { ...summaries[20], progress: { percentage: 12, updatedAt: '2026-09-03T00:00:00.000Z' }, narrationPercentage: null },
        readAlong: { ...summaries[30], progress: { percentage: 55, updatedAt: '2026-09-02T00:00:00.000Z' }, narrationPercentage: 61 },
      });
      expect(repo.findMemberProgress).toHaveBeenCalledWith(7, { textBookId: 10, audioBookId: 20, readAlongBookId: 30 });
    });

    // The read-along page shows the audiobook as its counterpart: the client labels the counterpart by
    // its own modality, so handing it the text book there would mislabel an EPUB as the audio edition.
    it.each([
      [10, 'text', 20],
      [20, 'audio', 10],
      [30, 'readAlong', 20],
    ] as const)('resolves the link from member %i as role %s', async (bookId, role, counterpartId) => {
      const result = await service.getForBook(user, bookId);

      expect(result.link).toEqual(threeWayRow);
      expect(result.role).toBe(role);
      expect(result.counterpart).toEqual(summaries[counterpartId]);
    });

    it('masks only the read-along member when it alone is inaccessible, without leaking its id', async () => {
      // Access is verified for the requested book first, then for the pair, then for the read-along.
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundException());

      const result = await service.getForBook(user, 10);

      expect(result.link).toEqual({ ...threeWayRow, readAlongBookId: null });
      expect(result.role).toBe('text');
      expect(result.members?.readAlong).toBeNull();
      expect(result.members?.text.id).toBe(10);
      expect(repo.findBookSummaries).toHaveBeenCalledWith([10, 20]);
      expect(repo.findMemberProgress).toHaveBeenCalledWith(7, { textBookId: 10, audioBookId: 20, readAlongBookId: null });
      // The stored row must not be mutated by the masking.
      expect(threeWayRow.readAlongBookId).toBe(30);
    });

    it('hides the whole link from the read-along page when the audio member is inaccessible', async () => {
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundException());

      await expect(service.getForBook(user, 30)).resolves.toEqual({
        link: null,
        proposed: null,
        counterpart: null,
        role: null,
        members: null,
      });
      expect(repo.findBookSummaries).not.toHaveBeenCalled();
    });

    it('hides the whole link when the text member is inaccessible', async () => {
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundException());

      await expect(service.getForBook(user, 20)).resolves.toMatchObject({ link: null, role: null, members: null });
      expect(repo.findBookSummaries).not.toHaveBeenCalled();
    });

    it('shows every member to a superuser', async () => {
      const superuser = { id: 1, isSuperuser: true, contentFilters: EMPTY_CONTENT_FILTER_RULES } as RequestUser;

      const result = await service.getForBook(superuser, 10);

      expect(result.link).toEqual(threeWayRow);
      expect(result.members?.readAlong?.id).toBe(30);
      expect(repo.findBookSummaries).toHaveBeenCalledWith([10, 20, 30]);
    });

    it('rejects linking a book that is already a read-along member', async () => {
      repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
      repo.findLinkForBook.mockResolvedValueOnce(threeWayRow).mockResolvedValueOnce(undefined);

      await expect(service.link(user, 30, 20)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.insertLink).not.toHaveBeenCalled();
    });

    it('rejects linking to a counterpart that is already a read-along member', async () => {
      repo.getBookModality.mockResolvedValueOnce('audio').mockResolvedValueOnce('text');
      repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce(threeWayRow);

      await expect(service.link(user, 40, 30)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.insertLink).not.toHaveBeenCalled();
    });

    it('detaches the read-along member instead of deleting the link', async () => {
      const detached = { ...threeWayRow, readAlongBookId: null };
      repo.setReadAlongBook.mockResolvedValue(detached);

      await expect(service.unlink(user, 30)).resolves.toEqual(detached);
      expect(repo.setReadAlongBook).toHaveBeenCalledWith(9, null);
      expect(repo.deleteLink).not.toHaveBeenCalled();
      expect(bookService.verifyBookAccess).toHaveBeenCalledWith(10, user);
      expect(bookService.verifyBookAccess).toHaveBeenCalledWith(20, user);
    });

    it('refuses to unlink from the read-along page when the audio member is inaccessible', async () => {
      const forbidden = new ForbiddenException('No access to this library');
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(forbidden);

      await expect(service.unlink(user, 30)).rejects.toBe(forbidden);
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
      expect(repo.deleteLink).not.toHaveBeenCalled();
    });

    // getForBook masks an inaccessible read-along and still hands the client an enabled Unlink
    // button. Demanding access to the masked book here made that button 404 - and name the book the
    // reader was never shown. Dropping the link row does not touch the read-along BOOK, so only the
    // text/audio pair gates it.
    it('unlinks from the text page even when the read-along member is inaccessible', async () => {
      // Only a third access check can reject here, and the fixed unlink never makes one: the
      // requested book and the audio member are all it consults.
      const forbidden = new ForbiddenException('No access to this library');
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(forbidden);

      await expect(service.unlink(user, 10)).resolves.toEqual(linkRow);
      expect(repo.deleteLink).toHaveBeenCalledWith(9);
      expect(bookService.verifyBookAccess).toHaveBeenCalledWith(20, user);
      expect(bookService.verifyBookAccess).not.toHaveBeenCalledWith(30, user);
    });
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
    // Addressed by the resolved link id: a member-column delete would take out every link the book
    // appears in and report only one of them back.
    expect(repo.deleteLink).toHaveBeenCalledWith(9);
  });

  it('rejects unlink when no link exists', async () => {
    repo.deleteLink.mockResolvedValue(undefined);

    await expect(service.unlink(user, 10)).rejects.toBeInstanceOf(NotFoundException);
  });
});
