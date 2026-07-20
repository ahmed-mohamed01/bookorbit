import type { ReadingAttemptOrigin, ReadingAttemptOutcome } from '@bookorbit/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadingAttemptService } from '../user-book-status/reading-attempt.service';

type Row = {
  id: number;
  userId: number;
  bookId: number;
  startedOn: string | null;
  endedOn: string | null;
  outcome: ReadingAttemptOutcome | null;
  origin: ReadingAttemptOrigin;
  externalProvider: string | null;
  externalId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeFakeRepo() {
  const rows: Row[] = [];
  let nextId = 1;
  const repo = {
    transaction: vi.fn((callback: (tx: object) => Promise<unknown>) => callback({})),
    findByExternal: vi.fn((_tx: object, userId: number, provider: string, externalId: string) =>
      Promise.resolve(rows.find((row) => row.userId === userId && row.externalProvider === provider && row.externalId === externalId)),
    ),
    findActive: vi.fn((_tx: object, userId: number, bookId: number) =>
      Promise.resolve(rows.find((row) => row.userId === userId && row.bookId === bookId && row.outcome === null && row.deletedAt === null)),
    ),
    create: vi.fn(
      (
        _tx: object,
        values: Omit<Row, 'id' | 'deletedAt' | 'createdAt' | 'updatedAt' | 'externalProvider' | 'externalId'> & {
          externalProvider?: string | null;
          externalId?: string | null;
        },
      ) => {
        const now = new Date('2026-07-12T12:00:00.000Z');
        const row: Row = {
          ...values,
          id: nextId++,
          externalProvider: values.externalProvider ?? null,
          externalId: values.externalId ?? null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(row);
        return Promise.resolve(row);
      },
    ),
    createActive: vi.fn(
      (
        tx: object,
        values: Omit<Row, 'id' | 'deletedAt' | 'createdAt' | 'updatedAt' | 'externalProvider' | 'externalId' | 'endedOn' | 'outcome'> & {
          externalProvider?: string | null;
          externalId?: string | null;
        },
      ) => repo.create(tx, { ...values, endedOn: null, outcome: null }),
    ),
    update: vi.fn((_tx: object, userId: number, bookId: number, id: number, patch: Partial<Row>) => {
      const row = rows.find((item) => item.id === id && item.userId === userId && item.bookId === bookId && item.deletedAt === null);
      if (!row) return Promise.resolve(null);
      Object.assign(row, patch, { updatedAt: new Date('2026-07-12T12:00:00.000Z') });
      return Promise.resolve(row);
    }),
  };
  return { repo, rows };
}

describe('Audiobookshelf reading-attempt imports', () => {
  let fake: ReturnType<typeof makeFakeRepo>;
  let service: ReadingAttemptService;

  beforeEach(() => {
    fake = makeFakeRepo();
    service = new ReadingAttemptService(fake.repo as never);
  });

  it('stamps origin and provider identity on a completed Audiobookshelf import', async () => {
    await service.importExternalRead(1, 10, {
      provider: 'audiobookshelf',
      externalId: 'abs-item-1',
      startedOn: '2025-03-01',
      endedOn: '2025-03-05',
    });

    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({
      startedOn: '2025-03-01',
      endedOn: '2025-03-05',
      outcome: 'completed',
      origin: 'audiobookshelf',
      externalProvider: 'audiobookshelf',
      externalId: 'abs-item-1',
    });
  });

  it('opens an active Audiobookshelf attempt with Audiobookshelf identity when unfinished', async () => {
    await service.importExternalRead(1, 10, {
      provider: 'audiobookshelf',
      externalId: 'abs-item-2',
      startedOn: '2025-04-01',
      endedOn: null,
    });

    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({
      startedOn: '2025-04-01',
      endedOn: null,
      outcome: null,
      origin: 'audiobookshelf',
      externalProvider: 'audiobookshelf',
      externalId: 'abs-item-2',
    });
  });

  it('adopts and closes a local active attempt when a finished Audiobookshelf import arrives', async () => {
    const active = await fake.repo.create(
      {},
      {
        userId: 1,
        bookId: 10,
        startedOn: '2025-05-01',
        endedOn: null,
        outcome: null,
        origin: 'bookorbit',
      },
    );

    await service.importExternalRead(1, 10, {
      provider: 'audiobookshelf',
      externalId: 'abs-item-h5',
      startedOn: '2025-05-02',
      endedOn: '2025-05-10',
    });

    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({
      id: active.id,
      startedOn: '2025-05-01',
      endedOn: '2025-05-10',
      outcome: 'completed',
      origin: 'bookorbit',
      externalProvider: 'audiobookshelf',
      externalId: 'abs-item-h5',
    });
    expect(fake.repo.create).toHaveBeenCalledTimes(1);
    expect(fake.repo.update).toHaveBeenCalledWith(
      expect.anything(),
      1,
      10,
      active.id,
      expect.objectContaining({
        endedOn: '2025-05-10',
        outcome: 'completed',
        externalProvider: 'audiobookshelf',
        externalId: 'abs-item-h5',
      }),
    );
  });
});
