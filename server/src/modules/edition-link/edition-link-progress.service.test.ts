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
});
