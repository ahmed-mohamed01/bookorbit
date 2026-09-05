import type { MonitoredDatePrecision } from '@bookorbit/types';

import { normalizeCore, normalizeText } from './observation-matcher';
import type { MergedWork, Observation, ObservationSource, SeriesMembership, WorkCluster } from './observation.types';

type DateChoice = {
  value: string | null;
  precision: MonitoredDatePrecision | null;
  source: ObservationSource | 'consensus' | null;
};

function bySource(observations: Observation[], source: ObservationSource): Observation[] {
  return observations
    .filter((observation) => observation.source === source)
    .sort((left, right) => right.popularity - left.popularity || left.id.localeCompare(right.id));
}

function firstValue<T>(
  observations: Observation[],
  ladder: ObservationSource[],
  pick: (observation: Observation) => T | null | undefined,
): { value: T | null; source: ObservationSource | null; observation: Observation | null } {
  for (const source of ladder) {
    for (const observation of bySource(observations, source)) {
      const value = pick(observation);
      if (value != null && value !== '') return { value, source, observation };
    }
  }
  return { value: null, source: null, observation: null };
}

function medianYear(observations: Observation[]): number | null {
  const years = observations
    .map((observation) => observation.releaseYear)
    .filter((year): year is number => year != null)
    .sort((left, right) => left - right);
  return years.length ? years[Math.floor(years.length / 2)] : null;
}

function saneYear(year: number, consensusYear: number | null): boolean {
  return consensusYear == null || Math.abs(year - consensusYear) <= 1;
}

function saneDay(date: string, consensusYear: number | null): boolean {
  return !date.endsWith('-01-01') && saneYear(Number(date.slice(0, 4)), consensusYear);
}

function chooseFormatDate(observations: Observation[], sources: ObservationSource[], clusterYear: number | null): DateChoice {
  const group = observations.filter((observation) => sources.includes(observation.source));
  if (group.length === 0) return { value: null, precision: null, source: null };
  // An audiobook ships on its own schedule, often years after the text edition it narrates, so each
  // format's dates are judged against that format's own consensus. Policing them with the
  // cluster-wide median would reject a genuine later audio date as an outlier and back-date it.
  const consensusYear = medianYear(group) ?? clusterYear;
  const candidates = sources.flatMap((source) =>
    bySource(observations, source)
      .filter((observation) => observation.releaseDate)
      .map((observation) => ({ value: observation.releaseDate!, source })),
  );
  const valid = candidates.find((candidate) => saneDay(candidate.value, consensusYear));
  if (valid) return { value: valid.value, precision: 'day', source: valid.source };

  // The year fallback must apply the same sanity test: otherwise the outlier whose day-date was just
  // rejected walks straight back in through its own year.
  const yearChoice = firstValue(observations, sources, (observation) =>
    observation.releaseYear != null && saneYear(observation.releaseYear, consensusYear) ? observation.releaseYear : null,
  );
  const fallbackYear = yearChoice.value ?? consensusYear;
  if (fallbackYear == null) return { value: null, precision: null, source: null };
  return {
    value: String(fallbackYear),
    precision: 'year',
    source: yearChoice.value == null ? 'consensus' : yearChoice.source,
  };
}

function rawRecord(observation: Observation): Record<string, unknown> {
  return typeof observation.raw === 'object' && observation.raw !== null ? (observation.raw as Record<string, unknown>) : {};
}

