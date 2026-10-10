import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EMPTY_CONTENT_FILTER_RULES } from '@bookorbit/types';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { EditionLinkRepository } from './edition-link.repository';
import { EditionLinkService } from './edition-link.service';
import { READ_ALONG_OUTPUT_SOURCE } from './read-along-output-source';

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
  let readAlongOutputs: {
    findReadAlongOutputs: Mock<(bookIds: readonly number[]) => Promise<Set<number>>>;
    findSourcePair: Mock<(bookId: number) => Promise<{ textBookId: number; audioBookId: number } | null>>;
    findReadAlongForPair: Mock<(link: { id: number }) => Promise<{ buildId: number; outputBookId: number } | null>>;
    findLostReadAlong: Mock<(link: { id: number }) => Promise<{ buildId: number; outputBookId: number } | null>>;
    recordAttachment: Mock<(buildId: number, linkId: number) => Promise<void>>;
    recordDetach: Mock<(readAlongBookId: number, linkId: number) => Promise<void>>;
  };

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
    readAlongOutputs = {
      findReadAlongOutputs: vi.fn().mockResolvedValue(new Set()),
      findSourcePair: vi.fn().mockResolvedValue(null),
      findReadAlongForPair: vi.fn().mockResolvedValue(null),
      findLostReadAlong: vi.fn().mockResolvedValue(null),
      recordAttachment: vi.fn().mockResolvedValue(undefined),
      recordDetach: vi.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        EditionLinkService,
        { provide: EditionLinkRepository, useValue: repo },
        { provide: BookService, useValue: bookService },
        { provide: LibraryService, useValue: libraryService },
        { provide: READ_ALONG_OUTPUT_SOURCE, useValue: readAlongOutputs },
      ],
    }).compile();
    service = module.get(EditionLinkService);

    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  describe('attachReadAlongByUser', () => {
    it('attaches the pair output and records the attachment', async () => {
      const attached = { ...linkRow, readAlongBookId: 30 };
      repo.findLinkForBook.mockResolvedValue(linkRow);
      readAlongOutputs.findReadAlongForPair.mockResolvedValue({ buildId: 4, outputBookId: 30 });
      repo.setReadAlongBook.mockResolvedValue(attached);

      await expect(service.attachReadAlongByUser(user, 10, 30)).resolves.toEqual(attached);
      expect(bookService.verifyBookAccess).toHaveBeenNthCalledWith(1, 10, user);
      expect(bookService.verifyBookAccess).toHaveBeenNthCalledWith(2, 20, user);
      expect(repo.setReadAlongBook).toHaveBeenCalledWith(9, 30);
      expect(readAlongOutputs.recordAttachment).toHaveBeenCalledWith(4, 9);
    });

    it('rejects with a conflict when the slot was taken by a different read-along meanwhile', async () => {
      repo.findLinkForBook.mockResolvedValue(linkRow);
      readAlongOutputs.findReadAlongForPair.mockResolvedValue({ buildId: 4, outputBookId: 30 });
      repo.setReadAlongBook.mockResolvedValue(undefined);

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(ConflictException);
      expect(readAlongOutputs.recordAttachment).not.toHaveBeenCalled();
    });

    it('propagates a write failure instead of reporting a conflict, and logs it', async () => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const failure = new Error('connection lost');
      repo.findLinkForBook.mockResolvedValue(linkRow);
      readAlongOutputs.findReadAlongForPair.mockResolvedValue({ buildId: 4, outputBookId: 30 });
      repo.setReadAlongBook.mockRejectedValue(failure);

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBe(failure);
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[edition_link\.attach_read_along\] \[fail\] bookId=10 readAlongBookId=30 userId=7 durationMs=\d+ errorClass=Error error="connection lost"/,
        ),
      );
    });

    it('returns an already attached link unchanged', async () => {
      const attached = { ...linkRow, readAlongBookId: 30 };
      repo.findLinkForBook.mockResolvedValue(attached);

      await expect(service.attachReadAlongByUser(user, 20, 30)).resolves.toBe(attached);
      expect(readAlongOutputs.findReadAlongForPair).not.toHaveBeenCalled();
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    it('rejects a different attached read-along with a conflict', async () => {
      repo.findLinkForBook.mockResolvedValue({ ...linkRow, readAlongBookId: 31 });

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(ConflictException);
      expect(readAlongOutputs.findReadAlongForPair).not.toHaveBeenCalled();
    });

    it('returns not found when the requested book has no pair link', async () => {
      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns not found when the requested output differs from the pair output', async () => {
      repo.findLinkForBook.mockResolvedValue(linkRow);
      readAlongOutputs.findReadAlongForPair.mockResolvedValue({ buildId: 4, outputBookId: 31 });

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    it('propagates an access denial before changing the link', async () => {
      const forbidden = new ForbiddenException('No access to this library');
      repo.findLinkForBook.mockResolvedValue(linkRow);
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(forbidden);

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBe(forbidden);
      expect(readAlongOutputs.findReadAlongForPair).not.toHaveBeenCalled();
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });
  });

  describe('a generated read-along detached from its pair', () => {
    it('is reported as such, with no proposal, and searches to nothing', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      repo.findCounterpartCandidates.mockResolvedValue([{ bookId: 11, title: 'Dune', authorName: null, coverVersion: null, score: 100 }]);

      await expect(service.getForBook(user, 30)).resolves.toMatchObject({ link: null, proposed: null, readAlongOutput: true });
      await expect(service.searchCandidates(user, 30, 'dune')).resolves.toEqual([]);
      expect(repo.findCounterpartCandidates).not.toHaveBeenCalled();
    });

    it('stays matched to its source pair, with both editions and itself as members and no link', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      repo.findBookSummaries.mockResolvedValue(
        new Map([
          [10, { id: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null }],
          [20, { id: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null }],
          [30, { id: 30, title: 'Dune (read-along)', authorName: 'Frank Herbert', coverVersion: null }],
        ]),
      );

      const result = await service.getForBook(user, 30);

      expect(result).toEqual({
        link: null,
        proposed: null,
        counterpart: null,
        role: 'readAlong',
        members: {
          text: expect.objectContaining({ id: 10, title: 'Dune' }),
          audio: expect.objectContaining({ id: 20, title: 'Dune (audio)' }),
          readAlong: expect.objectContaining({ id: 30, title: 'Dune (read-along)' }),
        },
      });
      expect(repo.findMemberProgress).toHaveBeenCalledWith(7, { textBookId: 10, audioBookId: 20, readAlongBookId: 30 });
      expect(repo.findCounterpartCandidates).not.toHaveBeenCalled();
    });

    it('falls back to a bare read-along when either side of its pair is out of reach', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      // The read-along page itself, then its ebook, then its audiobook.
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ForbiddenException());

      const result = await service.getForBook(user, 30);

      expect(result).toEqual({ link: null, proposed: null, counterpart: null, role: null, members: null, readAlongOutput: true });
      expect(repo.findBookSummaries).not.toHaveBeenCalled();
    });

    it('falls back to a bare read-along when its pair is linked without it on purpose', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      // The read-along page has no link of its own; its pair is linked, and detached it deliberately.
      repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce(linkRow).mockResolvedValueOnce(linkRow);

      await expect(service.getForBook(user, 30)).resolves.toMatchObject({ role: null, members: null, readAlongOutput: true });
      expect(readAlongOutputs.findLostReadAlong).toHaveBeenCalledWith(linkRow);
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    it('falls back to a bare read-along when a side of its pair is linked to another book', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      repo.findLinkForBook
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ ...linkRow, audioBookId: 21 })
        .mockResolvedValueOnce(undefined);

      await expect(service.getForBook(user, 30)).resolves.toMatchObject({ readAlongOutput: true });
      expect(readAlongOutputs.findLostReadAlong).not.toHaveBeenCalled();
    });

    it('rejoins a pair relinked without it, and answers its page with the linked view', async () => {
      const healed = { ...linkRow, readAlongBookId: 30 };
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      readAlongOutputs.findLostReadAlong.mockResolvedValue({ buildId: 4, outputBookId: 30 });
      repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce(linkRow).mockResolvedValueOnce(linkRow);
      repo.setReadAlongBook.mockResolvedValue(healed);

      await expect(service.getForBook(user, 30)).resolves.toMatchObject({
        link: healed,
        role: 'readAlong',
        members: { text: { id: 10 }, audio: { id: 20 }, readAlong: { id: 30 } },
      });
      expect(repo.setReadAlongBook).toHaveBeenCalledWith(9, 30);
      expect(readAlongOutputs.recordAttachment).toHaveBeenCalledWith(4, 9);
    });

    it('is never linked, from either side', async () => {
      repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio').mockResolvedValueOnce('audio').mockResolvedValueOnce('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));

      await expect(service.link(user, 30, 11)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.link(user, 11, 30)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.insertLink).not.toHaveBeenCalled();
    });

    it("is left out of an audiobook's candidates", async () => {
      const readAlong = { bookId: 30, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 100 };
      const ebook = { bookId: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 96 };
      repo.getBookModality.mockResolvedValue('audio');
      repo.findCounterpartCandidates.mockResolvedValue([readAlong, ebook]);
      readAlongOutputs.findReadAlongOutputs.mockImplementation((ids) => Promise.resolve(new Set(ids.filter((id) => id === 30))));

      await expect(service.getForBook(user, 11)).resolves.toMatchObject({ proposed: ebook });
      await expect(service.searchCandidates(user, 11)).resolves.toEqual([ebook]);
    });
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

    // The attach stamp is best effort, so a detach cannot rely on it: it records itself, before the
    // link is emptied, or the next read of the pair heals the read-along straight back.
    it('records the detach on the build before emptying the link', async () => {
      repo.setReadAlongBook.mockResolvedValue({ ...threeWayRow, readAlongBookId: null });

      await service.unlink(user, 30);

      expect(readAlongOutputs.recordDetach).toHaveBeenCalledWith(30, 9);
      expect(readAlongOutputs.recordDetach.mock.invocationCallOrder[0]).toBeLessThan(repo.setReadAlongBook.mock.invocationCallOrder[0]!);
    });

    it('leaves the link as it was when the detach cannot be recorded', async () => {
      readAlongOutputs.recordDetach.mockRejectedValue(new Error('db down'));

      await expect(service.unlink(user, 30)).rejects.toThrow('db down');
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    it('records nothing on the build when the whole link is removed', async () => {
      await service.unlink(user, 10);

      expect(readAlongOutputs.recordDetach).not.toHaveBeenCalled();
      expect(repo.deleteLink).toHaveBeenCalledWith(9);
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

  describe('a link that lost its read-along', () => {
    it('gets it back when the pair is linked again, in the same request', async () => {
      const healed = { ...linkRow, readAlongBookId: 30 };
      repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
      readAlongOutputs.findLostReadAlong.mockResolvedValue({ buildId: 4, outputBookId: 30 });
      repo.setReadAlongBook.mockResolvedValue(healed);

      await expect(service.link(user, 10, 20)).resolves.toEqual(healed);
      expect(readAlongOutputs.findLostReadAlong).toHaveBeenCalledWith(linkRow);
      expect(repo.setReadAlongBook).toHaveBeenCalledWith(9, 30);
      expect(readAlongOutputs.recordAttachment).toHaveBeenCalledWith(4, 9);
    });

    it('masks the attached read-along in the link response for a caller who cannot open it', async () => {
      const healed = { ...linkRow, readAlongBookId: 30 };
      repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
      readAlongOutputs.findLostReadAlong.mockResolvedValue({ buildId: 4, outputBookId: 30 });
      repo.setReadAlongBook.mockResolvedValue(healed);
      bookService.verifyBookAccess.mockImplementation((bookId: number) => {
        if (bookId === 30) throw new ForbiddenException('No access to this library');
      });

      await expect(service.link(user, 10, 20)).resolves.toEqual({ ...healed, readAlongBookId: null });
      expect(readAlongOutputs.recordAttachment).toHaveBeenCalledWith(4, 9);
    });

    it('does not record an attach the link did not take', async () => {
      repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
      readAlongOutputs.findLostReadAlong.mockResolvedValue({ buildId: 4, outputBookId: 30 });
      repo.setReadAlongBook.mockResolvedValue(undefined);

      await expect(service.link(user, 10, 20)).resolves.toEqual(linkRow);
      expect(readAlongOutputs.recordAttachment).not.toHaveBeenCalled();
    });

    it('logs how long the lookup ran when finding the lost read-along fails', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      repo.findLinkForBook.mockResolvedValue(linkRow);
      readAlongOutputs.findLostReadAlong.mockImplementation(() => {
        now.mockReturnValue(1_250);
        return Promise.reject(new Error('db down'));
      });

      await service.getForBook(user, 10);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[edition_link.restore_read_along] [fail] linkId=9 userId=7 durationMs=250 '));
      now.mockRestore();
    });

    it('still links when the read-along cannot be attached, and logs the failure', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
      readAlongOutputs.findLostReadAlong.mockResolvedValue({ buildId: 4, outputBookId: 30 });
      repo.setReadAlongBook.mockRejectedValue(new Error('unique violation'));

      await expect(service.link(user, 10, 20)).resolves.toEqual(linkRow);
      expect(readAlongOutputs.recordAttachment).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[edition_link\.restore_read_along\] \[fail\] linkId=9 buildId=4 outputBookId=30 userId=7 durationMs=\d+ errorClass=Error error="unique violation"/,
        ),
      );
    });

    it('is healed when any member page reads the link', async () => {
      const healed = { ...linkRow, readAlongBookId: 30 };
      repo.findLinkForBook.mockResolvedValue(linkRow);
      readAlongOutputs.findLostReadAlong.mockResolvedValue({ buildId: 4, outputBookId: 30 });
      repo.setReadAlongBook.mockResolvedValue(healed);

      await expect(service.getForBook(user, 10)).resolves.toMatchObject({ link: healed, members: { readAlong: { id: 30 } } });
      expect(readAlongOutputs.recordAttachment).toHaveBeenCalledWith(4, 9);
    });

    it('costs a link that carries its read-along no lookup, and one with none nothing more than the lookup', async () => {
      repo.findLinkForBook.mockResolvedValue({ ...linkRow, readAlongBookId: 30 });
      await service.getForBook(user, 10);
      expect(readAlongOutputs.findLostReadAlong).not.toHaveBeenCalled();

      repo.findLinkForBook.mockResolvedValue(linkRow);
      await service.getForBook(user, 10);
      expect(readAlongOutputs.findLostReadAlong).toHaveBeenCalledOnce();
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
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
