import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EMPTY_CONTENT_FILTER_RULES } from '@bookorbit/types';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from './edition-link.repository';
import { DEFAULT_EDITION_LINK_SETTINGS, EditionLinkSettingsService } from './edition-link-settings.service';
import { READ_ALONG_OUTPUT_SOURCE } from './read-along-output-source';
import { WorkEventsService } from './work-events.service';
import { WorkRepository, type WorkMemberRankRow } from './work.repository';
import { WorkScopeService } from './work-scope.service';
import { WorkService } from './work.service';
import { WorkStateService } from './work-state.service';

type AnyMock = Mock<(...args: never[]) => unknown>;

const user = { id: 7, isSuperuser: false, contentFilters: EMPTY_CONTENT_FILTER_RULES } as unknown as RequestUser;
const member = (linkId: number, bookId: number, role: WorkMemberRankRow['role'], primaryFormat: string, isPrimary = true): WorkMemberRankRow => ({
  linkId,
  bookId,
  role,
  isPrimary,
  createdAt: new Date(`2026-01-${String(bookId % 28 || 1).padStart(2, '0')}T00:00:00.000Z`),
  primaryFormat,
  primaryReadAlong: false,
  formatPriority: null,
});

describe('WorkService', () => {
  let service: WorkService;
  let repo: Record<string, AnyMock>;
  let settings: { get: AnyMock; update: AnyMock };
  let scope: { resolve: AnyMock; invalidate: AnyMock };
  let state: Record<string, AnyMock>;
  let links: Record<string, AnyMock>;

  beforeEach(async () => {
    repo = {
      findWorkMembersByBook: vi.fn().mockResolvedValue([]),
      findWorkMembersByLink: vi.fn().mockResolvedValue([]),
      findBookRanks: vi.fn().mockResolvedValue(new Map()),
      createWork: vi.fn().mockResolvedValue(4),
      addDuplicate: vi.fn().mockResolvedValue(undefined),
      applyPrimaries: vi.fn().mockResolvedValue(undefined),
      mergeWorks: vi.fn().mockResolvedValue(undefined),
      removeMember: vi.fn().mockResolvedValue(2),
      findVariantDetails: vi.fn().mockResolvedValue([]),
      findVariantProgress: vi.fn().mockResolvedValue([]),
    };
    settings = { get: vi.fn().mockResolvedValue(DEFAULT_EDITION_LINK_SETTINGS), update: vi.fn() };
    scope = { resolve: vi.fn().mockResolvedValue(null), invalidate: vi.fn() };
    state = { mergeWorkState: vi.fn().mockResolvedValue(0), mergeAllForUser: vi.fn().mockResolvedValue(undefined) };
    links = { getBookModality: vi.fn().mockResolvedValue('text'), findLinkForBook: vi.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        WorkService,
        { provide: WorkRepository, useValue: repo },
        { provide: EditionLinkRepository, useValue: links },
        { provide: WorkScopeService, useValue: scope },
        { provide: EditionLinkSettingsService, useValue: settings },
        { provide: WorkStateService, useValue: state },
        { provide: WorkEventsService, useValue: { notifyBooksChanged: vi.fn().mockResolvedValue(undefined) } },
        { provide: BookService, useValue: { verifyBookAccess: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: READ_ALONG_OUTPUT_SOURCE,
          useValue: {
            findReadAlongOutputs: vi.fn().mockResolvedValue(new Set()),
            isConfigured: vi.fn().mockResolvedValue(true),
            recordDetach: vi.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(WorkService);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('addMember', () => {
    it('refuses a same-type copy while the setting is off', async () => {
      settings.get.mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS, sameTypeAsOneWork: false });

      await expect(service.addMember(user, 10, 11)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.createWork).not.toHaveBeenCalled();
    });

    it('starts a work with the copy whose format ranks first as primary', async () => {
      repo.findBookRanks!.mockResolvedValue(
        new Map([
          [10, { bookId: 10, primaryFormat: 'mobi', primaryReadAlong: false, formatPriority: null }],
          [11, { bookId: 11, primaryFormat: 'epub', primaryReadAlong: false, formatPriority: null }],
        ]),
      );

      await service.addMember(user, 10, 11);

      expect(repo.createWork).toHaveBeenCalledWith(7, { text: 11, audio: null, readAlong: null }, [{ bookId: 10, role: 'text' }]);
      expect(scope.invalidate).toHaveBeenCalled();
      expect(state.mergeWorkState).toHaveBeenCalled();
    });

    it('refuses a copy of another type and a book already in a work', async () => {
      links.getBookModality!.mockImplementation((id: number) => Promise.resolve(id === 11 ? 'audio' : 'text'));
      await expect(service.addMember(user, 10, 11)).rejects.toBeInstanceOf(BadRequestException);

      repo.findWorkMembersByBook!.mockImplementation((id: number) => Promise.resolve(id === 11 ? [member(9, 11, 'text', 'epub')] : []));
      await expect(service.addMember(user, 10, 11)).rejects.toBeInstanceOf(ConflictException);
    });

    it('adds a duplicate to the anchor work and re-picks primaries', async () => {
      const work = [member(4, 10, 'text', 'mobi'), member(4, 20, 'audio', 'm4b')];
      repo.findWorkMembersByBook!.mockImplementation((id: number) => Promise.resolve(id === 10 ? work : []));
      repo.findWorkMembersByLink!.mockResolvedValue([...work, member(4, 11, 'text', 'epub', false)]);

      await service.addMember(user, 10, 11);

      expect(repo.addDuplicate).toHaveBeenCalledWith(4, 11, 'text');
      expect(repo.applyPrimaries).toHaveBeenCalledWith(4, { text: 11, audio: 20, readAlong: null });
    });
  });

  describe('joinWorks', () => {
    it('merges two works into the audiobook side and re-picks primaries', async () => {
      repo.findWorkMembersByBook!.mockImplementation((id: number) =>
        Promise.resolve(
          id === 10 ? [member(1, 10, 'text', 'epub'), member(1, 30, 'audio', 'mp3')] : [member(2, 20, 'audio', 'm4b'), member(2, 40, 'text', 'mobi')],
        ),
      );

      await expect(service.joinWorks(user, 10, 20)).resolves.toBe(2);

      expect(repo.mergeWorks).toHaveBeenCalledWith(2, 1, { text: 10, audio: 20, readAlong: null });
    });

    it('refuses to double up a role when same-type works are off', async () => {
      settings.get.mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS, sameTypeAsOneWork: false });
      repo.findWorkMembersByBook!.mockImplementation((id: number) =>
        Promise.resolve(id === 10 ? [member(1, 10, 'text', 'epub'), member(1, 30, 'audio', 'mp3')] : []),
      );

      await expect(service.joinWorks(user, 10, 20)).rejects.toBeInstanceOf(ConflictException);
    });

    it('extends a work with the missing role', async () => {
      repo.findWorkMembersByBook!.mockImplementation((id: number) =>
        Promise.resolve(id === 10 ? [member(1, 10, 'text', 'epub'), member(1, 11, 'text', 'mobi', false)] : []),
      );
      repo.findBookRanks!.mockResolvedValue(new Map([[20, { bookId: 20, primaryFormat: 'm4b', primaryReadAlong: false, formatPriority: null }]]));

      await expect(service.joinWorks(user, 10, 20)).resolves.toBe(1);

      expect(repo.addDuplicate).toHaveBeenCalledWith(1, 20, 'audio');
      expect(repo.applyPrimaries).toHaveBeenCalledWith(1, { text: 10, audio: 20, readAlong: null });
    });
  });

  it('describes a lone book as a work of one', async () => {
    repo.findVariantDetails!.mockResolvedValue([
      {
        bookId: 10,
        title: 'Dune',
        authorName: 'Frank Herbert',
        coverUpdatedAt: null,
        libraryId: 1,
        libraryName: 'Books',
        formats: ['epub'],
        sizeBytes: 100,
        metadataDurationSeconds: null,
        audioDurationSeconds: null,
      },
    ]);

    const work = await service.getWorkForBook(user, 10);

    expect(work).toMatchObject({ linkId: null, canonicalBookId: 10, sharedState: true, inSync: true, canGenerateReadAlong: false });
    expect(work.variants).toEqual([expect.objectContaining({ bookId: 10, role: 'text', isThisBook: true, libraryName: 'Books', progress: null })]);
  });

  it('marks a work out of sync and offers a read-along for an ebook and audiobook pair', async () => {
    scope.resolve.mockResolvedValue({
      linkId: 4,
      canonicalBookId: 20,
      members: [
        { bookId: 10, role: 'text', isPrimary: true, createdAt: new Date() },
        { bookId: 20, role: 'audio', isPrimary: true, createdAt: new Date() },
      ],
    });
    repo.findVariantProgress!.mockResolvedValue([
      {
        bookId: 10,
        filePercentage: 12,
        fileLastReadAt: new Date('2026-01-01'),
        fileProjectedAt: null,
        audioPercentage: null,
        audioUpdatedAt: null,
        sessionSource: 'kobo',
      },
      {
        bookId: 20,
        filePercentage: null,
        fileLastReadAt: null,
        fileProjectedAt: null,
        audioPercentage: 40,
        audioUpdatedAt: new Date('2026-01-02'),
        sessionSource: 'audiobookshelf',
      },
    ]);

    const work = await service.getWorkForBook(user, 10);

    expect(work).toMatchObject({ linkId: 4, canonicalBookId: 20, inSync: false, canGenerateReadAlong: true });
    expect(work.variants.map((variant) => [variant.bookId, variant.progress, variant.progressSource])).toEqual([
      [10, 12, 'kobo'],
      [20, 40, 'audiobookshelf'],
    ]);
  });

  it('folds every work together when shared state is turned on', async () => {
    settings.get.mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS, shareReadingState: false });
    settings.update.mockResolvedValue(DEFAULT_EDITION_LINK_SETTINGS);

    await service.updateSettings(7, { shareReadingState: true });

    expect(state.mergeAllForUser).toHaveBeenCalledWith(7);
  });
});
