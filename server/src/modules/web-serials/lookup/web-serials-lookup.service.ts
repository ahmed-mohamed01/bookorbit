import { Injectable, Logger } from '@nestjs/common';

import { authorsContradict, authorsMatch, baseSeriesTitle, normalizeSerialTitle, stripEditionQualifiers } from '@bookorbit/types';
import type {
  WebSerialKind,
  WebSerialLookupHealth,
  WebSerialPublication,
  WebSerialPublisher,
  WebSerialSeriesLookup,
  WebSerialSeriesMatch,
  WebSerialSeriesStatus,
} from '@bookorbit/types';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { BoundedTtlCache } from '../web-serials-cache.utils';
import { describeError } from '../web-serials-log.utils';
import { WebSerialsRepository } from '../web-serials.repository';
import { WebSerialsSettingsService } from '../web-serials-settings.service';
import type { EngineUnitSpec } from '../engines/web-serial-engine';
import { MangaBakaClient, type MangaBakaSeries } from './mangabaka.client';
import { MangaDexClient } from './mangadex.client';

const LOOKUP_EVENT = 'web_serials.lookup';
const UNAVAILABLE_MESSAGE = 'Series details could not be looked up right now.';
const CACHE_ENTRIES = 1_000;
const MATCHED_TTL_MS = 24 * 60 * 60_000;
const NO_MATCH_TTL_MS = 6 * 60 * 60_000;
const PARTIAL_TTL_MS = 5 * 60_000;
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 5 * 60_000;
const HEALTH_PERSIST_INTERVAL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 5_500;
const EXACT_TITLE_SCORE = 1_000;
const TITLE_SEARCH_LIMIT = 10;
const TITLE_SEARCH_BUDGET_MS = 2_500;
const TITLE_SEARCH_TTL_MS = 10 * 60_000;
const CATALOG_SEARCH_LIMIT = 20;
const CATALOG_SEARCH_BUDGET_MS = 3_000;
const CATALOG_SEARCH_ENTRIES = 100;
const CATALOG_SERIES_TTL_MS = 30 * 60_000;
const MISSING_SERIES_TTL_MS = 10 * 60_000;
const MANGA_TYPES = new Set(['manga', 'manhwa', 'manhua', 'oel']);
const MAX_PUBLISHERS = 20;

export interface RankedTitleEntry {
  rank: number;
  titles: string[];
}

export type CatalogSearchOutcome = { state: 'ok'; series: MangaBakaSeries[] } | { state: 'disabled' | 'unavailable' };

/** part: the database files the source's series as separate parts; this is the first of them. */
interface LookupCandidate {
  series: MangaBakaSeries;
  scope: 'series' | 'part';
}

@Injectable()
export class WebSerialsLookupService {
  private readonly logger = new Logger(WebSerialsLookupService.name);
  private readonly lookups = new BoundedTtlCache<string, WebSerialSeriesLookup>(CACHE_ENTRIES, Number.POSITIVE_INFINITY);
  private readonly matches = new BoundedTtlCache<string, WebSerialSeriesMatch | null>(CACHE_ENTRIES, Number.POSITIVE_INFINITY);
  private readonly matchOnly = new BoundedTtlCache<string, WebSerialSeriesMatch | null>(CACHE_ENTRIES, Number.POSITIVE_INFINITY);
  private readonly titleSearches = new BoundedTtlCache<string, RankedTitleEntry[]>(CACHE_ENTRIES, Number.POSITIVE_INFINITY);
  private readonly catalogSearches = new BoundedTtlCache<string, MangaBakaSeries[]>(CATALOG_SEARCH_ENTRIES, Number.POSITIVE_INFINITY);
  private readonly catalogSeries = new BoundedTtlCache<string, MangaBakaSeries>(CACHE_ENTRIES, Number.POSITIVE_INFINITY);
  private readonly missingSeries = new BoundedTtlCache<string, true>(CACHE_ENTRIES, Number.POSITIVE_INFINITY);
  private readonly inFlight = new Map<string, Promise<WebSerialSeriesLookup>>();
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private latestHealth: WebSerialLookupHealth | null = null;
  private lastPersistedAt = 0;

