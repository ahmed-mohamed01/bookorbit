import { Injectable, Logger } from '@nestjs/common';
import type { ProviderConfigurations } from '@bookorbit/types';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { HardcoverClient } from '../../metadata-fetch/providers/hardcover/hardcover.client';
import type { HardcoverAuthorContribution, HardcoverContributionBook } from '../../metadata-fetch/providers/hardcover/hardcover.types';
import { normalizeText } from '../reconcile/observation-matcher';
import type { Observation, SeriesMembership } from '../reconcile/observation.types';
import type { AuthorBibliographyProvider, BibliographyAuthorRef } from './author-bibliography-provider';

const PAGE_SIZE = 100;
const MAX_CONTRIBUTIONS = 1500;

export function isHardcoverConfigured(config: ProviderConfigurations): boolean {
  return config.hardcover.enabled && Boolean(config.hardcover.apiKey);
}

type HardcoverRawRow = HardcoverAuthorContribution | (HardcoverContributionBook & { contribution?: string | null });

function unwrapRow(row: HardcoverRawRow): { book: HardcoverContributionBook; role: string | null; raw: HardcoverContributionBook } | null {
  if ('book' in row && !('id' in row)) {
    return row.book ? { book: row.book, role: row.contribution ?? null, raw: row.book } : null;
  }
  const book = row as HardcoverContributionBook & { contribution?: string | null };
  return { book, role: book.contribution ?? null, raw: book };
}

