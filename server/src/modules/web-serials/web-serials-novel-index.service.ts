import { Injectable, Logger } from '@nestjs/common';

import { authorsContradict, authorsMatch, isMachineTranslationTitle, normalizeSerialTitle } from '@bookorbit/types';
import type {
  WebSerialNovelIndexFillState,
  WebSerialSeriesStatus,
  WebSerialSuggestion,
  WebSerialSuggestResult,
  WebSerialSeriesKey,
} from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { decodeNovelRemoteId, NovelSourcesClient, type NovelSourceEntry } from './engines/novel-sources.client';
import type { EngineConnection, EngineSearchHit, EngineSeries } from './engines/web-serial-engine';
import { BoundedTtlCache } from './web-serials-cache.utils';
import { WebSerialsCoverService } from './web-serials-cover.service';
import { describeError } from './web-serials-log.utils';
import { seriesCoverPath, tryMakeSeriesKey } from './web-serials-series-key.utils';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { WebSerialsNovelIndexRepository, type NovelIndexEntryInput, type NovelIndexHit } from './web-serials-novel-index.repository';
import { WebSerialsRepository } from './web-serials.repository';

const INDEX_EVENT = 'web_serials.novel_index';
const SOURCES_CACHE_TTL_MS = 5 * 60_000;
const SUGGEST_LIMIT = 8;
const SUGGEST_ENTRIES_PER_SERIES = 12;
const SUGGEST_MIN_LENGTH = 2;
const TITLE_KEY_MAX = 300;
const INDEX_TITLE_MAX = 1000;
const INDEX_LINK_MAX = 2048;
const INDEX_SOURCE_ID_MAX = 100;
const INDEX_AUTHOR_MAX = 500;

export interface NovelIndexScope {
  connection: EngineConnection;
  /** Admin-enabled installed source ids. */
  enabledSourceIds: string[];
}

export interface NovelIndexCandidate {
  hit: EngineSearchHit & { remoteId: string; url: string };
  seriesKey: WebSerialSeriesKey;
  matched: boolean;
  row: NovelIndexHit;
}

export function novelIndexKey(title: string): string {
  return normalizeSerialTitle(title).slice(0, TITLE_KEY_MAX);
}

export function novelRemoteId(sourceId: string, path: string): string {
  return `${sourceId}:${Buffer.from(path).toString('base64url')}`;
}

/** Null for an entry the index cannot hold; a link too long to store is dropped rather than failing the batch it came in. */
export function novelIndexEntry(
  sourceId: string,
  path: string,
  title: string,
  url: string | null,
  coverUrl: string | null,
  author: string | null = null,
): NovelIndexEntryInput | null {
  const titleKey = novelIndexKey(title);
  if (!titleKey || !path || path.length > INDEX_LINK_MAX || sourceId.length > INDEX_SOURCE_ID_MAX) return null;
  if (!tryMakeSeriesKey('novel', novelRemoteId(sourceId, path))) return null;
  return {
    sourceId,
    path,
    url: storableLink(url),
    title: title.trim().slice(0, INDEX_TITLE_MAX),
    titleKey,
    mtl: isMachineTranslationTitle(title),
    coverUrl: storableLink(coverUrl),
    author: author?.trim().slice(0, INDEX_AUTHOR_MAX) || null,
  };
}

function storableLink(value: string | null): string | null {
  return value && value.length <= INDEX_LINK_MAX ? value : null;
}

/**
 * The light novel index (LNReader engine only): what search, discover and autocomplete answer from before asking the
 * sources live. Writes are best effort: a failed index write never fails the request that carried it.
 */
