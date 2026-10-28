import { describe, expect, it } from 'vitest';

import type { AttemptRow } from './work.repository';
import { audioPositionAt, mirrorSkipReason, pickPrimaries, planAbsHistoryRebuild, planAttemptMerge, type PrimaryCandidate } from './work.utils';

const at = (day: number) => new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`);
const member = (
  bookId: number,
  role: PrimaryCandidate['role'],
  primaryFormat: string,
  createdDay: number,
  formatPriority: string[] | null = null,
): PrimaryCandidate => ({
  bookId,
  role,
  createdAt: at(createdDay),
  primaryFormat,
  primaryReadAlong: false,
  formatPriority,
});
const attempt = (id: number, bookId: number, fields: Partial<AttemptRow> = {}): AttemptRow => ({
  id,
  bookId,
  startedOn: null,
  endedOn: null,
  outcome: 'completed',
  origin: 'manual',
  ...fields,
});

describe('pickPrimaries', () => {
  it('picks per role the copy whose format comes first in its library order', () => {
    const primaries = pickPrimaries([
      member(1, 'text', 'mobi', 1),
      member(2, 'text', 'epub', 2),
      member(3, 'audio', 'mp3', 1),
      member(4, 'audio', 'm4b', 3),
    ]);

    expect(primaries).toEqual({ text: 2, audio: 4, readAlong: null });
  });

  it("honours each library's own format order", () => {
    const primaries = pickPrimaries([member(1, 'text', 'epub', 1, ['mobi', 'epub']), member(2, 'text', 'mobi', 2, ['mobi', 'epub'])]);

    expect(primaries.text).toBe(2);
  });

  it('breaks a tie with the oldest member', () => {
    expect(pickPrimaries([member(5, 'audio', 'm4b', 4), member(6, 'audio', 'm4b', 2)]).audio).toBe(6);
  });
});

describe('planAttemptMerge', () => {
  it('moves the joining attempts and keeps the dated one of two same-origin finishes', () => {
    const plan = planAttemptMerge(20, [
      attempt(1, 20, { origin: 'audiobookshelf', endedOn: '2026-03-01' }),
      attempt(2, 10, { origin: 'audiobookshelf', startedOn: '2026-02-01', endedOn: '2026-03-01' }),
      attempt(3, 10, { origin: 'kobo', endedOn: '2025-05-05' }),
    ]);

    expect(plan.deletes).toEqual([{ id: 1, keptId: 2 }]);
    expect(plan.moveIds).toEqual([2, 3]);
  });

  it('keeps one active attempt, the canonical one on a tie', () => {
    const plan = planAttemptMerge(20, [
      attempt(1, 10, { outcome: null, startedOn: '2026-01-01' }),
      attempt(2, 20, { outcome: null, startedOn: '2026-01-03' }),
    ]);

    expect(plan.deletes).toEqual([{ id: 1, keptId: 2 }]);
    expect(plan.moveIds).toEqual([]);
  });

  it('leaves the canonical history alone when nothing joins', () => {
    expect(planAttemptMerge(20, [attempt(1, 20), attempt(2, 20)])).toEqual({ moveIds: [], deletes: [] });
  });

  it('counts a work once: two variants with one finish each on the same day end as one completed attempt', () => {
    const attempts = [attempt(1, 20, { origin: 'migration', endedOn: '2026-04-01' }), attempt(2, 10, { origin: 'migration', endedOn: '2026-04-01' })];
    const plan = planAttemptMerge(20, attempts);
    const deleted = new Set(plan.deletes.map((entry) => entry.id));
    const remaining = attempts.filter((row) => !deleted.has(row.id)).map((row) => ({ ...row, bookId: 20 }));

    expect(remaining.filter((row) => row.outcome === 'completed')).toHaveLength(1);
  });
});

describe('planAbsHistoryRebuild', () => {
  it('replaces migration finishes across a work whose canonical has an Audiobookshelf finish', () => {
    const plan = planAbsHistoryRebuild(
      [
        { canonicalBookId: 20, memberBookIds: [20, 10] },
        { canonicalBookId: 50, memberBookIds: [50] },
      ],
      [
        attempt(1, 20, { origin: 'audiobookshelf', endedOn: '2026-02-02' }),
        attempt(2, 10, { origin: 'migration', endedOn: '2026-01-01' }),
        attempt(3, 20, { origin: 'migration', endedOn: null }),
        attempt(4, 10, { origin: 'kobo', endedOn: '2026-02-02' }),
        attempt(5, 50, { origin: 'migration', endedOn: '2026-02-02' }),
      ],
    );

    expect(plan).toHaveLength(1);
    expect(plan[0]!.canonicalBookId).toBe(20);
    expect(plan[0]!.absEndedOn).toBe('2026-02-02');
    expect(plan[0]!.replaced.map((row) => row.id).sort()).toEqual([2, 3]);
  });
});

describe('mirrorSkipReason', () => {
  it('leaves an aligned ebook and audiobook to the alignment sync', () => {
    expect(mirrorSkipReason('audio', 'text', { alignmentReady: true, readAlongOffsets: false })).toBe('alignment');
    expect(mirrorSkipReason('audio', 'text', { alignmentReady: false, readAlongOffsets: false })).toBeNull();
  });

  it('leaves a read-along with narration offsets to the read-along sync', () => {
    expect(mirrorSkipReason('readAlong', 'audio', { alignmentReady: false, readAlongOffsets: true })).toBe('read_along_offsets');
    expect(mirrorSkipReason('readAlong', 'text', { alignmentReady: true, readAlongOffsets: true })).toBeNull();
  });
});

describe('audioPositionAt', () => {
  it('maps a percentage onto the file sequence', () => {
    const files = [
      { id: 1, durationSeconds: 100 },
      { id: 2, durationSeconds: 300 },
    ];
    expect(audioPositionAt(files, 50)).toEqual({ currentFileId: 2, positionSeconds: 100 });
    expect(audioPositionAt(files, 100)).toEqual({ currentFileId: 2, positionSeconds: 300 });
  });

  it('refuses a sequence with an unknown duration', () => {
    expect(audioPositionAt([{ id: 1, durationSeconds: null }], 10)).toBeNull();
  });
});
