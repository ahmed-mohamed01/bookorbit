import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { HardcoverSearchBook, HardcoverUniversalSearchResult, MonitoredAuthorSearchResult, MonitoredCatalogSearchHit } from '@bookorbit/types';

import { StatsCache } from '../../common/cache/stats-cache';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { HardcoverClient } from '../metadata-fetch/providers/hardcover/hardcover.client';
import type { HardcoverAuthorSearchDocument, HardcoverSearchDocument } from '../metadata-fetch/providers/hardcover/hardcover.types';
import { foldedQueryWords, normalizeMonitoredName, titleAuthorKey } from './monitored-text.utils';
import { strongestHitPerName } from './hardcover-author-hits.utils';
import { MonitoredProviderConfigService } from './monitored-provider-config.service';
import { MonitoredStoreService } from './monitored-store.service';
import { isHardcoverConfigured } from './providers/hardcover-bibliography.provider';

const HARDCOVER_SEARCH_TIMEOUT_MS = 4000;
/** Measured Hardcover p90 is about 1s; a request that cannot even start inside that allowance is not worth a slot. */
const HARDCOVER_REQUEST_ALLOWANCE_MS = 1500;
const HARDCOVER_BOOK_LIMIT = 5;
const HARDCOVER_AUTHOR_LIMIT = 3;
const HARDCOVER_CACHE_TTL_MS = 15 * 60 * 1000;
const HARDCOVER_CACHE_MAX_ENTRIES = 500;
/** One scope for every user: the cache holds what Hardcover said, and dedupe runs per user after the read. */
const HARDCOVER_CACHE_SCOPE = 'hardcover';

/** The per-author fields the palette dedupe reads, kept in the shape the cache holds them. */
interface HardcoverCachedSearchAuthor {
  id: string;
  name: string;
  booksCount: number | null;
  imageUrl: string | null;
  genres: string[];
}

interface HardcoverSearchCacheEntry {
  books: HardcoverSearchBook[];
  authors: HardcoverCachedSearchAuthor[];
}

function toHardcoverSearchBook(document: HardcoverSearchDocument): HardcoverSearchBook {
  return {
    slug: document.slug,
    title: document.title,
    // Hardcover lists an author once per contribution, so one name can repeat.
    authorNames: [...new Set(document.author_names ?? [])],
    seriesName: document.featured_series?.series?.name ?? document.series_names?.[0] ?? null,
    coverUrl: document.image?.url ?? null,
  };
}

function toCachedSearchAuthor(hit: HardcoverAuthorSearchDocument): HardcoverCachedSearchAuthor {
  return {
    id: String(hit.id),
    name: hit.name,
    booksCount: hit.books_count ?? null,
    imageUrl: hit.image?.url ?? null,
    genres: hit.genres ?? [],
  };
}

/** Hardcover's author search is fuzzy; an author is only offered when every query word starts a word of the name. */
function authorNameMatches(name: string, query: string): boolean {
  const nameWords = foldedQueryWords(name);
  return foldedQueryWords(query).every((word) => nameWords.some((nameWord) => nameWord.startsWith(word)));
}

/** The palette skips the search rather than reserve a rate-limit slot its own timeout would abandon. */
class HardcoverBusyError extends ServiceUnavailableException {}

/**
 * The command palette's two reads beyond the library: watchlist catalog works, and a rate-limited
 * Hardcover search whose answer is deduped against what the user already has. The compacted
 * provider answer is cached query-wide; everything after it is per user.
 */
@Injectable()
export class MonitoredUniversalSearchService {
  private readonly logger = new Logger(MonitoredUniversalSearchService.name);
  // A rate-limit shield for a hot palette path, so it stays in memory rather than in the metadata cache.
  private readonly hardcoverCache = new StatsCache({ ttlMs: HARDCOVER_CACHE_TTL_MS, maxEntries: HARDCOVER_CACHE_MAX_ENTRIES });

  constructor(
    private readonly store: MonitoredStoreService,
    private readonly hardcover: HardcoverClient,
    private readonly providerConfigs: MonitoredProviderConfigService,
  ) {}

  searchCatalogWorks(user: RequestUser, q: string, limit: number): Promise<MonitoredCatalogSearchHit[]> {
    return this.store.searchCatalogWorks(user, q, limit);
  }

  async searchHardcover(user: RequestUser, query: string): Promise<HardcoverUniversalSearchResult> {
    const q = query.trim();
    const config = await this.providerConfigs.forUser(user.id);
    if (!isHardcoverConfigured(config)) return { available: false, books: [], authors: [] };
    const cacheKey = foldedQueryWords(q).join(' ');
    if (!cacheKey) return { available: true, books: [], authors: [] };
    let raw: HardcoverSearchCacheEntry;
    try {
      raw = await this.hardcoverCache.get(HARDCOVER_CACHE_SCOPE, cacheKey, () => this.fetchHardcover(q, config.hardcover.apiKey, user.id));
    } catch {
      // Provider failures are logged where they happen, inside fetchHardcover, and the palette
      // answers an empty search rather than an error. Only the fetch is guarded: everything after
      // it is this user's own dedupe, whose DB errors propagate like any other read's.
      return { available: true, books: [], authors: [] };
    }
    if (!raw.books.length && !raw.authors.length) return { available: true, books: [], authors: [] };
    const libraryIds = await this.store.accessibleLibraryIds(user);
    const [books, authors] = await Promise.all([
      this.dedupeBooks(user, libraryIds, raw.books),
      this.dedupeAuthors(
        user,
        libraryIds,
        raw.authors.filter((hit) => authorNameMatches(hit.name, q)),
      ),
    ]);
    return { available: true, books, authors };
  }

