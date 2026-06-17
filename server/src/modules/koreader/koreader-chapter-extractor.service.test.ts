import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KoreaderChapterExtractorService } from './koreader-chapter-extractor.service';

vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

function makeDb() {
  const orderBy = vi.fn().mockResolvedValue([]);
  const selectWhere = vi.fn().mockReturnValue({ orderBy });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });

  const limit = vi.fn().mockResolvedValue([]);
  const limitWhere = vi.fn().mockReturnValue({ limit });
  const limitFrom = vi.fn().mockReturnValue({ where: limitWhere });

  const select = vi.fn().mockReturnValue({ from: selectFrom });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);

  const values = vi.fn().mockResolvedValue([]);
  const insert = vi.fn().mockReturnValue({ values });

  return {
    select,
    _selectFrom: selectFrom,
    _selectWhere: selectWhere,
    _orderBy: orderBy,
    _limitFrom: limitFrom,
    _limitWhere: limitWhere,
    _limit: limit,
    delete: vi.fn().mockReturnValue({ where: deleteWhere }),
    _deleteWhere: deleteWhere,
    insert,
    _values: values,
  };
}

describe('KoreaderChapterExtractorService', () => {
  let db: ReturnType<typeof makeDb>;
  let service: KoreaderChapterExtractorService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    service = new KoreaderChapterExtractorService(db as never);
  });

  describe('getStoredChapters', () => {
    it('queries bookFileChapters ordered by chapterIndex and returns rows', async () => {
      const rows = [
        { index: 0, href: 'ch1.xhtml', title: 'Chapter 1' },
        { index: 1, href: 'ch2.xhtml', title: 'Chapter 2' },
      ];
      db._orderBy.mockResolvedValue(rows);

      const result = await service.getStoredChapters(42);

      expect(result).toEqual(rows);
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(db._orderBy).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no chapters exist', async () => {
      db._orderBy.mockResolvedValue([]);

      const result = await service.getStoredChapters(99);

      expect(result).toEqual([]);
    });
  });

  describe('invalidateChapters', () => {
    it('calls db.delete().where() and resolves', async () => {
      await service.invalidateChapters(7);

      expect(db.delete).toHaveBeenCalledTimes(1);
      expect(db._deleteWhere).toHaveBeenCalledTimes(1);
    });
  });

  describe('extractAndStoreChapters', () => {
    it('returns [] when file is not found', async () => {
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await service.extractAndStoreChapters(1);

      expect(result).toEqual([]);
    });

    it('returns [] when file format is not epub', async () => {
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ absolutePath: '/books/book.pdf', format: 'pdf' }]),
          }),
        }),
      });

      const result = await service.extractAndStoreChapters(2);

      expect(result).toEqual([]);
    });

    it('returns getStoredChapters result when extraction is already in progress', async () => {
      const storedChapters = [{ index: 0, href: 'ch1.xhtml', title: 'Intro' }];

      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ absolutePath: '/books/book.epub', format: 'epub' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(storedChapters),
            }),
          }),
        });

      (service as never)['extractionInProgress'].add(5);

      const result = await service.extractAndStoreChapters(5);

      expect(result).toEqual(storedChapters);

      (service as never)['extractionInProgress'].delete(5);
    });

    it('returns getStoredChapters when chapters already exist in DB', async () => {
      const storedChapters = [{ index: 0, href: 'oebps/ch1.xhtml', title: 'Chapter 1' }];

      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ absolutePath: '/books/book.epub', format: 'epub' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ chapterIndex: 0 }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(storedChapters),
            }),
          }),
        });

      const result = await service.extractAndStoreChapters(10);

      expect(result).toEqual(storedChapters);
    });

    it('returns [] and logs warning when extractChaptersFromEpub throws', async () => {
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ absolutePath: '/books/book.epub', format: 'epub' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

      vi.spyOn(service as never, 'extractChaptersFromEpub').mockRejectedValue(new Error('zip read failed'));

      const result = await service.extractAndStoreChapters(20);

      expect(result).toEqual([]);
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    });

    it('clears extractionInProgress after an error', async () => {
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ absolutePath: '/books/book.epub', format: 'epub' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

      vi.spyOn(service as never, 'extractChaptersFromEpub').mockRejectedValue(new Error('bad zip'));

      await service.extractAndStoreChapters(30);

      expect((service as never)['extractionInProgress'].has(30)).toBe(false);
    });

    it('inserts chapters and returns them on successful extraction', async () => {
      const extractedChapters = [
        { index: 0, href: 'oebps/ch1.xhtml', title: 'Chapter 1' },
        { index: 1, href: 'oebps/ch2.xhtml', title: 'Chapter 2' },
      ];

      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ absolutePath: '/books/book.epub', format: 'epub' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

      vi.spyOn(service as never, 'extractChaptersFromEpub').mockResolvedValue(extractedChapters);

      const result = await service.extractAndStoreChapters(50);

      expect(result).toEqual(extractedChapters);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db._values).toHaveBeenCalledWith([
        { bookFileId: 50, chapterIndex: 0, href: 'oebps/ch1.xhtml', title: 'Chapter 1' },
        { bookFileId: 50, chapterIndex: 1, href: 'oebps/ch2.xhtml', title: 'Chapter 2' },
      ]);
    });

    it('skips insert when extraction returns empty array', async () => {
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ absolutePath: '/books/empty.epub', format: 'epub' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

      vi.spyOn(service as never, 'extractChaptersFromEpub').mockResolvedValue([]);

      const result = await service.extractAndStoreChapters(60);

      expect(result).toEqual([]);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('clears extractionInProgress after successful extraction', async () => {
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ absolutePath: '/books/book.epub', format: 'epub' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

      vi.spyOn(service as never, 'extractChaptersFromEpub').mockResolvedValue([]);

      await service.extractAndStoreChapters(70);

      expect((service as never)['extractionInProgress'].has(70)).toBe(false);
    });
  });
});
