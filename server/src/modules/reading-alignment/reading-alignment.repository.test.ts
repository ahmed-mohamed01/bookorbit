import { PgDialect } from 'drizzle-orm/pg-core';

import { ReadingAlignmentRepository } from './reading-alignment.repository';

// compareAudioPlayOrder moved to ../../common/utils/audio-play-order.utils.ts (shared with the
// Storyteller module); its unit tests moved with it.

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
