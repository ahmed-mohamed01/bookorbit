import { WEB_SERIAL_SERIES_UNIT_KEY } from '@bookorbit/types';
import type { BookDockMetadata, WebSerialMetadataOverride, WebSerialPackaging, WebSerialSeriesMatch } from '@bookorbit/types';
import { htmlToPlainText } from '../../common/utils/html-to-text.utils';
import type { EngineSeries } from './engines/web-serial-engine';

const BARE_CHAPTER = /^(?:(?:volume|vol\.?)\s*\d+(?:\.\d+)?\s*[,:.\-–]?\s*)?(?:chapter|chap\.?|ch\.?|episode|ep\.?|#)?\s*\d+(?:\.\d+)?$/i;
const BARE_VOLUME = /^(?:volume|vol\.?)\s*\d+(?:\.\d+)?$/i;
// Sources often repeat the number in the name ("Chapter 2: The Priest's Lie"); the heading already carries it.
const LEADING_CHAPTER =
  /^(?:(?:volume|vol\.?)\s*\d+(?:\.\d+)?\s*[,:.\-–]?\s*)?(?:chapter|chap\.?|ch\.?|episode|ep\.?)\s*\d+(?:\.\d+)?\s*[:.\-–]?\s*/i;
const LEADING_VOLUME = /^(?:volume|vol\.?)\s*\d+(?:\.\d+)?\s*[:.\-–]?\s*/i;
const TITLE_MAX = 500;
const SERIES_INDEX_PATTERN = /^[0-9]+([.][0-9]+)?$/;
const GROWING_VOLUME = /^(volume-\d+|vol:[^:]+):(\d+(?:\.\d+)?-\d+(?:\.\d+)?)$/;
const LNCRAWL_RANGED_VOLUME = /^([^:]+):(\d+-\d+)$/;

export interface UnitMetadataInput {
  label: string;
  sequence: string;
  publishedAt?: string | null;
  /** The chapters a still-growing last volume holds (`201-250`), so a later, longer copy files as a book of its own. */
  chapterRange?: string | null;
}

/**
 * The range a short LNReader volume (`volume-20:1901-1950`), the last lightnovel-crawler volume (`<volume id>:101-150`)
 * or the growing volume of an ongoing manga (`vol:12:100-103`) carries in its key. Its title shows it: the Book Dock
 * refuses a second book of the same title, and a grown copy is one.
 */
export function growingVolumeRange(unitKey: string, seriesKey = ''): string | null {
  const pattern = seriesKey.startsWith('n:') ? LNCRAWL_RANGED_VOLUME : GROWING_VOLUME;
  return pattern.exec(unitKey)?.[2] ?? null;
}

/** A volume key without the range a growing volume carries, so two copies of one volume compare equal. */
export function volumeKeyBase(unitKey: string, seriesKey = ''): string | null {
  const pattern = seriesKey.startsWith('n:') ? LNCRAWL_RANGED_VOLUME : GROWING_VOLUME;
  const match = pattern.exec(unitKey);
  if (match) return match[1]!;
  if (seriesKey.startsWith('n:')) return unitKey === WEB_SERIAL_SERIES_UNIT_KEY ? null : unitKey;
  return /^(?:volume-\d+|vol:[^:]+)$/.test(unitKey) ? unitKey : null;
}

export interface WebSerialJobMetadataSnapshot {
  override?: WebSerialMetadataOverride;
  match?: WebSerialSeriesMatch | null;
}

export function resolveWebSerialAuthors(series: EngineSeries, metadata: WebSerialJobMetadataSnapshot): string[] {
  const matched = uniqueStrings(metadata.match?.authors ?? []);
  return uniqueStrings(metadata.override?.authors ?? (matched.length > 0 ? matched : series.authors));
}

export function buildDockMetadata(
  series: EngineSeries,
  unit: UnitMetadataInput,
  packaging: WebSerialPackaging,
  metadata: WebSerialJobMetadataSnapshot = {},
): BookDockMetadata {
  const description = series.synopsis ? htmlToPlainText(series.synopsis, { preserveLineBreaks: true }) || null : null;
  const seriesName = metadata.match?.title || series.title;
  const artists = uniqueStrings(metadata.override?.artists ?? metadata.match?.artists ?? series.artists ?? []);
  const base: BookDockMetadata = {
    authors: resolveWebSerialAuthors(series, metadata),
    description,
    genres: uniqueCaseInsensitive([...series.tags, ...(metadata.match?.genres ?? [])]),
    language: series.language,
    publishedDate: publishedDate(unit.publishedAt),
    ...(artists.length > 0 ? { comicMetadata: { pencillers: artists } } : {}),
  };
  const label = unit.label.trim();

  if (packaging === 'series') {
    const title = series.kind === 'manga' && label && label !== series.title ? `${seriesName}, ${label}` : seriesName;
    return { ...base, title: title.slice(0, TITLE_MAX) };
  }

  const seriesIndex = SERIES_INDEX_PATTERN.test(unit.sequence) ? unit.sequence : null;
  if (packaging === 'chapter') {
    const heading = `${seriesName} Ch. ${unit.sequence}`;
    const name = BARE_CHAPTER.test(label) ? '' : label.replace(LEADING_CHAPTER, '').trim();
    const title = name ? `${heading}: ${name}` : heading;
    return { ...base, title: title.slice(0, TITLE_MAX), seriesName, seriesIndex };
  }
  const heading = `${seriesName}, Volume ${unit.sequence}${unit.chapterRange ? ` (Chapters ${unit.chapterRange})` : ''}`;
  const name = BARE_VOLUME.test(label) ? '' : label.replace(LEADING_VOLUME, '').trim();
  const title = name ? `${heading}: ${name}` : heading;
  return { ...base, title: title.slice(0, TITLE_MAX), seriesName, seriesIndex };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueCaseInsensitive(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function publishedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