  constructor(
    private readonly client: MangaBakaClient,
    private readonly mangaDex: MangaDexClient,
    private readonly settings: WebSerialsSettingsService,
    private readonly repo: WebSerialsRepository,
  ) {}

  async lookup(
    kind: WebSerialKind,
    sourceTitle: string,
    sourceAuthor: string | null,
    units: EngineUnitSpec[] = [],
    seriesCacheKey?: string,
  ): Promise<WebSerialSeriesLookup> {
    const startedAt = Date.now();
    try {
      if (!(await this.settings.getSettings()).lookup.enabled) return { state: 'disabled', match: null, message: null, chapterVolumes: null };
      if (this.isPaused()) return this.unavailable();

      const cacheKey = `${kind}|${seriesCacheKey ?? normalizeSerialTitle(sourceTitle)}`;
      const cached = this.lookups.get(cacheKey);
      if (cached) return cached;

      const pending = this.inFlight.get(cacheKey);
      if (pending) return pending;
      const task = this.performLookup(kind, sourceTitle, sourceAuthor, units, cacheKey, startedAt).finally(() => this.inFlight.delete(cacheKey));
      this.inFlight.set(cacheKey, task);
      return task;
    } catch (error) {
      await this.recordFailure(kind, startedAt, error);
      return this.unavailable();
    }
  }

