import { Injectable, Logger } from '@nestjs/common';

import { markProviderDegraded, markProviderFailed } from '../../../../common/provider-cache/provider-call-context';
import { toBearerAuthorization } from '../../../../common/utils/bearer-token.utils';
import { fetchWithThrottle } from '../../fetch-with-throttle';
import { ProviderThrottleError } from '../../provider-throttle.error';
import { HardcoverRequestError } from './hardcover.errors';
import { PROVIDER_DELAYS_MS, PROVIDER_LIMITS, PROVIDER_TIMEOUT_MS } from '../provider-constants';
import { buildRequestSignal, sanitizeLogError, sleep } from '../provider-utils';
import {
  HardcoverAuthorSearchDocument,
  HardcoverAuthorSearchResponse,
  HardcoverBookAndAuthorSearchResponse,
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
  timeoutMs?: number;
  surfaceFailures?: boolean;
}
// The series total feeds the series gap finder, which reads it as the last book number, so it
// must be a released main-series number. books_count also counts novellas, split editions, box
// sets and announced books. Translations carry their own odd numbering, so only canonical books
// are considered.
const SERIES_FIELDS = `
  name
  primary_books_count
  latest_released: book_series(
    where: {
      position: { _is_null: false }
      compilation: { _eq: false }
      book: { canonical_id: { _is_null: true }, release_date: { _lte: $releasedBy } }
    }
    order_by: { position: desc }
    limit: 1
  ) { position }
`;

