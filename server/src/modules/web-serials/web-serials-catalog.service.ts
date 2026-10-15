import { mapWithConcurrency } from '../../common/utils/batch.utils';
import { htmlToPlainText } from '../../common/utils/html-to-text.utils';
import { BadGatewayException, BadRequestException, ForbiddenException, HttpException, Injectable, Logger } from '@nestjs/common';

import type {
  WebSerialCapabilities,
  WebSerialKind,
  WebSerialSearchHit,
  WebSerialSearchResult,
  WebSerialSeriesDetail,
  WebSerialSeriesKey,
  WebSerialSeriesLookup,
  WebSerialSeriesMatch,
  WebSerialSourceOption,
  WebSerialSourceOptions,
  WebSerialSettings,
} from '@bookorbit/types';
import { authorsMatch, normalizeSerialTitle, WebSerialErrorCode } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { LibraryService } from '../library/library.service';
import { novelSourceLimits } from './engines/novel-source-limits';
import type { EngineConnection, EngineSearchHit, EngineSeries } from './engines/web-serial-engine';
import { WebSerialsLookupService } from './lookup/web-serials-lookup.service';
import { BoundedTtlCache } from './web-serials-cache.utils';
import { WebSerialsCoverService } from './web-serials-cover.service';
import {
  beforeDeadline,
  latestPublishedAt,
  pickOnePerSource,
  shortlistHits,
  TIMED_OUT,
  type ClassifiedHit,
  type LoadedSourceCandidate,
  type SourceCandidates,
} from './web-serials-candidate.utils';
import { WebSerialsEngineRegistry } from './web-serials-engine-registry.service';
import { rankByRelevance } from './web-serials-ranking.utils';
import { describeError } from './web-serials-log.utils';
import { makeSeriesKey, parseSeriesKey, seriesCoverPath, tryMakeSeriesKey } from './web-serials-series-key.utils';
import { fixApostropheCase } from './web-serials-title.utils';
import { WebSerialsNovelIndexService, type NovelIndexScope } from './web-serials-novel-index.service';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { MAX_SOURCE_CANDIDATES, normalizedSourceName, sameSource } from './web-serials-source.utils';
import { WebSerialsRepository } from './web-serials.repository';
import { codedError } from './web-serials-error.utils';

const SEARCH_EVENT = 'web_serials.search';
const SEARCH_CACHE_ENTRIES = 200;
const SEARCH_CACHE_TTL_MS = 10 * 60_000;
const SOURCE_OPTIONS_CACHE_ENTRIES = 200;
const SOURCE_OPTIONS_CACHE_TTL_MS = 10 * 60_000;
const FAILED_SOURCE_OPTIONS_TTL_MS = 60_000;
const FAILED_SEARCH_TTL_MS = 60_000;
const SEARCH_TIMEOUT_MS = 30_000;
const FANOUT_CONCURRENCY = 3;
const FANOUT_BUDGET_MS = 20_000;

export interface MangaSourceSearchInput {
  sourceTitle: string;
  sourceName: string;
  query: string;
  matchId: string | null;
  /** Other titles of the same series (from the details database); an exact normalized match on any of them counts when no match id decides. */
  altTitles?: string[];
}

export type LoadedMangaSourceCandidate = LoadedSourceCandidate & { confidence: ClassifiedHit['confidence'] };

interface KindSearch {
  hits: WebSerialSearchHit[];
  failedSources: string[];
  failed: boolean;
  livePending?: boolean;
}

export interface MangaSourceCandidates extends SourceCandidates {
  candidates: LoadedMangaSourceCandidate[];
}