  /**
   * The provider match for a series without the volume map. Cheap enough to run for source candidates: it never
   * touches MangaDex and never writes the full-lookup cache, so a later lookup with the real chapters still computes volumes.
   */
  async findMatch(
    kind: WebSerialKind,
    sourceTitle: string,
    sourceAuthor: string | null,
    seriesCacheKey: string,
  ): Promise<WebSerialSeriesMatch | null> {
    const startedAt = Date.now();
    try {
      if (!(await this.settings.getSettings()).lookup.enabled || this.isPaused()) return null;
      const cacheKey = `${kind}|${seriesCacheKey}`;
      const full = this.lookups.get(cacheKey);
      if (full && full.state !== 'unavailable') return full.match;
      const cached = this.matchOnly.get(cacheKey);
      if (cached !== undefined) return cached;

      const candidate = await this.findCandidate(kind, sourceTitle, sourceAuthor, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      const match = candidate ? toCandidateMatch(candidate) : null;
      this.matchOnly.set(cacheKey, match, 1, candidate ? MATCHED_TTL_MS : NO_MATCH_TTL_MS);
      if (candidate) this.matches.set(String(candidate.series.id), toMatch(candidate.series), 1, MATCHED_TTL_MS);
      await this.recordSuccess();
      return match;
    } catch (error) {
      await this.recordFailure(kind, startedAt, error);
      return null;
    }
  }

  /** Relevance-ordered MangaBaka titles for ranking search results. Never throws; empty when lookup is off, paused, slow or failing. */
  async searchTitles(query: string, kind: WebSerialKind): Promise<RankedTitleEntry[]> {
    const startedAt = Date.now();
    try {
      if (!(await this.settings.getSettings()).lookup.enabled || this.isPaused()) return [];
      const cacheKey = `${kind}|${normalizeSerialTitle(query)}`;
      const cached = this.titleSearches.get(cacheKey);
      if (cached) return cached;

      const found = await this.searchWithinBudget(query, kind, TITLE_SEARCH_LIMIT, TITLE_SEARCH_BUDGET_MS);
      if (found === null) return [];
      const entries = found
        .filter((series) => series.state === 'active' && typeAllowed(kind, series.type))
        .slice(0, TITLE_SEARCH_LIMIT)
        .map((series, index) => ({ rank: index + 1, titles: titlesFor(series) }));
      this.titleSearches.set(cacheKey, entries, 1, TITLE_SEARCH_TTL_MS);
      await this.recordSuccess();
      return entries;
    } catch (error) {
      await this.recordFailure(kind, startedAt, error);
      return [];
    }
  }

  /**
   * Series for a title search, in MangaBaka's own relevance order. Unlike `searchTitles` it says why it has nothing:
   * lookup switched off, or paused, failing or too slow, so the caller can fall back to searching the sources.
   */
  async searchCatalog(query: string, kind: WebSerialKind, refresh = false): Promise<CatalogSearchOutcome> {
    const startedAt = Date.now();
    try {
      if (!(await this.settings.getSettings()).lookup.enabled) return { state: 'disabled' };
      if (this.isPaused()) return { state: 'unavailable' };
      const cacheKey = `${kind}|${normalizeSerialTitle(query)}`;
      const cached = refresh ? undefined : this.catalogSearches.get(cacheKey);
      if (cached) return { state: 'ok', series: cached };

      const found = await this.searchWithinBudget(query, kind, CATALOG_SEARCH_LIMIT, CATALOG_SEARCH_BUDGET_MS);
      if (found === null) return { state: 'unavailable' };
      const series = found.filter((entry) => entry.state === 'active' && typeAllowed(kind, entry.type)).slice(0, CATALOG_SEARCH_LIMIT);
      this.catalogSearches.set(cacheKey, series, 1, TITLE_SEARCH_TTL_MS);
      for (const entry of series) this.catalogSeries.set(String(entry.id), entry, 1, CATALOG_SERIES_TTL_MS);
      await this.recordSuccess();
      return { state: 'ok', series };
    } catch (error) {
      await this.recordFailure(kind, startedAt, error);
      return { state: 'unavailable' };
    }
  }

  /** One MangaBaka series by id, for its titles and cover. Null when lookup is off, paused, failing or the series is gone. */
  async getCatalogSeries(id: string, kind?: WebSerialKind): Promise<MangaBakaSeries | null> {
    if (!/^\d+$/.test(id)) return null;
    const startedAt = Date.now();
    try {
      if (!(await this.settings.getSettings()).lookup.enabled || this.isPaused()) return null;
      const cached = this.catalogSeries.get(id);
      if (cached) return cached;
      if (this.missingSeries.get(id)) return null;
      const series = await this.client.getSeries(id, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      await this.recordSuccess();
      if (!series || series.state !== 'active') {
        this.missingSeries.set(id, true, 1, MISSING_SERIES_TTL_MS);
        return null;
      }
      this.catalogSeries.set(id, series, 1, CATALOG_SERIES_TTL_MS);
      return series;
    } catch (error) {
      await this.recordFailure(kind ?? 'unknown', startedAt, error);
      return null;
    }
  }

  /** The lookup of a series whose details-database match is already known: only the volume map still has to be found. */
  async lookupByMatchId(kind: WebSerialKind, matchId: string, units: EngineUnitSpec[], seriesCacheKey: string): Promise<WebSerialSeriesLookup> {
    const startedAt = Date.now();
    if (!(await this.settings.getSettings()).lookup.enabled) return { state: 'disabled', match: null, message: null, chapterVolumes: null };
    const cacheKey = `${kind}|${seriesCacheKey}`;
    const cached = this.lookups.get(cacheKey);
    if (cached?.state === 'matched' && cached.match?.id === matchId) return cached;
    const series = await this.getCatalogSeries(matchId, kind);
    if (!series) return this.unavailable();
    let chapterVolumes: Record<string, string> | null = null;
    let volumesFailed = false;
    if (kind === 'manga') {
      try {
        chapterVolumes = await this.mangaDex.chapterVolumes(series, units, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      } catch (error) {
        volumesFailed = true;
        const { errorClass, message } = describeError(error);
        this.logger.warn(
          `[${LOOKUP_EVENT}] [fail] kind=${kind} matchId=${matchId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - volume data unavailable, match kept`,
        );
      }
    }
    const result: WebSerialSeriesLookup = { state: 'matched', match: toMatch(series), message: null, chapterVolumes };
    this.lookups.set(cacheKey, result, 1, volumesFailed ? PARTIAL_TTL_MS : MATCHED_TTL_MS);
    return result;
  }

  private async searchWithinBudget(query: string, kind: WebSerialKind, limit: number, budgetMs: number): Promise<MangaBakaSeries[] | null> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, budgetMs);
    });
    const work = this.client.search(query, kind, controller.signal, limit);
    work.catch(() => undefined);
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  peekCachedLookup(kind: WebSerialKind, seriesKey: string): WebSerialSeriesLookup | null {
    return this.lookups.get(`${kind}|${seriesKey}`) ?? null;
  }