@Injectable()
export class WebSerialsNovelIndexService {
  private readonly logger = new Logger(WebSerialsNovelIndexService.name);
  private readonly sources = new BoundedTtlCache<string, NovelSourceEntry[]>(2, SOURCES_CACHE_TTL_MS);

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly indexRepo: WebSerialsNovelIndexRepository,
    private readonly settings: WebSerialsSettingsService,
    private readonly client: NovelSourcesClient,
    private readonly covers: WebSerialsCoverService,
  ) {}

  /** Null unless the novel engine is LNReader and configured. */
  async scope(): Promise<NovelIndexScope | null> {
    const config = await this.settings.getEngineConfig('novel');
    if (!config || config.engine !== 'lnreader') return null;
    return { connection: config.connection, enabledSourceIds: config.allowedSources };
  }

  /** Installed sources, cached briefly; an empty list when the service cannot answer. */
  async installedSources(connection: EngineConnection): Promise<NovelSourceEntry[]> {
    const startedAt = Date.now();
    const key = `${this.settings.catalogVersion}|${connection.url}`;
    const cached = this.sources.get(key);
    if (cached) return cached;
    try {
      const installed = await this.client.listInstalled(connection);
      this.sources.set(key, installed);
      return installed;
    } catch (error) {
      this.warn('sources', error, startedAt);
      return [];
    }
  }

  async userSourceIds(user: RequestUser, scope: NovelIndexScope): Promise<string[]> {
    const disabled = new Set(await this.repo.getDisabledNovelDomains(user.id));
    return scope.enabledSourceIds.filter((id) => !disabled.has(id));
  }

  async fillStates(sourceIds: readonly string[]): Promise<Map<string, WebSerialNovelIndexFillState>> {
    const wanted = new Set(sourceIds);
    const rows = await this.indexRepo.listNovelIndexSources();
    return new Map(rows.filter((row) => wanted.has(row.sourceId)).map((row) => [row.sourceId, row.fillState]));
  }

  /** Index hits for a title search, as engine hits so they merge with the live ones. */
  async search(scope: NovelIndexScope, query: string, sourceIds: readonly string[]): Promise<EngineSearchHit[]> {
    const names = await this.sourceNames(scope);
    const rows = await this.indexRepo.searchNovelIndex(novelIndexKey(query), installedOnly(sourceIds, names));
    return keyed(rows).map(({ row, seriesKey }) => this.toHit(row, seriesKey, names));
  }

  async recordHits(hits: readonly EngineSearchHit[]): Promise<void> {
    const startedAt = Date.now();
    const entries = hits.flatMap((hit) => {
      if (!hit.remoteId || !hit.remoteId.includes(':')) return [];
      try {
        const ref = decodeNovelRemoteId(hit.remoteId);
        const entry = novelIndexEntry(ref.sourceId, ref.path, hit.title, hit.url, hit.remoteCoverPath, hit.author);
        return entry ? [entry] : [];
      } catch {
        return [];
      }
    });
    try {
      await this.indexRepo.upsertNovelIndexEntries(entries);
    } catch (error) {
      this.warn('record_hits', error, startedAt);
    }
  }

  async recordSeries(remoteId: string, series: EngineSeries): Promise<void> {
    const startedAt = Date.now();
    try {
      const ref = decodeNovelRemoteId(remoteId);
      const entry = novelIndexEntry(ref.sourceId, ref.path, series.title, series.sourceUrl, series.remoteCoverPath, series.author);
      if (entry) await this.indexRepo.recordNovelIndexDetails({ ...entry, status: series.status, chapterCount: series.chapterCount });
    } catch (error) {
      this.warn('record_series', error, startedAt);
    }
  }

  async recordMatch(remoteId: string, matchId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const ref = decodeNovelRemoteId(remoteId);
      await this.indexRepo.setNovelIndexMatch(ref.sourceId, ref.path, matchId);
    } catch (error) {
      this.warn('record_match', error, startedAt);
    }
  }

  /**
   * Lazy MangaBaka matching: an unmatched entry takes a returned novel's id when its title equals one of that novel's
   * titles and its known author is one of the novel's authors. A title two returned novels share decides nothing.
   */
  async matchCatalog(series: ReadonlyArray<{ id: string; titles: readonly string[]; authors: readonly string[] }>): Promise<void> {
    const startedAt = Date.now();
    const owners = new Map<string, Set<string>>();
    const authorsById = new Map(series.map((entry) => [entry.id, entry.authors]));
    for (const entry of series) {
      if (entry.authors.length === 0) continue;
      for (const title of entry.titles) {
        const key = novelIndexKey(title);
        if (!key) continue;
        owners.set(key, (owners.get(key) ?? new Set()).add(entry.id));
      }
    }
    const owner = new Map([...owners].filter(([, ids]) => ids.size === 1).map(([titleKey, ids]) => [titleKey, [...ids][0]!]));
    if (owner.size === 0) return;
    try {
      const rows = await this.indexRepo.findUnmatchedNovelIndexByTitleKeys([...owner.keys()]);
      const matches = rows.flatMap((row) => {
        const matchId = owner.get(row.titleKey);
        return matchId && authorsMatch([row.author], authorsById.get(matchId) ?? []) ? [{ sourceId: row.sourceId, path: row.path, matchId }] : [];
      });
      await this.indexRepo.setNovelIndexMatches(matches);
    } catch (error) {
      this.warn('match', error, startedAt);
    }
  }

  /**
   * Index entries carrying one MangaBaka novel, matched ones first in each source; at most one per source. A title-only
   * entry whose stored author contradicts every credited author and artist is another work with the same name and is dropped.
   */
  async candidates(
    scope: NovelIndexScope,
    matchId: string,
    titles: readonly string[],
    sourceIds: readonly string[],
    creators: readonly string[] = [],
  ): Promise<NovelIndexCandidate[]> {
    const keys = [...new Set(titles.map(novelIndexKey).filter(Boolean))];
    const found = await this.indexRepo.findNovelIndexCandidates(matchId, keys, sourceIds);
    const rows = found.filter((row) => row.matchId === matchId || !row.author || !authorsContradict([row.author], creators));
    if (rows.length === 0) return [];
    const names = await this.sourceNames(scope);
    const perSource = new Map<string, NovelIndexHit>();
    for (const row of rows) {
      const kept = perSource.get(row.sourceId);
      if (!kept || rank(row, matchId) < rank(kept, matchId)) perSource.set(row.sourceId, row);
    }
    return keyed([...perSource.values()]).map(({ row, seriesKey }) => this.toCandidate(row, seriesKey, names, row.matchId === matchId));
  }

  private toCandidate(row: NovelIndexHit, seriesKey: WebSerialSeriesKey, names: Map<string, string>, matched: boolean): NovelIndexCandidate {
    const hit = this.toHit(row, seriesKey, names);
    return { hit: { ...hit, remoteId: novelRemoteId(row.sourceId, row.path), url: hit.url ?? '' }, seriesKey, matched, row };
  }

  /**
   * Index entries whose title is one of the given base titles (with or without a leading "The"), at most one per source:
   * sites that carry a whole series the database files in parts. The caller still has to confirm the author.
   */
  async wholeSeriesCandidates(scope: NovelIndexScope, baseTitles: readonly string[], sourceIds: readonly string[]): Promise<NovelIndexCandidate[]> {
    const keys = [...new Set(baseTitles.flatMap((base) => (base ? [base, `the ${base}`] : [])).map(novelIndexKey))];
    const rows = await this.indexRepo.findNovelIndexByTitleKeys(keys, sourceIds);
    if (rows.length === 0) return [];
    const names = await this.sourceNames(scope);
    const perSource = new Map<string, NovelIndexHit>();
    for (const { row } of keyed(rows)) if (!perSource.has(row.sourceId)) perSource.set(row.sourceId, row);
    return keyed([...perSource.values()]).map(({ row, seriesKey }) => this.toCandidate(row, seriesKey, names, false));
  }

  async suggest(query: string, user: RequestUser): Promise<WebSerialSuggestResult> {
    const q = query.trim();
    const key = novelIndexKey(q);
    const scope = key.length >= SUGGEST_MIN_LENGTH ? await this.scope() : null;
    if (!scope) return { query: q, suggestions: [] };
    const names = await this.sourceNames(scope);
    const sourceIds = installedOnly(await this.userSourceIds(user, scope), names);
    const rows = await this.indexRepo.suggestNovelIndex(key, sourceIds, SUGGEST_LIMIT);
    const suggestions = rows.flatMap((row): WebSerialSuggestion[] => {
      const kept = keyed(row.entries).slice(0, SUGGEST_ENTRIES_PER_SERIES);
      if (kept.length === 0) return [];
      const entries = kept.map(({ row: entry, seriesKey }) => ({
        sourceId: entry.sourceId,
        sourceName: names.get(entry.sourceId) ?? entry.sourceId,
        path: entry.path,
        mtl: entry.mtl === true,
        seriesKey,
      }));
      const withCover = kept.findIndex(({ row: entry }) => entry.coverUrl);
      let cover: string | null = null;
      if (withCover >= 0) {
        const seriesKey = entries[withCover]!.seriesKey;
        this.covers.remember(seriesKey, kept[withCover]!.row.coverUrl);
        cover = seriesCoverPath(seriesKey);
      }
      return [
        {
          kind: 'novel',
          title: row.title,
          cover,
          sourcesCount: row.sourcesCount,
          mtlOnly: row.mtlOnly,
          ...(row.matchId ? { matchId: row.matchId } : {}),
          entries,
        },
      ];
    });
    return { query: q, suggestions };
  }

  private async sourceNames(scope: NovelIndexScope): Promise<Map<string, string>> {
    return new Map((await this.installedSources(scope.connection)).map((source) => [source.id, source.name]));
  }

  private toHit(row: NovelIndexHit, seriesKey: WebSerialSeriesKey, names: Map<string, string>): EngineSearchHit {
    this.covers.remember(seriesKey, row.coverUrl);
    return {
      remoteId: novelRemoteId(row.sourceId, row.path),
      url: row.url,
      title: row.title,
      author: null,
      remoteCoverPath: row.coverUrl,
      sourceName: names.get(row.sourceId) ?? row.sourceId,
      chapterCount: row.chapterCount,
      status: (row.status ?? 'unknown') as WebSerialSeriesStatus,
      ...(row.mtl ? { mtl: true } : {}),
    };
  }

  private warn(step: string, error: unknown, startedAt: number): void {
    const { errorClass, message } = describeError(error);
    this.logger.warn(
      `[${INDEX_EVENT}] [fail] step=${step} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - novel index step failed`,
    );
  }
}

/** A source removed from the service keeps its index rows (see the filler), but nothing on it can be opened. */
function installedOnly(sourceIds: readonly string[], installed: ReadonlyMap<string, string>): string[] {
  return sourceIds.filter((id) => installed.has(id));
}

/** Rows stored before over-long links were refused can carry a path no series key holds; lists skip them. */
function keyed<T extends { sourceId: string; path: string }>(rows: readonly T[]): Array<{ row: T; seriesKey: WebSerialSeriesKey }> {
  return rows.flatMap((row) => {
    const seriesKey = tryMakeSeriesKey('novel', novelRemoteId(row.sourceId, row.path));
    return seriesKey ? [{ row, seriesKey }] : [];
  });
}

function rank(row: NovelIndexHit, matchId: string): number {
  return (row.matchId === matchId ? 0 : 2) + (row.mtl ? 1 : 0);
}
