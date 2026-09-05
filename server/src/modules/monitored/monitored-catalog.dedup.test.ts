import { describe, expect, it } from 'vitest';

import type { MergedWork, SeriesMembership } from './reconcile/observation.types';
import type { VerdictResult } from './reconcile/verdict';
import { demoteSlotDuplicates } from './monitored-catalog.service';

function work(popularity: number, memberships: SeriesMembership[]): MergedWork {
  return { popularity: { hardcover: popularity }, seriesMemberships: memberships } as unknown as MergedWork;
}

function verified(): VerdictResult {
  return { verdict: 'verified', flags: [] };
}

describe('demoteSlotDuplicates', () => {
  it('demotes a low-popularity translation that shares a series slot with the canonical', () => {
    const works = [
      work(4557, [{ name: 'The Mistborn Saga', index: '4' }]), // The Alloy of Law
      work(3, [{ name: 'The Mistborn Saga', index: '4' }]), // Aleación de ley (Spanish)
    ];
    const verdicts = [verified(), verified()];
    demoteSlotDuplicates(works, verdicts);
    expect(verdicts[0].verdict).toBe('verified');
    expect(verdicts[1].verdict).toBe('suspect');
  });

  it('matches slots across a variant series name (normalized) and a numeric index like "4.0"', () => {
    const works = [work(1000, [{ name: 'The Mistborn Saga', index: '4' }]), work(2, [{ name: 'the mistborn saga', index: '4.0' }])];
    const verdicts = [verified(), verified()];
    demoteSlotDuplicates(works, verdicts);
    expect(verdicts[1].verdict).toBe('suspect');
  });

  it('keeps two comparably-popular real books that share a loose meta-series index', () => {
    const works = [
      work(3000, [{ name: 'The Cosmere', index: '10' }]), // The Emperor's Soul
      work(2500, [{ name: 'The Cosmere', index: '10' }]), // a different real book, comparable readership
    ];
    const verdicts = [verified(), verified()];
    demoteSlotDuplicates(works, verdicts);
    expect(verdicts[0].verdict).toBe('verified');
    expect(verdicts[1].verdict).toBe('verified');
  });

  it('ignores memberships with no index and single-occupancy slots', () => {
    const works = [work(10, [{ name: 'Standalones', index: null }]), work(5, [{ name: 'Other', index: '1' }])];
    const verdicts = [verified(), verified()];
    demoteSlotDuplicates(works, verdicts);
    expect(verdicts.every((result) => result.verdict === 'verified')).toBe(true);
  });
});
