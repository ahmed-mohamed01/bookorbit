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
import { WorkService } from './work.service';

type BuildProposal = { textBookId: number; audioBookId: number; status: string; outputBookId: number | null };

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
    setTextBook: ReturnType<typeof vi.fn>;
    findReadingPercentages: ReturnType<typeof vi.fn>;
  };
  let bookService: { verifyBookAccess: ReturnType<typeof vi.fn> };
  let works: {
    joinWorks: ReturnType<typeof vi.fn>;
    mergeStateForBook: ReturnType<typeof vi.fn>;
    findMembers: ReturnType<typeof vi.fn>;
    prepareDetach: ReturnType<typeof vi.fn>;
    finishDetach: ReturnType<typeof vi.fn>;
    notifyChanged: ReturnType<typeof vi.fn>;
    removeMember: ReturnType<typeof vi.fn>;
  };
  let libraryService: { findAccessibleLibraryIds: ReturnType<typeof vi.fn> };
  let readAlongOutputs: {
    findReadAlongOutputs: Mock<(bookIds: readonly number[]) => Promise<Set<number>>>;
    findSourcePair: Mock<(bookId: number) => Promise<{ textBookId: number; audioBookId: number } | null>>;
    findBuildByReadAlong: Mock<(id: number) => Promise<{ buildId: number; outputBookId: number; textBookId: number; audioBookId: number } | null>>;
    findLostReadAlong: Mock<(link: { id: number }) => Promise<{ buildId: number; outputBookId: number } | null>>;
    findNewestBuildForText: Mock<(textBookId: number) => Promise<BuildProposal | null>>;
    findNewestBuildForAudio: Mock<(audioBookId: number) => Promise<BuildProposal | null>>;
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
    textBookId: 10 as number | null,
    audioBookId: 20,
    readAlongBookId: null as number | null,
    createdBy: 7,
    createdAt: new Date('2026-07-24T12:00:00.000Z'),
  };
  const build = { buildId: 4, outputBookId: 30, textBookId: 10, audioBookId: 20 };
  const noProgress = { text: null, audio: null, readAlong: null, readAlongNarrationPercentage: null };
  type LinkRow = typeof linkRow;

  const hideBooks = (...hidden: number[]) =>
    (bookService.verifyBookAccess as Mock<(id: number) => Promise<void>>).mockImplementation((id) =>
      hidden.includes(id) ? Promise.reject(new NotFoundException()) : Promise.resolve(),
    );
  const linksBy = (lookup: (id: number) => LinkRow | undefined) =>
    (repo.findLinkForBook as Mock<(id: number) => Promise<LinkRow | undefined>>).mockImplementation((id) => Promise.resolve(lookup(id)));

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
      setTextBook: vi.fn().mockResolvedValue(linkRow),
      findReadingPercentages: vi.fn().mockResolvedValue(new Map()),
    };
    bookService = {
      verifyBookAccess: vi.fn().mockResolvedValue(undefined),
    };
    works = {
      joinWorks: vi.fn().mockRejectedValue(new ConflictException('One or both books are already linked')),
      mergeStateForBook: vi.fn().mockResolvedValue(undefined),
      findMembers: vi.fn().mockResolvedValue([]),
      prepareDetach: vi.fn().mockResolvedValue({ bookId: 0, remainingBookIds: [], carryOver: [], readers: [] }),
      finishDetach: vi.fn().mockResolvedValue(undefined),
      notifyChanged: vi.fn().mockResolvedValue(undefined),
      removeMember: vi.fn(),
    };
    libraryService = {
      findAccessibleLibraryIds: vi.fn().mockResolvedValue([1, 2]),
    };
    readAlongOutputs = {
      findReadAlongOutputs: vi.fn().mockResolvedValue(new Set()),
      findSourcePair: vi.fn().mockResolvedValue(null),
      findBuildByReadAlong: vi.fn().mockResolvedValue(null),
      findLostReadAlong: vi.fn().mockResolvedValue(null),
      findNewestBuildForText: vi.fn().mockResolvedValue(null),
      findNewestBuildForAudio: vi.fn().mockResolvedValue(null),
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
        { provide: WorkService, useValue: works },
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
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);
      repo.setReadAlongBook.mockResolvedValue(attached);

      await expect(service.attachReadAlongByUser(user, 10, 30)).resolves.toEqual(attached);
      expect(bookService.verifyBookAccess).toHaveBeenNthCalledWith(1, 10, user);
      expect(bookService.verifyBookAccess).toHaveBeenNthCalledWith(2, 30, user);
      expect(bookService.verifyBookAccess).toHaveBeenNthCalledWith(3, 20, user);
      expect(repo.setReadAlongBook).toHaveBeenCalledWith(9, 30);
      expect(readAlongOutputs.recordAttachment).toHaveBeenCalledWith(4, 9);
    });

    it('rejects with a conflict when the slot was taken by a different read-along meanwhile', async () => {
      repo.findLinkForBook.mockResolvedValue(linkRow);
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);
      repo.setReadAlongBook.mockResolvedValue(undefined);

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(ConflictException);
      expect(readAlongOutputs.recordAttachment).not.toHaveBeenCalled();
    });

    it('propagates a write failure instead of reporting a conflict, and logs it', async () => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const failure = new Error('connection lost');
      repo.findLinkForBook.mockResolvedValue(linkRow);
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);
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
      expect(readAlongOutputs.findBuildByReadAlong).not.toHaveBeenCalled();
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    // Otherwise "already attached" against "a different read-along" tells a caller who cannot open
    // the attached book which id it is.
    it('answers the access error for an inaccessible read-along even when it is the attached one', async () => {
      const forbidden = new ForbiddenException('No access to this library');
      repo.findLinkForBook.mockResolvedValue({ ...linkRow, readAlongBookId: 30 });
      (bookService.verifyBookAccess as Mock<(id: number) => Promise<void>>).mockImplementation((id) =>
        id === 30 ? Promise.reject(forbidden) : Promise.resolve(),
      );

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBe(forbidden);
    });

    it('answers the access error for an inaccessible read-along before a different attached one conflicts', async () => {
      const forbidden = new ForbiddenException('No access to this library');
      repo.findLinkForBook.mockResolvedValue({ ...linkRow, readAlongBookId: 31 });
      (bookService.verifyBookAccess as Mock<(id: number) => Promise<void>>).mockImplementation((id) =>
        id === 30 ? Promise.reject(forbidden) : Promise.resolve(),
      );

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBe(forbidden);
    });

    it('rejects a different attached read-along with a conflict', async () => {
      repo.findLinkForBook.mockResolvedValue({ ...linkRow, readAlongBookId: 31 });

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(ConflictException);
      expect(readAlongOutputs.findBuildByReadAlong).not.toHaveBeenCalled();
    });

    it('answers the generic attach conflict when the attached read-along is hidden from the reader', async () => {
      repo.findLinkForBook.mockResolvedValue({ ...linkRow, readAlongBookId: 31 });
      hideBooks(31);

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toThrow('This read-along is already attached to another edition link');
      expect(readAlongOutputs.findBuildByReadAlong).not.toHaveBeenCalled();
    });

    it('returns not found when the requested book has no pair link', async () => {
      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns not found when no build generated the requested read-along', async () => {
      repo.findLinkForBook.mockResolvedValue(linkRow);
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(null);

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    it('refuses a read-along built from another audiobook', async () => {
      repo.findLinkForBook.mockResolvedValueOnce(linkRow).mockResolvedValue(undefined);
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue({ ...build, audioBookId: 99 });

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    it('refuses a read-along already attached to another link', async () => {
      repo.findLinkForBook.mockResolvedValueOnce(linkRow).mockResolvedValue({ ...linkRow, id: 77, readAlongBookId: 30 });
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(ConflictException);
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    it('attaches to a link whose ebook side is empty', async () => {
      const nullText = { ...linkRow, textBookId: null };
      const attached = { ...nullText, readAlongBookId: 30 };
      repo.findLinkForBook.mockResolvedValueOnce(nullText).mockResolvedValue(undefined);
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);
      repo.setReadAlongBook.mockResolvedValue(attached);

      await expect(service.attachReadAlongByUser(user, 20, 30)).resolves.toEqual(attached);
      expect(readAlongOutputs.recordAttachment).toHaveBeenCalledWith(4, 9);
    });

    it('creates the link for an audiobook that has none and records the attachment', async () => {
      const created = { ...linkRow, textBookId: null, readAlongBookId: 30 };
      repo.findLinkForBook.mockResolvedValue(undefined);
      repo.getBookModality.mockResolvedValue('audio');
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);
      repo.insertLink.mockResolvedValue(created);

      await expect(service.attachReadAlongByUser(user, 20, 30)).resolves.toEqual(created);
      expect(repo.insertLink).toHaveBeenCalledWith(null, 20, 7, 30);
      expect(readAlongOutputs.recordAttachment).toHaveBeenCalledWith(4, 9);
      expect(bookService.verifyBookAccess).toHaveBeenCalledWith(20, user);
      expect(bookService.verifyBookAccess).toHaveBeenCalledWith(30, user);
    });

    it('does not create a link from an unlinked ebook', async () => {
      repo.findLinkForBook.mockResolvedValue(undefined);
      repo.getBookModality.mockResolvedValue('text');

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.insertLink).not.toHaveBeenCalled();
    });

    it('refuses a read-along built from another audiobook for an audiobook with no link', async () => {
      repo.findLinkForBook.mockResolvedValue(undefined);
      repo.getBookModality.mockResolvedValue('audio');
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue({ ...build, audioBookId: 99 });

      await expect(service.attachReadAlongByUser(user, 20, 30)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.insertLink).not.toHaveBeenCalled();
      expect(readAlongOutputs.recordAttachment).not.toHaveBeenCalled();
    });

    // Filling an ebook-less row with another ebook keeps the read-along, so the audiobook alone
    // decides whether it may come back after a detach.
    it('attaches a read-along built from another ebook than the one now on the link', async () => {
      const attached = { ...linkRow, readAlongBookId: 30 };
      repo.findLinkForBook.mockResolvedValueOnce(linkRow).mockResolvedValue(undefined);
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue({ ...build, textBookId: 11 });
      repo.setReadAlongBook.mockResolvedValue(attached);

      await expect(service.attachReadAlongByUser(user, 20, 30)).resolves.toEqual(attached);
      expect(repo.setReadAlongBook).toHaveBeenCalledWith(9, 30);
    });

    it('answers a conflict when a concurrent attach put the read-along on another link first', async () => {
      repo.findLinkForBook.mockResolvedValueOnce(linkRow).mockResolvedValue(undefined);
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);
      repo.setReadAlongBook.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBeInstanceOf(ConflictException);
      expect(readAlongOutputs.recordAttachment).not.toHaveBeenCalled();
    });

    it('answers not found for an ebook-less link whose only read-along the reader cannot see', async () => {
      repo.findLinkForBook.mockResolvedValue({ ...linkRow, textBookId: null, readAlongBookId: 30 });
      hideBooks(30);

      await expect(service.attachReadAlongByUser(user, 20, 31)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    it('lets the audiobook take back its read-along detached after another ebook filled the row', async () => {
      let row: LinkRow = { ...linkRow, textBookId: null, readAlongBookId: 30 };
      const linkOf = (id: number) =>
        [row.textBookId, row.audioBookId, row.readAlongBookId].includes(id) && (row.textBookId !== null || row.readAlongBookId !== null)
          ? row
          : undefined;
      linksBy(linkOf);
      (repo.getBookModality as Mock<(id: number) => Promise<string>>).mockImplementation((id) => Promise.resolve(id === 20 ? 'audio' : 'text'));
      readAlongOutputs.findReadAlongOutputs.mockImplementation((ids) => Promise.resolve(new Set(ids.filter((id) => id === 30))));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);
      (repo.setTextBook as Mock<(id: number, textBookId: number | null) => Promise<LinkRow>>).mockImplementation((_id, textBookId) =>
        Promise.resolve((row = { ...row, textBookId })),
      );
      (repo.setReadAlongBook as Mock<(id: number, readAlongBookId: number | null) => Promise<LinkRow>>).mockImplementation((_id, readAlongBookId) =>
        Promise.resolve((row = { ...row, readAlongBookId })),
      );

      await service.link(user, 11, 20);
      await service.unlink(user, 30);

      await expect(service.getForBook(user, 30)).resolves.toMatchObject({
        link: { textBookId: 11, audioBookId: 20, readAlongBookId: null },
        role: 'readAlong',
        members: { text: { id: 11 }, audio: { id: 20 }, readAlong: null },
      });
      await expect(service.attachReadAlongByUser(user, 20, 30)).resolves.toMatchObject({ textBookId: 11, audioBookId: 20, readAlongBookId: 30 });
    });

    it('refuses a read-along attached elsewhere for an audiobook with no link', async () => {
      repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValue({ ...linkRow, id: 77, audioBookId: 21, readAlongBookId: 30 });
      repo.getBookModality.mockResolvedValue('audio');
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);

      await expect(service.attachReadAlongByUser(user, 20, 30)).rejects.toBeInstanceOf(ConflictException);
      expect(repo.insertLink).not.toHaveBeenCalled();
    });

    // Another user's read-along, or any book id the caller cannot open, answers the access error
    // before the build lookup, so the attach cannot probe which books are read-alongs.
    it('checks access to the read-along before looking up its build', async () => {
      const forbidden = new ForbiddenException('No access to this library');
      repo.findLinkForBook.mockResolvedValue(undefined);
      repo.getBookModality.mockResolvedValue('audio');
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(forbidden);

      await expect(service.attachReadAlongByUser(user, 20, 30)).rejects.toBe(forbidden);
      expect(bookService.verifyBookAccess).toHaveBeenLastCalledWith(30, user);
      expect(readAlongOutputs.findBuildByReadAlong).not.toHaveBeenCalled();
      expect(repo.insertLink).not.toHaveBeenCalled();
    });

    it('answers a conflict when another link took the audiobook meanwhile', async () => {
      repo.findLinkForBook.mockResolvedValue(undefined);
      repo.getBookModality.mockResolvedValue('audio');
      readAlongOutputs.findBuildByReadAlong.mockResolvedValue(build);
      repo.insertLink.mockResolvedValue(undefined);

      await expect(service.attachReadAlongByUser(user, 20, 30)).rejects.toBeInstanceOf(ConflictException);
      expect(readAlongOutputs.recordAttachment).not.toHaveBeenCalled();
    });

    it('propagates an access denial before changing the link', async () => {
      const forbidden = new ForbiddenException('No access to this library');
      repo.findLinkForBook.mockResolvedValue(linkRow);
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(forbidden);

      await expect(service.attachReadAlongByUser(user, 10, 30)).rejects.toBe(forbidden);
      expect(readAlongOutputs.findBuildByReadAlong).not.toHaveBeenCalled();
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

    it('stays matched to its source pair, with both editions as members and no link', async () => {
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
          readAlong: null,
        },
        thisBookProgress: null,
      });
      expect(repo.findMemberProgress).toHaveBeenCalledWith(7, { textBookId: 10, audioBookId: 20, readAlongBookId: null });
      expect(repo.findCounterpartCandidates).not.toHaveBeenCalled();
    });

    it('falls back to a bare read-along when the audiobook of its pair is out of reach', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      hideBooks(20);

      const result = await service.getForBook(user, 30);

      expect(result).toEqual({
        link: null,
        proposed: null,
        counterpart: null,
        role: null,
        members: null,
        thisBookProgress: null,
        readAlongOutput: true,
      });
      expect(repo.findBookSummaries).not.toHaveBeenCalled();
    });

    it('shows the audiobook alone when the ebook of its free pair is out of reach', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      hideBooks(10);

      const result = await service.getForBook(user, 30);

      expect(result).toMatchObject({ link: null, role: 'readAlong', members: { text: null, audio: { id: 20 }, readAlong: null } });
      expect(result.readAlongOutput).toBeUndefined();
      expect(repo.findMemberProgress).toHaveBeenCalledWith(7, { textBookId: null, audioBookId: 20, readAlongBookId: null });
    });

    it('shows the pair link it can rejoin when its pair is linked without it on purpose', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      // The read-along page has no link of its own; its pair is linked, and detached it deliberately.
      repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce(linkRow).mockResolvedValueOnce(linkRow);
      repo.findBookSummaries.mockResolvedValue(
        new Map([
          [10, { id: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null }],
          [20, { id: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null }],
        ]),
      );

      const result = await service.getForBook(user, 30);

      expect(result).toEqual({
        link: linkRow,
        proposed: null,
        counterpart: { id: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null },
        role: 'readAlong',
        members: {
          text: expect.objectContaining({ id: 10 }),
          audio: expect.objectContaining({ id: 20 }),
          readAlong: null,
        },
        thisBookProgress: null,
      });
      expect(result.readAlongOutput).toBeUndefined();
      expect(readAlongOutputs.findLostReadAlong).toHaveBeenCalledWith(linkRow);
      expect(repo.findMemberProgress).toHaveBeenCalledWith(7, { textBookId: 10, audioBookId: 20, readAlongBookId: null });
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
    });

    it('falls back to a bare read-along when its pair link holds another read-along', async () => {
      const other = { ...linkRow, readAlongBookId: 31 };
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce(other).mockResolvedValueOnce(other);

      await expect(service.getForBook(user, 30)).resolves.toMatchObject({ role: null, members: null, readAlongOutput: true });
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
      expect(repo.findBookSummaries).not.toHaveBeenCalled();
    });

    it('shows the audiobook alone when the ebook of its free pair is linked to another audiobook', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      repo.findLinkForBook
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ ...linkRow, audioBookId: 21 })
        .mockResolvedValueOnce(undefined);

      await expect(service.getForBook(user, 30)).resolves.toMatchObject({
        link: null,
        role: 'readAlong',
        members: { text: null, audio: { id: 20 }, readAlong: null },
      });
      expect(readAlongOutputs.findLostReadAlong).not.toHaveBeenCalled();
    });

    it('falls back to a bare read-along when its audiobook is not the audio side of the link it sits on', async () => {
      repo.getBookModality.mockResolvedValue('text');
      readAlongOutputs.findReadAlongOutputs.mockResolvedValue(new Set([30]));
      readAlongOutputs.findSourcePair.mockResolvedValue({ textBookId: 10, audioBookId: 20 });
      repo.findLinkForBook
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ ...linkRow, textBookId: 11, audioBookId: 21 });

      await expect(service.getForBook(user, 30)).resolves.toMatchObject({ role: null, members: null, readAlongOutput: true });
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

    it('tells an unlinked ebook about the read-along its candidate audiobook already carries', async () => {
      const audio = { bookId: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null, score: 96 };
      repo.getBookModality.mockResolvedValue('text');
      repo.findCounterpartCandidates.mockResolvedValue([audio]);
      repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ...linkRow, textBookId: null, readAlongBookId: 30 });

      await expect(service.getForBook(user, 10)).resolves.toMatchObject({
        link: null,
        proposed: audio,
        role: null,
        members: { text: null, audio: { id: 20 }, readAlong: { id: 30 } },
      });
    });

    it('proposes an ebook for a link that holds only the audiobook and its read-along', async () => {
      const ebook = { bookId: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 96 };
      repo.findLinkForBook.mockResolvedValue({ ...linkRow, textBookId: null, readAlongBookId: 30 });
      repo.findCounterpartCandidates.mockResolvedValue([ebook]);

      await expect(service.getForBook(user, 20)).resolves.toMatchObject({ proposed: ebook, role: 'audio', members: { text: null } });
      expect(repo.findCounterpartCandidates).toHaveBeenCalledWith(expect.objectContaining({ bookId: 20, modality: 'audio' }));
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
      proposed: { ...candidate, progress: null },
      counterpart: null,
      role: null,
      members: null,
      thisBookProgress: null,
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
      thisBookProgress: null,
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
      thisBookProgress: null,
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
      expect(result.members?.text?.id).toBe(10);
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
        thisBookProgress: null,
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
      expect(repo.setReadAlongBook).toHaveBeenCalledWith(9, null, 30);
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
      await service.unlink(user, 20);

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
    it('unlinks from the audio page even when the read-along member is inaccessible', async () => {
      // Only a third access check can reject here, and the fixed unlink never makes one: the
      // requested book and the audio member are all it consults.
      const forbidden = new ForbiddenException('No access to this library');
      bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(forbidden);

      await expect(service.unlink(user, 20)).resolves.toEqual(linkRow);
      expect(repo.deleteLink).toHaveBeenCalledWith(9);
      expect(bookService.verifyBookAccess).toHaveBeenCalledWith(10, user);
      expect(bookService.verifyBookAccess).not.toHaveBeenCalledWith(30, user);
    });

    it('masks a read-along the reader cannot open in the unlink answer', async () => {
      repo.deleteLink.mockResolvedValue(threeWayRow);
      hideBooks(30);

      await expect(service.unlink(user, 20)).resolves.toEqual({ ...threeWayRow, readAlongBookId: null });
      expect(repo.deleteLink).toHaveBeenCalledWith(9);
    });

    it('keeps the audiobook and read-along linked when the ebook leaves', async () => {
      const left = { ...threeWayRow, textBookId: null };
      repo.setTextBook.mockResolvedValue(left);

      await expect(service.unlink(user, 10)).resolves.toEqual(left);
      expect(repo.setTextBook).toHaveBeenCalledWith(9, null, 10);
      expect(repo.deleteLink).not.toHaveBeenCalled();
      expect(readAlongOutputs.recordDetach).not.toHaveBeenCalled();
    });

    // Through the compare-and-set clear, never a delete by id: a read-along attached since the read
    // would go with the row. The repository drops the row itself when nothing is left on it.
    it('clears the ebook through the compare-and-set even when the link had no read-along', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      log.mockClear();
      repo.findLinkForBook.mockResolvedValue(linkRow);
      repo.setTextBook.mockResolvedValue({ ...linkRow, textBookId: null });

      await service.unlink(user, 10);

      expect(repo.setTextBook).toHaveBeenCalledWith(9, null, 10);
      expect(repo.deleteLink).not.toHaveBeenCalled();
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes('[edition_link.unlink] [end]') && line.includes('outcome=link_deleted'))).toBe(true);
      log.mockRestore();
    });

    it('keeps a read-along attached between the read and the clear when the ebook leaves', async () => {
      const left = { ...linkRow, textBookId: null, readAlongBookId: 30 };
      repo.findLinkForBook.mockResolvedValue(linkRow);
      repo.setTextBook.mockResolvedValue(left);

      await expect(service.unlink(user, 10)).resolves.toEqual(left);
      expect(repo.deleteLink).not.toHaveBeenCalled();
    });

    it('answers not found when the read-along changed between the read and the detach', async () => {
      repo.setReadAlongBook.mockResolvedValue(undefined);

      await expect(service.unlink(user, 30)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.setReadAlongBook).toHaveBeenCalledWith(9, null, 30);
    });

    // One event per operation: the unlink's own end line carries the outcome.
    it('logs the ebook leaving while the read-along stays on the unlink end line alone', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      log.mockClear();
      repo.setTextBook.mockResolvedValue({ ...threeWayRow, textBookId: null });

      await service.unlink(user, 10);

      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.startsWith('[edition_link.leave_text]'))).toBe(false);
      expect(
        lines.some((line) => line.includes('[edition_link.unlink] [end]') && line.includes('textBookId=10') && line.includes('outcome=text_left')),
      ).toBe(true);
      log.mockRestore();
    });

    // The read-along was detached between the read and the clear: the repository dropped the row.
    it('reports the link deleted when the ebook was the last optional member', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      log.mockClear();
      repo.setTextBook.mockResolvedValue({ ...threeWayRow, textBookId: null, readAlongBookId: null });

      await service.unlink(user, 10);

      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.startsWith('[edition_link.leave_text]'))).toBe(false);
      expect(lines.some((line) => line.includes('[edition_link.unlink] [end]') && line.includes('outcome=link_deleted'))).toBe(true);
      log.mockRestore();
    });

    it('deletes an ebook-less link when the audiobook leaves', async () => {
      repo.findLinkForBook.mockResolvedValue({ ...threeWayRow, textBookId: null });

      await service.unlink(user, 20);

      expect(repo.deleteLink).toHaveBeenCalledWith(9);
      expect(repo.setTextBook).not.toHaveBeenCalled();
      expect(repo.setReadAlongBook).not.toHaveBeenCalled();
      // The read-along is checked only because it is all that makes the row visible.
      expect(bookService.verifyBookAccess).toHaveBeenCalledTimes(2);
      expect(bookService.verifyBookAccess).toHaveBeenCalledWith(30, user);
    });

    it('lets the repository drop the row when the read-along leaves an ebook-less link', async () => {
      const nullText = { ...threeWayRow, textBookId: null };
      repo.findLinkForBook.mockResolvedValue(nullText);
      repo.setReadAlongBook.mockResolvedValue(nullText);

      await service.unlink(user, 30);

      expect(repo.setReadAlongBook).toHaveBeenCalledWith(9, null, 30);
      expect(bookService.verifyBookAccess).toHaveBeenCalledWith(20, user);
      expect(bookService.verifyBookAccess).toHaveBeenCalledTimes(2);
      expect(repo.deleteLink).not.toHaveBeenCalled();
    });

    describe('with no ebook on the link', () => {
      const nullText = { ...threeWayRow, textBookId: null };

      beforeEach(() => {
        repo.findLinkForBook.mockResolvedValue(nullText);
      });

      it('reports a null text member and no counterpart on the audiobook page', async () => {
        const result = await service.getForBook(user, 20);

        expect(result.role).toBe('audio');
        expect(result.members?.text).toBeNull();
        expect(result.members?.audio.id).toBe(20);
        expect(result.members?.readAlong?.id).toBe(30);
        expect(result.counterpart).toBeNull();
        expect(repo.findBookSummaries).toHaveBeenCalledWith([20, 30]);
        expect(repo.findMemberProgress).toHaveBeenCalledWith(7, { textBookId: null, audioBookId: 20, readAlongBookId: 30 });
      });

      // Stripping the read-along leaves nothing linked but the audiobook, which the client would show
      // as a linked audio-only row whose switch deletes the owner's attachment.
      it('answers like an unlinked audiobook when the reader cannot see the read-along', async () => {
        const candidate = { bookId: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 98 };
        repo.findCounterpartCandidates.mockResolvedValue([candidate]);
        bookService.verifyBookAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundException());

        const result = await service.getForBook(user, 20);

        expect(result).toEqual({
          link: null,
          proposed: { ...candidate, progress: null },
          counterpart: null,
          role: null,
          members: null,
          thisBookProgress: null,
        });
        expect(bookService.verifyBookAccess).toHaveBeenCalledWith(30, user);
      });

      it('reports the audiobook as the counterpart of the read-along page', async () => {
        const result = await service.getForBook(user, 30);

        expect(result.role).toBe('readAlong');
        expect(result.members?.text).toBeNull();
        expect(result.counterpart?.id).toBe(20);
      });

      it('checks access only on the members that exist', async () => {
        await service.getForBook(user, 30);

        expect(bookService.verifyBookAccess).toHaveBeenCalledTimes(2);
        expect(bookService.verifyBookAccess).toHaveBeenCalledWith(30, user);
        expect(bookService.verifyBookAccess).toHaveBeenCalledWith(20, user);
      });

      it('fills the ebook side of the row on link, keeping the read-along', async () => {
        const filled = { ...nullText, textBookId: 10 };
        repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
        repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce(nullText);
        repo.setTextBook.mockResolvedValue(filled);

        await expect(service.link(user, 10, 20)).resolves.toEqual(filled);
        expect(repo.setTextBook).toHaveBeenCalledWith(9, 10, null);
        expect(repo.insertLink).not.toHaveBeenCalled();
      });

      it('refuses to fill the row with an ebook linked elsewhere', async () => {
        repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
        repo.findLinkForBook.mockResolvedValueOnce({ ...linkRow, id: 77, audioBookId: 21 }).mockResolvedValueOnce(nullText);

        await expect(service.link(user, 10, 20)).rejects.toBeInstanceOf(ConflictException);
        expect(repo.setTextBook).not.toHaveBeenCalled();
        expect(repo.insertLink).not.toHaveBeenCalled();
      });

      it('answers a conflict when the ebook side changed meanwhile', async () => {
        repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
        repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce(nullText);
        repo.setTextBook.mockResolvedValue(undefined);
        repo.insertLink.mockResolvedValue(undefined);

        await expect(service.link(user, 10, 20)).rejects.toBeInstanceOf(ConflictException);
        expect(repo.insertLink).toHaveBeenCalledTimes(1);
      });

      it('inserts the pair when a concurrent detach removed the row it was filling', async () => {
        repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
        repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce(nullText);
        repo.setTextBook.mockResolvedValue(undefined);

        await expect(service.link(user, 10, 20)).resolves.toEqual(linkRow);
        expect(repo.insertLink).toHaveBeenCalledWith(10, 20, 7);
      });

      it('does not give a read-along back to the row inserted after a lost fill', async () => {
        repo.getBookModality.mockResolvedValueOnce('text').mockResolvedValueOnce('audio');
        repo.findLinkForBook.mockResolvedValueOnce(undefined).mockResolvedValueOnce(nullText);
        repo.setTextBook.mockResolvedValue(undefined);
        readAlongOutputs.findLostReadAlong.mockResolvedValue({ buildId: 4, outputBookId: 30 });

        await expect(service.link(user, 10, 20)).resolves.toEqual(linkRow);
        expect(readAlongOutputs.findLostReadAlong).not.toHaveBeenCalled();
        expect(repo.setReadAlongBook).not.toHaveBeenCalled();
      });

      it('answers not found on unlink when the only read-along is hidden from the reader', async () => {
        hideBooks(30);

        await expect(service.unlink(user, 20)).rejects.toBeInstanceOf(NotFoundException);
        expect(repo.deleteLink).not.toHaveBeenCalled();
      });

      it('answers like an unlinked ebook, with no members, when the proposal carries a hidden read-along', async () => {
        const audio = { bookId: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null, score: 96 };
        repo.getBookModality.mockResolvedValue('text');
        repo.findCounterpartCandidates.mockResolvedValue([audio]);
        linksBy((id) => (id === 20 ? nullText : undefined));
        hideBooks(30);

        await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 20 }, members: null });
      });
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

    await expect(service.unlink(user, 20)).resolves.toEqual(linkRow);
    // Access is verified on both sides of the pair (bookId 20 and its counterpart 10).
    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(20, user);
    expect(bookService.verifyBookAccess).toHaveBeenCalledWith(10, user);
    // Addressed by the resolved link id: a member-column delete would take out every link the book
    // appears in and report only one of them back.
    expect(repo.deleteLink).toHaveBeenCalledWith(9);
  });

  it('rejects unlink when no link exists', async () => {
    repo.deleteLink.mockResolvedValue(undefined);

    await expect(service.unlink(user, 10)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('an unlinked ebook page', () => {
    const proposedAudio = { bookId: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null, score: 96 };
    const links = new Map<number, LinkRow>();

    beforeEach(() => {
      links.clear();
      repo.getBookModality.mockResolvedValue('text');
      repo.findCounterpartCandidates.mockResolvedValue([proposedAudio]);
      linksBy((id) => links.get(id));
    });

    describe('with the audiobook on screen named', () => {
      it('shows the read-along the picked audiobook carries, not the proposal', async () => {
        links.set(20, { ...linkRow, textBookId: null, readAlongBookId: 30 });
        links.set(21, { ...linkRow, id: 12, textBookId: null, audioBookId: 21, readAlongBookId: 31 });

        const result = await service.getForBook(user, 10, 21);

        expect(result).toMatchObject({ link: null, proposed: { bookId: 20 }, role: null });
        expect(result.members).toMatchObject({ text: null, audio: { id: 21 }, readAlong: { id: 31 } });
        expect(repo.findMemberProgress).toHaveBeenCalledWith(7, { textBookId: null, audioBookId: 21, readAlongBookId: 31 });
      });

      it('shows no members when the picked audiobook carries no read-along', async () => {
        links.set(20, { ...linkRow, textBookId: null, readAlongBookId: 30 });

        const result = await service.getForBook(user, 10, 21);

        expect(result).toMatchObject({ proposed: { bookId: 20 }, members: null });
      });

      it('ignores a picked audiobook the reader cannot open', async () => {
        links.set(20, { ...linkRow, textBookId: null, readAlongBookId: 30 });
        links.set(21, { ...linkRow, id: 12, textBookId: null, audioBookId: 21, readAlongBookId: 31 });
        hideBooks(21);

        const result = await service.getForBook(user, 10, 21);

        expect(result.members).toMatchObject({ audio: { id: 20 }, readAlong: { id: 30 } });
      });
    });

    describe('progress for the animation', () => {
      it("carries this book's and the proposal's progress, read in one query", async () => {
        repo.findReadingPercentages.mockResolvedValue(
          new Map([
            [10, 42],
            [20, 17],
          ]),
        );

        const result = await service.getForBook(user, 10);

        expect(result.thisBookProgress).toBe(42);
        expect(result.proposed).toEqual({ ...proposedAudio, progress: 17 });
        expect(repo.findReadingPercentages).toHaveBeenCalledTimes(1);
        expect(repo.findReadingPercentages).toHaveBeenCalledWith(7, [
          { bookId: 10, audio: false },
          { bookId: 20, audio: true },
        ]);
      });

      it('reads null for books with no progress', async () => {
        const result = await service.getForBook(user, 10);

        expect(result.thisBookProgress).toBeNull();
        expect(result.proposed?.progress).toBeNull();
      });

      it("reads an audiobook page's progress from the audiobook and its proposed ebook from the file", async () => {
        const ebook = { bookId: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 96 };
        links.set(20, { ...linkRow, textBookId: null, readAlongBookId: 30 });
        repo.findCounterpartCandidates.mockResolvedValue([ebook]);
        repo.findReadingPercentages.mockResolvedValue(new Map([[20, 55]]));

        const result = await service.getForBook(user, 20);

        expect(result).toMatchObject({ role: 'audio', thisBookProgress: 55, proposed: { bookId: 10, progress: null } });
        expect(repo.findReadingPercentages).toHaveBeenCalledWith(7, [
          { bookId: 20, audio: true },
          { bookId: 10, audio: false },
        ]);
      });

      it('leaves search results without progress', async () => {
        await expect(service.searchCandidates(user, 10)).resolves.toEqual([proposedAudio]);
        expect(repo.findReadingPercentages).not.toHaveBeenCalled();
      });
    });

    describe('with a read-along build for the ebook', () => {
      const build22 = { textBookId: 10, audioBookId: 22, status: 'building', outputBookId: null as number | null };
      const dune22 = new Map([[22, { id: 22, title: 'Dune (unabridged)', authorName: 'Frank Herbert', coverVersion: null }]]);

      it('proposes the audiobook the build pairs it with, marked as coming from the build', async () => {
        readAlongOutputs.findNewestBuildForText.mockResolvedValue(build22);
        repo.findBookSummaries.mockResolvedValue(dune22);
        repo.findReadingPercentages.mockResolvedValue(new Map([[22, 8]]));

        const result = await service.getForBook(user, 10);

        expect(result.proposed).toEqual({
          bookId: 22,
          title: 'Dune (unabridged)',
          authorName: 'Frank Herbert',
          coverVersion: null,
          score: 0,
          progress: 8,
          fromBuild: true,
        });
        expect(readAlongOutputs.findNewestBuildForText).toHaveBeenCalledWith(10);
      });

      it('keeps the match score when the paired audiobook is also a similarity candidate', async () => {
        readAlongOutputs.findNewestBuildForText.mockResolvedValue({ ...build22, audioBookId: 20 });

        await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 20, score: 96, fromBuild: true } });
      });

      it('marks only a proposal that comes from a build', async () => {
        const result = await service.getForBook(user, 10);

        expect(result.proposed).not.toHaveProperty('fromBuild');
      });

      it('falls back to the similarity candidate when the paired audiobook is linked to another ebook', async () => {
        readAlongOutputs.findNewestBuildForText.mockResolvedValue(build22);
        links.set(22, { ...linkRow, id: 13, textBookId: 15, audioBookId: 22 });

        await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 20 } });
      });

      it('falls back to the similarity candidate when the reader cannot open the paired audiobook', async () => {
        readAlongOutputs.findNewestBuildForText.mockResolvedValue(build22);
        hideBooks(22);

        await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 20 } });
      });

      it('falls back to the similarity candidate when the build names a missing book', async () => {
        readAlongOutputs.findNewestBuildForText.mockResolvedValue(build22);
        repo.findBookSummaries.mockResolvedValue(new Map());

        await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 20 } });
      });

      it('falls back to the similarity candidate when the build names a generated read-along', async () => {
        readAlongOutputs.findNewestBuildForText.mockResolvedValue(build22);
        repo.findBookSummaries.mockResolvedValue(dune22);
        readAlongOutputs.findReadAlongOutputs.mockImplementation((ids) => Promise.resolve(new Set(ids.filter((id) => id === 22))));

        await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 20 } });
      });

      it('proposes the paired audiobook when it holds a read-along without an ebook', async () => {
        readAlongOutputs.findNewestBuildForText.mockResolvedValue(build22);
        links.set(22, { ...linkRow, id: 13, textBookId: null, audioBookId: 22, readAlongBookId: 32 });
        repo.findBookSummaries.mockResolvedValue(new Map([[22, { id: 22, title: 'Dune (unabridged)', authorName: null, coverVersion: null }]]));

        await expect(service.getForBook(user, 10)).resolves.toMatchObject({
          proposed: { bookId: 22 },
          members: { audio: { id: 22 }, readAlong: { id: 32 } },
        });
      });

      it.each(['queued', 'building', 'failed'])('keeps proposing the audiobook of a %s build', async (status) => {
        readAlongOutputs.findNewestBuildForText.mockResolvedValue({ ...build22, status });
        repo.findBookSummaries.mockResolvedValue(dune22);

        await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 22, fromBuild: true } });
      });

      describe('once the build is ready', () => {
        const ready = { ...build22, status: 'ready', outputBookId: 31 };

        beforeEach(() => {
          repo.findBookSummaries.mockResolvedValue(dune22);
        });

        it('keeps proposing the audiobook while its output sits on no link', async () => {
          readAlongOutputs.findNewestBuildForText.mockResolvedValue(ready);

          await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 22, fromBuild: true } });
          expect(repo.findLinkForBook).toHaveBeenCalledWith(31);
        });

        it('stops proposing it once the output is attached to a link', async () => {
          readAlongOutputs.findNewestBuildForText.mockResolvedValue(ready);
          links.set(31, { ...linkRow, id: 14, readAlongBookId: 31 });

          await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 20 } });
        });

        it('proposes nothing from a ready build whose output was deleted', async () => {
          readAlongOutputs.findNewestBuildForText.mockResolvedValue({ ...ready, outputBookId: null });

          await expect(service.getForBook(user, 10)).resolves.toMatchObject({ proposed: { bookId: 20 } });
        });
      });
    });

    describe('on an audiobook page with a read-along build', () => {
      const ebook12 = { id: 12, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null };
      const forAudio = { textBookId: 12, audioBookId: 20, status: 'building', outputBookId: null as number | null };

      beforeEach(() => {
        repo.getBookModality.mockResolvedValue('audio');
        repo.findBookSummaries.mockResolvedValue(new Map([[12, ebook12]]));
      });

      it('proposes the ebook the build pairs it with, marked as coming from the build', async () => {
        readAlongOutputs.findNewestBuildForAudio.mockResolvedValue(forAudio);
        repo.findReadingPercentages.mockResolvedValue(new Map([[12, 30]]));

        const result = await service.getForBook(user, 20);

        expect(readAlongOutputs.findNewestBuildForAudio).toHaveBeenCalledWith(20);
        expect(result.proposed).toEqual({
          bookId: 12,
          title: 'Dune',
          authorName: 'Frank Herbert',
          coverVersion: null,
          score: 0,
          progress: 30,
          fromBuild: true,
        });
      });

      it('keeps proposing the ebook of a ready build whose output sits on no link', async () => {
        readAlongOutputs.findNewestBuildForAudio.mockResolvedValue({ ...forAudio, status: 'ready', outputBookId: 31 });

        await expect(service.getForBook(user, 20)).resolves.toMatchObject({ proposed: { bookId: 12, fromBuild: true } });
      });

      it('falls back to the similarity candidate when the build ebook is linked elsewhere', async () => {
        const similar = { bookId: 11, title: 'Dune', authorName: null, coverVersion: null, score: 90 };
        repo.findCounterpartCandidates.mockResolvedValue([similar]);
        readAlongOutputs.findNewestBuildForAudio.mockResolvedValue(forAudio);
        links.set(12, { ...linkRow, id: 15, textBookId: 12, audioBookId: 21 });

        await expect(service.getForBook(user, 20)).resolves.toMatchObject({ proposed: { bookId: 11 } });
      });

      it('proposes the build ebook on the page of an audiobook linked to a read-along alone', async () => {
        readAlongOutputs.findNewestBuildForAudio.mockResolvedValue(forAudio);
        links.set(20, { ...linkRow, textBookId: null, readAlongBookId: 30 });

        await expect(service.getForBook(user, 20)).resolves.toMatchObject({ role: 'audio', proposed: { bookId: 12, fromBuild: true } });
      });
    });

    describe('with the audiobook the page has on screen', () => {
      it('reads the progress of the picked audiobook with the same percentages query', async () => {
        repo.findReadingPercentages.mockResolvedValue(
          new Map([
            [20, 17],
            [25, 61],
          ]),
        );
        repo.findBookSummaries.mockResolvedValue(new Map());

        const result = await service.getForBook(user, 10, 25);

        expect(result.pickedProgress).toBe(61);
        expect(repo.findReadingPercentages).toHaveBeenCalledTimes(1);
        expect(repo.findReadingPercentages).toHaveBeenCalledWith(7, [
          { bookId: 10, audio: false },
          { bookId: 20, audio: true },
          { bookId: 25, audio: true },
        ]);
      });

      it('reuses the proposal progress when the picked audiobook is the proposal', async () => {
        repo.findReadingPercentages.mockResolvedValue(new Map([[20, 17]]));

        const result = await service.getForBook(user, 10, 20);

        expect(result.pickedProgress).toBe(17);
        expect(repo.findReadingPercentages).toHaveBeenCalledWith(7, [
          { bookId: 10, audio: false },
          { bookId: 20, audio: true },
        ]);
      });

      it('answers null when the picked audiobook has no progress', async () => {
        const result = await service.getForBook(user, 10, 25);

        expect(result.pickedProgress).toBeNull();
      });

      it('answers no picked progress for a counterpart the reader cannot open', async () => {
        hideBooks(25);
        repo.findReadingPercentages.mockResolvedValue(new Map([[25, 61]]));

        const result = await service.getForBook(user, 10, 25);

        expect(result.pickedProgress).toBeUndefined();
        expect(repo.findReadingPercentages).toHaveBeenCalledWith(7, [
          { bookId: 10, audio: false },
          { bookId: 20, audio: true },
        ]);
      });

      it('answers no picked progress without a counterpart', async () => {
        const result = await service.getForBook(user, 10);

        expect(result.pickedProgress).toBeUndefined();
      });
    });
  });

  describe('works', () => {
    it('joins an ebook already in a work to an audiobook and folds the history together', async () => {
      (repo.getBookModality as Mock<(id: number) => Promise<string>>).mockImplementation((id) => Promise.resolve(id === 10 ? 'text' : 'audio'));
      const joined = { ...linkRow, id: 12, audioBookId: 21 };
      works.joinWorks.mockResolvedValue(12);
      repo.findLinkForBook.mockResolvedValueOnce(linkRow).mockResolvedValueOnce(undefined).mockResolvedValueOnce(joined);

      await expect(service.link(user, 10, 21)).resolves.toEqual(joined);
      expect(works.joinWorks).toHaveBeenCalledWith(user, 10, 21);
      expect(works.mergeStateForBook).toHaveBeenCalledWith(10, 7);
      expect(repo.insertLink).not.toHaveBeenCalled();
    });

    it('folds the history together after a fresh link', async () => {
      (repo.getBookModality as Mock<(id: number) => Promise<string>>).mockImplementation((id) => Promise.resolve(id === 10 ? 'text' : 'audio'));

      await service.link(user, 10, 20);

      expect(works.mergeStateForBook).toHaveBeenCalledWith(10, 7);
    });

    it('removes a member of a work with duplicate copies through the work, copying history around it', async () => {
      const members = [
        { linkId: 9, bookId: 10, role: 'text', isPrimary: true },
        { linkId: 9, bookId: 11, role: 'text', isPrimary: false },
        { linkId: 9, bookId: 20, role: 'audio', isPrimary: true },
      ];
      const context = { bookId: 11, remainingBookIds: [10, 20], carryOver: [], readers: [7] };
      repo.findLinkForBook.mockResolvedValue(linkRow);
      works.findMembers.mockResolvedValue(members);
      works.prepareDetach.mockResolvedValue(context);
      works.removeMember.mockResolvedValue(linkRow);

      await expect(service.unlink(user, 11)).resolves.toEqual(linkRow);

      expect(works.removeMember).toHaveBeenCalledWith(11, members);
      expect(repo.setTextBook).not.toHaveBeenCalled();
      expect(repo.deleteLink).not.toHaveBeenCalled();
      expect(works.prepareDetach.mock.invocationCallOrder[0]).toBeLessThan(works.removeMember.mock.invocationCallOrder[0]!);
      expect(works.finishDetach).toHaveBeenCalledWith(context);
      expect(works.notifyChanged).toHaveBeenCalledWith(7, [10, 11, 20], [20]);
    });

    it('copies history onto a book leaving a plain pair before the slot is cleared', async () => {
      repo.findLinkForBook.mockResolvedValue(linkRow);
      works.findMembers.mockResolvedValue([
        { linkId: 9, bookId: 10, role: 'text', isPrimary: true },
        { linkId: 9, bookId: 20, role: 'audio', isPrimary: true },
      ]);
      repo.setTextBook.mockResolvedValue({ ...linkRow, textBookId: null });

      await service.unlink(user, 10);

      expect(works.prepareDetach).toHaveBeenCalledWith(10);
      expect(works.prepareDetach.mock.invocationCallOrder[0]).toBeLessThan(repo.setTextBook.mock.invocationCallOrder[0]!);
      expect(works.finishDetach).toHaveBeenCalled();
    });
  });
});
