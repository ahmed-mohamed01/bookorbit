import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { WebSerialErrorCode, type WebSerialKind } from '@bookorbit/types';
import { LncrawlClient } from './engines/lncrawl.client';
import { decodeNovelRemoteId, NovelSourcesClient } from './engines/novel-sources.client';
import { SuwayomiClient } from './engines/suwayomi.client';
import { SOURCE_ID_PREFIX, type EngineSeries, type WebSerialEngineClient } from './engines/web-serial-engine';
import { fixApostropheCase } from './web-serials-title.utils';
import { BoundedTtlCache } from './web-serials-cache.utils';
import { WebSerialsSettingsService, type WebSerialEngineConfig } from './web-serials-settings.service';
import { codedError } from './web-serials-error.utils';

const SERIES_CACHE_ENTRIES = 30;
const SERIES_CACHE_TTL_MS = 45_000;

@Injectable()
export class WebSerialsEngineRegistry {
  private readonly seriesCache = new BoundedTtlCache<string, EngineSeries>(SERIES_CACHE_ENTRIES, SERIES_CACHE_TTL_MS);
  private readonly seriesLoads = new Map<string, Promise<EngineSeries>>();

  constructor(
    private readonly settings: WebSerialsSettingsService,
    private readonly suwayomi: SuwayomiClient,
    private readonly lncrawl: LncrawlClient,
    private readonly novelSources?: NovelSourcesClient,
  ) {}

  client(kind: WebSerialKind, remoteId?: string, engine?: WebSerialEngineConfig['engine']): WebSerialEngineClient {
    if (kind === 'manga') return this.suwayomi;
    if (remoteId?.includes(':') || engine === 'lnreader') {
      if (!this.novelSources)
        throw new ServiceUnavailableException(codedError('The LNReader client is unavailable', WebSerialErrorCode.EngineNotConfigured));
      return this.novelSources;
    }
    return this.lncrawl;
  }

  getConfig(kind: WebSerialKind): Promise<WebSerialEngineConfig | null> {
    return this.settings.getEngineConfig(kind);
  }

  async requireConfig(kind: WebSerialKind): Promise<WebSerialEngineConfig> {
    const config = await this.settings.getEngineConfig(kind);
    if (!config) {
      throw new ServiceUnavailableException({
        message: `${kind === 'manga' ? 'Manga' : 'Web novels'} are not available on this server`,
        errorCode: WebSerialErrorCode.KindUnavailable,
        errorMeta: { kind },
      });
    }
    return config;
  }

  async configForSeries(kind: WebSerialKind, remoteId: string): Promise<WebSerialEngineConfig | null> {
    if (kind !== 'novel') return this.settings.getEngineConfig(kind);
    if (!this.settings.getNovelEngineConfig) return this.settings.getEngineConfig(kind);
    return this.settings.getNovelEngineConfig(remoteId.includes(':') ? 'lnreader' : 'lncrawl');
  }

  /** For answers served from a cache without loading the series: refuses a light novel site the admin disabled. */
  async requireEnabledSource(kind: WebSerialKind, remoteId: string): Promise<void> {
    const config = await this.configForSeries(kind, remoteId);
    if (config) assertNovelSourceEnabled(kind, remoteId, config);
  }

  /**
   * One series scrape serves the detail, lookup, sources and cover requests that a single preview fires together.
   * Concurrent callers share the in-flight request, and a series from a source the admin has not enabled is refused. A
   * failed load, including a long chapter list that is still loading, is never cached: the next call asks again.
   */
  async loadSeries(kind: WebSerialKind, remoteId: string): Promise<EngineSeries> {
    const config = await this.configForSeries(kind, remoteId);
    if (!config) throw new ServiceUnavailableException(codedError('This series engine is not configured', WebSerialErrorCode.EngineNotConfigured));
    assertNovelSourceEnabled(kind, remoteId, config);
    const key = `${this.settings.catalogVersion}|${kind}|${remoteId}`;
    let series = this.seriesCache.get(key);
    if (!series) {
      let pending = this.seriesLoads.get(key);
      if (!pending) {
        pending = this.client(kind, remoteId, config.engine)
          .getSeries(config.connection, remoteId)
          .then((loaded) => {
            const series = { ...loaded, title: fixApostropheCase(loaded.title) };
            this.seriesCache.set(key, series);
            return series;
          })
          .finally(() => this.seriesLoads.delete(key));
        this.seriesLoads.set(key, pending);
      }
      series = await pending;
    }
    if (kind === 'manga' && !isSeriesSourceAllowed(series, config.allowedSources)) {
      throw new NotFoundException(codedError('That series is not available from an enabled source', WebSerialErrorCode.SeriesSourceDisabled));
    }
    return series;
  }
}

function assertNovelSourceEnabled(kind: WebSerialKind, remoteId: string, config: WebSerialEngineConfig): void {
  if (kind === 'novel' && remoteId.includes(':') && !isNovelSourceAllowed(remoteId, config.allowedSources)) {
    throw new NotFoundException(codedError('That site is not enabled for downloads', WebSerialErrorCode.SourceDisabled));
  }
}

/** An LNReader series key names its source; only sources the admin enabled may be opened or downloaded. */
export function isNovelSourceAllowed(remoteId: string, allowedSources: readonly string[]): boolean {
  return allowedSources.includes(decodeNovelRemoteId(remoteId).sourceId);
}

/** Mirrors the engine's own source filter: picked source ids when there are any, otherwise the language list. */
export function isSeriesSourceAllowed(series: Pick<EngineSeries, 'sourceId' | 'language'>, allowedSources: string[]): boolean {
  const pickedIds = allowedSources.filter((entry) => entry.startsWith(SOURCE_ID_PREFIX));
  if (pickedIds.length > 0) {
    if (!series.sourceId) return true;
    return pickedIds.includes(`${SOURCE_ID_PREFIX}${series.sourceId}`);
  }
  if (!series.language) return true;
  const language = series.language.toLowerCase();
  const languages = new Set(allowedSources.map((entry) => entry.trim().toLowerCase()));
  return languages.has(language) || languages.has(language.split('-', 1)[0] ?? language);
}
