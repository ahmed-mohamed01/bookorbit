import { PgDialect } from 'drizzle-orm/pg-core';

import { EditionLinkProgressService } from './edition-link-progress.service';

describe('EditionLinkProgressService', () => {
  it('returns both link directions keyed by the book whose card is being rendered', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        { bookId: 10, percentage: 62, at: new Date('2026-01-03T00:00:00.000Z') },
        { bookId: 20, percentage: 33, at: new Date('2026-01-04T00:00:00.000Z') },
      ],
    });
    const service = new EditionLinkProgressService({ execute } as never);

    const result = await service.findProgressForBooks(7, [10, 20]);

    expect(result.get(10)).toEqual({ percentage: 62, updatedAt: new Date('2026-01-03T00:00:00.000Z') });
    expect(result.get(20)).toEqual({ percentage: 33, updatedAt: new Date('2026-01-04T00:00:00.000Z') });

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain('book_edition_links');
    expect(query.sql).toContain('union all');
    expect(query.params).toContain(7);
  });

  it('normalizes the string timestamps raw execute() returns into Dates', async () => {
    // Raw execute() bypasses drizzle's column mapping, so timestamps arrive as strings at runtime.
    const execute = vi.fn().mockResolvedValue({ rows: [{ bookId: 10, percentage: 62, at: '2026-01-03 00:00:00.000+00' }] });
    const service = new EditionLinkProgressService({ execute } as never);

    const result = await service.findProgressForBooks(7, [10]);

    expect(result.get(10)?.updatedAt).toEqual(new Date('2026-01-03T00:00:00.000Z'));
  });

  it('skips the query entirely when no book ids are requested', async () => {
    const execute = vi.fn();
    const service = new EditionLinkProgressService({ execute } as never);

    await expect(service.findProgressForBooks(7, [])).resolves.toEqual(new Map());
    expect(execute).not.toHaveBeenCalled();
  });

  it('finds the audiobook and read-along linked with either book, and nothing without a read-along', async () => {
    const limit = vi
      .fn()
      .mockResolvedValueOnce([{ audioBookId: 5, readAlongBookId: 9 }])
      .mockResolvedValueOnce([]);
    const chain = { from: vi.fn(), where: vi.fn(), limit };
    chain.from.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    const service = new EditionLinkProgressService({ select: vi.fn().mockReturnValue(chain) } as never);

    await expect(service.findReadAlongLink(9)).resolves.toEqual({ audioBookId: 5, readAlongBookId: 9 });
    await expect(service.findReadAlongLink(5)).resolves.toBeNull();

    const query = new PgDialect().sqlToQuery(chain.where.mock.calls[0]![0]);
    expect(query.sql).toContain('"read_along_book_id" is not null');
    expect(query.params).toEqual([9, 9]);
  });
  describe('resolveScope', () => {
    function makeScopeService(rows: unknown[]) {
      const limit = vi.fn().mockResolvedValue(rows);
      const chain = { from: vi.fn(), where: vi.fn(), limit };
      chain.from.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      return { service: new EditionLinkProgressService({ select: vi.fn().mockReturnValue(chain) } as never), chain };
    }

    it('returns every member of the link, the read-along copy included', async () => {
      const { service, chain } = makeScopeService([{ textBookId: 10, audioBookId: 20, readAlongBookId: 30 }]);

      await expect(service.resolveScope(20)).resolves.toEqual([
        { bookId: 10, role: 'text' },
        { bookId: 20, role: 'audio' },
        { bookId: 30, role: 'readAlong' },
      ]);

      const query = new PgDialect().sqlToQuery(chain.where.mock.calls[0]![0]);
      expect(query.sql).toContain('"text_book_id"');
      expect(query.sql).toContain('"read_along_book_id"');
      expect(query.params).toEqual([20, 20, 20]);
    });

    it('returns the text and audio members when the link has no read-along copy', async () => {
      const { service } = makeScopeService([{ textBookId: 10, audioBookId: 20, readAlongBookId: null }]);

      await expect(service.resolveScope(10)).resolves.toEqual([
        { bookId: 10, role: 'text' },
        { bookId: 20, role: 'audio' },
      ]);
    });

    it('returns null when the book is not linked', async () => {
      const { service } = makeScopeService([]);

      await expect(service.resolveScope(10)).resolves.toBeNull();
    });
  });
});
