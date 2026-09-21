import type { MonitoredFormat } from '@bookorbit/types';

import type { HardcoverEditionsProbeBook } from '../../metadata-fetch/providers/hardcover/hardcover.types';
import type { EditionEvidence, HardcoverEvidence, HardcoverProbeBook, HardcoverProbeEdition } from './release-probe.types';

export type EditionFormat = MonitoredFormat | 'physical';

const FORMAT_BY_ID: Record<number, EditionFormat | undefined> = { 1: 'physical', 2: 'audiobook', 4: 'ebook' };

function isbn13To10(value: string): string | null {
  const digits = value.replace(/[^0-9]/g, '');
  if (!/^978\d{10}$/.test(digits)) return null;
  const body = digits.slice(3, 12);
  const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const remainder = (11 - (sum % 11)) % 11;
  return `${body}${remainder === 10 ? 'X' : remainder}`;
}

const FAR_FUTURE_DAYS = 548;

function isPlaceholderDate(value: string): boolean {
  return value.endsWith('-01-01') || value.endsWith('-12-31');
}

function daysAfterToday(date: string, today: string): number {
  return (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000;
}

export function isStrongEdition(edition: HardcoverProbeEdition, today: string): boolean {
  // A listing this far out is an announcement rather than something anybody can buy, and its ids
  // routinely turn out dead, so no identifier makes it strong.
  if (edition.releaseDate && daysAfterToday(edition.releaseDate, today) > FAR_FUTURE_DAYS) return false;
  return edition.asin !== null || edition.isbn13 !== null || edition.isbn10 !== null || edition.usersCount >= 10;
}

/**
 * The language a book is mostly edited in, so a non-English work is not stripped of every edition.
 * The most shelved edition that declares a language wins; editions with no language stay in.
 */
export function dominantLanguage(book: HardcoverProbeBook): string | null {
  let dominant: HardcoverProbeEdition | null = null;
  for (const edition of book.editions) {
    if (edition.languageCode === null) continue;
    if (dominant === null || edition.usersCount > dominant.usersCount) dominant = edition;
  }
  return dominant?.languageCode ?? null;
}

export function editionsForFormat(format: EditionFormat, book: HardcoverProbeBook, language: string | null): HardcoverProbeEdition[] {
  return book.editions.filter(
    (edition) =>
      FORMAT_BY_ID[edition.readingFormatId ?? -1] === format &&
      (language === null || edition.languageCode === null || edition.languageCode === language),
  );
}

function seedsFrom(editions: HardcoverProbeEdition[]): string[] {
  const seeds: string[] = [];
  const seen = new Set<string>();
  for (const edition of editions) {
    for (const seed of [edition.asin, edition.isbn10, edition.isbn13 ? isbn13To10(edition.isbn13) : null]) {
      if (seed && !seen.has(seed)) {
        seen.add(seed);
        seeds.push(seed);
      }
    }
  }
  return seeds;
}

function evidenceFor(format: MonitoredFormat, book: HardcoverProbeBook, today: string, language: string | null): EditionEvidence {
  const editions = editionsForFormat(format, book, language);
  const seeds = seedsFrom(editions);

  const dated = editions.filter((edition) => edition.releaseDate !== null);
  const precise = dated
    .filter((edition) => /^\d{4}-\d{2}-\d{2}$/.test(edition.releaseDate!) && !isPlaceholderDate(edition.releaseDate!))
    .sort((a, b) => a.releaseDate!.localeCompare(b.releaseDate!));
  if (precise.length > 0) {
    // A zero-user placeholder dated earlier must not mask a real edition, so the earliest edition
    // that somebody can actually buy or has shelved wins over the earliest edition overall.
    const strong = precise.find((edition) => isStrongEdition(edition, today));
    const chosen = strong ?? precise[0];
    return { count: editions.length, date: chosen.releaseDate, precision: 'day', strength: strong ? 'strong' : 'weak', seeds };
  }

  if (dated.length > 0) {
    const year = dated.map((edition) => edition.releaseDate!.slice(0, 4)).sort()[0];
    const bookDate = book.releaseDate;
    if (bookDate && /^\d{4}-\d{2}-\d{2}$/.test(bookDate) && bookDate.startsWith(`${year}-`) && !isPlaceholderDate(bookDate)) {
      return { count: editions.length, date: bookDate, precision: 'day', strength: 'weak', seeds };
    }
    return { count: editions.length, date: year, precision: 'year', strength: 'weak', seeds };
  }

  return { count: editions.length, date: null, precision: null, strength: null, seeds };
}

export function buildHardcoverEvidence(book: HardcoverProbeBook, today: string): HardcoverEvidence {
  const language = dominantLanguage(book);
  const physical = editionsForFormat('physical', book, language);
  return {
    ebook: evidenceFor('ebook', book, today, language),
    audiobook: evidenceFor('audiobook', book, today, language),
    physical: { count: physical.length, seeds: seedsFrom(physical) },
  };
}

export function mapHardcoverProbeBook(raw: HardcoverEditionsProbeBook): HardcoverProbeBook {
  return {
    slug: raw.slug,
    releaseDate: raw.release_date,
    editions: raw.editions.map((edition): HardcoverProbeEdition => ({
      readingFormatId: edition.reading_format_id,
      releaseDate: edition.release_date,
      asin: edition.asin,
      isbn13: edition.isbn_13,
      isbn10: edition.isbn_10,
      usersCount: edition.users_count ?? 0,
      languageCode: edition.language?.code2 ?? null,
    })),
  };
}
