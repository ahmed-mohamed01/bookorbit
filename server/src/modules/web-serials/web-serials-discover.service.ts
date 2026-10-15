import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type {
  WebSerialCatalogEntry,
  WebSerialDiscoverFallback,
  WebSerialDiscoverResult,
  WebSerialKind,
  WebSerialSourceOptions,
} from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { htmlToPlainText } from '../../common/utils/html-to-text.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { MangaBakaSeries } from './lookup/mangabaka.client';
import { titlesFor, toMatch, typeAllowed, WebSerialsLookupService } from './lookup/web-serials-lookup.service';
import { BoundedTtlCache } from './web-serials-cache.utils';
import { WebSerialsCatalogService } from './web-serials-catalog.service';
import { rankDiscoverOptions, type SourceCandidates } from './web-serials-candidate.utils';
import { WebSerialsCoverService, type WebSerialCover } from './web-serials-cover.service';
import { WebSerialsEngineRegistry } from './web-serials-engine-registry.service';
import { describeError } from './web-serials-log.utils';
import { relevanceScore } from './web-serials-ranking.utils';
import { WebSerialsNovelCandidatesService } from './web-serials-novel-candidates.service';
import { WebSerialsNovelIndexService } from './web-serials-novel-index.service';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { WebSerialsRepository } from './web-serials.repository';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from './web-serials-error.utils';

const DISCOVER_EVENT = 'web_serials.discover';
const INFO_CACHE_ENTRIES = 500;
const INFO_CACHE_TTL_MS = 30 * 60_000;
const SOURCES_CACHE_ENTRIES = 200;
const SOURCES_CACHE_TTL_MS = 10 * 60_000;
const FAILED_SOURCES_CACHE_TTL_MS = 60_000;
const SYNOPSIS_MAX_CHARS = 4_000;
const MAX_ALT_TITLES = 30;
const KINDS: readonly WebSerialKind[] = ['manga', 'novel'];

interface CatalogInfo {
  title: string;
  altTitles: string[];
  authors: string[];
  artists: string[];
  coverUrl: string | null;
}

