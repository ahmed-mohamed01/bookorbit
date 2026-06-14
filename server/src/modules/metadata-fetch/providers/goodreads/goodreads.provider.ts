import { Injectable, Logger } from '@nestjs/common';
import { MetadataCandidate, MetadataProviderKey } from '@bookorbit/types';

import { ProviderConfigService } from '../../../metadata-preferences/provider-config.service';
import { sanitizeLogValue } from '../../../../common/utils/log-sanitize.utils';
import { fetchWithThrottle } from '../../fetch-with-throttle';
import { ProviderThrottleError } from '../../provider-throttle.error';
import { IdentifiableProvider } from '../metadata-provider';
import { PROVIDER_DELAYS_MS, PROVIDER_LIMITS, PROVIDER_TIMEOUT_MS } from '../provider-constants';
import { MetadataSearchParams } from '../metadata-search-params';
import { buildRequestSignal, sleep } from '../provider-utils';
import { mapGoodreadsApolloState, mapGoodreadsAutocompleteItem } from './goodreads.mapper';
import { GoodreadsAutocompleteItem, GoodreadsNextData } from './goodreads.types';

const HEADERS: HeadersInit = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};
const JSON_HEADERS: HeadersInit = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'application/json,text/plain,*/*',
  'accept-language': 'en-US,en;q=0.9',
};
type GoodreadsFetchOp = 'search' | 'search-autocomplete' | 'search-by-isbn' | 'lookup';

@Injectable()
export class GoodreadsProvider implements IdentifiableProvider {
  readonly key = MetadataProviderKey.GOODREADS;
  readonly label = 'Goodreads';
  readonly identifiable = true as const;

  private readonly logger = new Logger(GoodreadsProvider.name);

  constructor(private readonly providerConfig: ProviderConfigService) {}

  async search(params: MetadataSearchParams): Promise<MetadataCandidate[]> {
    const { enabled } = await this.providerConfig.getConfig().then((c) => c.goodreads);
    if (!enabled) return [];
    const targets = params.isbn
      ? await this.findIdByIsbn(params.isbn, params.signal).then((id): GoodreadsSearchTarget[] => (id ? [{ id }] : []))
      : await this.searchTargets(params, params.signal);

    // Detail pages are frequently gated behind the AWS WAF challenge. Try the
    // detail scrape first (richest metadata), but once a detail page cannot be
    // loaded at all, stop hitting it for the rest of the batch and build
    // candidates from the autocomplete payload we already hold. A page that
    // loads but fails to parse does not disable detail mode, so a single odd
    // book never downgrades the whole batch.
    const results: MetadataCandidate[] = [];
    let detailReachable = true;
    for (const target of targets.slice(0, PROVIDER_LIMITS.GOODREADS_MAX_RESULTS)) {
      let candidate: MetadataCandidate | null = null;
      if (detailReachable) {
        if (results.length > 0) await sleep(PROVIDER_DELAYS_MS.GOODREADS_BETWEEN_REQUESTS, params.signal);
        const detail = await this.fetchBook(target.id, params.signal);
        candidate = detail.candidate;
        if (!detail.reachable && target.item) detailReachable = false;
      }
      if (!candidate && target.item) candidate = mapGoodreadsAutocompleteItem(target.item, target.id);
      if (candidate) results.push(candidate);
    }

    return results;
  }

  async lookupById(providerId: string, signal?: AbortSignal): Promise<MetadataCandidate | null> {
    const { enabled } = await this.providerConfig.getConfig().then((c) => c.goodreads);
    if (!enabled) return null;
    return (await this.fetchBook(providerId, signal)).candidate;
  }