@Injectable()
export class WebSerialsCatalogService {
  private readonly logger = new Logger(WebSerialsCatalogService.name);
  private readonly searchCache = new BoundedTtlCache<string, WebSerialSearchResult>(SEARCH_CACHE_ENTRIES, SEARCH_CACHE_TTL_MS);
  private readonly sourceOptionsCache = new BoundedTtlCache<WebSerialSeriesKey, WebSerialSourceOptions>(
    SOURCE_OPTIONS_CACHE_ENTRIES,
    SOURCE_OPTIONS_CACHE_TTL_MS,
  );

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly settings: WebSerialsSettingsService,
    private readonly engines: WebSerialsEngineRegistry,
    private readonly covers: WebSerialsCoverService,
    private readonly libraryService: LibraryService,
    private readonly lookupService: WebSerialsLookupService,
    private readonly novelIndex?: WebSerialsNovelIndexService,
  ) {}

  async getCapabilities(user: RequestUser): Promise<WebSerialCapabilities> {
    const settings = await this.settings.getSettings();
    const mangaAvailable = this.isAvailable(settings.manga);
    const novelAvailable = this.isAvailable(settings.novel);
    const [mangaLibrary, novelLibrary] = await Promise.all([
      mangaAvailable ? this.usableLibraryId(user, settings.manga.targetLibraryId) : null,
      novelAvailable ? this.usableLibraryId(user, settings.novel.targetLibraryId) : null,
    ]);
    const novelHasDomains = (settings.novel.engine === 'lnreader' ? settings.novel.sourceIds : settings.novel.searchDomains).length > 0;
    return {
      manga: {
        available: mangaAvailable,
        searchable: mangaAvailable && settings.manga.sourceIds?.length !== 0 && this.hasSearchableSources(settings.manga),
        defaultLibraryId: mangaLibrary,
        targetFolderId: mangaLibrary === null ? null : settings.manga.targetFolderId,
      },
      novel: {
        available: novelAvailable,
        searchable: novelAvailable && novelHasDomains && this.hasSearchableSources(settings.novel),
        acceptsLinks: novelAvailable,
        defaultLibraryId: novelLibrary,
        targetFolderId: novelLibrary === null ? null : settings.novel.targetFolderId,
      },
    };
  }

  /**
   * `phase: 'index'` (novels on the LNReader engine): only the light novel index answers, at once, and `livePending`
   * says whether the full search would still ask unindexed sources live.
   */
  async search(
    query: string,
    kind: WebSerialKind | 'all',
    user: RequestUser,
    refresh = false,
    phase: 'index' | 'full' = 'full',
  ): Promise<WebSerialSearchResult> {
    const q = query.trim();
    const disabledNovelDomains = kind === 'manga' ? [] : [...(await this.repo.getDisabledNovelDomains(user.id))].sort();
    const indexOnly = phase === 'index' && kind === 'novel';
    const cacheKey = `${this.settings.catalogVersion}|${kind}|${q.toLowerCase()}|${disabledNovelDomains.join(',')}`;
    const cached = refresh || indexOnly ? undefined : this.searchCache.get(cacheKey);
    if (cached) return cached;

    const startedAt = Date.now();
    const kinds: WebSerialKind[] = kind === 'all' ? ['manga', 'novel'] : [kind];
    const canonicalSearches = Promise.all(kinds.map((entry) => this.lookupService.searchTitles(q, entry)));
    const settled = await Promise.all(kinds.map((entry) => this.searchKind(entry, q, disabledNovelDomains, refresh, indexOnly)));
    const searched = settled.filter((entry) => entry !== null);
    if (searched.length === 0)
      throw new BadRequestException(codedError('Search is not available on this server', WebSerialErrorCode.SearchNotConfigured));
    if (searched.every((entry) => entry.failed)) {
      throw new BadGatewayException(codedError('Search is unavailable right now. Try again in a moment.', WebSerialErrorCode.SearchUnavailable));
    }

    const canonicalByKind = await canonicalSearches;
    const canonical = Object.fromEntries(kinds.map((entry, index) => [entry, canonicalByKind[index]]));
    const result: WebSerialSearchResult = {
      query: q,
      hits: rankByRelevance(
        searched.flatMap((entry) => entry.hits),
        q,
        canonical,
      ),
      failedSources: searched.flatMap((entry) => entry.failedSources),
      ...(searched.some((entry) => entry.livePending) ? { livePending: true } : {}),
    };
    if (indexOnly) return result;
    if (result.hits.length > 0 || result.failedSources.length === 0) this.searchCache.set(cacheKey, result);
    else this.searchCache.set(cacheKey, result, 1, FAILED_SEARCH_TTL_MS);
    this.logger.log(
      `[${SEARCH_EVENT}] [end] kind=${kind} durationMs=${Date.now() - startedAt} hits=${result.hits.length} failedSources=${result.failedSources.length} - search completed`,
    );
    return result;
  }

  async resolve(url: string, user: RequestUser): Promise<WebSerialSeriesDetail> {
    const config = await this.engines.getConfig('novel');
    if (!config) throw linksOnlyException();
    let ref;
    try {
      ref = await this.engines.client('novel', undefined, config.engine).resolveUrl(config.connection, url);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new BadGatewayException(codedError('That link could not be opened', WebSerialErrorCode.LinkUnavailable));
    }
    if (!ref) throw linksOnlyException();
    return this.getSeriesDetail(makeSeriesKey(ref.kind, ref.remoteId), user);
  }

  /** `knownMatchId`: the details-database series this one was found for, so chapters imported from other sources count as already downloaded. */
  async getSeriesDetail(seriesKey: WebSerialSeriesKey, user: RequestUser, knownMatchId?: string): Promise<WebSerialSeriesDetail> {
    const { kind, remoteId } = parseSeriesKey(seriesKey);
    const series = await this.loadSeries(kind, remoteId, seriesKey);
    const cachedMatch = this.lookupService.peekCachedLookup(kind, seriesKey)?.match;
    const matchId = validMatchId(knownMatchId) ?? cachedMatch?.id;
    const [importedUnitKeys, importedGroupKeys] = await Promise.all([
      this.repo.findImportedUnitKeys(
        user.id,
        seriesKey,
        series.units.map((unit) => ({
          key: unit.unitKey,
          sequence: unit.sequence,
          packaging: unit.packaging,
          ...(unit.packaging === 'volume' && unit.chapterRange ? { range: unit.chapterRange } : {}),
          ...(unit.positional ? { positional: true } : {}),
        })),
        matchId ? `mb:${matchId}` : null,
        kind === 'novel' ? [series.title, ...(cachedMatch?.title ? [cachedMatch.title] : [])] : [],
      ),
      this.repo.findImportedGroupKeys(user.id, seriesKey),
    ]);
    return {
      seriesKey,
      kind,
      title: series.title,
      author: series.author?.trim() || null,
      synopsis: series.synopsis ? htmlToPlainText(series.synopsis, { preserveLineBreaks: true }) || null : null,
      tags: series.tags,
      coverUrl: series.remoteCoverPath ? seriesCoverPath(seriesKey) : null,
      sourceName: series.sourceName,
      sourceUrl: series.sourceUrl,
      status: series.status,
      chapterCount: series.chapterCount,
      units: series.units.map((unit) => ({
        key: unit.unitKey,
        label: unit.label,
        sequence: unit.sequence,
        chapterCount: unit.chapterCount,
        publishedAt: unit.publishedAt,
        volume: unit.volume ?? null,
        ...(unit.positional ? { positional: true } : {}),
      })),
      packagingOptions: series.packagingOptions,
      defaultPackaging: series.defaultPackaging,
      importedUnitKeys,
      importedGroupKeys,
    };
  }

  /** `knownMatchId` presets the details-database match (a series opened from search); the title guess is skipped. */
  async getSeriesLookup(seriesKey: WebSerialSeriesKey, knownMatchId?: string): Promise<WebSerialSeriesLookup> {
    const { kind, remoteId } = parseSeriesKey(seriesKey);
    if (kind === 'novel' && remoteId.includes(':')) await this.engines.requireEnabledSource(kind, remoteId);
    const presetId = validMatchId(knownMatchId);
    if (presetId) {
      const series = await this.loadSeries(kind, remoteId, seriesKey);
      return this.lookupService.lookupByMatchId(kind, presetId, series.units, seriesKey);
    }
    const cached = this.lookupService.peekCachedLookup(kind, seriesKey);
    if (cached && (await this.settings.getSettings()).lookup.enabled) return cached;
    const series = await this.loadSeries(kind, remoteId, seriesKey);
    const lookup = await this.lookupService.lookup(kind, series.title, series.author?.trim() || null, series.units, seriesKey);
    if (kind === 'novel' && remoteId.includes(':') && lookup.match && confirmsSameSeries(series, lookup.match))
      await this.novelIndex?.recordMatch(remoteId, lookup.match.id);
    return lookup;
  }

  async getSeriesSources(seriesKey: WebSerialSeriesKey, refresh = false): Promise<WebSerialSourceOptions> {
    const { kind, remoteId } = parseSeriesKey(seriesKey);
    if (kind === 'novel' && remoteId.includes(':')) await this.engines.requireEnabledSource(kind, remoteId);
    const cacheKey = `${this.settings.catalogVersion}|${seriesKey}`;
    const cached = refresh ? undefined : this.sourceOptionsCache.get(cacheKey);
    if (cached) return cached;

    const series = await this.loadSeries(kind, remoteId, seriesKey);
    const current: WebSerialSourceOption = {
      seriesKey,
      sourceName: series.sourceName,
      title: series.title,
      chapterCount: series.chapterCount,
      latestAt: latestPublishedAt(series),
      confidence: 'current',
      mostComplete: true,
    };
    if (kind === 'novel') {
      const result = { options: [current], failedSources: [] };
      this.sourceOptionsCache.set(cacheKey, result);
      return result;
    }

    let found: MangaSourceCandidates;
    try {
      const match = await this.lookupService.findMatch(kind, series.title, series.author?.trim() || null, seriesKey);
      found = await this.findMangaSourceCandidates({
        sourceTitle: series.title,
        sourceName: series.sourceName,
        query: match?.title?.trim() || series.title,
        matchId: match?.id ?? null,
      });
    } catch {
      return { options: [current], failedSources: ['manga'] };
    }

    const seenSources = new Set([normalizedSourceName(series.sourceName)]);
    const alternatives = found.candidates
      .map(({ seriesKey: candidateKey, series: candidateSeries, confidence }): WebSerialSourceOption => ({
        seriesKey: candidateKey,
        sourceName: candidateSeries.sourceName,
        title: candidateSeries.title,
        chapterCount: candidateSeries.chapterCount,
        latestAt: latestPublishedAt(candidateSeries),
        confidence,
        mostComplete: false,
      }))
      .sort(compareSourceOptions)
      .filter((option) => {
        const source = normalizedSourceName(option.sourceName);
        if (seenSources.has(source)) return false;
        seenSources.add(source);
        return true;
      })
      .slice(0, MAX_SOURCE_CANDIDATES);
    const options = [current, ...alternatives];
    const mostComplete = options.reduce((best, option) => (option.chapterCount > best.chapterCount ? option : best), current);
    for (const option of options) option.mostComplete = option === mostComplete;

    const result = { options, failedSources: found.failedSources };
    const hasSuccess = result.failedSources.length === 0 || alternatives.length > 0;
    this.sourceOptionsCache.set(cacheKey, result, 1, hasSuccess ? SOURCE_OPTIONS_CACHE_TTL_MS : FAILED_SOURCE_OPTIONS_TTL_MS);
    return result;
  }

  private async searchKind(
    kind: WebSerialKind,
    query: string,
    disabledNovelDomains: string[],
    refresh: boolean,
    indexOnly: boolean,
  ): Promise<KindSearch | null> {
    const config = await this.engines.getConfig(kind);
    if (!config || config.allowedSources.length === 0) return null;
    const allowedSources =
      kind === 'novel'
        ? config.allowedSources.filter((domain) => !disabledNovelDomains.includes(config.engine === 'lnreader' ? domain : domain.toLowerCase()))
        : config.allowedSources;
    if (allowedSources.length === 0) return { hits: [], failedSources: [WebSerialErrorCode.NovelSourcesAllDisabled], failed: false };
    if (kind === 'novel' && config.engine === 'lnreader' && this.novelIndex) {
      const scope = { connection: config.connection, enabledSourceIds: config.allowedSources };
      return this.searchNovelIndexed(scope, query, allowedSources, refresh, indexOnly);
    }
    if (indexOnly) return { hits: [], failedSources: [], failed: false, livePending: true };
    const startedAt = Date.now();
    try {
      const result = await this.engines
        .client(kind, undefined, config.engine)
        .search(config.connection, query, allowedSources, AbortSignal.timeout(this.searchTimeoutMs(kind, config)));
      return { hits: this.toHits(kind, result.hits), failedSources: result.failedSources, failed: false };
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.warn(
        `[${SEARCH_EVENT}] [fail] kind=${kind} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - search failed`,
      );
      return { hits: [], failedSources: [kind], failed: true };
    }
  }

  private searchTimeoutMs(kind: WebSerialKind, config: { engine: string; connection: EngineConnection }): number {
    return kind === 'novel' && config.engine === 'lnreader' ? novelSourceLimits(config.connection).catalogSearchMs : SEARCH_TIMEOUT_MS;
  }

  /** Index first; the live engine search only covers sources whose fill is not done (every source on a refresh). */
  private async searchNovelIndexed(
    scope: NovelIndexScope,
    query: string,
    sourceIds: string[],
    refresh: boolean,
    indexOnly: boolean,
  ): Promise<KindSearch> {
    const index = this.novelIndex!;
    const startedAt = Date.now();
    let indexed: EngineSearchHit[] = [];
    try {
      indexed = await index.search(scope, query, sourceIds);
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.warn(
        `[${SEARCH_EVENT}] [fail] kind=novel step=index durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - index search failed`,
      );
    }
    const states = await index.fillStates(sourceIds).catch(() => new Map<string, string>());
    const live = refresh ? sourceIds : sourceIds.filter((id) => states.get(id) !== 'done');
    if (indexOnly || live.length === 0) {
      return { hits: this.toHits('novel', indexed), failedSources: [], failed: false, livePending: indexOnly && live.length > 0 };
    }
    try {
      const result = await this.engines
        .client('novel', undefined, 'lnreader')
        .search(scope.connection, query, live, AbortSignal.timeout(novelSourceLimits(scope.connection).catalogSearchMs));
      await index.recordHits(result.hits);
      const seen = new Set(indexed.map((hit) => hit.remoteId));
      const merged = [...indexed, ...result.hits.filter((hit) => !hit.remoteId || !seen.has(hit.remoteId))];
      return { hits: this.toHits('novel', merged), failedSources: result.failedSources, failed: false };
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.warn(
        `[${SEARCH_EVENT}] [fail] kind=novel durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - search failed`,
      );
      return { hits: this.toHits('novel', indexed), failedSources: ['novel'], failed: indexed.length === 0 };
    }
  }

  async searchMangaTargets(
    query: string,
    currentSourceName: string,
    timeoutMs = SEARCH_TIMEOUT_MS,
  ): Promise<{ hits: Array<EngineSearchHit & { remoteId: string }>; failedSources: string[] }> {
    const config = await this.engines.requireConfig('manga');
    let result: { hits: EngineSearchHit[]; failedSources: string[] };
    try {
      result = await this.engines.client('manga').search(config.connection, query, config.allowedSources, AbortSignal.timeout(timeoutMs));
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException(codedError('Search is unavailable right now. Try again in a moment.', WebSerialErrorCode.SearchUnavailable));
    }
    const seen = new Set<string>();
    const hits = result.hits.filter((hit): hit is EngineSearchHit & { remoteId: string } => {
      if (!hit.remoteId || sameSource(hit.sourceName, currentSourceName) || seen.has(hit.remoteId)) return false;
      seen.add(hit.remoteId);
      return true;
    });
    return { hits, failedSources: result.failedSources.filter((source) => !sameSource(source, currentSourceName)) };
  }

  async findMangaSourceCandidates(input: MangaSourceSearchInput): Promise<MangaSourceCandidates> {
    const deadline = Date.now() + FANOUT_BUDGET_MS;
    const searched = await this.searchMangaTargets(input.query, input.sourceName, FANOUT_BUDGET_MS);
    const failedSources = new Set(searched.failedSources);
    const wantedTitles = new Set([input.sourceTitle, ...(input.altTitles ?? [])].map(normalizeSerialTitle));

    const classified = await mapWithConcurrency(
      shortlistHits(searched.hits, [input.sourceTitle, ...(input.altTitles ?? [])]),
      FANOUT_CONCURRENCY,
      async (hit): Promise<ClassifiedHit | null> => {
        if (Date.now() >= deadline) {
          failedSources.add(hit.sourceName);
          return null;
        }
        const seriesKey = makeSeriesKey('manga', hit.remoteId);
        if (input.matchId) {
          const match = await beforeDeadline(this.lookupService.findMatch('manga', hit.title, hit.author?.trim() || null, seriesKey), deadline);
          if (match === TIMED_OUT) {
            failedSources.add(hit.sourceName);
            return null;
          }
          if (match) return match.id === input.matchId ? { hit, seriesKey, confidence: 'same_series' } : null;
        }
        return wantedTitles.has(normalizeSerialTitle(hit.title)) ? { hit, seriesKey, confidence: 'title_match' } : null;
      },
    );

    const finalists = pickOnePerSource(classified.filter((entry) => entry !== null)).slice(0, MAX_SOURCE_CANDIDATES);
    const candidates = (
      await mapWithConcurrency(finalists, FANOUT_CONCURRENCY, async (entry): Promise<LoadedMangaSourceCandidate | null> => {
        if (Date.now() >= deadline) {
          failedSources.add(entry.hit.sourceName);
          return null;
        }
        try {
          const { remoteId } = parseSeriesKey(entry.seriesKey);
          const series = await beforeDeadline(this.loadSeries('manga', remoteId, entry.seriesKey), deadline);
          if (series === TIMED_OUT) {
            failedSources.add(entry.hit.sourceName);
            return null;
          }
          this.covers.remember(entry.seriesKey, entry.hit.remoteCoverPath);
          return { ...entry, series };
        } catch {
          failedSources.add(entry.hit.sourceName);
          return null;
        }
      })
    ).filter((candidate) => candidate !== null);
    return { candidates, failedSources: [...failedSources] };
  }

  /** A hit whose link no series key can carry is left out rather than failing the whole search. */
  private toHits(kind: WebSerialKind, hits: readonly EngineSearchHit[]): WebSerialSearchHit[] {
    return hits.flatMap((hit) => {
      if (!hit.remoteId) return [this.toHit(kind, hit, null)];
      const seriesKey = tryMakeSeriesKey(kind, hit.remoteId);
      return seriesKey ? [this.toHit(kind, hit, seriesKey)] : [];
    });
  }

  private toHit(kind: WebSerialKind, hit: EngineSearchHit, seriesKey: WebSerialSeriesKey | null): WebSerialSearchHit {
    if (seriesKey) this.covers.remember(seriesKey, hit.remoteCoverPath);
    return {
      seriesKey,
      url: hit.url,
      kind,
      title: fixApostropheCase(hit.title),
      author: hit.author?.trim() || null,
      coverUrl: seriesKey && hit.remoteCoverPath ? seriesCoverPath(seriesKey) : null,
      sourceName: hit.sourceName,
      chapterCount: hit.chapterCount,
      status: hit.status,
      ...(hit.mtl ? { mtl: true } : {}),
    };
  }

  async loadSeries(kind: WebSerialKind, remoteId: string, seriesKey: WebSerialSeriesKey): Promise<EngineSeries> {
    const startedAt = Date.now();
    try {
      const series = await this.engines.loadSeries(kind, remoteId);
      this.covers.remember(seriesKey, series.remoteCoverPath);
      if (kind === 'novel' && remoteId.includes(':')) await this.novelIndex?.recordSeries(remoteId, series);
      return series;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      const { errorClass, message } = describeError(err);
      this.logger.warn(
        `[web_serials.series] [fail] seriesKey=${seriesKey} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - series could not be loaded`,
      );
      throw new BadGatewayException(codedError('This series could not be loaded right now', WebSerialErrorCode.SeriesUnavailable));
    }
  }

  private isAvailable(engine: WebSerialSettings['manga'] | WebSerialSettings['novel']): boolean {
    return Boolean(engine.url) && engine.lastCheck?.ok !== false;
  }

  private hasSearchableSources(engine: WebSerialSettings['manga'] | WebSerialSettings['novel']): boolean {
    return engine.lastCheck ? engine.lastCheck.searchableSources > 0 : true;
  }

  private async usableLibraryId(user: RequestUser, libraryId: number | null): Promise<number | null> {
    if (libraryId === null) return null;
    try {
      await this.libraryService.verifyUserAccess(user.id, libraryId, user.isSuperuser);
      return libraryId;
    } catch (err) {
      if (err instanceof ForbiddenException) return null;
      throw err;
    }
  }
}

function compareSourceOptions(left: WebSerialSourceOption, right: WebSerialSourceOption): number {
  const confidenceRank = { current: 0, same_series: 1, title_match: 2, whole_series: 3 } as const;
  return (
    confidenceRank[left.confidence] - confidenceRank[right.confidence] ||
    right.chapterCount - left.chapterCount ||
    left.title.localeCompare(right.title)
  );
}

function validMatchId(value: string | undefined): string | null {
  return value && /^\d{1,12}$/.test(value) ? value : null;
}

function linksOnlyException(): BadRequestException {
  return new BadRequestException({
    message: 'Links work for web novels. For manga, search by title.',
    errorCode: WebSerialErrorCode.LinksNovelOnly,
  });
}

/**
 * The index match is shared by every user, so only a lookup that names this very series writes it: the same title and
 * the same author. A preset id, a part of a series filed in parts, or a contained title never does.
 */
function confirmsSameSeries(series: EngineSeries, match: WebSerialSeriesMatch): boolean {
  if (match.scope === 'part' || !series.author) return false;
  return normalizeSerialTitle(series.title) === normalizeSerialTitle(match.title) && authorsMatch([series.author], match.authors);
}