const BOOK_FIELDS = `
  id
  slug
  title
  subtitle
  description
  cached_contributors
  cached_tags
  featured_book_series { series { ${SERIES_FIELDS} } position }
  book_series { position series { name } }
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
  query BookSearchByIsbn($isbn: String!, $releasedBy: date!) {
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

// The default book search also matches titles, which ranks books about an author (quiz books,
// companions, diaries) above the ones they wrote. Each field searched needs its own weight and typo
// allowance, or the search answers with an error instead of hits.
const SEARCH_BOOKS_BY_AUTHOR_QUERY = `
  query BookSearchByAuthor($q: String!, $limit: Int!) {
    search(query: $q, query_type: "Book", per_page: $limit, page: 1, fields: "author_names", weights: "1", typos: "1") {
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

// Both searches in one request, so a caller that needs books and authors takes one rate-limit slot.
const SEARCH_BOOKS_AND_AUTHORS_QUERY = `
  query BookAndAuthorSearch($q: String!, $limit: Int!) {
    books: search(query: $q, query_type: "Book", per_page: $limit, page: 1) {
      results
    }
    authors: search(query: $q, query_type: "Author", per_page: 5, page: 1) {
      results
    }
  }
`;

const FETCH_AUTHOR_CONTRIBUTIONS_QUERY = `
  query AuthorContributions($id: Int!, $off: Int!, $releasedBy: date!) {
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
  query BookBySlug($slug: String!, $releasedBy: date!) {
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

  queueDelayMs(): number {
    return Math.max(0, this.nextAllowedTime - Date.now());
  }
}

// Deliberately not part of the provider cache key, which would expire every answer at midnight. A
// cached answer from before a release can only undercount, and stored series totals only rise.
function releasedBy(): string {
  return new Date().toISOString().slice(0, 10);
}

// GraphQL reports query and permission faults in a 200 body, sometimes alongside partial data.
function reportGraphqlBodyQuality(body: unknown, op: string): void {
  const record = typeof body === 'object' && body !== null ? (body as { errors?: unknown; data?: unknown }) : null;
  if (!record || record.errors !== undefined || record.data === undefined || record.data === null) {
    markProviderFailed(`hardcover.${op}: graphql error body`);
  }
}

@Injectable()
export class HardcoverClient {
  private readonly logger = new Logger(HardcoverClient.name);
  private readonly rateLimiter = new RateLimiter();

  queueDelayMs(): number {
    return this.rateLimiter.queueDelayMs();
  }

  async searchByIsbn(isbn: string, apiKey: string, signal?: AbortSignal): Promise<HardcoverBookWithEditions[]> {
    const body = await this.post<HardcoverBooksResponse>('search-by-isbn', SEARCH_BY_ISBN_QUERY, { isbn, releasedBy: releasedBy() }, apiKey, signal);
    if (body && !Array.isArray(body.data?.books)) markProviderFailed('hardcover.search-by-isbn: response without books');
    return body?.data?.books ?? [];
  }

  async searchBooks(
    query: string,
    apiKey: string,
    signal?: AbortSignal,
    limit: number = PROVIDER_LIMITS.DEFAULT_SEARCH_RESULTS,
  ): Promise<HardcoverSearchDocument[]> {
    return this.search('search', SEARCH_BOOKS_QUERY, query, apiKey, signal, limit);
  }

  /** The books an author wrote, most read first. */
  async searchBooksByAuthor(
    author: string,
    apiKey: string,
    signal?: AbortSignal,
    limit: number = PROVIDER_LIMITS.DEFAULT_SEARCH_RESULTS,
  ): Promise<HardcoverSearchDocument[]> {
    return this.search('search-by-author', SEARCH_BOOKS_BY_AUTHOR_QUERY, author, apiKey, signal, limit);
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

  async searchBooksAndAuthors(
    query: string,
    apiKey: string,
    signal?: AbortSignal,
    options?: HardcoverRequestOptions,
  ): Promise<{ books: HardcoverSearchDocument[]; authors: HardcoverAuthorSearchDocument[] }> {
    const body = await this.post<HardcoverBookAndAuthorSearchResponse>(
      'book-author-search',
      SEARCH_BOOKS_AND_AUTHORS_QUERY,
      { q: query, limit: PROVIDER_LIMITS.DEFAULT_SEARCH_RESULTS },
      apiKey,
      signal,
      options,
    );
    const bookHits = body?.data?.books?.results?.hits;
    const authorHits = body?.data?.authors?.results?.hits;
    // A 200 whose hits are not arrays is not an answer: caching it as empty would silence the
    // provider for every user of that query until the cache entry expires. The only caller opts
    // into surfaceFailures, so a malformed body is always a failure here.
    if (!Array.isArray(bookHits) || !Array.isArray(authorHits)) {
      throw new HardcoverRequestError('book-author-search', 200);
    }
    return {
      books: bookHits.map((hit) => hit.document).filter((document): document is HardcoverSearchDocument => document != null),
      authors: authorHits.map((hit) => hit.document).filter((document): document is HardcoverAuthorSearchDocument => document != null),
    };
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
      { id: authorId, off: offset, releasedBy: releasedBy() },
      apiKey,
      signal,
      options,
    );
    if (options?.surfaceFailures && !Array.isArray(body?.data?.authors)) {
      throw new HardcoverRequestError('author-contributions', 200);
    }
    return body?.data?.authors?.[0] ?? null;
  }

  async lookupBySlug(slug: string, apiKey: string, signal?: AbortSignal): Promise<HardcoverBookWithEditions | null> {
    const body = await this.post<HardcoverBooksResponse>('lookup', LOOKUP_BY_SLUG_QUERY, { slug, releasedBy: releasedBy() }, apiKey, signal);
    if (body && !Array.isArray(body.data?.books)) markProviderFailed('hardcover.lookup: response without books');
    return body?.data?.books?.[0] ?? null;
  }

  private async search(
    op: 'search' | 'search-by-author',
    graphql: string,
    query: string,
    apiKey: string,
    signal: AbortSignal | undefined,
    limit: number,
  ): Promise<HardcoverSearchDocument[]> {
    const body = await this.post<HardcoverSearchResponse>(op, graphql, { q: query, limit }, apiKey, signal);
    const hits = body?.data?.search?.results?.hits;
    if (body && !Array.isArray(hits)) markProviderFailed(`hardcover.${op}: response without hits`);
    const documents = hits?.map((h) => h.document).filter((d): d is HardcoverSearchDocument => d != null) ?? [];
    if (hits && documents.length < hits.length) markProviderDegraded(`hardcover.${op}: hit without document`);
    return documents;
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
    op:
      | 'search-by-isbn'
      | 'search'
      | 'search-by-author'
      | 'lookup'
      | 'author-search'
      | 'book-author-search'
      | 'author-contributions'
      | 'editions-by-slugs',
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
        signal: buildRequestSignal(options?.timeoutMs ?? PROVIDER_TIMEOUT_MS.DEFAULT, signal),
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
      reportGraphqlBodyQuality(body, op);
      this.logger.log(`[hardcover] [end] op=${op} method=POST status=${res.status} durationMs=${Date.now() - startedAt}`);
      return body;
    } catch (err) {
      if (err instanceof ProviderThrottleError) {
        this.logger.warn(`[hardcover] [fail] op=${op} method=POST durationMs=${Date.now() - startedAt} message="throttled"`);
        throw err;
      }
      markProviderFailed(`hardcover.${op}: unusable response`);
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