  private async searchTargets(params: MetadataSearchParams, signal?: AbortSignal): Promise<GoodreadsSearchTarget[]> {
    const query = [params.title, params.author].filter(Boolean).join(' ');
    if (!query.trim()) return [];

    // Goodreads search pages are frequently gated behind WAF challenges.
    // Prefer the JSON autocomplete endpoint, then fall back to HTML scraping.
    const autocompleteItems: GoodreadsAutocompleteItem[] = [];
    for (const autocompleteQuery of buildAutocompleteQueries(params)) {
      const autocompleteUrl = `https://www.goodreads.com/book/auto_complete?format=json&q=${encodeURIComponent(autocompleteQuery)}`;
      const autocomplete = await this.fetchJson<GoodreadsAutocompleteItem[]>(
        autocompleteUrl,
        'search-autocomplete',
        autocompleteQuery,
        undefined,
        signal,
      );
      if (Array.isArray(autocomplete)) autocompleteItems.push(...autocomplete);
    }
    const autocompleteTargets = rankAutocompleteItems(autocompleteItems, params, PROVIDER_LIMITS.GOODREADS_MAX_RESULTS);
    if (autocompleteTargets.length > 0) return autocompleteTargets;

    const searchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}&search_type=books`;
    const html = await this.fetchHtml(searchUrl, 'search', query, undefined, signal);
    const ids = html ? extractBookIds(html, params.title, PROVIDER_LIMITS.GOODREADS_MAX_RESULTS) : [];
    return ids.map((id) => ({ id }));
  }

  private async findIdByIsbn(isbn: string, signal?: AbortSignal): Promise<string | null> {
    const html = await this.fetchHtml(`https://www.goodreads.com/book/isbn/${isbn}`, 'search-by-isbn', isbn, undefined, signal);
    if (!html) return null;
    return (
      html.match(/property="og:url"\s+content="[^"]*\/book\/show\/(\d+)/)?.[1] ??
      html.match(/<link[^>]+rel="canonical"[^>]+href="[^"]*\/book\/show\/(\d+)/)?.[1] ??
      null
    );
  }

  // `reachable` reports whether the detail page itself loaded, independent of
  // whether it parsed into a candidate. The caller uses it to tell a WAF block
  // apart from a book that simply did not map.
  private async fetchBook(bookId: string, signal?: AbortSignal): Promise<{ candidate: MetadataCandidate | null; reachable: boolean }> {
    const url = `https://www.goodreads.com/book/show/${bookId}`;
    const html = await this.fetchHtml(url, 'lookup', undefined, bookId, signal);
    if (!html) return { candidate: null, reachable: false };
    const nextData = extractNextData(html);
    const state = nextData?.props?.pageProps?.apolloState;
    if (!state) return { candidate: null, reachable: true };
    return { candidate: mapGoodreadsApolloState(state, bookId), reachable: true };
  }

  private async fetchHtml(url: string, op: GoodreadsFetchOp, query?: string, providerId?: string, signal?: AbortSignal): Promise<string | null> {
    const safeQuery = query ? sanitizeLogValue(query) : undefined;
    const safeProviderId = providerId ? sanitizeLogValue(providerId) : undefined;
    const startedAt = Date.now();
    this.logger.log(
      `[goodreads] [start] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''}`,
    );
    try {
      const res = await fetchWithThrottle(url, { headers: HEADERS, signal: buildRequestSignal(PROVIDER_TIMEOUT_MS.SCRAPE, signal) });
      if (!res.ok) {
        this.logger.warn(
          `[goodreads] [fail] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''} status=${res.status} durationMs=${Date.now() - startedAt} message="non-ok response"`,
        );
        return null;
      }
      const html = await res.text();
      if (isWafChallenge(res.status, html)) {
        this.logger.warn(
          `[goodreads] [fail] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''} status=${res.status} durationMs=${Date.now() - startedAt} message="bot challenge"`,
        );
        return null;
      }
      this.logger.log(
        `[goodreads] [end] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''} status=${res.status} durationMs=${Date.now() - startedAt}`,
      );
      return html;
    } catch (err) {
      if (err instanceof ProviderThrottleError) {
        this.logger.warn(
          `[goodreads] [fail] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''} durationMs=${Date.now() - startedAt} message="throttled"`,
        );
        throw err;
      }
      this.logger.warn(
        `[goodreads] [fail] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''} durationMs=${Date.now() - startedAt} message="${err instanceof Error ? err.message : String(err)}"`,
      );
      return null;
    }
  }

  private async fetchJson<T>(url: string, op: GoodreadsFetchOp, query?: string, providerId?: string, signal?: AbortSignal): Promise<T | null> {
    const safeQuery = query ? sanitizeLogValue(query) : undefined;
    const safeProviderId = providerId ? sanitizeLogValue(providerId) : undefined;
    const startedAt = Date.now();
    this.logger.log(
      `[goodreads] [start] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''}`,
    );
    try {
      const res = await fetchWithThrottle(url, { headers: JSON_HEADERS, signal: buildRequestSignal(PROVIDER_TIMEOUT_MS.SCRAPE, signal) });
      if (!res.ok) {
        this.logger.warn(
          `[goodreads] [fail] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''} status=${res.status} durationMs=${Date.now() - startedAt} message="non-ok response"`,
        );
        return null;
      }
      const body = (await res.json()) as T;
      this.logger.log(
        `[goodreads] [end] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''} status=${res.status} durationMs=${Date.now() - startedAt}`,
      );
      return body;
    } catch (err) {
      if (err instanceof ProviderThrottleError) {
        this.logger.warn(
          `[goodreads] [fail] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''} durationMs=${Date.now() - startedAt} message="throttled"`,
        );
        throw err;
      }
      this.logger.warn(
        `[goodreads] [fail] op=${op}${safeQuery ? ` query="${safeQuery}"` : ''}${safeProviderId ? ` providerId="${safeProviderId}"` : ''} durationMs=${Date.now() - startedAt} message="${err instanceof Error ? err.message : String(err)}"`,
      );
      return null;
    }
  }
}

type GoodreadsSearchTarget = { id: string; item?: GoodreadsAutocompleteItem };

function extractNextData(html: string): GoodreadsNextData | null {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as GoodreadsNextData;
  } catch {
    return null;
  }
}

// AWS WAF serves a JavaScript token challenge with a 202 status instead of the
// real page. A plain fetch cannot solve it, so treat it as a failed fetch.
function isWafChallenge(status: number, html: string): boolean {
  return status === 202 || /awsWafCookieDomainList|AwsWafIntegration|id="challenge-container"|challenge\.js/.test(html);
}

