import { Injectable, Logger } from '@nestjs/common';

import { toBearerAuthorization } from '../../../../common/utils/bearer-token.utils';
import { fetchWithThrottle } from '../../fetch-with-throttle';
import { ProviderThrottleError } from '../../provider-throttle.error';
import { HardcoverRequestError } from './hardcover.errors';
import { PROVIDER_DELAYS_MS, PROVIDER_LIMITS, PROVIDER_TIMEOUT_MS } from '../provider-constants';
import { buildRequestSignal, sanitizeLogError, sleep } from '../provider-utils';
import {
  HardcoverAuthorSearchDocument,
  HardcoverAuthorSearchResponse,
  HardcoverAuthorWithContributions,
  HardcoverAuthorContributionsResponse,
  HardcoverBookWithEditions,
  HardcoverBooksResponse,
  HardcoverEditionsBySlugsResponse,
  HardcoverEditionsProbeBook,
  HardcoverSearchDocument,
  HardcoverSearchResponse,
} from './hardcover.types';

const GRAPHQL_ENDPOINT = 'https://api.hardcover.app/v1/graphql';

/**
 * `surfaceFailures` turns a failed request into a thrown HardcoverRequestError instead of the null
 * every caller here has always received. It is opt-in per call because the metadata providers rely
 * on a failure reading as "nothing found", while the bibliography path must be able to tell the two
 * apart before it decides to persist a catalog.
 */
export interface HardcoverRequestOptions {
  surfaceFailures?: boolean;
}

const BOOK_FIELDS = `
  id
  slug
  title
  subtitle
  description
  cached_contributors
  cached_tags
  featured_book_series { series { name books_count } position }
  rating
  ratings_count
  pages
  release_date
  release_year
  image { url width height }
`;

const EDITION_FIELDS = `
  id
  title
  subtitle
  cached_contributors
  pages
  release_date
  release_year
  image { url width height }
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
      contributions(
        # Roughly 65% of rows are edition-level (contributable_type "Edition") and return book: null,
        # so filter them server-side before pagination spends its budget.
        where: { contributable_type: { _eq: "Book" } }
        limit: 100
        offset: $off
        order_by: { book: { id: asc } }
      ) {
        contribution
        contributor_role_id
        book {
          ${BOOK_FIELDS}
          canonical_id
          compilation
          users_count
          featured_book_series { series { id } }
          book_series { position series { id name books_count } }
          book_status { id name }
          book_category_id
          users_read_count
          editions_count
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

const PROBE_EDITION_FIELDS = `
  reading_format_id
  release_date
  asin
  isbn_13
  isbn_10
  users_count
  language { code2 }
`;

const EDITIONS_BY_SLUGS_QUERY = `
  query EditionsBySlugs($slugs: [String!]!) {
    books(where: { slug: { _in: $slugs } }) {
      slug
      release_date
      ebook_editions: editions(where: { reading_format_id: { _eq: 4 } }, order_by: { users_count: desc }, limit: 15) {
        ${PROBE_EDITION_FIELDS}
      }
      audio_editions: editions(where: { reading_format_id: { _eq: 2 } }, order_by: { users_count: desc }, limit: 15) {
        ${PROBE_EDITION_FIELDS}
      }
      print_editions: editions(where: { reading_format_id: { _eq: 1 } }, order_by: { users_count: desc }, limit: 15) {
        ${PROBE_EDITION_FIELDS}
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

  async searchAuthors(
    query: string,
    apiKey: string,
    signal?: AbortSignal,
    options?: HardcoverRequestOptions,
  ): Promise<HardcoverAuthorSearchDocument[]> {
    const body = await this.post<HardcoverAuthorSearchResponse>('author-search', SEARCH_AUTHORS_QUERY, { q: query }, apiKey, signal, options);
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
    options?: HardcoverRequestOptions,
  ): Promise<HardcoverAuthorWithContributions | null> {
    const body = await this.post<HardcoverAuthorContributionsResponse>(
      'author-contributions',
      FETCH_AUTHOR_CONTRIBUTIONS_QUERY,
      { id: authorId, off: offset },
      apiKey,
      signal,
      options,
    );
    return body?.data?.authors?.[0] ?? null;
  }

  async lookupBySlug(slug: string, apiKey: string, signal?: AbortSignal): Promise<HardcoverBookWithEditions | null> {
    const body = await this.post<HardcoverBooksResponse>('lookup', LOOKUP_BY_SLUG_QUERY, { slug }, apiKey, signal);
    return body?.data?.books?.[0] ?? null;
  }

  async fetchEditionsBySlugs(
    slugs: string[],
    apiKey: string,
    signal?: AbortSignal,
    options?: HardcoverRequestOptions,
  ): Promise<HardcoverEditionsProbeBook[]> {
    if (slugs.length === 0) return [];
    const body = await this.post<HardcoverEditionsBySlugsResponse>('editions-by-slugs', EDITIONS_BY_SLUGS_QUERY, { slugs }, apiKey, signal, options);
    return (body?.data?.books ?? []).map((book) => ({
      slug: book.slug,
      release_date: book.release_date,
      editions: [...(book.ebook_editions ?? []), ...(book.audio_editions ?? []), ...(book.print_editions ?? [])],
    }));
  }

  private async post<T>(
    op: 'search-by-isbn' | 'search' | 'lookup' | 'author-search' | 'author-contributions' | 'editions-by-slugs',
    query: string,
    variables: Record<string, unknown>,
    apiKey: string,
    signal?: AbortSignal,
    options?: HardcoverRequestOptions,
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
        if (options?.surfaceFailures) throw new HardcoverRequestError(op, res.status);
        return null;
      }

      const body = (await res.json()) as T;
      // GraphQL reports a refused or half-served query as errors beside a 200, so an opted-in caller
      // has to read them: unread, they reach it as an author with no book, or as a contributions page
      // that ends pagination early and silently shortens the catalog.
      const errors = (body as { errors?: unknown } | null)?.errors;
      if (options?.surfaceFailures && Array.isArray(errors) && errors.length > 0) {
        this.logger.warn(
          `[hardcover] [fail] op=${op} method=POST status=${res.status} durationMs=${Date.now() - startedAt} errors=${errors.length} message="graphql errors"`,
        );
        throw new HardcoverRequestError(op, res.status, { cause: errors });
      }
      this.logger.log(`[hardcover] [end] op=${op} method=POST status=${res.status} durationMs=${Date.now() - startedAt}`);
      return body;
    } catch (err) {
      if (err instanceof ProviderThrottleError) {
        this.logger.warn(`[hardcover] [fail] op=${op} method=POST durationMs=${Date.now() - startedAt} message="throttled"`);
        throw err;
      }
      // The branches above throw from inside the try, so their error arrives here already shaped.
      if (options?.surfaceFailures && err instanceof HardcoverRequestError) throw err;
      this.logger.warn(`[hardcover] [fail] op=${op} method=POST durationMs=${Date.now() - startedAt} message="${sanitizeLogError(err)}"`);
      if (options?.surfaceFailures) {
        // A caller that aborted its own request wants that abort, not a report that Hardcover is down.
        // Identity, not `signal.aborted`: the composite signal carries whichever source reason fired,
        // so an internal timeout stays a timeout even once the caller aborts a moment later.
        if (signal?.aborted && err === signal.reason) throw err;
        throw new HardcoverRequestError(op, null, { cause: err });
      }
      return null;
    }
  }
}
