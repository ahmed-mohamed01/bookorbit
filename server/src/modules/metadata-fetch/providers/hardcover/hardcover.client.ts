import { Injectable, Logger } from '@nestjs/common';

import { toBearerAuthorization } from '../../../../common/utils/bearer-token.utils';
import { fetchWithThrottle } from '../../fetch-with-throttle';
import { ProviderThrottleError } from '../../provider-throttle.error';
import { PROVIDER_DELAYS_MS, PROVIDER_LIMITS, PROVIDER_TIMEOUT_MS } from '../provider-constants';
import { buildRequestSignal, sanitizeLogError, sleep } from '../provider-utils';
import {
  HardcoverAuthorSearchDocument,
  HardcoverAuthorSearchResponse,
  HardcoverAuthorWithContributions,
  HardcoverAuthorContributionsResponse,
  HardcoverBookWithEditions,
  HardcoverBooksResponse,
  HardcoverSearchDocument,
  HardcoverSearchResponse,
} from './hardcover.types';

const GRAPHQL_ENDPOINT = 'https://api.hardcover.app/v1/graphql';

const BOOK_FIELDS = `
  id
  slug
  title
  subtitle
  description
  cached_contributors
  featured_book_series { series { name books_count } position }
  rating
  ratings_count
  pages
  release_date
  release_year
  image { url }
`;

const EDITION_FIELDS = `
  id
  title
  subtitle
  cached_contributors
  pages
  release_date
  release_year
  image { url }
  publisher { name }
  isbn_10
  isbn_13
  language { code2 }
  reading_format_id
  audio_seconds
`;

// Fetch several editions on slug lookup so the mapper can rank by format
// instead of resolving to whatever single edition Hardcover returns first.
const EDITION_LOOKUP_LIMIT = 50;

const SEARCH_BY_ISBN_QUERY = `
  query BookSearchByIsbn($isbn: String!) {
    books(where: { editions: { _or: [{ isbn_13: { _eq: $isbn } }, { isbn_10: { _eq: $isbn } }] } }) {
      ${BOOK_FIELDS}
      editions(where: { _or: [{ isbn_13: { _eq: $isbn } }, { isbn_10: { _eq: $isbn } }] }) {
        ${EDITION_FIELDS}
      }
    }
  }
`;

const SEARCH_BOOKS_QUERY = `
  query BookSearch($q: String!, $limit: Int!) {
    search(query: $q, query_type: "Book", per_page: $limit, page: 1) {
      results
    }
  }
`;

const SEARCH_AUTHORS_QUERY = `
  query AuthorSearch($q: String!) {
    search(query: $q, query_type: "Author", per_page: 5, page: 1) {
      results
    }
  }
`;

const FETCH_AUTHOR_CONTRIBUTIONS_QUERY = `
  query AuthorContributions($id: Int!, $off: Int!) {
    authors(where: { id: { _eq: $id } }) {
      id
      name
      books_count
      contributions(limit: 100, offset: $off, order_by: { book: { id: asc } }) {
        contribution
        book {
          id
          slug
          title
          subtitle
          description
          canonical_id
          compilation
          release_date
          release_year
          pages
          users_count
          rating
          ratings_count
          image { url }
          featured_book_series { position series { name books_count } }
          book_series { position series { id name books_count } }
          cached_contributors
          lang_editions: editions(distinct_on: language_id, order_by: [{ language_id: asc }, { users_count: desc }], limit: 5) {
            language {
              code2
            }
          }
        }
      }
    }
  }
`;

const LOOKUP_BY_SLUG_QUERY = `
  query BookBySlug($slug: String!) {
    books(where: { slug: { _eq: $slug } }) {
      ${BOOK_FIELDS}
      editions(limit: ${EDITION_LOOKUP_LIMIT}) {
        ${EDITION_FIELDS}
      }
    }
  }
`;

class RateLimiter {
  private nextAllowedTime = 0;

