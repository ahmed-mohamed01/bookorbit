import { Injectable } from '@nestjs/common';
import { BOOK_FIELDS, HardcoverClient, type HardcoverRequestOptions, releasedBy } from '../../metadata-fetch/providers/hardcover/hardcover.client';
import { HardcoverRequestError } from '../../metadata-fetch/providers/hardcover/hardcover.errors';
import { PROVIDER_LIMITS } from '../../metadata-fetch/providers/provider-constants';
import type { HardcoverSearchDocument } from '../../metadata-fetch/providers/hardcover/hardcover.types';
import type {
  HardcoverAuthorSearchDocument,
  HardcoverAuthorSearchResponse,
  HardcoverBookAndAuthorSearchResponse,
  HardcoverAuthorWithContributions,
  HardcoverAuthorContributionsResponse,
  HardcoverEditionsBySlugsResponse,
  HardcoverEditionsProbeBook,
} from './hardcover-catalog.types';

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

@Injectable()
export class HardcoverCatalogClient {
  constructor(private readonly hardcover: HardcoverClient) {}

  async searchAuthors(
    query: string,
    apiKey: string,
    signal?: AbortSignal,
    options?: HardcoverRequestOptions,
  ): Promise<HardcoverAuthorSearchDocument[]> {
    const body = await this.hardcover.post<HardcoverAuthorSearchResponse>(
      'author-search',
      SEARCH_AUTHORS_QUERY,
      { q: query },
      apiKey,
      signal,
      options,
    );
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
    const body = await this.hardcover.post<HardcoverBookAndAuthorSearchResponse>(
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
    const body = await this.hardcover.post<HardcoverAuthorContributionsResponse>(
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

  async fetchEditionsBySlugs(
    slugs: string[],
    apiKey: string,
    signal?: AbortSignal,
    options?: HardcoverRequestOptions,
  ): Promise<HardcoverEditionsProbeBook[]> {
    if (slugs.length === 0) return [];
    const body = await this.hardcover.post<HardcoverEditionsBySlugsResponse>(
      'editions-by-slugs',
      EDITIONS_BY_SLUGS_QUERY,
      { slugs },
      apiKey,
      signal,
      options,
    );
    return (body?.data?.books ?? []).map((book) => ({
      slug: book.slug,
      release_date: book.release_date,
      editions: [...(book.ebook_editions ?? []), ...(book.audio_editions ?? []), ...(book.print_editions ?? [])],
    }));
  }
}
