import { Logger } from '@nestjs/common';
import { EMPTY_CONTENT_FILTER_RULES } from '@bookorbit/types';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { DEFAULT_EDITION_LINK_SETTINGS } from './edition-link-settings.service';
import { WorkMatchService } from './work-match.service';

type AnyMock = Mock<(...args: never[]) => unknown>;

const user = { id: 7, isSuperuser: true, contentFilters: EMPTY_CONTENT_FILTER_RULES } as unknown as RequestUser;
const result = (id: number, sourceBookId: number, targetBookId: number, fields: Record<string, unknown> = {}) => ({
  id,
  scanId: 3,
  userId: 7,
  sourceBookId,
  targetBookId,
  targetRole: 'audio',
  bucket: 'strong',
  score: 0.95,
  titleScore: 0.95,
  authorScore: 1,
  isbnMatch: false,
  reason: 'title 0.95 author 1',
  linkId: null,
  competingBookIds: [],
  createdAt: new Date(),
  ...fields,
});
const member = (linkId: number, bookId: number, role: string, isPrimary = true) => ({ linkId, bookId, role, isPrimary });

describe('WorkMatchService', () => {
  let repo: Record<string, AnyMock>;
  let works: { findWorkMembersForBooks: AnyMock };
  let links: { findMatchCandidates: AnyMock; findBookSummaries: AnyMock };
  let linkService: { link: AnyMock; unlink: AnyMock; attachReadAlongByUser: AnyMock };
  let workService: { addMember: AnyMock };
  let settings: { get: AnyMock };
  let outputs: { findReadAlongOutputs: AnyMock; findSourcePair: AnyMock };
  let service: WorkMatchService;

  beforeEach(() => {
    repo = {
      findLatestScan: vi.fn().mockResolvedValue({ id: 3, userId: 7, state: 'done' }),
      findStrongUnlinked: vi.fn().mockResolvedValue([]),
      markLinked: vi.fn().mockResolvedValue(undefined),
      findScan: vi.fn().mockResolvedValue({ id: 3, userId: 7, libraryId: null }),
      countScanBooks: vi.fn().mockResolvedValue(2),
      updateScan: vi.fn().mockResolvedValue(undefined),
      findScanBatch: vi.fn().mockResolvedValue([]),
      findIdentifierMatches: vi.fn().mockResolvedValue([]),
      findDismissedPairs: vi.fn().mockResolvedValue(new Set()),
      insertResults: vi.fn().mockResolvedValue(undefined),
      findStrongClaims: vi.fn().mockResolvedValue([]),
      findAuthorNames: vi.fn().mockResolvedValue(new Map()),
      markConflict: vi.fn().mockResolvedValue(undefined),
      deleteOlderScans: vi.fn().mockResolvedValue(undefined),
    };
    works = { findWorkMembersForBooks: vi.fn().mockResolvedValue([]) };
    links = { findMatchCandidates: vi.fn().mockResolvedValue([]), findBookSummaries: vi.fn().mockResolvedValue(new Map()) };
    linkService = {
      link: vi.fn().mockResolvedValue({ id: 40 }),
      unlink: vi.fn().mockResolvedValue({ id: 41 }),
      attachReadAlongByUser: vi.fn().mockResolvedValue({ id: 42 }),
    };
    workService = { addMember: vi.fn().mockResolvedValue({ linkId: 43 }) };
    settings = { get: vi.fn().mockResolvedValue(DEFAULT_EDITION_LINK_SETTINGS) };
    outputs = { findReadAlongOutputs: vi.fn().mockResolvedValue(new Set()), findSourcePair: vi.fn().mockResolvedValue(null) };
    service = new WorkMatchService(
      repo as never,
      works as never,
      links as never,
      linkService as never,
      workService as never,
      settings as never,
      { findAccessibleLibraryIds: vi.fn().mockResolvedValue([1]) } as never,
      outputs as never,
    );
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  describe('linkAllStrong', () => {
    it('links every strong result still free and skips the ones claimed since the scan', async () => {
      repo.findStrongUnlinked!.mockResolvedValueOnce([result(1, 10, 20), result(2, 11, 21), result(3, 12, 22)]).mockResolvedValue([]);
      works.findWorkMembersForBooks.mockImplementation((ids: number[]) => {
        if (ids.includes(21)) return Promise.resolve([member(5, 21, 'audio'), member(5, 99, 'text')]);
        if (ids.includes(12)) return Promise.resolve([member(6, 12, 'text'), member(6, 98, 'audio')]);
        return Promise.resolve([]);
      });

      await expect(service.linkAllStrong(user)).resolves.toEqual({ linked: 1, skipped: 2 });
      expect(linkService.link).toHaveBeenCalledTimes(1);
      expect(linkService.link).toHaveBeenCalledWith(user, 10, 20);
      expect(repo.markLinked).toHaveBeenCalledWith(1, 40);
    });

    it('counts a link that fails as skipped', async () => {
      repo.findStrongUnlinked!.mockResolvedValueOnce([result(1, 10, 20)]).mockResolvedValue([]);
      linkService.link.mockRejectedValue(new Error('boom'));

      await expect(service.linkAllStrong(user)).resolves.toEqual({ linked: 0, skipped: 1 });
    });

    it('adds a duplicate result as a same-type copy', async () => {
      repo.findStrongUnlinked!.mockResolvedValueOnce([result(1, 10, 11, { targetRole: 'duplicate' })]).mockResolvedValue([]);

      await expect(service.linkAllStrong(user)).resolves.toEqual({ linked: 1, skipped: 0 });
      expect(workService.addMember).toHaveBeenCalledWith(user, 10, 11);
    });
  });

  describe('runScan', () => {
    it('stores bucketed results, marks conflicts and links strong matches when asked', async () => {
      settings.get.mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS, sameTypeAsOneWork: false, autoLinkStrong: true });
      repo
        .findScanBatch!.mockResolvedValueOnce([
          { id: 10, title: 'Dune', language: 'en', formats: ['epub'], isbn13: null, isbn10: null, amazonId: null, audibleId: null },
          { id: 11, title: 'Emma', language: 'en', formats: ['epub'], isbn13: null, isbn10: null, amazonId: null, audibleId: null },
          { id: 12, title: 'Dune', language: 'en', formats: ['epub'], isbn13: null, isbn10: null, amazonId: null, audibleId: null },
        ])
        .mockResolvedValue([]);
      works.findWorkMembersForBooks.mockImplementation((ids: number[]) =>
        Promise.resolve(ids.includes(11) ? [member(5, 11, 'text'), member(5, 31, 'audio')] : []),
      );
      links.findMatchCandidates.mockImplementation(({ bookId }: { bookId: number }) =>
        Promise.resolve(
          bookId === 11
            ? [
                { bookId: 31, title: 'Emma', authorNames: [], language: 'en', score: 0.85, titleScore: 0.85, authorScore: 1 },
                { bookId: 32, title: 'Emma', authorNames: [], language: 'en', score: 0.98, titleScore: 0.98, authorScore: 1 },
              ]
            : [
                { bookId: 30, title: 'Dune', authorNames: [], language: 'en', score: 0.97, titleScore: 0.97, authorScore: 1 },
                { bookId: 33, title: 'Dune', authorNames: [], language: 'de', score: 0.99, titleScore: 0.99, authorScore: 1 },
              ],
        ),
      );
      repo.findStrongClaims!.mockResolvedValue([
        { resultId: 100, sourceBookId: 10, targetBookId: 30 },
        { resultId: 101, sourceBookId: 12, targetBookId: 30 },
      ]);

      await service.runScan(3, user);

      const stored = repo.insertResults!.mock.calls[0]![0] as { sourceBookId: number; targetBookId: number; bucket: string }[];
      expect(stored.map((row) => [row.sourceBookId, row.targetBookId, row.bucket])).toEqual([
        [10, 30, 'strong'],
        [11, 32, 'linked_suspect'],
        [12, 30, 'strong'],
      ]);
      expect(repo.markConflict).toHaveBeenCalledWith(100, [12]);
      expect(repo.markConflict).toHaveBeenCalledWith(101, [10]);
      expect(repo.updateScan).toHaveBeenCalledWith(3, expect.objectContaining({ state: 'done', processed: 3 }));
      expect(repo.findStrongUnlinked).toHaveBeenCalled();
    });
  });
});