/** Search starts at the series database: one entry per real series, and the release sources are checked only for the one the user opens. */
@Injectable()
export class WebSerialsDiscoverService {
  private readonly logger = new Logger(WebSerialsDiscoverService.name);
  private readonly info = new BoundedTtlCache<string, CatalogInfo>(INFO_CACHE_ENTRIES, INFO_CACHE_TTL_MS);
  private readonly sourcesCache = new BoundedTtlCache<string, WebSerialSourceOptions>(SOURCES_CACHE_ENTRIES, SOURCES_CACHE_TTL_MS);

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly settings: WebSerialsSettingsService,
    private readonly engines: WebSerialsEngineRegistry,
    private readonly catalog: WebSerialsCatalogService,
    private readonly novels: WebSerialsNovelCandidatesService,
    private readonly lookupService: WebSerialsLookupService,
    private readonly covers: WebSerialsCoverService,
    private readonly novelIndex?: WebSerialsNovelIndexService,
  ) {}

  async discover(query: string, kind: WebSerialKind | 'all', user: RequestUser, refresh = false): Promise<WebSerialDiscoverResult> {
    const q = query.trim();
    const kinds = await this.searchableKinds(kind);
    if (kinds.length === 0)
      throw new BadRequestException(codedError('Search is not available on this server', WebSerialErrorCode.SearchNotConfigured));

    const startedAt = Date.now();
    this.logger.log(`[${DISCOVER_EVENT}] [start] userId=${user.id} kind=${kind} queryLength=${q.length} - series search started`);
    const outcomes = await Promise.all(kinds.map((entry) => this.lookupService.searchCatalog(q, entry, refresh)));
    const unavailable = outcomes.find((outcome) => outcome.state !== 'ok');
    if (unavailable) return this.fallback(unavailable.state as WebSerialDiscoverFallback, user.id, kind, startedAt);

    const perKind = outcomes.map((outcome, index) =>
      outcome.state === 'ok' ? outcome.series.filter(isListable).map((series) => ({ kind: kinds[index]!, series })) : [],
    );
    const found = mergeByMatch(perKind, q);
    if (found.length === 0) return this.fallback('empty', user.id, kind, startedAt);
    const novels = found.filter((entry) => entry.kind === 'novel');
    if (novels.length > 0 && this.novelIndex) {
      await this.novelIndex.matchCatalog(
        novels.map(({ series }) => ({ id: String(series.id), titles: titlesFor(series), authors: series.authors ?? [] })),
      );
    }

    const importedKeys = await this.repo.findImportedMatchKeys(
      user.id,
      found.map(({ series }) => matchKeyOf(series.id)),
    );
    const results = found.map(({ kind: entryKind, series }) => this.toEntry(entryKind, series, importedKeys.has(matchKeyOf(series.id))));
    this.logger.log(
      `[${DISCOVER_EVENT}] [end] userId=${user.id} kind=${kind} durationMs=${Date.now() - startedAt} results=${results.length} fallback=none - series search completed`,
    );
    return { results, fallback: null };
  }

  /** The release sources carrying one series from the database, most complete first. Never searches the sources for anything else. */
  async getSources(kind: WebSerialKind, matchId: string, user: RequestUser, refresh = false): Promise<WebSerialSourceOptions> {
    const info = await this.requireInfo(kind, matchId);
    const disabledDomains = kind === 'novel' ? [...(await this.repo.getDisabledNovelDomains(user.id))].sort() : [];
    const cacheKey = `${this.settings.catalogVersion}|${kind}|${matchId}|${disabledDomains.join(',')}`;
    const cached = refresh ? undefined : this.sourcesCache.get(cacheKey);
    if (cached) return cached;

    const startedAt = Date.now();
    this.logger.log(`[${DISCOVER_EVENT}.sources] [start] userId=${user.id} kind=${kind} matchId=${matchId} - source check started`);
    let found: SourceCandidates;
    try {
      found =
        kind === 'manga'
          ? await this.catalog.findMangaSourceCandidates({
              sourceTitle: info.title,
              sourceName: '',
              query: info.title,
              matchId,
              altTitles: info.altTitles,
            })
          : await this.novels.find({
              title: info.title,
              altTitles: info.altTitles,
              authors: info.authors,
              artists: info.artists,
              matchId,
              disabledDomains,
            });
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${DISCOVER_EVENT}.sources] [fail] userId=${user.id} kind=${kind} matchId=${matchId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - source check failed`,
      );
      return { options: [], failedSources: [kind] };
    }

    const result: WebSerialSourceOptions = { options: rankDiscoverOptions(found.candidates), failedSources: found.failedSources };
    const hasSuccess = result.failedSources.length === 0 || result.options.length > 0;
    this.sourcesCache.set(cacheKey, result, 1, hasSuccess ? SOURCES_CACHE_TTL_MS : FAILED_SOURCES_CACHE_TTL_MS);
    this.logger.log(
      `[${DISCOVER_EVENT}.sources] [end] userId=${user.id} kind=${kind} matchId=${matchId} durationMs=${Date.now() - startedAt} options=${result.options.length} failedSources=${result.failedSources.length} - source check completed`,
    );
    return result;
  }

  async getCover(kind: WebSerialKind, matchId: string): Promise<WebSerialCover> {
    const info = await this.requireInfo(kind, matchId);
    if (!info.coverUrl) throw new NotFoundException('No cover for this series');
    return this.covers.getRemoteCover(infoKey(kind, matchId), info.coverUrl);
  }

  private async requireInfo(kind: WebSerialKind, matchId: string): Promise<CatalogInfo> {
    if (!KINDS.includes(kind)) throw new BadRequestException('Unknown kind');
    if (!/^\d{1,12}$/.test(matchId)) throw new BadRequestException('Invalid series identifier');
    const cached = this.info.get(infoKey(kind, matchId));
    if (cached) return cached;
    const series = await this.lookupService.getCatalogSeries(matchId, kind);
    if (!series) throw new BadGatewayException(codedError('This series could not be looked up right now', WebSerialErrorCode.SeriesUnavailable));
    if (!typeAllowed(kind, series.type)) throw new NotFoundException(codedError(`That series is not a ${kind}`, WebSerialErrorCode.SeriesNotFound));
    return this.remember(kind, series);
  }

  private remember(kind: WebSerialKind, series: MangaBakaSeries): CatalogInfo {
    const title = series.title.trim();
    const seen = new Set([title.toLowerCase()]);
    const altTitles = titlesFor(series)
      .map((value) => value.trim())
      .filter((value) => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_ALT_TITLES);
    const info: CatalogInfo = {
      title,
      altTitles,
      authors: (series.authors ?? []).map((name) => name.trim()).filter(Boolean),
      artists: (series.artists ?? []).map((name) => name.trim()).filter(Boolean),
      coverUrl: coverUrlOf(series),
    };
    this.info.set(infoKey(kind, String(series.id)), info);
    return info;
  }

  private toEntry(kind: WebSerialKind, series: MangaBakaSeries, inLibrary: boolean): WebSerialCatalogEntry {
    const info = this.remember(kind, series);
    const match = toMatch(series);
    const synopsis = series.description ? htmlToPlainText(series.description, { preserveLineBreaks: true }).slice(0, SYNOPSIS_MAX_CHARS) : '';
    return {
      matchId: match.id,
      kind,
      title: match.title,
      authors: match.authors,
      artists: match.artists,
      year: match.year,
      status: match.status,
      genres: match.genres,
      synopsis: synopsis || null,
      coverUrl: info.coverUrl ? `/api/v1/web-serials/discover/${kind}/${match.id}/cover` : null,
      url: match.url,
      inLibrary,
      publication: match.publication,
    };
  }

  private fallback(reason: WebSerialDiscoverFallback, userId: number, kind: string, startedAt: number): WebSerialDiscoverResult {
    this.logger.log(
      `[${DISCOVER_EVENT}] [end] userId=${userId} kind=${kind} durationMs=${Date.now() - startedAt} results=0 fallback=${reason} - series search sent no results`,
    );
    return { results: [], fallback: reason };
  }

  private async searchableKinds(kind: WebSerialKind | 'all'): Promise<WebSerialKind[]> {
    const wanted = kind === 'all' ? KINDS : [kind];
    const configs = await Promise.all(wanted.map((entry) => this.engines.getConfig(entry)));
    return wanted.filter((_entry, index) => (configs[index]?.allowedSources.length ?? 0) > 0);
  }
}

function infoKey(kind: WebSerialKind, matchId: string): string {
  return `${kind}:${matchId}`;
}

/** MangaBaka keeps placeholder rows for series it has not identified yet; they are not series a user can pick. */
const PLACEHOLDER_TITLE = /^unknown title\b/i;

function isListable(series: MangaBakaSeries): boolean {
  return !PLACEHOLDER_TITLE.test(series.title.trim());
}

function matchKeyOf(id: number): string {
  return `mb:${id}`;
}

function coverUrlOf(series: MangaBakaSeries): string | null {
  const cover = series.cover;
  const value = cover?.x250?.x2 ?? cover?.x250?.x1 ?? cover?.x350?.x1 ?? cover?.x150?.x2 ?? cover?.raw?.url ?? null;
  return typeof value === 'string' && /^https:\/\//i.test(value) ? value : null;
}

/**
 * Merges each kind's results without reordering inside a kind (MangaBaka's order is its relevance):
 * at every step the head that matches the query best goes next, so a weak manga hit never sits above an exact novel title.
 */
function mergeByMatch(lists: Array<Array<{ kind: WebSerialKind; series: MangaBakaSeries }>>, query: string) {
  const heads = lists.map(() => 0);
  const merged: Array<{ kind: WebSerialKind; series: MangaBakaSeries }> = [];
  const total = lists.reduce((sum, list) => sum + list.length, 0);
  while (merged.length < total) {
    let pick = -1;
    let best = -1;
    lists.forEach((list, index) => {
      const head = list[heads[index]!];
      if (!head) return;
      const score = bestTitleScore(head.series, query);
      if (score > best) {
        best = score;
        pick = index;
      }
    });
    merged.push(lists[pick]![heads[pick]!]!);
    heads[pick]! += 1;
  }
  return merged;
}

function bestTitleScore(series: MangaBakaSeries, query: string): number {
  return Math.max(0, ...[series.title, ...titlesFor(series)].map((title) => relevanceScore(title, query)));
}
