import { PgDialect } from 'drizzle-orm/pg-core';

import { ReadingAlignmentRepository } from './reading-alignment.repository';

function makeInsertDb(returned: unknown[]) {
  const returning = vi.fn().mockResolvedValue(returned);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  return { db: { insert: vi.fn().mockReturnValue({ values }) }, values, onConflictDoUpdate };
}

describe('ReadingAlignmentRepository.projectAudiobookProgress', () => {
  const updatedAt = new Date('2026-02-01T00:00:00.000Z');

  it('bumps the revision and stamps capturedAt so a stale web player conflicts', async () => {
    const { db, values, onConflictDoUpdate } = makeInsertDb([{ userId: 7 }]);
    const repo = new ReadingAlignmentRepository(db as never, {} as never);

    await expect(repo.projectAudiobookProgress(7, 42, 900, 12.5, 30, updatedAt)).resolves.toBe(true);

    expect(values).toHaveBeenCalledWith({
      userId: 7,
      bookId: 42,
      currentFileId: 900,
      positionSeconds: 12.5,
      percentage: 30,
      capturedAt: updatedAt,
      updatedAt,
    });

    const conflict = onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.set).toMatchObject({ currentFileId: 900, positionSeconds: 12.5, percentage: 30, capturedAt: updatedAt, updatedAt });
    expect(new PgDialect().sqlToQuery(conflict.set.revision).sql).toBe('"audiobook_progress"."revision" + 1');
    // The newest-wins guard must survive the revision bump: a stale projection still loses the race.
    expect(new PgDialect().sqlToQuery(conflict.setWhere).sql).toContain('"updated_at" <');
  });

  it('reports a lost newest-wins race as not applied', async () => {
    const { db } = makeInsertDb([]);
    const repo = new ReadingAlignmentRepository(db as never, {} as never);

    await expect(repo.projectAudiobookProgress(7, 42, 900, 12.5, 30, updatedAt)).resolves.toBe(false);
  });
});

describe('ReadingAlignmentRepository.projectReadingProgress', () => {
  const projectedAt = new Date('2026-02-01T00:00:00.000Z');

  it('inserts a projection with equal timestamps and updates only the percentage and projection time', async () => {
    const { db, values, onConflictDoUpdate } = makeInsertDb([{ userId: 7 }]);
    const repo = new ReadingAlignmentRepository(db as never, {} as never);

    await expect(repo.projectReadingProgress(7, 500, 42.5, projectedAt)).resolves.toBe(true);

    expect(values).toHaveBeenCalledWith({
      userId: 7,
      bookFileId: 500,
      percentage: 42.5,
      cfi: null,
      updatedAt: projectedAt,
      lastReadAt: projectedAt,
      alignmentProjectedAt: projectedAt,
    });

    const conflict = onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.set).toEqual({ percentage: 42.5, alignmentProjectedAt: projectedAt });
    const guard = new PgDialect().sqlToQuery(conflict.setWhere);
    expect(guard.sql).toBe(
      '("reading_progress"."last_read_at" < $1 and ("reading_progress"."alignment_projected_at" is null or "reading_progress"."alignment_projected_at" < $2))',
    );
  });

  it('clamps the percentage to the column CHECK range', async () => {
    const { db, values } = makeInsertDb([{ userId: 7 }]);
    const repo = new ReadingAlignmentRepository(db as never, {} as never);

    await repo.projectReadingProgress(7, 500, 104, projectedAt);

    expect(values.mock.calls[0]![0]).toMatchObject({ percentage: 100 });
  });

  it('reports a guarded no-op as not applied', async () => {
    const { db } = makeInsertDb([]);
    const repo = new ReadingAlignmentRepository(db as never, {} as never);

    await expect(repo.projectReadingProgress(7, 500, 42.5, projectedAt)).resolves.toBe(false);
  });
});

describe('ReadingAlignmentRepository.deleteAlignment', () => {
  function makeDeleteDb(returned: unknown[]) {
    const returning = vi.fn().mockResolvedValue(returned);
    const where = vi.fn().mockReturnValue({ returning });
    return { db: { delete: vi.fn().mockReturnValue({ where }) }, where };
  }

  it('deletes only an unfinished alignment by id and reports that it was there', async () => {
    const { db, where } = makeDeleteDb([{ id: 4 }]);
    const repo = new ReadingAlignmentRepository(db as never, {} as never);

    await expect(repo.deleteAlignment(4)).resolves.toBe(true);

    const predicate = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
    expect(predicate.sql).toBe('("audiobook_alignment"."id" = $1 and "audiobook_alignment"."status" in ($2, $3))');
    expect(predicate.params).toEqual([4, 'pending', 'building']);
  });

  it('reports false when no unfinished alignment had that id (a ready one is kept)', async () => {
    const { db } = makeDeleteDb([]);
    const repo = new ReadingAlignmentRepository(db as never, {} as never);

    await expect(repo.deleteAlignment(99)).resolves.toBe(false);
  });
});

describe('ReadingAlignmentRepository.findEbookFile', () => {
  it('excludes media-overlay EPUBs before selecting the first plain content EPUB', async () => {
    const plain = { id: 20, absolutePath: '/books/plain.epub', sizeBytes: 200 };
    const limit = vi.fn().mockResolvedValue([plain]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const repo = new ReadingAlignmentRepository({ select: vi.fn().mockReturnValue({ from }) } as never);

    await expect(repo.findEbookFile(11)).resolves.toEqual(plain);

    const predicate = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
    expect(predicate.sql).toContain('"book_files"."media_overlay_available" = $4');
    expect(predicate.params).toEqual([11, 'content', 'epub', false]);
    expect(orderBy).toHaveBeenCalledOnce();
    expect(limit).toHaveBeenCalledWith(1);
  });
});

describe('ReadingAlignmentRepository.hasReadAlong', () => {
  function makeSelectDb(result: unknown[]) {
    const wheres: unknown[] = [];
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: (predicate: unknown) => {
          wheres.push(predicate);
          return { limit: vi.fn().mockResolvedValue(result) };
        },
      }),
    }));
    return { db: { select }, select, wheres };
  }

  it('is false without a media-overlay EPUB', async () => {
    const { db, select, wheres } = makeSelectDb([]);
    const repo = new ReadingAlignmentRepository(db as never, {} as never);

    await expect(repo.hasReadAlong(11)).resolves.toBe(false);

    expect(select).toHaveBeenCalledOnce();
    const predicate = new PgDialect().sqlToQuery(wheres[0] as never);
    expect(predicate.sql).toContain('"book_files"."media_overlay_available" = $3');
    expect(predicate.params).toEqual([11, 'epub', true]);
  });

  it('is true for a book holding a read-along, whatever its read-aloud sync mode', async () => {
    const { db, select } = makeSelectDb([{ id: 30 }]);
    const repo = new ReadingAlignmentRepository(db as never, {} as never);

    await expect(repo.hasReadAlong(11)).resolves.toBe(true);
    expect(select).toHaveBeenCalledOnce();
  });
});
