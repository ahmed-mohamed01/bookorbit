import type { MonitoredDatePrecision, MonitoredReleaseDateSource, MonitoredReleaseProbeStatus } from '@bookorbit/types';

import { releaseDateRange } from '../release-window';
import type { ProbeDecision, ProbeDecisionInput } from './release-probe.types';

function decision(
  status: ProbeDecision['status'],
  releaseDate: string | null,
  precision: ProbeDecision['precision'],
  source: ProbeDecision['source'],
  asin: string | null,
  overlay: ProbeDecision['overlay'],
): ProbeDecision {
  return { status, releaseDate, precision, source, asin, overlay };
}

export function decideFormat(input: ProbeDecisionInput): ProbeDecision | null {
  if (input.owned) return null;

  if (input.format === 'audiobook' && input.audible) {
    return decision('dated', input.audible.date, input.audible.precision ?? 'day', 'audible', null, 'set');
  }

  // Positive evidence may only be overwritten by positive evidence: an Amazon lookup that missed
  // (strict title tokens, no swatch block) is a failed search, not proof that a confirmed listing
  // stopped existing, so every negative branch sits below the strong Hardcover edition.
  const amazonFormat = input.amazon?.listing === 'found' ? input.amazon.formats[input.format] : undefined;
  if (amazonFormat?.date) return decision('dated', amazonFormat.date, 'day', 'amazon', amazonFormat.asin, 'set');
  if (input.format === 'ebook' && input.apple) return decision('dated', input.apple.releaseDate, 'day', 'apple', null, 'set');

  const evidence = input.hardcover?.[input.format];
  if (evidence?.date && evidence.strength === 'strong') {
    return decision('dated', evidence.date, evidence.precision, 'hardcover_edition', null, 'set');
  }
  if (input.amazon?.listing === 'none') return decision('unlisted', null, null, 'amazon_search', null, 'clear');
  if (input.amazon?.listing === 'found' && !amazonFormat) return decision('unlisted', null, null, 'amazon', null, 'clear');
  if (evidence?.date && evidence.strength === 'weak') {
    return decision('expected', evidence.date, evidence.precision, 'hardcover_edition', null, 'clear');
  }
  if (
    input.format === 'ebook' &&
    input.hardcover !== null &&
    input.hardcover.ebook.count === 0 &&
    input.hardcover.physical.count === 0 &&
    input.hardcover.audiobook.count > 0
  ) {
    return decision('unlisted', null, null, 'hardcover_edition', null, 'clear');
  }
  if (input.inherited.date) return decision('expected', input.inherited.date, input.inherited.precision, null, null, 'clear');
  return decision('unlisted', null, null, null, null, 'clear');
}

function add(now: Date, milliseconds: number): Date {
  return new Date(now.getTime() + milliseconds);
}

function distanceDays(now: Date, releaseDate: string, precision: MonitoredDatePrecision | null): number | null {
  const signed = signedStartDistanceDays(now, releaseDate, precision);
  return signed === null ? null : Math.abs(signed);
}

function signedStartDistanceDays(now: Date, releaseDate: string, precision: MonitoredDatePrecision | null): number | null {
  const range = releaseDateRange(releaseDate, precision);
  if (!range) return null;
  const day = new Date(`${range.start}T00:00:00.000Z`).getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (day - today) / 86_400_000;
}

export const USER_DATE_RECHECK_DAYS = 30;

export function nextProbeCheckAt(
  now: Date,
  input: {
    status: MonitoredReleaseProbeStatus;
    releaseDate: string | null;
    precision: MonitoredDatePrecision | null;
    source: MonitoredReleaseDateSource | null;
    siblingDates: string[];
    failed: boolean;
    attempts: number;
  },
): Date {
  const day = 86_400_000;
  if (input.failed) return add(now, Math.min(3_600_000 * 2 ** (Math.max(1, input.attempts) - 1), 7 * day));
  // A row the owner dated is normally scheduled by the automatic decision it is watching; this is
  // the rest it falls back to once the format is owned and no automatic decision is left to follow.
  if (input.source === 'user') return add(now, USER_DATE_RECHECK_DAYS * day);
  if (input.status === 'pending') return add(now, day);
  const distance = input.releaseDate ? distanceDays(now, input.releaseDate, input.precision) : null;
  const signedDistance = input.releaseDate ? signedStartDistanceDays(now, input.releaseDate, input.precision) : null;
  if ((input.status === 'dated' || input.status === 'expected') && signedDistance !== null && signedDistance < -365) {
    return add(now, 30 * day);
  }
  // A date years out is a placeholder or an announcement, not something that can move this week.
  if ((input.status === 'dated' || input.status === 'expected') && signedDistance !== null && signedDistance > 180) {
    return add(now, 30 * day);
  }
  if (input.status === 'dated') return add(now, distance !== null && distance <= 14 ? day : distance !== null && distance <= 90 ? 3 * day : 7 * day);
  if (input.status === 'expected') return add(now, distance !== null && distance <= 30 ? day : 3 * day);
  const siblingIsNear = input.siblingDates.some((date) => {
    const siblingDistance = distanceDays(now, date, null);
    return siblingDistance !== null && siblingDistance <= 90;
  });
  const allSiblingsAreAged =
    input.siblingDates.length > 0 &&
    input.siblingDates.every((date) => {
      const siblingDistance = signedStartDistanceDays(now, date, null);
      return siblingDistance !== null && siblingDistance < -365;
    });
  const allSiblingsAreFarOut =
    input.siblingDates.length > 0 &&
    input.siblingDates.every((date) => {
      const siblingDistance = signedStartDistanceDays(now, date, null);
      return siblingDistance !== null && siblingDistance > 180;
    });
  return add(now, siblingIsNear ? 3 * day : allSiblingsAreAged || allSiblingsAreFarOut ? 30 * day : 7 * day);
}
