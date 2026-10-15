import { baseSeriesTitle, isMachineTranslationTitle, normalizeSerialTitle } from '@bookorbit/types';
import type { WebSerialSeriesKey, WebSerialSourceOption } from '@bookorbit/types';
import type { EngineSearchHit, EngineSeries } from './engines/web-serial-engine';
import { normalizedSourceName } from './web-serials-source.utils';

const MAX_CLASSIFIED_HITS = 12;
const MAX_HITS_PER_SOURCE = 3;

export interface ClassifiedHit {
  hit: EngineSearchHit & { remoteId: string };
  seriesKey: WebSerialSeriesKey;
  confidence: 'same_series' | 'title_match';
}

/** whole_series: the source carries the whole series while the database files the wanted part on its own. */
export type SourceConfidence = ClassifiedHit['confidence'] | 'whole_series';

export interface LoadedSourceCandidate extends Omit<ClassifiedHit, 'confidence'> {
  confidence: SourceConfidence;
  series: EngineSeries;
}

export interface SourceCandidates {
  candidates: LoadedSourceCandidate[];
  failedSources: string[];
}

export const TIMED_OUT = Symbol('timed_out');

export async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()));
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Title-equal hits first, then at most a few per source and a bounded total, so one preview cannot fan out to hundreds of lookups. */
export function shortlistHits<T extends { title: string; sourceName: string }>(
  hits: T[],
  wantedTitles: readonly string[],
  wantedBases: ReadonlySet<string> = new Set(),
): T[] {
  const wanted = new Set(wantedTitles.map(normalizeSerialTitle));
  const closeness = (title: string) => (wanted.has(normalizeSerialTitle(title)) ? 0 : wantedBases.has(baseSeriesTitle(title)) ? 1 : 2);
  const ranked = [...hits].sort(
    (left, right) =>
      closeness(left.title) - closeness(right.title) ||
      Number(isMachineTranslationTitle(left.title)) - Number(isMachineTranslationTitle(right.title)),
  );
  const perSource = new Map<string, number>();
  const picked: T[] = [];
  for (const hit of ranked) {
    const source = normalizedSourceName(hit.sourceName);
    const count = perSource.get(source) ?? 0;
    if (count >= MAX_HITS_PER_SOURCE) continue;
    perSource.set(source, count + 1);
    picked.push(hit);
    if (picked.length >= MAX_CLASSIFIED_HITS) break;
  }
  return picked;
}

/** A source's machine-translated copy is only picked when it has nothing else of the series. */
export function pickOnePerSource<T extends { hit: { sourceName: string; title: string }; confidence: SourceConfidence }>(entries: T[]): T[] {
  const ordered = [...entries].sort(
    (left, right) =>
      Number(isMachineTranslationTitle(left.hit.title)) - Number(isMachineTranslationTitle(right.hit.title)) ||
      Number(right.confidence === 'same_series') - Number(left.confidence === 'same_series'),
  );
  const seen = new Set<string>();
  return ordered.filter((entry) => {
    const source = normalizedSourceName(entry.hit.sourceName);
    if (seen.has(source)) return false;
    seen.add(source);
    return true;
  });
}

export function latestPublishedAt(series: EngineSeries): string | null {
  let latest: { value: string; timestamp: number } | null = null;
  for (const unit of series.units) {
    if (!unit.publishedAt) continue;
    const timestamp = Date.parse(unit.publishedAt);
    if (!Number.isFinite(timestamp)) continue;
    if (!latest || timestamp > latest.timestamp) latest = { value: unit.publishedAt, timestamp };
  }
  return latest?.value ?? null;
}

/**
 * Source options for a series matched in the details database: confirmed copies of the series before title-only ones, the
 * most complete first within each (a machine translation, then a whole-series copy of a part, only after the rest).
 */
export function rankDiscoverOptions(candidates: readonly LoadedSourceCandidate[]): WebSerialSourceOption[] {
  const options = candidates.map(({ seriesKey, series, confidence, hit }): WebSerialSourceOption => {
    const option: WebSerialSourceOption = {
      seriesKey,
      sourceName: series.sourceName,
      title: series.title,
      chapterCount: series.chapterCount,
      latestAt: latestPublishedAt(series),
      confidence,
      mostComplete: false,
    };
    if (isMachineTranslationTitle(hit.title) || isMachineTranslationTitle(series.title)) option.mtl = true;
    return option;
  });
  options.sort(
    (left, right) =>
      Number(left.mtl === true) - Number(right.mtl === true) ||
      Number(left.confidence === 'whole_series') - Number(right.confidence === 'whole_series') ||
      Number(right.confidence === 'same_series') - Number(left.confidence === 'same_series') ||
      right.chapterCount - left.chapterCount ||
      left.sourceName.localeCompare(right.sourceName),
  );
  if (options[0]) options[0].mostComplete = true;
  return options;
}
