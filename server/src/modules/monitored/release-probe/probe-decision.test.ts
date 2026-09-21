import { describe, expect, it } from 'vitest';

import { decideFormat, nextProbeCheckAt } from './probe-decision';
import type { HardcoverEvidence, ProbeDecisionInput } from './release-probe.types';

const emptyEvidence = (): HardcoverEvidence => ({
  ebook: { count: 0, date: null, precision: null, strength: null, seeds: [] },
  audiobook: { count: 0, date: null, precision: null, strength: null, seeds: [] },
  physical: { count: 0, seeds: [] },
});

const input = (values: Partial<ProbeDecisionInput> = {}): ProbeDecisionInput => ({
  format: 'ebook',
  owned: false,
  inherited: { date: null, precision: null },
  audible: null,
  hardcover: null,
  apple: undefined,
  amazon: undefined,
  ...values,
});

describe('decideFormat', () => {
  it('skips owned formats', () => expect(decideFormat(input({ owned: true }))).toBeNull());

  it('prefers Audible for audiobooks', () => {
    expect(decideFormat(input({ format: 'audiobook', audible: { date: '2026-09-10', precision: null } }))).toEqual({
      status: 'dated',
      releaseDate: '2026-09-10',
      precision: 'day',
      source: 'audible',
      asin: null,
      overlay: 'set',
    });
  });

  it('uses dated Amazon format evidence before Apple', () => {
    expect(
      decideFormat(
        input({
          apple: { releaseDate: '2026-10-01' },
          amazon: { listing: 'found', formats: { ebook: { asin: 'B012345678', date: '2026-09-01' } } },
        }),
      ),
    ).toMatchObject({ status: 'dated', releaseDate: '2026-09-01', source: 'amazon', asin: 'B012345678' });
  });

  it('uses Apple when Blightfall has a physical edition but no ebook edition', () => {
    const hardcover = emptyEvidence();
    hardcover.physical.count = 1;
    hardcover.audiobook.count = 1;
    expect(
      decideFormat(input({ inherited: { date: '2026-09-01', precision: 'day' }, hardcover, apple: { releaseDate: '2026-09-01' } })),
    ).toMatchObject({ status: 'dated', releaseDate: '2026-09-01', source: 'apple' });
  });

  it('keeps strong Hardcover evidence through an Amazon search miss', () => {
    const hardcover = emptyEvidence();
    hardcover.ebook = { count: 1, date: '2026-12-01', precision: 'day', strength: 'strong', seeds: [] };
    expect(decideFormat(input({ hardcover, amazon: { listing: 'none' } }))).toMatchObject({
      status: 'dated',
      releaseDate: '2026-12-01',
      source: 'hardcover_edition',
      overlay: 'set',
    });
  });

  it('keeps strong Hardcover evidence when an Amazon family lacks the format', () => {
    const hardcover = emptyEvidence();
    hardcover.ebook = { count: 1, date: '2026-12-01', precision: 'day', strength: 'strong', seeds: [] };
    const amazon = { listing: 'found' as const, formats: { audiobook: { asin: 'B012345678', date: '2026-10-06' } } };
    expect(decideFormat(input({ hardcover, amazon }))).toMatchObject({ status: 'dated', source: 'hardcover_edition' });
  });

  it('lets an Amazon negative overrule weak Hardcover evidence', () => {
    const hardcover = emptyEvidence();
    hardcover.ebook = { count: 1, date: '2026-12-01', precision: 'day', strength: 'weak', seeds: [] };
    expect(decideFormat(input({ hardcover, amazon: { listing: 'none' } }))).toMatchObject({
      status: 'unlisted',
      source: 'amazon_search',
      overlay: 'clear',
    });
  });

  it('prefers a dated Amazon format to strong Hardcover evidence', () => {
    const hardcover = emptyEvidence();
    hardcover.ebook = { count: 1, date: '2026-12-01', precision: 'day', strength: 'strong', seeds: [] };
    expect(
      decideFormat(input({ hardcover, amazon: { listing: 'found', formats: { ebook: { asin: 'B012345678', date: '2026-11-02' } } } })),
    ).toMatchObject({ status: 'dated', releaseDate: '2026-11-02', source: 'amazon' });
  });

  it('marks formats an Amazon family does not list unlisted', () => {
    const amazon = { listing: 'found' as const, formats: { ebook: { asin: 'B012345678', date: '2026-10-06' } } };
    expect(decideFormat(input({ format: 'audiobook', amazon }))).toMatchObject({ status: 'unlisted', source: 'amazon' });
    expect(decideFormat(input({ amazon }))).toEqual({
      status: 'dated',
      releaseDate: '2026-10-06',
      precision: 'day',
      source: 'amazon',
      asin: 'B012345678',
      overlay: 'set',
    });
  });

  it('keeps weak Hardcover ebook evidence expected', () => {
    const hardcover = emptyEvidence();
    hardcover.ebook = { count: 1, date: '2027-01-10', precision: 'day', strength: 'weak', seeds: [] };
    expect(decideFormat(input({ hardcover }))).toMatchObject({
      status: 'expected',
      releaseDate: '2027-01-10',
      source: 'hardcover_edition',
      overlay: 'clear',
    });
  });

  it('marks a Hardcover audio-only record as having no ebook listing', () => {
    const hardcover = emptyEvidence();
    hardcover.audiobook.count = 1;
    expect(decideFormat(input({ hardcover }))).toMatchObject({ status: 'unlisted', source: 'hardcover_edition' });
  });

  it('falls back to the inherited Blightfall hint when a physical edition is present', () => {
    const hardcover = emptyEvidence();
    hardcover.physical.count = 1;
    hardcover.audiobook.count = 1;
    expect(decideFormat(input({ inherited: { date: '2026-09-01', precision: 'day' }, hardcover }))).toMatchObject({
      status: 'expected',
      releaseDate: '2026-09-01',
      source: null,
    });
  });

  it('returns a source-less unlisted decision when no evidence exists', () => {
    expect(decideFormat(input())).toMatchObject({ status: 'unlisted', source: null, overlay: 'clear' });
  });
});