  async getMatch(id: string, kind?: WebSerialKind): Promise<WebSerialSeriesMatch | null> {
    if (!/^\d+$/.test(id) || this.isPaused()) return null;
    const cached = this.matches.get(id);
    if (cached !== undefined) return cached;
    const startedAt = Date.now();
    try {
      const series = await this.client.getSeries(id, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      const match = series?.state === 'active' ? toMatch(series) : null;
      this.matches.set(id, match, 1, match ? MATCHED_TTL_MS : MISSING_SERIES_TTL_MS);
      await this.recordSuccess();
      return match;
    } catch (error) {
      await this.recordFailure(kind ?? 'unknown', startedAt, error);
      return null;
    }
  }

  async test(): Promise<WebSerialLookupHealth> {
    const startedAt = Date.now();
    this.logger.log(`[${LOOKUP_EVENT}] [start] kind=manga queryLength=7 - series lookup test started`);
    try {
      await this.client.search('Frieren', 'manga', AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      const health = await this.recordSuccess();
      this.logger.log(`[${LOOKUP_EVENT}] [end] kind=manga durationMs=${Date.now() - startedAt} ok=true - series lookup test completed`);
      return health;
    } catch (error) {
      return this.recordFailure('manga', startedAt, error);
    }
  }

  private async performLookup(
    kind: WebSerialKind,
    sourceTitle: string,
    sourceAuthor: string | null,
    units: EngineUnitSpec[],
    cacheKey: string,
    startedAt: number,
  ): Promise<WebSerialSeriesLookup> {
    try {
      const candidate = await this.findCandidate(kind, sourceTitle, sourceAuthor, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      let chapterVolumes: Record<string, string> | null = null;
      let volumesFailed = false;
      // A part's volumes are numbered within that part, so they never line up with the whole series' chapters.
      if (candidate?.scope === 'series' && kind === 'manga') {
        try {
          chapterVolumes = await this.mangaDex.chapterVolumes(candidate.series, units, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
        } catch (error) {
          volumesFailed = true;
          const { errorClass, message } = describeError(error);
          this.logger.warn(
            `[${LOOKUP_EVENT}] [fail] kind=${kind} matchId=${candidate.series.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - volume data unavailable, match kept`,
          );
        }
      }
      const result: WebSerialSeriesLookup = candidate
        ? { state: 'matched', match: toCandidateMatch(candidate), message: null, chapterVolumes }
        : { state: 'no_match', match: null, message: null, chapterVolumes: null };
      this.lookups.set(cacheKey, result, 1, !candidate ? NO_MATCH_TTL_MS : volumesFailed ? PARTIAL_TTL_MS : MATCHED_TTL_MS);
      if (candidate) this.matches.set(String(candidate.series.id), toMatch(candidate.series), 1, MATCHED_TTL_MS);
      await this.recordSuccess();
      return result;
    } catch (error) {
      await this.recordFailure(kind, startedAt, error);
      return this.unavailable();
    }
  }

  private async findCandidate(
    kind: WebSerialKind,
    sourceTitle: string,
    sourceAuthor: string | null,
    signal: AbortSignal,
  ): Promise<LookupCandidate | null> {
    const searched = await this.client.search(stripEditionQualifiers(sourceTitle) || sourceTitle, kind, signal);
    const candidate = selectCandidate(kind, sourceTitle, sourceAuthor, searched);
    if (candidate?.scope === 'series') return candidate;
    const fuzzy = await this.client.match(sourceTitle, signal);
    const matched = selectCandidate(kind, sourceTitle, sourceAuthor, fuzzy);
    if (matched?.scope === 'series' || !candidate) return matched;
    return selectCandidate(kind, sourceTitle, sourceAuthor, [...searched, ...fuzzy]);
  }

  private async recordSuccess(): Promise<WebSerialLookupHealth> {
    this.consecutiveFailures = 0;
    this.pausedUntil = 0;
    const health: WebSerialLookupHealth = { ok: true, checkedAt: new Date().toISOString(), error: null, pausedUntil: null };
    await this.rememberHealth(health);
    return health;
  }

  private async recordFailure(kind: WebSerialKind | 'unknown', startedAt: number, error: unknown): Promise<WebSerialLookupHealth> {
    const wasPaused = this.pausedUntil > Date.now();
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_FAILURES) this.pausedUntil = Date.now() + BREAKER_PAUSE_MS;
    const breakerOpened = !wasPaused && this.pausedUntil > Date.now();
    const { errorClass, message } = describeError(error);
    this.logger.warn(
      `[${LOOKUP_EVENT}] [fail] kind=${kind} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - series lookup failed`,
    );
    const health: WebSerialLookupHealth = {
      ok: false,
      checkedAt: new Date().toISOString(),
      error: UNAVAILABLE_MESSAGE,
      pausedUntil: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : null,
    };
    await this.rememberHealth(health, breakerOpened);
    return health;
  }

  private async rememberHealth(health: WebSerialLookupHealth, force = false): Promise<void> {
    const previous = this.latestHealth;
    this.latestHealth = health;
    const now = Date.now();
    if (!force && this.lastPersistedAt !== 0 && previous?.ok === health.ok && now - this.lastPersistedAt < HEALTH_PERSIST_INTERVAL_MS) return;
    this.lastPersistedAt = now;
    await this.repo.recordLookupCheck(health).catch(() => undefined);
  }

  private isPaused(): boolean {
    if (this.pausedUntil <= Date.now()) {
      this.pausedUntil = 0;
      return false;
    }
    return true;
  }

  private unavailable(): WebSerialSeriesLookup {
    return { state: 'unavailable', match: null, message: UNAVAILABLE_MESSAGE, chapterVolumes: null };
  }
}

/** An exact title first, then the first part of a series filed in parts, then a title containing the other (author confirmed). */
function selectCandidate(
  kind: WebSerialKind,
  sourceTitle: string,
  sourceAuthor: string | null,
  candidates: MangaBakaSeries[],
): LookupCandidate | null {
  const eligible = candidates.filter((series) => series.state === 'active' && typeAllowed(kind, series.type));
  const exact = bestTitleMatch(kind, sourceTitle, sourceAuthor, eligible, true);
  if (exact) return { series: exact, scope: 'series' };
  const part = firstPart(sourceTitle, sourceAuthor, eligible);
  if (part) return { series: part, scope: 'part' };
  const contained = bestTitleMatch(kind, sourceTitle, sourceAuthor, eligible, false);
  return contained ? { series: contained, scope: 'series' } : null;
}

/** The earliest series whose base title and author agree with the source; arcs filed separately share both. */
function firstPart(sourceTitle: string, sourceAuthor: string | null, candidates: MangaBakaSeries[]): MangaBakaSeries | null {
  const base = baseSeriesTitle(sourceTitle);
  if (!base || !sourceAuthor) return null;
  const parts = candidates.filter(
    (series) => titlesFor(series).some((title) => baseSeriesTitle(title) === base) && authorsMatch([sourceAuthor], series.authors ?? []),
  );
  parts.sort((left, right) => yearOrder(left.year) - yearOrder(right.year) || left.id - right.id);
  return parts[0] ?? null;
}

function yearOrder(year: number | null | undefined): number {
  return typeof year === 'number' && Number.isFinite(year) ? year : Number.POSITIVE_INFINITY;
}

function toCandidateMatch(candidate: LookupCandidate): WebSerialSeriesMatch {
  const match = toMatch(candidate.series);
  return candidate.scope === 'part' ? { ...match, scope: 'part' } : match;
}

function bestTitleMatch(
  kind: WebSerialKind,
  sourceTitle: string,
  sourceAuthor: string | null,
  candidates: MangaBakaSeries[],
  exactOnly: boolean,
): MangaBakaSeries | null {
  const source = normalizeSerialTitle(sourceTitle);
  let best: { series: MangaBakaSeries; score: number } | null = null;
  for (const series of candidates) {
    const scores = titlesFor(series).map((title) => titleScore(source, normalizeSerialTitle(title)));
    const titleMatch = Math.max(...scores, 0);
    if (titleMatch === 0 || (exactOnly && titleMatch < EXACT_TITLE_SCORE)) continue;
    const seriesAuthors = series.authors ?? [];
    const authorAgrees = sourceAuthor !== null && authorsMatch([sourceAuthor], seriesAuthors);
    // Two works can share a title ("Monster"); known authors that disagree mean a different series.
    if (sourceAuthor !== null && authorsContradict([sourceAuthor], [...seriesAuthors, ...(series.artists ?? [])])) continue;
    // A substring title ("One Piece Party" inside "One Piece") only counts as the same series when the author confirms it.
    if (titleMatch < EXACT_TITLE_SCORE && !authorAgrees) continue;
    const preferredType = series.type === kind ? 10 : 0;
    const preferredAuthor = authorAgrees ? 20 : 0;
    const score = titleMatch + preferredType + preferredAuthor;
    if (!best || score > best.score) best = { series, score };
  }
  return best?.series ?? null;
}

function titleScore(source: string, candidate: string): number {
  if (!source || !candidate) return 0;
  if (source === candidate) return EXACT_TITLE_SCORE;
  const shorter = Math.min(source.length, candidate.length);
  return shorter >= 8 && (source.includes(candidate) || candidate.includes(source)) ? 500 + shorter : 0;
}

export function titlesFor(series: MangaBakaSeries): string[] {
  const secondary = Object.values(series.secondary_titles ?? {}).flatMap((titles) => titles.map((entry) => entry.title).filter(isString));
  return [series.title, series.romanized_title, series.native_title, ...secondary].filter(isString);
}

export function typeAllowed(kind: WebSerialKind, type: string): boolean {
  return kind === 'novel' ? type === 'novel' : MANGA_TYPES.has(type);
}

export function toMatch(series: MangaBakaSeries): WebSerialSeriesMatch {
  return {
    provider: 'mangabaka',
    id: String(series.id),
    title: series.title.trim(),
    url: `https://mangabaka.org/${series.id}`,
    year: typeof series.year === 'number' && Number.isFinite(series.year) ? series.year : null,
    authors: cleanStrings(series.authors),
    artists: cleanStrings(series.artists),
    status: mapStatus(series.status),
    genres: cleanStrings(series.genres).map(titleCaseGenre),
    publication: toPublication(series),
  };
}

export function toPublication(series: MangaBakaSeries): WebSerialPublication {
  const publishers = toPublishers(series.publishers);
  const englishPublisher = publishers.some((publisher) => publisher.type?.toLowerCase() === 'english');
  return { licensed: series.is_licensed === true || englishPublisher, finalVolume: parseFinalVolume(series.final_volume), publishers };
}

function toPublishers(values: MangaBakaSeries['publishers']): WebSerialPublisher[] {
  if (!Array.isArray(values)) return [];
  const publishers: WebSerialPublisher[] = [];
  for (const value of values) {
    const name = typeof value?.name === 'string' ? value.name.trim() : '';
    if (!name) continue;
    publishers.push({ name, type: optionalText(value.type), language: optionalText(value.language) });
    if (publishers.length >= MAX_PUBLISHERS) break;
  }
  return publishers;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseFinalVolume(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Math.trunc(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanStrings(values: string[] | null | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function titleCaseGenre(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(' ');
}

function mapStatus(status: string): WebSerialSeriesStatus {
  switch (status) {
    case 'releasing':
      return 'ongoing';
    case 'completed':
      return 'completed';
    case 'hiatus':
      return 'hiatus';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function isString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
