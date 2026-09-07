import type { MonitoredWorkFlag, MonitoredWorkVerdict } from '@bookorbit/types';

import { normalizeText } from './observation-matcher';
import type { MergedWork, ObservationSource } from './observation.types';
import { COLLECTION_TITLE_PATTERN, DRAMATIZED_ADAPTATION_PATTERN, SPLIT_PART_SUFFIX_PATTERN } from './work-shape';

export const CATALOG_VERDICT_VERSION = 1;

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
  // NOTE: this deliberately still trusts Hardcover's bare `compilation` boolean, unlike
  // slot-resolution's isCollection. Relaxing it here to match was measured and is net-negative: it
  // recovers 6 real novels (`Axiom`, `An Autumn War`, `Cold Hearted`) but exposes ~14 genuine
  // omnibuses, anthologies and magazines that carry a series position and no bundle word in the
  // title - `The Complete Wheel of Time`, `Shadow and Betrayal`, `Unfettered III`, `Interzone 157`.
  // Fixing it properly needs the signals slot-resolution has and this function does not: the book
  // category and the author-credit count. See work-shape.ts.
  if (work.compilationFlag || COLLECTION_TITLE_PATTERN.test(work.title)) flags.push('compilation');
  // normalizeText strips non-ASCII, so a CJK, Greek or Cyrillic series name collapses to the empty
  // string and the pattern degenerates to /^\s*(?:book\s*)?[\d.]+$/ - which matches any purely
  // numeric title. Without this guard `1984` or `2001` would read as a bare series-and-number stub.
  const normalizedSeriesName = work.seriesName ? normalizeText(work.seriesName) : '';
  const seriesOnlyTitle =
    normalizedSeriesName.length > 0 && new RegExp(`^${escapeRegExp(normalizedSeriesName)}\\s*(?:book\\s*)?[\\d.]+$`).test(normalizeText(work.title));
  // "Untitled" is how a publisher announces a book whose name is not public yet, so on its own it
  // marks the most valuable rows in the catalog rather than junk: Stormlight #6-#10, Elantris #2-#3,
  // The Burning #4. What separates those from a genuine stub is that they hold a numbered place in a
  // series. Across the validation set 15 of 16 surviving "Untitled" works hold one and every one is a
  // real announcement; the single row without a slot is the only stub.
  const holdsSeriesSlot = (work.seriesMemberships ?? []).some((membership) => {
    const position = Number(membership.index);
    return Number.isInteger(position) && position >= 1;
  });
  // The same test applies to a title that is just the series name and a number. `New Life as a Max
  // Level Archmage, Book 2` and `The Devils book 3` are announced sequels listed before their cover
  // and blurb exist, which is how most LitRPG and indie sequels appear. All four works this branch
  // caught across the validation set hold a numbered slot and all four are real.
  const untitledStub = /^untitled\b/i.test(work.title) && !holdsSeriesSlot;
  const seriesNumberStub = seriesOnlyTitle && !work.hasDesc && !work.cover && !holdsSeriesSlot;
  if (untitledStub || seriesNumberStub) flags.push('placeholder');
  // Flag translations: a non-Latin title, or a work whose editions are entirely non-English
  // (allForeign, sourced from Hardcover edition languages). A work with any English edition keeps
  // allForeign false and, after series-slot merge, wins its English title, so it is not flagged.
  if (NON_LATIN_SCRIPT_PATTERN.test(work.title) || work.allForeign) flags.push('foreign_language');
  if (DRAMATIZED_ADAPTATION_PATTERN.test(work.title) || SPLIT_PART_SUFFIX_PATTERN.test(work.title)) flags.push('adaptation_split');
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

  const hardcoverPopularity = work.popularity.hardcover ?? 0;
  const hardcoverTrustFloor = Math.max(3, context.floor.hardcover ?? 0);
  // Two providers listing a work proves it EXISTS, not that it is a book worth announcing. Goodreads
  // carries in-world fictional titles (`The Girl Who Looked Up`, `The Taldain System`), annotation
  // PDFs and unpublished fragments, all of which Hardcover mirrors. So corroboration still asks the
  // work for one signal of its own: a cover, a description, a series membership, a release date, or
  // readership at the floor. An upcoming release is exempt, as everywhere else in this file.
  const hasOwnEvidence =
    Boolean(work.cover) ||
    work.hasDesc ||
    (work.seriesMemberships?.length ?? 0) > 0 ||
    releaseValue != null ||
    hardcoverPopularity >= hardcoverTrustFloor;

  // Cross-source agreement or a curated upcoming release is verified outright.
  if (work.sources.length >= 2 && (future || hasOwnEvidence)) return { verdict: 'verified', flags };
  if (future && work.sources.includes('audible')) return { verdict: 'verified', flags };

  // Single-source Hardcover: the book is real if it is upcoming or has genuine readership. Obscure
  // low-read Hardcover rows (stray editions, misattributions) stay in the review tray.
  if (future) return { verdict: 'verified', flags };
  if (hardcoverPopularity >= hardcoverTrustFloor) return { verdict: 'verified', flags };
  // A lone low-read row is normally a stray edition, but not when it carries every mark a real book
  // has: a numbered place in a series, a cover, a description and a dated release. Niche and
  // small-press authors sit at 0-2 Hardcover readers across their whole catalog - Cheyenne McCray's
  // King Creek Cowboys and Alexander Wales's Thresholder are complete, dated, illustrated series that
  // the floor alone would bury. This mirrors the evidence test the corroborated branch already makes.
  if (holdsSeriesSlot && work.cover && work.hasDesc && releaseValue != null) return { verdict: 'verified', flags };
  if (released && monthsOld >= 6) return { verdict: 'suspect', flags };
  return { verdict: 'probable', flags };
}
