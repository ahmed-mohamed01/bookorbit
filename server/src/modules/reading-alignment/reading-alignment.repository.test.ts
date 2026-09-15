import { PgDialect } from 'drizzle-orm/pg-core';

import { ReadingAlignmentRepository, compareAudioPlayOrder } from './reading-alignment.repository';

function audioRow(sortOrder: number | null, absolutePath: string) {
  return { sortOrder, absolutePath };
}

function makeSelectDb(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  return { select: vi.fn().mockReturnValue({ from }) };
}

function makeInsertDb(returned: unknown[]) {
  const returning = vi.fn().mockResolvedValue(returned);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  return { db: { insert: vi.fn().mockReturnValue({ values }) }, values, onConflictDoUpdate };
}

describe('compareAudioPlayOrder', () => {
  it('orders by sortOrder and pushes a null sortOrder last', () => {
    const files = [audioRow(null, '/books/zz.mp3'), audioRow(2, '/books/b.mp3'), audioRow(1, '/books/a.mp3')];

    expect(files.sort(compareAudioPlayOrder).map((file) => file.absolutePath)).toEqual(['/books/a.mp3', '/books/b.mp3', '/books/zz.mp3']);
  });

  it('falls back to natural filename order when every sortOrder is null', () => {
    const files = [audioRow(null, '/books/track-10.mp3'), audioRow(null, '/books/track-2.mp3'), audioRow(null, '/books/track-1.mp3')];

    expect(files.sort(compareAudioPlayOrder).map((file) => file.absolutePath)).toEqual([
      '/books/track-1.mp3',
      '/books/track-2.mp3',
      '/books/track-10.mp3',
    ]);
  });

  it('compares basenames rather than whole paths', () => {
    expect(compareAudioPlayOrder(audioRow(null, '/zzz/track-2.mp3'), audioRow(null, '/aaa/track-10.mp3'))).toBeLessThan(0);
  });

  it('is stable for files that tie on both keys', () => {
    const first = audioRow(1, '/books/disc-1/track-1.mp3');
    const second = audioRow(1, '/books/disc-2/track-1.mp3');

    expect(compareAudioPlayOrder(first, second)).toBe(0);
    expect([first, second].sort(compareAudioPlayOrder)).toEqual([first, second]);
  });
});

describe('ReadingAlignmentRepository.resolveAudioPlayOrder', () => {
  it('drops non-audio files and returns the rest in manifest play order', async () => {
    const db = makeSelectDb([
      { id: 3, format: 'mp3', absolutePath: '/books/track-10.mp3', sortOrder: null, durationSeconds: 30 },
      { id: 1, format: 'epub', absolutePath: '/books/book.epub', sortOrder: null, durationSeconds: null },
      { id: 2, format: 'mp3', absolutePath: '/books/track-2.mp3', sortOrder: null, durationSeconds: 20 },
    ]);
    const repo = new ReadingAlignmentRepository(db as never);

    await expect(repo.resolveAudioPlayOrder(42)).resolves.toEqual([
      { fileId: 2, durationSeconds: 20 },
      { fileId: 3, durationSeconds: 30 },
    ]);
  });
});

describe('ReadingAlignmentRepository.projectAudiobookProgress', () => {
  const updatedAt = new Date('2026-02-01T00:00:00.000Z');

  it('bumps the revision and stamps capturedAt so a stale web player conflicts', async () => {
    const { db, values, onConflictDoUpdate } = makeInsertDb([{ userId: 7 }]);
    const repo = new ReadingAlignmentRepository(db as never);

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
    const repo = new ReadingAlignmentRepository(db as never);

    await expect(repo.projectAudiobookProgress(7, 42, 900, 12.5, 30, updatedAt)).resolves.toBe(false);
  });
});
