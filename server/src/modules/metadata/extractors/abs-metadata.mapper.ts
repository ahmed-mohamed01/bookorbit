import type { AbsBookMetadata } from './abs-metadata.types';
import type { ParsedBookData } from './format-extractor.interface';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return null;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceYear(value: unknown): number | null {
  const str = coerceString(value);
  if (str === null) return null;
  const year = parseInt(str, 10);
  return Number.isFinite(year) ? year : null;
}

function hoistLegacyWrapper(raw: Record<string, unknown>): Record<string, unknown> {
  const nested = raw.metadata;
  if (isPlainObject(nested)) {
    const hoisted = { ...raw, ...nested };
    delete hoisted.metadata;
    return hoisted;
  }
  return raw;
}

function mapIsbn(value: unknown): { isbn10: string | null; isbn13: string | null } {
  const str = coerceString(value);
  if (str === null) return { isbn10: null, isbn13: null };
  const cleaned = str.replace(/[\s-]/g, '');
  if (/^\d{13}$/.test(cleaned)) return { isbn10: null, isbn13: cleaned };
  if (/^\d{9}[\dXx]$/.test(cleaned)) return { isbn10: cleaned, isbn13: null };
  return { isbn10: null, isbn13: null };
}

const NUMERIC_SEQUENCE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function mapSeries(value: unknown): { seriesName: string | null; seriesIndex: number | null } {
  const [first] = coerceStringArray(value);
  if (first === undefined) return { seriesName: null, seriesIndex: null };

  const match = first.match(/ #([^#\s]+)$/);
  if (match && NUMERIC_SEQUENCE.test(match[1])) {
    const name = first.slice(0, match.index).trim();
    return { seriesName: name.length > 0 ? name : first, seriesIndex: parseFloat(match[1]) };
  }
  return { seriesName: first, seriesIndex: null };
}

function mapChapters(value: unknown): { title: string; startMs: number }[] {
  if (!Array.isArray(value)) return [];
  const chapters: { title: string; startMs: number }[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const title = coerceString(entry.title);
    const start = coerceFiniteNumber(entry.start);
    if (title === null || title.trim().length === 0 || start === null) continue;
    chapters.push({ title, startMs: Math.round(start * 1000) });
  }
  chapters.sort((a, b) => a.startMs - b.startMs);
  return chapters;
}

export function mapAbsMetadata(raw: AbsBookMetadata): ParsedBookData {
  const source = hoistLegacyWrapper(raw as Record<string, unknown>);
  const { isbn10, isbn13 } = mapIsbn(source.isbn);
  const { seriesName, seriesIndex } = mapSeries(source.series);

  return {
    title: coerceString(source.title),
    subtitle: coerceString(source.subtitle),
    description: coerceString(source.description),
    isbn10,
    isbn13,
    publisher: coerceString(source.publisher),
    publishedDate: coerceString(source.publishedDate),
    publishedYear: coerceYear(source.publishedYear),
    language: coerceString(source.language),
    seriesName,
    seriesIndex,
    authors: coerceStringArray(source.authors).map((name) => ({ name, sortName: null })),
    genres: coerceStringArray(source.genres),
    tags: coerceStringArray(source.tags),
    audibleId: coerceString(source.asin),
    narrators: coerceStringArray(source.narrators),
    chapters: mapChapters(source.chapters),
    abridged: coerceBoolean(source.abridged),
    cover: null,
  };
}

export function hasAbsMetadata(data: ParsedBookData): boolean {
  return (
    data.title !== null ||
    data.subtitle !== null ||
    data.description !== null ||
    data.isbn10 !== null ||
    data.isbn13 !== null ||
    data.publisher !== null ||
    data.publishedDate !== null ||
    data.publishedYear !== null ||
    data.language !== null ||
    data.seriesName !== null ||
    data.seriesIndex !== null ||
    data.audibleId !== null ||
    data.abridged !== null ||
    data.authors.length > 0 ||
    data.genres.length > 0 ||
    (data.tags?.length ?? 0) > 0 ||
    (data.narrators?.length ?? 0) > 0 ||
    (data.chapters?.length ?? 0) > 0
  );
}