function scalarId(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function providerId(observation: Observation): string {
  const raw = rawRecord(observation);
  if (observation.source === 'hardcover') return scalarId(raw.slug ?? raw.id, observation.id.replace(/^hc:/, ''));
  if (observation.source === 'goodreads') return scalarId(raw.bookId, observation.id.replace(/^gr:/, ''));
  return observation.asin ?? scalarId(raw.asin, observation.id.replace(/^aud:/, ''));
}

function compilationFlag(observation: Observation): boolean {
  const raw = rawRecord(observation);
  return observation.source === 'hardcover' && raw.compilation === true;
}

function seriesKey(name: string): string {
  return normalizeText(name).replace(/\bversus\b/g, 'vs');
}

function mergeSeriesMemberships(observations: Observation[]): SeriesMembership[] {
  // Hardcover is the series authority; Audible/Goodreads carry unreliable variant spellings
  // ("Alcatraz versus ...") that would fan a book into duplicate groups. Take memberships from the
  // Hardcover editions only (already deduped and junk-filtered by the Hardcover mapper).
  const hardcover = observations.filter((observation) => observation.source === 'hardcover');
  const source = hardcover.length ? hardcover : observations;
  const memberships = new Map<string, SeriesMembership>();
  for (const observation of source) {
    for (const membership of observation.seriesMemberships ?? []) {
      const name = membership.name.trim();
      if (!name) continue;
      const key = seriesKey(name);
      const current = memberships.get(key);
      if (!current) memberships.set(key, { name, index: membership.index });
      else if (current.index == null && membership.index != null) current.index = membership.index;
    }
  }
  // Collapse a short alias into the fuller series name: Hardcover lists "Alcatraz" AND "Alcatraz vs.
  // the Evil Librarians" for the same book, and the short one is a duplicate of the longer.
  const kept = [...memberships.entries()];
  const result: SeriesMembership[] = [];
  for (const [key, membership] of kept) {
    const supersededBy = kept.find(([otherKey]) => otherKey !== key && (otherKey.startsWith(`${key} `) || otherKey === key));
    if (supersededBy && supersededBy[0].length > key.length) {
      if (supersededBy[1].index == null && membership.index != null) supersededBy[1].index = membership.index;
      continue;
    }
    result.push({ name: membership.name, index: membership.index });
  }
  return result;
}

const ENGLISH_STOPWORDS = new Set([
  'the',
  'of',
  'and',
  'to',
  'a',
  'in',
  'is',
  'that',
  'with',
  'for',
  'on',
  'as',
  'his',
  'her',
  'he',
  'she',
  'they',
  'this',
  'from',
  'by',
  'an',
  'are',
  'was',
  'which',
  'but',
  'not',
  'have',
  'has',
  'it',
  'at',
  'be',
  'when',
  'who',
  'their',
]);

// Fraction of a description's words that are common English function words. A long English blurb scores
// high; German/Italian/Spanish translations score near zero, so an English description wins even when a
// foreign one is longer (Hardcover's canonical book often carries a translated description).
function englishScore(text: string): number {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return 0;
  return words.filter((word) => ENGLISH_STOPWORDS.has(word)).length / words.length;
}

export function mergeCluster(cluster: WorkCluster, today: string): MergedWork {
  const observations = [...cluster.observations].sort(
    (left, right) => left.source.localeCompare(right.source) || right.popularity - left.popularity || left.id.localeCompare(right.id),
  );
  if (observations.length === 0) throw new RangeError('Cannot merge an empty observation cluster');

  const hardcover = bySource(observations, 'hardcover');
  const canonicalHardcover = hardcover.filter((observation) => !observation.canonicalId)[0] ?? hardcover[0];
  const titleChoice = firstValue(observations, ['goodreads', 'audible'], (observation) => observation.title);
  const title = canonicalHardcover?.title || titleChoice.value || observations[0].title;
  const titleObservation = canonicalHardcover ?? titleChoice.observation ?? observations[0];
  const subtitle = firstValue(observations, ['hardcover', 'goodreads', 'audible'], (observation) => observation.subtitle).value;
  const consensusYear = medianYear(observations);
  const ebook = chooseFormatDate(observations, ['hardcover', 'goodreads'], consensusYear);
  const audio = chooseFormatDate(observations, ['audible'], consensusYear);
  const series = firstValue(observations, ['hardcover', 'audible', 'goodreads'], (observation) => observation.seriesName);
  const seriesIndex = series.observation?.seriesIndex ?? null;
  // Covers come from Hardcover only, preferring the dominant edition's art. Audible covers are often
  // audiobook/GraphicAudio adaptation art or low-resolution crops, so they are never used here.
  const cover: { value: string | null; source: ObservationSource | null } = canonicalHardcover?.cover
    ? { value: canonicalHardcover.cover, source: 'hardcover' }
    : firstValue(observations, ['hardcover'], (observation) => observation.cover);
  const description =
    observations
      .map((observation) => observation.description?.trim() || null)
      .filter((value): value is string => value != null)
      .sort((left, right) => englishScore(right) - englishScore(left) || right.length - left.length)[0] ?? null;
  const sources = [...new Set(observations.map((observation) => observation.source))];
  const popularity: Partial<Record<ObservationSource, number>> = {};
  const providerWorkIds: Partial<Record<ObservationSource, string>> = {};
  for (const source of sources) {
    const ranked = bySource(observations, source);
    popularity[source] = Math.max(...ranked.map((observation) => observation.popularity || 0));
    if (ranked[0]) providerWorkIds[source] = providerId(ranked[0]);
  }

  // A work is unreleased when its OWN earliest release is still ahead. Deriving this from the latest
  // raw edition date instead let a single far-future placeholder edition mark a long-released work as
  // upcoming, which then bypasses the popularity floor in the verdict step. The chosen format dates
  // are the dominant editions' dates and have already passed the sanity filter above.
  const chosenDates = [ebook.value, audio.value].filter((value): value is string => value != null).sort();
  const earliestRelease = chosenDates[0] ?? null;
  const unreleased = earliestRelease
    ? earliestRelease.length > 4
      ? earliestRelease >= today
      : Number(earliestRelease) >= Number(today.slice(0, 4))
    : observations.some((observation) => (observation.releaseYear ?? 0) >= Number(today.slice(0, 4)));
  const releaseYears = [ebook.value, audio.value]
    .filter((value): value is string => value != null)
    .map((value) => Number(value.slice(0, 4)))
    .filter(Number.isFinite);
  const releaseYear = releaseYears[0] ?? consensusYear;
  const hardcoverRoles = hardcover.map((observation) => observation.role).filter((role): role is string => Boolean(role));

  return {
    title,
    subtitle,
    coreTitle: normalizeCore(titleObservation.title, titleObservation.seriesName),
    ebookReleaseDate: ebook.value,
    ebookDatePrecision: ebook.precision,
    ebookDateSource: ebook.source,
    audioReleaseDate: audio.value,
    audioDatePrecision: audio.precision,
    audioDateSource: audio.source,
    releaseYear,
    seriesName: series.value,
    seriesIndex,
    seriesMemberships: mergeSeriesMemberships(observations),
    seriesSource: series.source,
    cover: cover.value,
    coverSource: cover.source,
    description,
    hasDesc: observations.some((observation) => observation.hasDesc),
    sources,
    providerWorkIds,
    popularity,
    unreleased,
    // Reflect the DOMINANT edition, not any edition: a real book with one box-set edition folded in
    // (or a stray mis-canonical'd omnibus) must not be flagged a compilation. The winning hardcover
    // edition defines the work's identity; the title pattern in the verdict still catches true box sets.
    compilationFlag: compilationFlag(canonicalHardcover ?? titleObservation),
    allRolesNonAuthor:
      hardcover.length > 0 &&
      hardcoverRoles.length === hardcover.length &&
      hardcoverRoles.every((role) => !/^(author|writer)$/i.test(role)) &&
      sources.length === 1,
    allForeign: (() => {
      const languages = observations
        .map((observation) => observation.language?.toLowerCase())
        .filter((language): language is string => Boolean(language));
      return languages.length > 0 && !languages.includes('english') && !languages.includes('en');
    })(),
    observations,
  };
}
