import type { MonitoredWorkFlag, MonitoredWorkVerdict } from '@bookorbit/types';

import { normalizeText } from './observation-matcher';
import type { MergedWork, ObservationSource } from './observation.types';

export const CATALOG_VERDICT_VERSION = 1;

const COMPILATION_PATTERN =
  /\b(books?\s*\d+\s*[-\u2013\u2014]\s*\d+|omnibus|box ?set|boxed ?set|collection|complete series|bundle|anthology|sampler|trilogy|duology)\b/i;
const ADAPTATION_PATTERN =
  /dramatized adaptation|graphicaudio|\(\s*\d+\s+of\s+\d+\s*\)|\bpart \d+ of \d+\b|[,:]\s*part\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const NON_LATIN_SCRIPT_PATTERN =
  /\p{Script=Greek}|\p{Script=Cyrillic}|\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Devanagari}|\p{Script=Thai}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}|\p{Script=Hangul}/u;

export interface VerdictContext {
  today: string;
  floor: Partial<Record<ObservationSource, number>>;
}

export interface VerdictResult {
  verdict: MonitoredWorkVerdict;
  flags: MonitoredWorkFlag[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function computePopularityFloor(works: MergedWork[]): Partial<Record<ObservationSource, number>> {
  const corroborated = works.filter((work) => work.sources.length >= 2);
  const floor: Partial<Record<ObservationSource, number>> = {};
  for (const source of ['hardcover', 'goodreads', 'audible'] as const) {
    const values = corroborated
      .map((work) => work.popularity[source] ?? 0)
      .filter((popularity) => popularity > 0)
      .sort((left, right) => left - right);
    floor[source] = values.length >= 4 ? Math.max(2, values[Math.floor(values.length * 0.25)] * 0.1) : 2;
  }
  return floor;
}

export function assignVerdict(work: MergedWork, context: VerdictContext): VerdictResult {
  const flags: MonitoredWorkFlag[] = [];
  if (work.compilationFlag || COMPILATION_PATTERN.test(work.title)) flags.push('compilation');
  const seriesOnlyTitle = work.seriesName
    ? new RegExp(`^${escapeRegExp(normalizeText(work.seriesName))}\\s*(?:book\\s*)?[\\d.]+$`).test(normalizeText(work.title))
    : false;
  if (/^untitled\b/i.test(work.title) || (seriesOnlyTitle && !work.hasDesc && !work.cover)) flags.push('placeholder');
  // Flag translations: a non-Latin title, or a work whose editions are entirely non-English
  // (allForeign, sourced from Hardcover edition languages). A work with any English edition keeps
  // allForeign false and, after series-slot merge, wins its English title, so it is not flagged.
  if (NON_LATIN_SCRIPT_PATTERN.test(work.title) || work.allForeign) flags.push('foreign_language');
  if (ADAPTATION_PATTERN.test(work.title)) flags.push('adaptation_split');
  if (work.allRolesNonAuthor) flags.push('wrong_contributor');

  const releaseValue = work.ebookReleaseDate ?? work.audioReleaseDate;
  const releasePrecision = work.ebookReleaseDate ? work.ebookDatePrecision : work.audioDatePrecision;
  const currentYear = Number(context.today.slice(0, 4));
  const future = work.unreleased && (releaseValue != null || (work.releaseYear ?? 0) >= currentYear);
  const released =
    releasePrecision === 'day' && releaseValue ? releaseValue < context.today : work.releaseYear ? work.releaseYear < currentYear : true;
  const monthsOld = releasePrecision === 'day' && releaseValue ? (Date.parse(context.today) - Date.parse(releaseValue)) / 2_628_000_000 : 12;

  // Hardcover is the trusted spine, but it is crowd-sourced and slow to index indie/LitRPG releases.
  // Admit a work with no Hardcover edition when it is fresh (upcoming, or released within six months)
  // and corroborated by 2+ providers with no junk flags, so a new Audible/Goodreads release surfaces
  // on release week instead of waiting months for Hardcover. Everything else stays a suspect stray.
  if (!work.sources.includes('hardcover')) {
    const fresh = future || (released && monthsOld <= 6);
    if (fresh && work.sources.length >= 2 && flags.length === 0) return { verdict: 'verified', flags };
    return { verdict: 'suspect', flags };
  }

  // Cross-source agreement or a curated upcoming release is verified outright.
  if (work.sources.length >= 2) return { verdict: 'verified', flags };
  if (future && work.sources.includes('audible')) return { verdict: 'verified', flags };

  // Single-source Hardcover: the book is real if it is upcoming or has genuine readership. Obscure
  // low-read Hardcover rows (stray editions, misattributions) stay in the review tray.
  const hardcoverPopularity = work.popularity.hardcover ?? 0;
  const hardcoverTrustFloor = Math.max(3, context.floor.hardcover ?? 0);
  if (future) return { verdict: 'verified', flags };
  if (hardcoverPopularity >= hardcoverTrustFloor) return { verdict: 'verified', flags };
  if (released && monthsOld >= 6) return { verdict: 'suspect', flags };
  return { verdict: 'probable', flags };
}