describe('nextProbeCheckAt', () => {
  const now = new Date('2026-09-18T12:00:00.000Z');
  const plusDays = (days: number) => new Date(now.getTime() + days * 86_400_000);

  it.each([
    [1, 1],
    [2, 2],
    [10, 7],
  ])('backs off failed attempt %s by %s hour/day units', (attempts, expected) => {
    const result = nextProbeCheckAt(now, {
      status: 'pending',
      releaseDate: null,
      precision: null,
      source: null,
      siblingDates: [],
      failed: true,
      attempts,
    });
    const expectedMs = attempts < 10 ? expected * 3_600_000 : expected * 86_400_000;
    expect(result.getTime() - now.getTime()).toBe(expectedMs);
  });

  it.each([
    ['dated', '2026-09-20', 'day', [], 1],
    ['dated', '2026-11-01', 'day', [], 3],
    ['dated', '2027-01-01', 'day', [], 7],
    ['expected', '2026-09', 'month', [], 1],
    ['expected', null, null, [], 3],
    ['unlisted', null, null, ['2026-10-01'], 3],
    ['unlisted', null, null, [], 7],
    ['pending', null, null, [], 1],
  ] as const)('schedules %s evidence in %s days', (status, releaseDate, precision, siblingDates, days) => {
    expect(
      nextProbeCheckAt(now, { status, releaseDate, precision, source: null, siblingDates: [...siblingDates], failed: false, attempts: 0 }),
    ).toEqual(plusDays(days));
  });

  it.each([
    ['dated', '2025-09-17'],
    ['expected', '2025-09-17'],
  ] as const)('rechecks an aged %s date monthly', (status, releaseDate) => {
    expect(nextProbeCheckAt(now, { status, releaseDate, precision: 'day', source: null, siblingDates: [], failed: false, attempts: 0 })).toEqual(
      plusDays(30),
    );
  });

  it.each([
    ['dated', '2034-01-01'],
    ['expected', '2027-06-01'],
  ] as const)('rechecks a far-future %s date monthly', (status, releaseDate) => {
    expect(nextProbeCheckAt(now, { status, releaseDate, precision: 'day', source: null, siblingDates: [], failed: false, attempts: 0 })).toEqual(
      plusDays(30),
    );
  });

  it('keeps a date just inside the forward bound on the normal cadence', () => {
    expect(
      nextProbeCheckAt(now, {
        status: 'expected',
        releaseDate: '2027-03-01',
        precision: 'day',
        source: null,
        siblingDates: [],
        failed: false,
        attempts: 0,
      }),
    ).toEqual(plusDays(3));
  });

  it('rests a date the owner chose for a month when no automatic decision is left to follow', () => {
    expect(
      nextProbeCheckAt(now, {
        status: 'dated',
        releaseDate: '2026-09-20',
        precision: 'day',
        source: 'user',
        siblingDates: [],
        failed: false,
        attempts: 0,
      }),
    ).toEqual(plusDays(30));
  });

  it('rechecks an unlisted format monthly when every sibling date is far out', () => {
    expect(
      nextProbeCheckAt(now, {
        status: 'unlisted',
        releaseDate: null,
        precision: null,
        source: null,
        siblingDates: ['2034-01-01', '2028-05-02'],
        failed: false,
        attempts: 0,
      }),
    ).toEqual(plusDays(30));
  });

  it('rechecks an unlisted format monthly when every sibling date is aged', () => {
    expect(
      nextProbeCheckAt(now, {
        status: 'unlisted',
        releaseDate: null,
        precision: null,
        source: null,
        siblingDates: ['2024-01-01', '2025-09-17'],
        failed: false,
        attempts: 0,
      }),
    ).toEqual(plusDays(30));
  });
});
