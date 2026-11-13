import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingAttemptService } from './reading-attempt.service';
import { ReadingAttemptEventsService } from './reading-attempt-events.service';
import { makeFakeRepo } from '../../../test/helpers/reading-attempt-repository.fake';

describe('ReadingAttemptService', () => {
  let fake: ReturnType<typeof makeFakeRepo>;
  let service: ReadingAttemptService;

  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    fake = makeFakeRepo();
    service = new ReadingAttemptService(fake.repo as never, new ReadingAttemptEventsService());
  });

  it('creates a placeholder completion before a legacy manual reread', async () => {
    const result = await service.applyManualStatus(1, 10, 'rereading', undefined, undefined, '2026-07-12');

    expect(fake.rows).toHaveLength(2);
    expect(fake.rows[0]).toMatchObject({ outcome: 'completed', startedOn: null, endedOn: null, origin: 'migration' });
    expect(fake.rows[1]).toMatchObject({ outcome: null, startedOn: '2026-07-12', origin: 'manual' });
    expect(result.status).toBe('rereading');
  });

  it('does not create a reread from weak activity after completion', async () => {
    await fake.repo.create(
      {},
      {
        userId: 1,
        bookId: 10,
        startedOn: '2025-01-01',
        endedOn: '2025-01-10',
        outcome: 'completed',
        origin: 'manual',
      },
    );

    await expect(
      service.recordActivity({
        userId: 1,
        bookId: 10,
        occurredOn: '2026-07-12',
        origin: 'kobo',
        progress: 25,
        finishThreshold: 98,
        strongRereadEvidence: false,
        meaningfulActivity: false,
      }),
    ).resolves.toBeNull();
    expect(fake.rows).toHaveLength(1);
  });

  describe('sessions a device delivers after its finished state closed the read', () => {
    const lateActivity = (occurredOn: string, progress = 64, strongRereadEvidence = false) =>
      service.recordActivity({
        userId: 1,
        bookId: 10,
        occurredOn,
        origin: 'bookorbit',
        progress,
        finishThreshold: 98,
        strongRereadEvidence,
        meaningfulActivity: true,
        timeZone: 'America/Chicago',
      });
    const finished = (startedOn: string | null) =>
      fake.repo.create({}, { userId: 1, bookId: 10, startedOn, endedOn: '2026-10-17', outcome: 'completed', origin: 'kobo' });

    it('files a session from within the read into it instead of opening another', async () => {
      const read = await finished('2026-10-11');

      await expect(lateActivity('2026-10-16')).resolves.toBeNull();

      expect(fake.rows).toHaveLength(1);
      expect(fake.repo.attachBackfilledSessions).toHaveBeenCalledWith({}, 1, 10, read.id, 'America/Chicago', '2026-10-11', '2026-10-17');
    });

    it('does not open a second completed read when the late session is already at the finish', async () => {
      await finished('2026-10-11');

      await expect(lateActivity('2026-10-17', 100)).resolves.toBeNull();

      expect(fake.rows).toHaveLength(1);
    });

    it('bounds the files it adopts by the late session itself when the read has no start', async () => {
      const read = await finished(null);

      await lateActivity('2026-10-16');

      expect(fake.repo.attachBackfilledSessions).toHaveBeenCalledWith({}, 1, 10, read.id, 'America/Chicago', '2026-10-16', '2026-10-17');
    });

    it('leaves a session from before the read began unassigned without opening a read', async () => {
      await finished('2026-10-11');

      await expect(lateActivity('2026-10-02')).resolves.toBeNull();

      expect(fake.rows).toHaveLength(1);
      expect(fake.repo.attachBackfilledSessions).not.toHaveBeenCalled();
    });

    it('still opens a reread from activity after the finish day', async () => {
      await finished('2026-10-11');

      await expect(lateActivity('2026-10-18')).resolves.toMatchObject({ status: 'rereading' });
      expect(fake.rows).toHaveLength(2);
    });
  });

  it('opens a reread from a strong Kobo transition', async () => {
    await fake.repo.create(
      {},
      {
        userId: 1,
        bookId: 10,
        startedOn: '2025-01-01',
        endedOn: '2025-01-10',
        outcome: 'completed',
        origin: 'manual',
      },
    );

    const result = await service.recordActivity({
      userId: 1,
      bookId: 10,
      occurredOn: '2026-07-12',
      origin: 'kobo',
      progress: 25,
      finishThreshold: 98,
      strongRereadEvidence: true,
      meaningfulActivity: false,
    });

    expect(result?.status).toBe('rereading');
    expect(fake.rows[1]).toMatchObject({ startedOn: '2026-07-12', outcome: null, origin: 'kobo' });
    expect(fake.projections.at(-1)?.status).toBe('rereading');
  });

  it('records a same-day completion when a strong reread signal first arrives at the finish threshold', async () => {
    await fake.repo.create(
      {},
      {
        userId: 1,
        bookId: 10,
        startedOn: '2025-01-01',
        endedOn: '2025-01-10',
        outcome: 'completed',
        origin: 'manual',
      },
    );

    const result = await service.recordActivity({
      userId: 1,
      bookId: 10,
      occurredOn: '2026-07-12',
      origin: 'kobo',
      progress: 99,
      finishThreshold: 98,
      strongRereadEvidence: true,
      meaningfulActivity: false,
    });

    expect(result?.status).toBe('read');
    expect(fake.rows).toHaveLength(2);
    expect(fake.rows[1]).toMatchObject({ startedOn: '2026-07-12', endedOn: '2026-07-12', outcome: 'completed' });
  });

  it('completes the active attempt without creating a duplicate', async () => {
    await fake.repo.create(
      {},
      {
        userId: 1,
        bookId: 10,
        startedOn: '2026-07-01',
        endedOn: null,
        outcome: null,
        origin: 'bookorbit',
      },
    );

    const result = await service.recordActivity({
      userId: 1,
      bookId: 10,
      occurredOn: '2026-07-12',
      origin: 'bookorbit',
      progress: 99,
      finishThreshold: 98,
      strongRereadEvidence: false,
      meaningfulActivity: true,
    });

    expect(result?.status).toBe('read');
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({ outcome: 'completed', endedOn: '2026-07-12' });
  });

  it.each([
    { progress: 99.94, expectedStatus: 'reading', expectedOutcome: null },
    { progress: Math.fround(99.95), expectedStatus: 'read', expectedOutcome: 'completed' },
  ])('uses a fractional finish threshold at $progress% progress', async ({ progress, expectedStatus, expectedOutcome }) => {
    const result = await service.recordActivity({
      userId: 1,
      bookId: 10,
      occurredOn: '2026-07-12',
      origin: 'bookorbit',
      progress,
      finishThreshold: 99.95,
      strongRereadEvidence: false,
      meaningfulActivity: true,
    });

    expect(result?.status).toBe(expectedStatus);
    expect(fake.rows[0]?.outcome).toBe(expectedOutcome);
  });

  it('keeps repeated manual read operations idempotent', async () => {
    const first = await service.applyManualStatus(1, 10, 'read', '2026-01-01', '2026-01-10', '2026-07-12');
    const second = await service.applyManualStatus(1, 10, 'read', undefined, undefined, '2026-07-12');
    expect(fake.rows).toHaveLength(1);
    expect(first.status).toBe('read');
    expect(second.status).toBe('read');
  });

  describe('manual lifecycle dates without an explicit status', () => {
    it.each(['unread', 'want_to_read'] as const)('opens a reading attempt when a start date is set from %s', async (status) => {
      const result = await service.applyManualStatus(1, 10, status, '2026-01-10', undefined, '2026-07-12', {
        statusWasExplicit: false,
      });

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-01-10', endedOn: null, outcome: null, origin: 'manual' });
      expect(result).toMatchObject({ status: 'reading', startedAt: '2026-01-10', finishedAt: null });
      expect(fake.projections.at(-1)).toMatchObject({ status: 'reading', startedAt: new Date('2026-01-10T00:00:00.000Z'), finishedAt: null });
    });

    it('creates a completed attempt when both dates are set on an unread book', async () => {
      const result = await service.applyManualStatus(1, 10, 'unread', '2026-01-10', '2026-02-01', '2026-07-12', {
        statusWasExplicit: false,
      });

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-01-10', endedOn: '2026-02-01', outcome: 'completed', origin: 'manual' });
      expect(result).toMatchObject({ status: 'read', startedAt: '2026-01-10', finishedAt: '2026-02-01' });
    });

    it('creates a completed attempt with an unknown start when only a finish date is set', async () => {
      const result = await service.applyManualStatus(1, 10, 'unread', undefined, '2026-02-01', '2026-07-12', {
        statusWasExplicit: false,
      });

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ startedOn: null, endedOn: '2026-02-01', outcome: 'completed' });
      expect(result).toMatchObject({ status: 'read', startedAt: null, finishedAt: '2026-02-01' });
    });

    it.each(['reading', 'rereading', 'on_hold'] as const)('completes an active %s attempt when a finish date is set', async (status) => {
      if (status === 'rereading') {
        await fake.repo.create(
          {},
          {
            userId: 1,
            bookId: 10,
            startedOn: '2025-01-01',
            endedOn: '2025-01-10',
            outcome: 'completed',
            origin: 'manual',
          },
        );
      }
      await fake.repo.createActive({}, { userId: 1, bookId: 10, startedOn: '2026-01-10', origin: 'manual' });

      const result = await service.applyManualStatus(1, 10, status, undefined, '2026-02-01', '2026-07-12', {
        statusWasExplicit: false,
      });

      expect(fake.rows.at(-1)).toMatchObject({ startedOn: '2026-01-10', endedOn: '2026-02-01', outcome: 'completed' });
      expect(result).toMatchObject({ status: 'read', startedAt: '2026-01-10', finishedAt: '2026-02-01' });
      expect(fake.projections.at(-1)?.status).toBe('read');
    });

    it('clears a completed attempt finish date without reopening it', async () => {
      await fake.repo.create(
        {},
        {
          userId: 1,
          bookId: 10,
          startedOn: '2026-01-10',
          endedOn: '2026-02-01',
          outcome: 'completed',
          origin: 'manual',
        },
      );

      const result = await service.applyManualStatus(1, 10, 'read', undefined, null, '2026-07-12', {
        statusWasExplicit: false,
      });

      expect(fake.rows[0]).toMatchObject({ endedOn: null, outcome: 'completed' });
      expect(result).toMatchObject({ status: 'read', startedAt: '2026-01-10', finishedAt: null });
      expect(fake.rows.filter((row) => row.outcome === null)).toHaveLength(0);
    });

    it('edits the start date of the latest completed attempt without reopening it', async () => {
      await fake.repo.create(
        {},
        {
          userId: 1,
          bookId: 10,
          startedOn: '2026-01-10',
          endedOn: '2026-02-01',
          outcome: 'completed',
          origin: 'manual',
        },
      );

      const result = await service.applyManualStatus(1, 10, 'read', '2026-01-05', undefined, '2026-07-12', {
        statusWasExplicit: false,
      });

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-01-05', endedOn: '2026-02-01', outcome: 'completed' });
      expect(result).toMatchObject({ status: 'read', startedAt: '2026-01-05', finishedAt: '2026-02-01' });
    });

    it('treats clearing absent dates without an attempt as a no-op', async () => {
      const result = await service.applyManualStatus(1, 10, 'unread', null, null, '2026-07-12', {
        statusWasExplicit: false,
      });

      expect(fake.rows).toHaveLength(0);
      expect(fake.repo.create).not.toHaveBeenCalled();
      expect(fake.repo.createActive).not.toHaveBeenCalled();
      expect(fake.repo.update).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'unread', startedAt: null, finishedAt: null });
    });

    it('validates the resolved attempt before changing an existing date', async () => {
      await fake.repo.create(
        {},
        {
          userId: 1,
          bookId: 10,
          startedOn: '2026-01-10',
          endedOn: '2026-02-01',
          outcome: 'completed',
          origin: 'manual',
        },
      );

      await expect(
        service.applyManualStatus(1, 10, 'read', '2026-02-02', undefined, '2026-07-12', { statusWasExplicit: false }),
      ).rejects.toMatchObject({ response: { errorCode: 'READING_DATES_INVALID_ORDER' } });
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-01-10', endedOn: '2026-02-01', outcome: 'completed' });
      expect(fake.repo.update).not.toHaveBeenCalled();
    });

    it('rejects an explicit active status combined with a finish date before writing', async () => {
      await expect(service.applyManualStatus(1, 10, 'reading', '2026-01-10', '2026-02-01', '2026-07-12')).rejects.toMatchObject({
        response: { errorCode: 'READING_DATES_STATUS_CONFLICT' },
      });

      expect(fake.rows).toHaveLength(0);
    });

    it('creates one completed attempt for an explicit read status with both dates', async () => {
      const result = await service.applyManualStatus(1, 10, 'read', '2026-01-10', '2026-02-01', '2026-07-12');

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-01-10', endedOn: '2026-02-01', outcome: 'completed' });
      expect(result).toMatchObject({ status: 'read', startedAt: '2026-01-10', finishedAt: '2026-02-01' });
    });

    it('completes an abandoned attempt when a finish date is set', async () => {
      await fake.repo.create({}, { userId: 1, bookId: 10, startedOn: '2026-01-10', endedOn: '2026-01-20', outcome: 'abandoned', origin: 'manual' });

      const result = await service.applyManualStatus(1, 10, 'abandoned', undefined, '2026-02-01', '2026-07-12', {
        statusWasExplicit: false,
      });

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-01-10', endedOn: '2026-02-01', outcome: 'completed' });
      expect(result).toMatchObject({ status: 'read', startedAt: '2026-01-10', finishedAt: '2026-02-01' });
    });

    it('mutates and projects in one repository transaction', async () => {
      await service.applyManualStatus(1, 10, 'unread', '2026-01-10', '2026-02-01', '2026-07-12', {
        statusWasExplicit: false,
      });

      expect(fake.repo.transaction).toHaveBeenCalledOnce();
      expect(fake.repo.create).toHaveBeenCalledWith(fake.transactionContext, expect.any(Object));
      expect(fake.repo.project).toHaveBeenCalledWith(fake.transactionContext, 1, 10, expect.objectContaining({ status: 'read' }));
    });
  });

  describe('lifecycle-clearing projections', () => {
    it.each(['unread', 'want_to_read'] as const)('keeps %s free of lifecycle dates it cannot own', async (status) => {
      await service.applyManualStatus(1, 10, 'read', '2026-01-10', '2026-02-01', '2026-07-12');

      const result = await service.applyManualStatus(1, 10, status, undefined, undefined, '2026-07-12');

      expect(result).toMatchObject({ status, startedAt: null, finishedAt: null });
      expect(fake.projections.at(-1)).toMatchObject({ status, startedAt: null, finishedAt: null });
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-01-10', endedOn: '2026-02-01', outcome: 'completed' });
    });

    it('does not project a historical attempt onto a book the reader marked unread', async () => {
      fake.repo.findStatus.mockResolvedValue({ status: 'unread' });

      await service.createHistorical(1, 10, { startedOn: '2026-01-10', endedOn: '2026-02-01', outcome: 'completed' });

      expect(fake.projections.at(-1)).toMatchObject({ status: 'unread', startedAt: null, finishedAt: null });
    });
  });

  it('edits the latest completed dates without creating another completion', async () => {
    await service.applyManualStatus(1, 10, 'read', '2026-01-01', '2026-01-10', '2026-07-12');
    const result = await service.applyManualStatus(1, 10, 'read', undefined, '2026-01-12', '2026-07-12');

    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.endedOn).toBe('2026-01-12');
    expect(result.finishedAt).toBe('2026-01-12');
  });

  it('keeps an active reread on hold without changing it to rereading', async () => {
    await service.applyManualStatus(1, 10, 'read', '2025-01-01', '2025-01-10', '2026-07-12');
    await service.applyManualStatus(1, 10, 'rereading', undefined, undefined, '2026-07-12');
    const result = await service.applyManualStatus(1, 10, 'on_hold', undefined, undefined, '2026-07-12');
    expect(result.status).toBe('on_hold');
  });

  it('rejects an end date before the start date', async () => {
    await expect(service.createHistorical(1, 10, { startedOn: '2026-07-12', endedOn: '2026-07-01', outcome: 'completed' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns not found when deleting an inaccessible attempt', async () => {
    await expect(service.delete(1, 10, 999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rebuilds the projection when Hardcover closes a reopened linked attempt', async () => {
    await fake.repo.create({}, { userId: 1, bookId: 10, startedOn: '2025-01-01', endedOn: '2025-01-10', outcome: 'completed', origin: 'manual' });
    const row = await fake.repo.createActive(
      {},
      {
        userId: 1,
        bookId: 10,
        startedOn: '2026-07-01',
        origin: 'hardcover',
        externalProvider: 'hardcover',
        externalId: '77',
      },
    );
    await fake.repo.project({}, 1, 10, { status: 'rereading', source: 'auto', startedAt: new Date('2026-07-01'), finishedAt: null });
    fake.projections.length = 0;
    await service.importExternalRead(1, 10, { provider: 'hardcover', externalId: '77', startedOn: '2026-07-01', endedOn: '2026-07-12' });
    expect(row.outcome).toBe('completed');
    expect(fake.projections).toEqual([expect.objectContaining({ status: 'read', finishedAt: new Date('2026-07-12') })]);
    fake.projections.length = 0;
    await service.importExternalRead(1, 10, { provider: 'hardcover', externalId: '77', startedOn: '2026-07-01', endedOn: '2026-07-12' });
    expect(fake.projections).toHaveLength(0);
  });

  it('does not resurrect a tombstoned Hardcover read', async () => {
    const row = await fake.repo.create(
      {},
      {
        userId: 1,
        bookId: 10,
        startedOn: '2025-01-01',
        endedOn: '2025-01-10',
        outcome: 'completed',
        origin: 'hardcover',
        externalProvider: 'hardcover',
        externalId: '77',
      },
    );
    row.deletedAt = new Date();

    await service.importExternalRead(1, 10, {
      provider: 'hardcover',
      externalId: '77',
      startedOn: '2025-01-01',
      endedOn: '2025-01-11',
    });

    expect(row.endedOn).toBe('2025-01-10');
  });

  describe('closing an attempt that a skewed device clock started in the future', () => {
    it('ends a completed attempt on its own start date instead of an earlier today', async () => {
      const active = await fake.repo.createActive({}, { userId: 1, bookId: 10, startedOn: '2026-11-01', origin: 'kobo' });

      const result = await service.applyManualStatus(1, 10, 'read', undefined, undefined, '2026-07-12');

      expect(active.endedOn).toBe('2026-11-01');
      expect(active.outcome).toBe('completed');
      expect(result.status).toBe('read');
    });

    it('ends an implicitly abandoned attempt on its own start date', async () => {
      const active = await fake.repo.createActive({}, { userId: 1, bookId: 10, startedOn: '2026-11-01', origin: 'kobo' });

      await service.applyManualStatus(1, 10, 'unread', undefined, undefined, '2026-07-12');

      expect(active.endedOn).toBe('2026-11-01');
      expect(active.outcome).toBe('abandoned');
    });

    it('ends a newly created closed attempt on its own start date', async () => {
      await service.applyManualStatus(1, 10, 'read', '2026-11-01', undefined, '2026-07-12');

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-11-01', endedOn: '2026-11-01', outcome: 'completed' });
    });

    it('ends an automatic completion on its own start date', async () => {
      const active = await fake.repo.createActive({}, { userId: 1, bookId: 10, startedOn: '2026-11-01', origin: 'kobo' });

      const result = await service.recordActivity({
        userId: 1,
        bookId: 10,
        occurredOn: '2026-07-12',
        origin: 'kobo',
        progress: 100,
        finishThreshold: 98,
        strongRereadEvidence: false,
        meaningfulActivity: true,
      });

      expect(active.endedOn).toBe('2026-11-01');
      expect(active.outcome).toBe('completed');
      expect(result?.status).toBe('read');
    });

    it('still ends on today when the attempt started in the past', async () => {
      const active = await fake.repo.createActive({}, { userId: 1, bookId: 10, startedOn: '2026-01-05', origin: 'kobo' });

      await service.applyManualStatus(1, 10, 'read', undefined, undefined, '2026-07-12');

      expect(active.endedOn).toBe('2026-07-12');
    });

    it('rejects an explicitly supplied end date before the active start date', async () => {
      const active = await fake.repo.createActive({}, { userId: 1, bookId: 10, startedOn: '2026-11-01', origin: 'kobo' });

      await expect(service.applyManualStatus(1, 10, 'read', undefined, '2026-07-12', '2026-07-12')).rejects.toBeInstanceOf(BadRequestException);

      expect(active).toMatchObject({ startedOn: '2026-11-01', endedOn: null, outcome: null });
      expect(fake.repo.update).not.toHaveBeenCalled();
    });
  });

  describe('importUnlinkedRead', () => {
    it('adopts an existing active attempt silently for an in-progress import', async () => {
      const active = await fake.repo.createActive({}, { userId: 1, bookId: 10, startedOn: '2026-01-01', origin: 'kobo' });

      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: '2026-01-05', endedOn: null });

      expect(fake.rows).toHaveLength(1);
      expect(active).toMatchObject({ startedOn: '2026-01-01', origin: 'kobo', outcome: null });
    });

    it('opens a new active attempt with no external identity when none exists', async () => {
      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: '2026-01-05', endedOn: null });

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({
        startedOn: '2026-01-05',
        endedOn: null,
        outcome: null,
        origin: 'audiobookshelf',
        externalProvider: null,
        externalId: null,
      });
    });

    it('does not resurrect a soft-deleted in-progress ABS import', async () => {
      const row = await fake.repo.create(
        {},
        { userId: 1, bookId: 10, startedOn: '2026-01-01', endedOn: null, outcome: null, origin: 'audiobookshelf' },
      );
      row.deletedAt = new Date();

      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: '2026-01-05', endedOn: null });

      expect(fake.rows).toHaveLength(1);
      expect(row.deletedAt).not.toBeNull();
    });

    it('dedupes a finished import already recorded for this origin and finish date', async () => {
      await fake.repo.create(
        {},
        {
          userId: 1,
          bookId: 10,
          startedOn: '2026-01-01',
          endedOn: '2026-01-10',
          outcome: 'completed',
          origin: 'audiobookshelf',
        },
      );

      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: '2026-01-05', endedOn: '2026-01-10' });

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-01-01', endedOn: '2026-01-10' });
    });

    it('does not resurrect a soft-deleted finished ABS tombstone with the same finish date', async () => {
      const row = await fake.repo.create(
        {},
        {
          userId: 1,
          bookId: 10,
          startedOn: '2026-01-01',
          endedOn: '2026-01-10',
          outcome: 'completed',
          origin: 'audiobookshelf',
        },
      );
      row.deletedAt = new Date();

      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: '2026-01-01', endedOn: '2026-01-10' });

      expect(fake.rows).toHaveLength(1);
      expect(row.deletedAt).not.toBeNull();
    });

    it('backfills a missing startedOn on a deduped finished import', async () => {
      await fake.repo.create(
        {},
        {
          userId: 1,
          bookId: 10,
          startedOn: null,
          endedOn: '2026-01-10',
          outcome: 'completed',
          origin: 'audiobookshelf',
        },
      );

      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: '2026-01-02', endedOn: '2026-01-10' });

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ startedOn: '2026-01-02', endedOn: '2026-01-10' });
    });

    it('closes an active attempt whose start date is on or before the ABS finish date', async () => {
      const active = await fake.repo.createActive({}, { userId: 1, bookId: 10, startedOn: '2026-01-01', origin: 'audiobookshelf' });

      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: null, endedOn: '2026-01-10' });

      expect(fake.rows).toHaveLength(1);
      expect(active).toMatchObject({ startedOn: '2026-01-01', endedOn: '2026-01-10', outcome: 'completed' });
    });

    it('keeps a Hardcover-stamped active attempt identity when closing it from an ABS finish', async () => {
      const active = await fake.repo.create(
        {},
        {
          userId: 1,
          bookId: 10,
          startedOn: '2026-01-01',
          endedOn: null,
          outcome: null,
          origin: 'hardcover',
          externalProvider: 'hardcover',
          externalId: '99',
        },
      );

      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: null, endedOn: '2026-01-10' });

      expect(fake.rows).toHaveLength(1);
      expect(active).toMatchObject({
        endedOn: '2026-01-10',
        outcome: 'completed',
        externalProvider: 'hardcover',
        externalId: '99',
      });
    });

    it('creates a separate completed attempt when the active attempt started after the ABS finish date', async () => {
      const active = await fake.repo.createActive({}, { userId: 1, bookId: 10, startedOn: '2026-02-01', origin: 'audiobookshelf' });

      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: '2026-01-01', endedOn: '2026-01-10' });

      expect(fake.rows).toHaveLength(2);
      expect(active).toMatchObject({ startedOn: '2026-02-01', endedOn: null, outcome: null });
      expect(fake.rows[1]).toMatchObject({
        startedOn: '2026-01-01',
        endedOn: '2026-01-10',
        outcome: 'completed',
        origin: 'audiobookshelf',
        externalProvider: null,
        externalId: null,
      });
    });

    it('creates a completed attempt with no external identity when no active attempt exists', async () => {
      await service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: '2026-01-01', endedOn: '2026-01-10' });

      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({
        startedOn: '2026-01-01',
        endedOn: '2026-01-10',
        outcome: 'completed',
        origin: 'audiobookshelf',
        externalProvider: null,
        externalId: null,
      });
    });
  });

  describe('recent finish catch-up', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-13T18:00:00Z'));
    });
    const today = () => new Date().toISOString().slice(0, 10);
    async function finish(hours = 2, endedOn = today()) {
      const row = await fake.repo.create(
        {},
        { userId: 1, bookId: 10, startedOn: '2023-01-01', endedOn, outcome: 'completed', origin: 'audiobookshelf' },
      );
      row.updatedAt = new Date(Date.now() - hours * 3600000);
      fake.sessionStarts.push({ userId: 1, bookId: 10, startedAt: new Date() });
      return row;
    }
    const push = (progress = 40) =>
      service.recordActivity({
        userId: 1,
        bookId: 10,
        occurredOn: today(),
        occurredAt: new Date(),
        origin: 'bookorbit',
        progress,
        finishThreshold: 98,
        strongRereadEvidence: progress === 100,
        meaningfulActivity: true,
      });

    it('reopens the sleeping reader attempt and finishes the same row', async () => {
      const row = await finish();
      await expect(push()).resolves.toMatchObject({ status: 'reading' });
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ id: row.id, startedOn: '2023-01-01', endedOn: null, outcome: null });
      expect(fake.sessionStarts).toHaveLength(1);
      await expect(push(100)).resolves.toMatchObject({ status: 'read' });
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ id: row.id, endedOn: today(), outcome: 'completed' });
    });
    it('opens a new read after the window', async () => {
      await finish(25);
      await expect(push()).resolves.toMatchObject({ status: 'rereading' });
      expect(fake.rows).toHaveLength(2);
    });
    it('opens a new read for a recently imported old finish', async () => {
      await finish(2, '2023-03-01');
      await push();
      expect(fake.rows).toHaveLength(2);
    });
    it('labels a reopened subsequent read rereading', async () => {
      await finish(100, '2023-03-01');
      const row = await finish();
      await expect(push()).resolves.toMatchObject({ status: 'rereading' });
      expect(fake.rows).toHaveLength(2);
      expect(fake.rows[1]).toMatchObject({ id: row.id, outcome: null });
    });
    it('updates a strong-evidence finish without another row', async () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const row = await finish(2, yesterday);
      await push(100);
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ id: row.id, endedOn: today(), outcome: 'completed' });
    });
    it('reopens an ABS in-progress import and projects reading', async () => {
      const row = await finish();
      await expect(
        service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: today(), endedOn: null, occurredOn: today() }),
      ).resolves.toBe('reopened');
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ id: row.id, outcome: null });
      expect(fake.projections.at(-1)).toMatchObject({ status: 'reading', source: 'auto', finishedAt: null });
    });
    it.each(['abandoned', 'skimmed'] as const)('does not reopen a completion before a later %s attempt', async (outcome) => {
      await finish();
      await fake.repo.create({}, { userId: 1, bookId: 10, startedOn: today(), endedOn: today(), outcome, origin: 'manual' });
      await push();
      expect(fake.rows).toHaveLength(3);
      expect(fake.rows[0].outcome).toBe('completed');
    });
    it('uses the reader timezone for the recent finish date cutoff', async () => {
      vi.setSystemTime(new Date('2026-11-13T01:00:00Z'));
      const row = await finish(2, '2026-11-11');
      await expect(
        service.importUnlinkedRead(1, 10, {
          origin: 'audiobookshelf',
          startedOn: null,
          endedOn: null,
          occurredOn: today(),
          timeZone: 'America/Los_Angeles',
        }),
      ).resolves.toBe('reopened');
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ id: row.id, outcome: null });
    });
    it('keeps deliberate manual rereading as a new attempt', async () => {
      await finish();
      await service.applyManualStatus(1, 10, 'rereading', undefined, undefined, today());
      expect(fake.rows).toHaveLength(2);
      expect(fake.rows[1].outcome).toBeNull();
    });
  });

  describe('a finish heard again', () => {
    // The fake stamps every row it writes at 2026-07-12T12:00Z, so that is when this read closed.
    const finishedRead = () =>
      fake.repo.create({}, { userId: 1, bookId: 10, startedOn: '2025-05-29', endedOn: '2026-07-12', outcome: 'completed', origin: 'audiobookshelf' });
    const push = (progress: number, strongRereadEvidence: boolean, occurredOn = '2026-07-12') =>
      service.recordActivity({
        userId: 1,
        bookId: 10,
        occurredOn,
        origin: 'bookorbit',
        progress,
        finishThreshold: 98,
        strongRereadEvidence,
        meaningfulActivity: false,
      });
    const absInProgress = (occurredOn = '2026-07-12') =>
      service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: '2025-05-29', endedOn: null, occurredOn });

    it('opens no read when Audiobookshelf un-finishes the book the day it finished', async () => {
      await finishedRead();

      for (let i = 0; i < 5; i++) {
        await expect(absInProgress()).resolves.toBe('repeat');
        await push(100, false);
      }

      expect(fake.rows).toHaveLength(1);
    });

    it('opens no read when the position bounces off the end the day it finished', async () => {
      await finishedRead();

      for (let i = 0; i < 5; i++) {
        await expect(push(40, true)).resolves.toBeNull();
        await push(100, true);
      }

      expect(fake.rows).toHaveLength(1);
    });

    it('reopens the same read once something was read after the finish', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-12T18:00:00Z'));
      await finishedRead();
      fake.sessionStarts.push({ userId: 1, bookId: 10, startedAt: new Date('2026-07-12T15:00:00.000Z') });

      await expect(push(5, true)).resolves.toMatchObject({ status: 'reading' });
      await expect(absInProgress()).resolves.toBe('imported');
      expect(fake.rows).toHaveLength(1);
    });

    it('reopens the same-day read when its session arrives after the rewind', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-12T18:00:00Z'));
      await finishedRead();
      await expect(push(0, true)).resolves.toBeNull();
      fake.sessionStarts.push({ userId: 1, bookId: 10, startedAt: new Date('2026-07-12T13:00:00.000Z') });

      await expect(
        service.recordActivity({
          userId: 1,
          bookId: 10,
          occurredOn: '2026-07-12',
          activityStartedAt: new Date('2026-07-12T13:00:00.000Z'),
          occurredAt: new Date('2026-07-12T13:30:00.000Z'),
          origin: 'bookorbit',
          progress: 20,
          finishThreshold: 98,
          meaningfulActivity: true,
          timeZone: 'UTC',
        }),
      ).resolves.toMatchObject({ status: 'reading' });
      expect(fake.rows).toHaveLength(1);
      expect(fake.repo.attachBackfilledSessions).not.toHaveBeenCalled();

      await expect(push(100, false)).resolves.toMatchObject({ status: 'read' });
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0].outcome).toBe('completed');
    });

    it.each([
      { label: 'an older session despite a post-finish session', occurredOn: '2026-07-11', occurredAt: '2026-07-11T20:00:00.000Z' },
      { label: 'a session within the clock skew margin', occurredOn: '2026-07-12', occurredAt: '2026-07-12T12:02:00.000Z' },
    ])('backfills $label without opening a reread', async ({ occurredOn, occurredAt }) => {
      await finishedRead();
      fake.sessionStarts.push({ userId: 1, bookId: 10, startedAt: new Date('2026-07-12T13:00:00.000Z') });
      await expect(
        service.recordActivity({
          userId: 1,
          bookId: 10,
          occurredOn,
          activityStartedAt: new Date(occurredAt),
          occurredAt: new Date(occurredAt),
          origin: 'bookorbit',
          progress: 20,
          finishThreshold: 98,
          strongRereadEvidence: false,
          meaningfulActivity: true,
          timeZone: 'UTC',
        }),
      ).resolves.toBeNull();
      expect(fake.rows).toHaveLength(1);
      expect(fake.repo.attachBackfilledSessions).toHaveBeenCalledWith({}, 1, 10, fake.rows[0].id, 'UTC', '2025-05-29', '2026-07-12');
    });

    it.each([
      { label: 'a session spanning the finish', activityStartedAt: '2026-07-12T11:00:00.000Z', strongRereadEvidence: false },
      { label: 'a session heard before the finish with rewind evidence', activityStartedAt: '2026-07-12T11:00:00.000Z', strongRereadEvidence: true },
    ])('attaches $label to the finished read', async ({ activityStartedAt, strongRereadEvidence }) => {
      await finishedRead();
      await expect(
        service.recordActivity({
          userId: 1,
          bookId: 10,
          occurredOn: '2026-07-12',
          activityStartedAt: new Date(activityStartedAt),
          occurredAt: new Date('2026-07-12T12:30:00.000Z'),
          origin: 'bookorbit',
          progress: 98,
          finishThreshold: 98,
          strongRereadEvidence,
          meaningfulActivity: true,
          timeZone: 'UTC',
        }),
      ).resolves.toBeNull();
      expect(fake.rows).toHaveLength(1);
      expect(fake.repo.attachBackfilledSessions).toHaveBeenCalledWith({}, 1, 10, fake.rows[0].id, 'UTC', '2025-05-29', '2026-07-12');
      if (!strongRereadEvidence) expect(fake.repo.hasSessionsSince).not.toHaveBeenCalled();
    });

    it.each([true, false])('backfills future activity with an explicit start: %s', async (explicitStart) => {
      await finishedRead();
      const now = new Date();
      fake.rows[0].updatedAt = now;
      const future = new Date(now.getTime() + 60 * 60_000);
      fake.sessionStarts.push({ userId: 1, bookId: 10, startedAt: future });
      await expect(
        service.recordActivity({
          userId: 1,
          bookId: 10,
          occurredOn: '2026-07-12',
          activityStartedAt: explicitStart ? future : undefined,
          occurredAt: future,
          origin: 'bookorbit',
          progress: 20,
          finishThreshold: 98,
          strongRereadEvidence: false,
          meaningfulActivity: true,
          timeZone: 'UTC',
        }),
      ).resolves.toBeNull();
      expect(fake.rows).toHaveLength(1);
      expect(fake.repo.attachBackfilledSessions).toHaveBeenCalledWith({}, 1, 10, fake.rows[0].id, 'UTC', '2025-05-29', '2026-07-12');
    });

    it('treats a session from a clock running fast as backlog, even after its start was saved', async () => {
      await finishedRead();
      const now = new Date();
      fake.rows[0].updatedAt = new Date(now.getTime() - 10 * 60_000);
      const fast = new Date(now.getTime() + 2 * 60 * 60_000);
      fake.sessionStarts.push({ userId: 1, bookId: 10, startedAt: fast });
      await expect(
        service.recordActivity({
          userId: 1,
          bookId: 10,
          occurredOn: '2026-07-12',
          activityStartedAt: fast,
          occurredAt: new Date(fast.getTime() + 30 * 60_000),
          origin: 'bookorbit',
          progress: 60,
          finishThreshold: 98,
          meaningfulActivity: true,
          timeZone: 'UTC',
        }),
      ).resolves.toBeNull();
      expect(fake.rows).toHaveLength(1);
      expect(fake.repo.attachBackfilledSessions).toHaveBeenCalled();
    });

    it('imports an older Audiobookshelf finish before a later BookOrbit read', async () => {
      await fake.repo.create({}, { userId: 1, bookId: 10, startedOn: null, endedOn: '2025-06-10', outcome: 'completed', origin: 'bookorbit' });
      await expect(service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: null, endedOn: '2023-03-01' })).resolves.toBe('imported');
      expect(fake.rows).toHaveLength(2);
      expect(fake.rows[1]).toMatchObject({ endedOn: '2023-03-01', outcome: 'completed', origin: 'audiobookshelf' });
    });

    it('ignores an Audiobookshelf finish already recorded by BookOrbit on the same day', async () => {
      await fake.repo.create(
        {},
        {
          userId: 1,
          bookId: 10,
          startedOn: '2026-07-01',
          endedOn: '2026-07-12',
          outcome: 'completed',
          origin: 'bookorbit',
        },
      );

      await expect(service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: null, endedOn: '2026-07-12' })).resolves.toBe('repeat');
      expect(fake.rows).toHaveLength(1);
    });

    it('imports an Audiobookshelf finish on a later day than the BookOrbit finish', async () => {
      await fake.repo.create(
        {},
        {
          userId: 1,
          bookId: 10,
          startedOn: '2026-07-01',
          endedOn: '2026-07-12',
          outcome: 'completed',
          origin: 'bookorbit',
        },
      );

      await expect(service.importUnlinkedRead(1, 10, { origin: 'audiobookshelf', startedOn: null, endedOn: '2026-07-13' })).resolves.toBe('imported');
      expect(fake.rows).toHaveLength(2);
    });

    it('still opens a reread on a later day outside the reopen window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-13T18:00:00Z'));
      await finishedRead();

      await expect(push(5, true, '2026-07-13')).resolves.toMatchObject({ status: 'rereading' });
      expect(fake.rows).toHaveLength(2);
    });

    it('still records a first finish', async () => {
      await expect(push(100, false)).resolves.toMatchObject({ status: 'read' });
      expect(fake.rows).toHaveLength(1);
    });
  });
});