// A "series" that is really an adaptation or edition variant, not a reading series. Hardcover carries
// these as extra book_series rows (e.g. "... [Dramatized adaptation]"), which would otherwise fan a
// book out into duplicate near-identical groups.
const JUNK_SERIES_PATTERN = /\[|\bdramatized\b|graphic ?audio|adaptation|box(?:ed)? ?set|collection|omnibus/i;

// Collapse punctuation and "versus" so "Alcatraz vs. the Evil Librarians" and "Alcatraz Versus the
// Evil Librarians" (Hardcover lists both) are one series.
function seriesKey(name: string): string {
  return normalizeText(name).replace(/\bversus\b/g, 'vs');
}

function mapSeriesMemberships(book: HardcoverContributionBook): SeriesMembership[] {
  const memberships = new Map<string, SeriesMembership & { featured: boolean }>();
  const featuredName = book.featured_book_series?.series?.name?.trim() ?? null;
  const featuredKey = featuredName ? seriesKey(featuredName) : null;
  const consider = (name: string | undefined, position: number | string | null | undefined): void => {
    const trimmed = name?.trim();
    if (!trimmed || JUNK_SERIES_PATTERN.test(trimmed)) return;
    const key = seriesKey(trimmed);
    const index = position == null ? null : String(position);
    const featured = key === featuredKey;
    const current = memberships.get(key);
    if (!current) {
      memberships.set(key, { name: trimmed, index, featured });
      return;
    }
    if (current.index == null && index != null) current.index = index;
    // Prefer the featured spelling as the canonical display name for the collapsed key.
    if (featured && !current.featured) {
      current.name = trimmed;
      current.featured = true;
    }
  };
  for (const entry of book.book_series ?? []) consider(entry.series?.name, entry.position);
  consider(featuredName ?? undefined, book.featured_book_series?.position);
  return [...memberships.values()].map(({ name, index }) => ({ name, index }));
}

export function mapHardcoverObservations(rawRows: unknown[]): Observation[] {
  return (rawRows as HardcoverRawRow[]).flatMap((row) => {
    const value = unwrapRow(row);
    if (!value?.book.id || !value.book.title?.trim()) return [];
    const { book, role, raw } = value;
    const series = book.featured_book_series;
    const editionLanguages = (book.lang_editions ?? [])
      .map((edition) => edition.language?.code2?.toLowerCase())
      .filter((code): code is string => Boolean(code));
    const language =
      editionLanguages.length === 0 ? null : editionLanguages.some((code) => code === 'en' || code === 'eng') ? 'english' : editionLanguages[0];
    return [
      {
        source: 'hardcover' as const,
        id: `hc:${book.id}`,
        canonicalId: book.canonical_id != null ? `hc:${book.canonical_id}` : null,
        title: book.title.trim(),
        subtitle: book.subtitle?.trim() || null,
        hasDesc: Boolean(book.description && book.description.length > 50),
        description: book.description?.trim() || null,
        cover: book.image?.url ?? null,
        releaseDate: book.release_date ?? null,
        releaseYear: book.release_year ?? (book.release_date ? Number(book.release_date.slice(0, 4)) : null),
        precision: book.release_date ? ('day' as const) : book.release_year ? ('year' as const) : null,
        seriesName: series?.series?.name?.trim() || null,
        seriesIndex: series?.position == null ? null : String(series.position),
        seriesMemberships: mapSeriesMemberships(book),
        popularity: book.users_count ?? 0,
        popularityKind: 'users' as const,
        format: 'unknown' as const,
        language,
        role,
        isbn10: null,
        isbn13: null,
        asin: null,
        raw,
      },
    ];
  });
}

@Injectable()
export class HardcoverBibliographyProvider implements AuthorBibliographyProvider {
  readonly source = 'hardcover' as const;
  readonly curated = false;
  private readonly logger = new Logger(HardcoverBibliographyProvider.name);

  constructor(private readonly hardcover: HardcoverClient) {}

  isEnabled(config: ProviderConfigurations): boolean {
    return isHardcoverConfigured(config);
  }

  async resolveAuthor(
    name: string,
    config: ProviderConfigurations,
    existingId?: string,
    signal?: AbortSignal,
  ): Promise<BibliographyAuthorRef | null> {
    const startedAt = Date.now();
    try {
      if (!this.isEnabled(config)) return null;
      if (existingId && Number.isSafeInteger(Number(existingId)) && Number(existingId) > 0) {
        return { id: existingId, name, bookCount: null, imageUrl: null };
      }
      const target = normalizeText(name).replace(/ /g, '');
      const matches = (await this.hardcover.searchAuthors(name, config.hardcover.apiKey, signal))
        .filter((hit) => normalizeText(hit.name).replace(/ /g, '') === target)
        .sort((left, right) => (right.books_count ?? 0) - (left.books_count ?? 0));
      const match = matches[0];
      if (!match) return null;
      return {
        id: String(match.id),
        name: match.name,
        bookCount: match.books_count ?? null,
        imageUrl: match.image?.url ?? null,
      };
    } catch (error) {
      this.logFailure('resolve', name, startedAt, error);
      throw error;
    }
  }

  async fetchObservations(authorRef: BibliographyAuthorRef, config: ProviderConfigurations, signal?: AbortSignal): Promise<Observation[]> {
    const startedAt = Date.now();
    this.logger.log(
      `[monitored.provider.hardcover] [start] authorId=${authorRef.id} op=fetch authorName="${sanitizeLogValue(authorRef.name)}" - bibliography fetch started`,
    );
    try {
      if (!this.isEnabled(config)) return [];
      const authorId = Number(authorRef.id);
      if (!Number.isSafeInteger(authorId) || authorId <= 0) return [];
      const rows: HardcoverAuthorContribution[] = [];
      for (let offset = 0; offset < MAX_CONTRIBUTIONS; offset += PAGE_SIZE) {
        const author = await this.hardcover.fetchAuthorContributions(authorId, offset, config.hardcover.apiKey, signal);
        if (!author) throw new Error('Hardcover returned no author contribution page');
        const page = author.contributions ?? [];
        rows.push(...page.slice(0, MAX_CONTRIBUTIONS - rows.length));
        if (page.length < PAGE_SIZE) break;
      }
      const observations = this.toObservations(rows);
      this.logger.log(
        `[monitored.provider.hardcover] [end] authorId=${authorId} op=fetch durationMs=${Date.now() - startedAt} observations=${observations.length} - bibliography fetch completed`,
      );
      return observations;
    } catch (error) {
      this.logFailure('fetch', authorRef.name, startedAt, error);
      throw error;
    }
  }

  toObservations(rawRows: unknown[]): Observation[] {
    return mapHardcoverObservations(rawRows);
  }

  private logFailure(op: string, authorName: string, startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[monitored.provider.hardcover] [fail] op=${op} authorName="${sanitizeLogValue(authorName)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - bibliography provider failed`,
    );
  }
}
