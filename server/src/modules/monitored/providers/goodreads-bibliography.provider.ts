import { Injectable, Logger } from '@nestjs/common';
import type { ProviderConfigurations } from '@bookorbit/types';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { fetchWithThrottle } from '../../metadata-fetch/fetch-with-throttle';
import { PROVIDER_DELAYS_MS, PROVIDER_TIMEOUT_MS } from '../../metadata-fetch/providers/provider-constants';
import { buildRequestSignal, sleep, stripHtml } from '../../metadata-fetch/providers/provider-utils';
import { ProviderConfigService } from '../../metadata-preferences/provider-config.service';
import { normalizeText } from '../reconcile/observation-matcher';
import type { Observation } from '../reconcile/observation.types';
import type { AuthorBibliographyProvider, BibliographyAuthorRef } from './author-bibliography-provider';

const HEADERS: HeadersInit = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};
const JSON_HEADERS: HeadersInit = { ...HEADERS, accept: 'application/json,text/plain,*/*' };
const MAX_PAGES = 3;

export interface GoodreadsBibliographyRow {
  title: string;
  bookId: string | null;
  avgRating: string | null;
  ratings: number;
  year: string | number | null;
  expected: boolean;
  editions: string | null;
}

type GoodreadsAutocompleteAuthor = { id: string | number; name: string };
type GoodreadsAutocompleteRow = { author?: GoodreadsAutocompleteAuthor };

function authorKey(name: string): string {
  return normalizeText(name).replace(/ /g, '');
}

function nameVariants(name: string): string[] {
  return [...new Set([name, name.replace(/([a-z])([A-Z])/g, '$1 $2')])];
}