  private async fetchHardcover(q: string, apiKey: string, userId: number): Promise<HardcoverSearchCacheEntry> {
    const startedAt = Date.now();
    // One combined request, one rate-limit slot. When the backlog would already eat the budget, calling
    // would only reserve a slot the palette abandons on timeout, starving every other Hardcover caller.
    if (this.hardcover.queueDelayMs() >= HARDCOVER_SEARCH_TIMEOUT_MS - HARDCOVER_REQUEST_ALLOWANCE_MS) {
      this.logger.log(
        `[monitored.hardcover_search] [end] userId=${userId} busy=true durationMs=${Date.now() - startedAt} - hardcover search skipped, rate-limit backlog full`,
      );
      throw new HardcoverBusyError('Hardcover rate-limit backlog would exceed the search budget');
    }
    this.logger.log(`[monitored.hardcover_search] [start] userId=${userId} - hardcover search started`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HARDCOVER_SEARCH_TIMEOUT_MS);
      // surfaceFailures makes an HTTP or GraphQL failure throw, so only a real answer reaches the cache.
      const { books, authors } = await this.hardcover
        .searchBooksAndAuthors(q, apiKey, controller.signal, { surfaceFailures: true })
        .finally(() => clearTimeout(timeout));
      this.logger.log(
        `[monitored.hardcover_search] [end] userId=${userId} durationMs=${Date.now() - startedAt} books=${books.length} authors=${authors.length} - hardcover search completed`,
      );
      // The cache holds only the fields the dedupe reads, and only one hit per author name, so a
      // provider document's description never sits in memory for the entry's whole TTL.
      return { books: books.map(toHardcoverSearchBook), authors: strongestHitPerName(authors).map(toCachedSearchAuthor) };
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.hardcover_search] [fail] userId=${userId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - hardcover search failed`,
      );
      throw error;
    }
  }

  private async dedupeBooks(user: RequestUser, libraryIds: number[] | null, candidates: HardcoverSearchBook[]): Promise<HardcoverSearchBook[]> {
    if (!candidates.length) return [];
    const slugs = candidates.map((candidate) => candidate.slug).filter(Boolean);
    const [librarySlugs, catalogSlugs] = await Promise.all([
      this.store.findLibraryHardcoverIds(libraryIds, slugs),
      this.store.findCatalogHardcoverIds(user, slugs),
    ]);
    const unowned = candidates.filter((candidate) => !librarySlugs.has(candidate.slug) && !catalogSlugs.has(candidate.slug));
    if (!unowned.length) return [];
    const titles = unowned.map((candidate) => candidate.title);
    const [libraryKeys, catalogKeys] = await Promise.all([
      this.store.findLibraryTitleAuthorKeys(libraryIds, titles),
      this.store.findCatalogTitleAuthorKeys(user, titles),
    ]);
    const ownedKeys = new Set([...libraryKeys, ...catalogKeys]);
    const books: HardcoverSearchBook[] = [];
    for (const candidate of unowned) {
      if (candidate.authorNames.some((name) => ownedKeys.has(titleAuthorKey(candidate.title, name)))) continue;
      books.push(candidate);
      if (books.length >= HARDCOVER_BOOK_LIMIT) break;
    }
    return books;
  }

  private async dedupeAuthors(
    user: RequestUser,
    libraryIds: number[] | null,
    candidates: HardcoverCachedSearchAuthor[],
  ): Promise<MonitoredAuthorSearchResult[]> {
    if (!candidates.length) return [];
    const [monitoredByName, monitoredById, localKeys] = await Promise.all([
      this.store.findMonitoredIdsByNames(
        candidates.map((hit) => hit.name),
        user,
      ),
      this.store.findMonitoredHardcoverProviderIds(
        user,
        candidates.map((hit) => hit.id),
      ),
      this.store.findLocalAuthorNameKeys(
        libraryIds,
        candidates.map((hit) => hit.name),
      ),
    ]);
    const results: MonitoredAuthorSearchResult[] = [];
    for (const hit of candidates) {
      const key = normalizeMonitoredName(hit.name);
      if (monitoredByName.has(key) || monitoredById.has(hit.id) || localKeys.has(key)) continue;
      results.push({
        name: hit.name,
        providerIds: { hardcover: hit.id },
        localAuthorId: null,
        bookCount: hit.booksCount,
        imageUrl: hit.imageUrl,
        genres: hit.genres,
        alreadyMonitoredId: null,
      });
      if (results.length >= HARDCOVER_AUTHOR_LIMIT) break;
    }
    return results;
  }
}