  async throttle(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const scheduled = Math.max(now, this.nextAllowedTime);
    this.nextAllowedTime = scheduled + PROVIDER_DELAYS_MS.HARDCOVER_RATE_LIMIT;
    const wait = scheduled - now;
    if (wait > 0) {
      await sleep(wait, signal);
    }
  }
}

@Injectable()
export class HardcoverClient {
  private readonly logger = new Logger(HardcoverClient.name);
  private readonly rateLimiter = new RateLimiter();

  async searchByIsbn(isbn: string, apiKey: string, signal?: AbortSignal): Promise<HardcoverBookWithEditions[]> {
    const body = await this.post<HardcoverBooksResponse>('search-by-isbn', SEARCH_BY_ISBN_QUERY, { isbn }, apiKey, signal);
    return body?.data?.books ?? [];
  }

  async searchBooks(query: string, apiKey: string, signal?: AbortSignal): Promise<HardcoverSearchDocument[]> {
    const body = await this.post<HardcoverSearchResponse>(
      'search',
      SEARCH_BOOKS_QUERY,
      { q: query, limit: PROVIDER_LIMITS.DEFAULT_SEARCH_RESULTS },
      apiKey,
      signal,
    );
    return body?.data?.search?.results?.hits?.map((h) => h.document).filter((d): d is HardcoverSearchDocument => d != null) ?? [];
  }

  async searchAuthors(query: string, apiKey: string, signal?: AbortSignal): Promise<HardcoverAuthorSearchDocument[]> {
    const body = await this.post<HardcoverAuthorSearchResponse>('author-search', SEARCH_AUTHORS_QUERY, { q: query }, apiKey, signal);
    return (
      body?.data?.search?.results?.hits
        ?.map((hit) => hit.document)
        .filter((document): document is HardcoverAuthorSearchDocument => document != null) ?? []
    );
  }

  async fetchAuthorContributions(
    authorId: number,
    offset: number,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<HardcoverAuthorWithContributions | null> {
    const body = await this.post<HardcoverAuthorContributionsResponse>(
      'author-contributions',
      FETCH_AUTHOR_CONTRIBUTIONS_QUERY,
      { id: authorId, off: offset },
      apiKey,
      signal,
    );
    return body?.data?.authors?.[0] ?? null;
  }

  async lookupBySlug(slug: string, apiKey: string, signal?: AbortSignal): Promise<HardcoverBookWithEditions | null> {
    const body = await this.post<HardcoverBooksResponse>('lookup', LOOKUP_BY_SLUG_QUERY, { slug }, apiKey, signal);
    return body?.data?.books?.[0] ?? null;
  }

  private async post<T>(
    op: 'search-by-isbn' | 'search' | 'lookup' | 'author-search' | 'author-contributions',
    query: string,
    variables: Record<string, unknown>,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<T | null> {
    await this.rateLimiter.throttle(signal);
    const startedAt = Date.now();
    this.logger.log(`[hardcover] [start] op=${op} method=POST`);

    try {
      const res = await fetchWithThrottle(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: toBearerAuthorization(apiKey),
        },
        body: JSON.stringify({ query, variables }),
        signal: buildRequestSignal(PROVIDER_TIMEOUT_MS.DEFAULT, signal),
      });

      if (!res.ok) {
        this.logger.warn(
          `[hardcover] [fail] op=${op} method=POST status=${res.status} durationMs=${Date.now() - startedAt} message="non-ok response"`,
        );
        return null;
      }

      const body = (await res.json()) as T;
      this.logger.log(`[hardcover] [end] op=${op} method=POST status=${res.status} durationMs=${Date.now() - startedAt}`);
      return body;
    } catch (err) {
      if (err instanceof ProviderThrottleError) {
        this.logger.warn(`[hardcover] [fail] op=${op} method=POST durationMs=${Date.now() - startedAt} message="throttled"`);
        throw err;
      }
      this.logger.warn(`[hardcover] [fail] op=${op} method=POST durationMs=${Date.now() - startedAt} message="${sanitizeLogError(err)}"`);
      return null;
    }
  }
}