function isWafChallenge(status: number, html: string): boolean {
  return status === 202 || /awsWafCookieDomainList|AwsWafIntegration|id=["']challenge-container["']/.test(html);
}

export function mapGoodreadsObservations(rawRows: unknown[]): Observation[] {
  return (rawRows as GoodreadsBibliographyRow[]).flatMap((row) => {
    if (!row.title?.trim()) return [];
    const seriesMatch = row.title.match(/\(([^,(]+?),?\s*#([\d.]+)\)\s*$/);
    const title = row.title.replace(/\([^)]*#[\d.,\- ]+\)\s*$/, '').trim();
    const releaseYear = row.year == null ? null : Number(row.year);
    const seriesName = seriesMatch?.[1]?.trim() || null;
    const seriesIndex = seriesMatch?.[2] ?? null;
    return [
      {
        source: 'goodreads' as const,
        id: `gr:${row.bookId || normalizeText(row.title)}`,
        canonicalId: null,
        title,
        subtitle: null,
        hasDesc: false,
        description: null,
        cover: null,
        releaseDate: null,
        releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
        precision: releaseYear ? ('year' as const) : null,
        seriesName,
        seriesIndex,
        seriesMemberships: seriesName ? [{ name: seriesName, index: seriesIndex }] : [],
        popularity: row.ratings ?? 0,
        popularityKind: 'ratings' as const,
        format: 'unknown' as const,
        language: null,
        role: null,
        isbn10: null,
        isbn13: null,
        asin: null,
        raw: row,
      },
    ];
  });
}

@Injectable()
export class GoodreadsBibliographyProvider implements AuthorBibliographyProvider {
  readonly source = 'goodreads' as const;
  readonly curated = false;
  private readonly logger = new Logger(GoodreadsBibliographyProvider.name);

  constructor(private readonly providerConfig: ProviderConfigService) {}

  isEnabled(config: ProviderConfigurations): boolean {
    return config.goodreads.enabled;
  }

  async resolveAuthor(name: string, existingId?: string, signal?: AbortSignal): Promise<BibliographyAuthorRef | null> {
    if (existingId) return { id: existingId, name, bookCount: null, imageUrl: null };
    const startedAt = Date.now();
    this.logger.log(`[monitored.provider.goodreads] [start] op=resolve authorName="${sanitizeLogValue(name)}" - author resolution started`);
    try {
      for (const variant of nameVariants(name)) {
        const url = `https://www.goodreads.com/book/auto_complete?format=json&q=${encodeURIComponent(variant)}`;
        const response = await fetchWithThrottle(url, { headers: JSON_HEADERS, signal: buildRequestSignal(PROVIDER_TIMEOUT_MS.SCRAPE, signal) });
        if (!response.ok) continue;
        const rows = (await response.json()) as GoodreadsAutocompleteRow[];
        const match = rows.find((row) => row.author && authorKey(row.author.name) === authorKey(name))?.author;
        if (match) {
          this.logger.log(
            `[monitored.provider.goodreads] [end] authorId="${sanitizeLogValue(String(match.id))}" op=resolve durationMs=${Date.now() - startedAt} found=true - author resolution completed`,
          );
          return { id: String(match.id), name: match.name, bookCount: null, imageUrl: null };
        }
      }
      this.logger.log(
        `[monitored.provider.goodreads] [end] op=resolve durationMs=${Date.now() - startedAt} found=false - author resolution completed`,
      );
      return null;
    } catch (error) {
      this.logFailure('resolve', name, startedAt, error);
      throw error;
    }
  }

  async fetchObservations(authorRef: BibliographyAuthorRef, signal?: AbortSignal): Promise<Observation[]> {
    const startedAt = Date.now();
    this.logger.log(
      `[monitored.provider.goodreads] [start] authorId="${sanitizeLogValue(authorRef.id)}" op=fetch authorName="${sanitizeLogValue(authorRef.name)}" - bibliography fetch started`,
    );
    try {
      const rows: GoodreadsBibliographyRow[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1) await sleep(PROVIDER_DELAYS_MS.GOODREADS_BETWEEN_REQUESTS, signal);
        const url = `https://www.goodreads.com/author/list/${encodeURIComponent(authorRef.id)}?per_page=100&page=${page}`;
        const response = await fetchWithThrottle(url, { headers: HEADERS, redirect: 'follow', signal: buildRequestSignal(30_000, signal) });
        if (!response.ok) throw new Error(`Goodreads list returned HTTP ${response.status}`);
        const html = await response.text();
        if (isWafChallenge(response.status, html)) throw new Error('Goodreads served a bot challenge instead of the author list');
        const chunks = html.split(/class="bookTitle"/).slice(1);
        for (const chunk of chunks) {
          const title = chunk.match(/<span itemprop=.name.[^>]*>([^<]+)</)?.[1];
          if (!title) continue;
          rows.push({
            title: stripHtml(title).trim(),
            bookId: chunk.match(/\/book\/show\/(\d+)/)?.[1] ?? null,
            avgRating: chunk.match(/([\d.]+) avg rating/)?.[1] ?? null,
            ratings: Number((chunk.match(/([\d,]+) ratings?/)?.[1] ?? '0').replace(/,/g, '')),
            year: chunk.match(/(?:expected publication|published)\s+(\d{4})/)?.[1] ?? null,
            expected: /expected publication/.test(chunk),
            editions: chunk.match(/([\d,]+) editions?/)?.[1] ?? null,
          });
        }
        if (chunks.length < 100) break;
      }
      const observations = this.toObservations(rows);
      this.logger.log(
        `[monitored.provider.goodreads] [end] authorId="${sanitizeLogValue(authorRef.id)}" op=fetch durationMs=${Date.now() - startedAt} observations=${observations.length} - bibliography fetch completed`,
      );
      return observations;
    } catch (error) {
      this.logFailure('fetch', authorRef.name, startedAt, error, authorRef.id);
      throw error;
    }
  }

  toObservations(rawRows: unknown[]): Observation[] {
    return mapGoodreadsObservations(rawRows);
  }

  private logFailure(op: string, authorName: string, startedAt: number, error: unknown, authorId?: string): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[monitored.provider.goodreads] [fail]${authorId ? ` authorId="${sanitizeLogValue(authorId)}"` : ''} op=${op} authorName="${sanitizeLogValue(authorName)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - bibliography provider failed`,
    );
  }
}