function buildAutocompleteQueries(params: MetadataSearchParams): string[] {
  const title = params.title?.trim();
  const author = params.author?.trim();
  const queries = title ? [title, [title, author].filter(Boolean).join(' ')] : [author ?? ''];
  return [...new Set(queries.filter((q) => q.trim().length > 0))];
}

interface RankableEntry {
  id: string;
  text: string;
  title?: string;
  author?: string;
  ratingsCount?: number;
  item?: GoodreadsAutocompleteItem;
}

function extractBookIds(html: string, titleHint: string | undefined, limit: number): string[] {
  const seen = new Set<string>();
  const entries: RankableEntry[] = [];

  // from_srp=true only appears on actual search result links, not nav/sidebar
  const pattern = /href="(\/book\/show\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    const href = m[1];
    if (!href.includes('from_srp=true')) continue;
    const idMatch = /\/book\/show\/(\d+)([^?]*)/.exec(href);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, text: idMatch[2] ?? '' });
  }

  return rankEntries(entries, titleHint, limit).map((entry) => entry.id);
}

function rankAutocompleteItems(payload: GoodreadsAutocompleteItem[] | null, params: MetadataSearchParams, limit: number): GoodreadsSearchTarget[] {
  if (!Array.isArray(payload) || payload.length === 0) return [];

  const seen = new Set<string>();
  const entries: RankableEntry[] = [];
  for (const item of payload) {
    const id = getAutocompleteBookId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const text = [item.bookUrl ?? '', item.title ?? '', item.bookTitleBare ?? ''].join(' ');
    entries.push({
      id,
      text,
      title: item.bookTitleBare ?? item.title,
      author: getAutocompleteAuthor(item),
      ratingsCount: parseRatingsCount(item.ratingsCount),
      item,
    });
  }

  return rankEntries(entries, params.title, limit, params.author).map((entry) => ({ id: entry.id, item: entry.item }));
}

function getAutocompleteBookId(item: GoodreadsAutocompleteItem): string | null {
  const direct = typeof item.bookId === 'number' ? String(item.bookId) : item.bookId;
  if (direct && /^\d+$/.test(direct)) return direct;

  const fromUrl = item.bookUrl?.match(/\/book\/show\/(\d+)/)?.[1];
  return fromUrl ?? null;
}

function getAutocompleteAuthor(item: GoodreadsAutocompleteItem): string | undefined {
  if (typeof item.author === 'string') return item.author;
  return item.author?.name;
}

function parseRatingsCount(value: string | number | undefined): number | undefined {
  if (value == null) return undefined;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '') : value;
  const parsed = typeof normalized === 'string' ? parseInt(normalized, 10) : Math.round(normalized);
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
}

function rankEntries(entries: RankableEntry[], titleHint: string | undefined, limit: number, authorHint?: string): RankableEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, score: scoreRankedEntry(entry, titleHint, authorHint) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

function scoreRankedEntry(
  entry: { text: string; title?: string; author?: string; ratingsCount?: number },
  titleHint: string | undefined,
  authorHint?: string,
): number {
  let score = 0;
  const title = normalizeSearchText(entry.title ?? entry.text);
  const queryTitle = titleHint ? normalizeSearchText(titleHint) : '';

  if (queryTitle) {
    if (title === queryTitle) score += 100;
    else if (title.startsWith(queryTitle)) score += 70;
    else if (queryTitle.startsWith(title)) score += 55;
    else if (title.includes(queryTitle)) score += 45;
    else score += titleOverlapScore(queryTitle, title);
  }

  const queryAuthor = authorHint ? normalizeSearchText(authorHint) : '';
  const author = entry.author ? normalizeSearchText(entry.author) : '';
  if (queryAuthor && author) {
    if (author === queryAuthor || author.includes(queryAuthor) || queryAuthor.includes(author)) score += 30;
    else score += authorOverlapScore(queryAuthor, author);
  }

  if (entry.ratingsCount) score += Math.min(Math.log10(entry.ratingsCount + 1) * 3, 20);
  if (isDerivativeResult(entry.title ?? entry.text)) score -= 80;

  return score;
}

function titleOverlapScore(queryTitle: string, title: string): number {
  const queryTokens = tokenizeSearchText(queryTitle);
  if (!queryTokens.length) return 0;
  const titleTokens = new Set(tokenizeSearchText(title));
  return (queryTokens.filter((token) => titleTokens.has(token)).length / queryTokens.length) * 30;
}

function authorOverlapScore(queryAuthor: string, author: string): number {
  const queryTokens = tokenizeSearchText(queryAuthor).filter((token) => token.length > 1);
  if (!queryTokens.length) return 0;
  const authorTokens = new Set(tokenizeSearchText(author));
  return (queryTokens.filter((token) => authorTokens.has(token)).length / queryTokens.length) * 15;
}

function isDerivativeResult(value: string): boolean {
  return /\b(summary|study guide|analysis|book analysis|reading guide|literature guide|workbook|digest|breakdown|companion)\b/i.test(value);
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return value.split(' ').filter((token) => token.length > 1);
}
