import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';

import type { WebSerialSeriesKey } from '@bookorbit/types';
import { readBoundedBytes, ResponseTooLargeError } from '../../common/utils/bounded-response';
import { BoundedTtlCache } from './web-serials-cache.utils';
import { WebSerialsEngineRegistry } from './web-serials-engine-registry.service';
import { decodeNovelRemoteId } from './engines/novel-sources.client';
import { fetchUntrusted } from './engines/untrusted-fetch.utils';
import { parseSeriesKey } from './web-serials-series-key.utils';
import { WebSerialsNovelIndexRepository } from './web-serials-novel-index.repository';

const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVER_CACHE_ENTRIES = 100;
const COVER_CACHE_BYTES = 40 * 1024 * 1024;
const COVER_CACHE_TTL_MS = 10 * 60_000;
const COVER_PATH_ENTRIES = 2000;
const COVER_PATH_TTL_MS = 60 * 60_000;
/** SVG is left out on purpose: the response is served from the app's own origin. */
const REMOTE_COVER_TIMEOUT_MS = 8_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

export interface WebSerialCover {
  body: Buffer;
  contentType: string;
}

@Injectable()
export class WebSerialsCoverService {
  private readonly covers = new BoundedTtlCache<WebSerialSeriesKey, WebSerialCover>(COVER_CACHE_ENTRIES, COVER_CACHE_TTL_MS, COVER_CACHE_BYTES);
  private readonly coverPaths = new BoundedTtlCache<WebSerialSeriesKey, string>(COVER_PATH_ENTRIES, COVER_PATH_TTL_MS);
  private readonly inFlight = new Map<WebSerialSeriesKey, Promise<WebSerialCover>>();
  private readonly remoteCovers = new BoundedTtlCache<string, WebSerialCover>(COVER_CACHE_ENTRIES, COVER_CACHE_TTL_MS, COVER_CACHE_BYTES);
  private readonly remoteInFlight = new Map<string, Promise<WebSerialCover>>();

  constructor(
    private readonly engines: WebSerialsEngineRegistry,
    private readonly novelIndex?: WebSerialsNovelIndexRepository,
  ) {}

  /** Search and series responses tell the cover service where an engine keeps each cover, so a later image request needs no engine round trip for it. */
  remember(seriesKey: WebSerialSeriesKey, remoteCoverPath: string | null): void {
    if (remoteCoverPath) this.coverPaths.set(seriesKey, remoteCoverPath);
  }

  async getCover(seriesKey: WebSerialSeriesKey): Promise<WebSerialCover> {
    const cached = this.covers.get(seriesKey);
    if (cached) return cached;
    const pending = this.inFlight.get(seriesKey) ?? this.load(seriesKey);
    this.inFlight.set(seriesKey, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(seriesKey);
    }
  }

  private async load(seriesKey: WebSerialSeriesKey): Promise<WebSerialCover> {
    const { kind, remoteId } = parseSeriesKey(seriesKey);
    const config =
      (this.engines.configForSeries ? await this.engines.configForSeries(kind, remoteId) : null) ?? (await this.engines.requireConfig(kind));
    const client = this.engines.client(kind, remoteId, config.engine);

    let path = this.coverPaths.get(seriesKey) ?? (await this.indexedCover(kind, remoteId));
    if (!path) {
      const series = await this.engines.loadSeries(kind, remoteId);
      this.remember(seriesKey, series.remoteCoverPath);
      path = series.remoteCoverPath ?? undefined;
    }
    if (!path) throw new NotFoundException('No cover for this series');

    const cover = await client.fetchCover(config.connection, path);
    const contentType = cover.contentType.split(';')[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) throw new BadGatewayException('The cover is not a supported image');
    if (cover.body.length > COVER_MAX_BYTES) throw new BadGatewayException('The cover is too large');
    const result = { body: cover.body, contentType };
    this.covers.set(seriesKey, result, cover.body.length);
    return result;
  }

  /** Light novel index entries keep their cover address, so an index hit's cover never needs the novel opened. */
  private async indexedCover(kind: string, remoteId: string): Promise<string | undefined> {
    if (kind !== 'novel' || !remoteId.includes(':') || !this.novelIndex) return undefined;
    const ref = decodeNovelRemoteId(remoteId);
    return (await this.novelIndex.findNovelIndexCover(ref.sourceId, ref.path)) ?? undefined;
  }

  /** A cover the details database hosts, proxied so the page never loads a third-party image. Same size and type guards as engine covers. */
  async getRemoteCover(cacheKey: string, remoteUrl: string): Promise<WebSerialCover> {
    const cached = this.remoteCovers.get(cacheKey);
    if (cached) return cached;
    const pending = this.remoteInFlight.get(cacheKey) ?? this.loadRemote(cacheKey, remoteUrl);
    this.remoteInFlight.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      this.remoteInFlight.delete(cacheKey);
    }
  }

  private async loadRemote(cacheKey: string, remoteUrl: string): Promise<WebSerialCover> {
    if (!/^https:\/\//i.test(remoteUrl)) throw new NotFoundException('No cover for this series');
    const signal = AbortSignal.timeout(REMOTE_COVER_TIMEOUT_MS);
    let body: Buffer;
    let contentType: string;
    try {
      const response = await fetchUntrusted(remoteUrl, { headers: { Accept: 'image/*' }, signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new BadGatewayException('The cover could not be loaded');
      }
      contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.has(contentType)) {
        void response.body?.cancel().catch(() => undefined);
        throw new BadGatewayException('The cover is not a supported image');
      }
      body = await readBoundedBytes(response, COVER_MAX_BYTES);
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      if (error instanceof ResponseTooLargeError) throw new BadGatewayException('The cover is too large');
      throw new BadGatewayException('The cover could not be loaded');
    }
    const result = { body, contentType };
    this.remoteCovers.set(cacheKey, result, body.length);
    return result;
  }
}
