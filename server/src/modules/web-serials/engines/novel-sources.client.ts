import { createReadStream } from 'node:fs';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BadGatewayException, BadRequestException, GatewayTimeoutException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { isMachineTranslationTitle, WebSerialErrorCode, type WebSerialEngineHealth, type WebSerialSeriesStatus } from '@bookorbit/types';

import { mapWithConcurrency } from '../../../common/utils/batch.utils';
import { htmlToPlainText } from '../../../common/utils/html-to-text.utils';
import { readBoundedBytes, ResponseTooLargeError } from '../../../common/utils/bounded-response';
import { classifyFailure } from '../web-serials-failure.utils';
import { WebSerialsEpubBuilder } from '../web-serials-epub.builder';
import { logEngineHealthEnd, logEngineHealthFail, logNovelSearchEnd, logNovelSearchStart } from './engine-log.utils';
import { EngineCredentialsRejectedException, fetchEngineResponse, readEngineJson, readEngineText, withEngineFailure } from './engine-http.utils';
import { LncrawlClient } from './lncrawl.client';
import {
  NOVEL_SOURCES_NOVEL_LOAD_CAP_MS,
  NOVEL_SOURCES_ROUTE_TIMEOUTS_MS,
  NOVEL_SOURCES_SEARCH_MARGIN_MS,
  novelSourceLimits,
} from './novel-source-limits';
import { declaredContentType, fetchUntrusted, mayBeImageType, resolveImageType } from './untrusted-fetch.utils';
import {
  MissingChaptersError,
  TooManyMissingChaptersError,
  UnitDownloadStopped,
  type EngineConnection,
  type EngineDownload,
  type EngineDownloadOptions,
  type EngineDownloadProgress,
  type EngineSearchHit,
  type EngineSeries,
  type EngineSeriesOptions,
  type EngineSeriesRef,
  type EngineUnitHandle,
  type EngineUnitProgress,
  type EngineUnitSpec,
  type WebSerialEngineClient,
} from './web-serial-engine';
import { codedError } from '../web-serials-error.utils';

const HEALTH_EVENT = 'web_serials.lnreader_health';
const SEARCH_CONCURRENCY = 4;
const COVER_MAX_BYTES = 5 * 1024 * 1024;
const VOLUME_SIZE = 100;
const MAX_CONSECUTIVE_CHAPTER_FAILURES = 5;
// Only short pages are checked, so a long chapter that quotes a challenge page is still content.
const BLOCKED_PAGE_MAX_TEXT = 600;
const CHALLENGE_TITLE =
  /<title[^>]*>\s*(?:just a moment\.\.\.|attention required!? \| cloudflare|ddos-guard|checking your browser[^<]*)\s*<\/title>/i;
const CHALLENGE_MARKUP =
  /cf-browser-verification|\/cdn-cgi\/challenge-platform\/|window\._cf_chl_opt|id=["']?challenge-form|ddos-guard\.net|__ddg\d?_/i;
const LOGIN_FORM = /<form\b[^>]*>(?:(?!<\/form>)[\s\S])*<input\b[^>]*type=["']?password/i;
// More missing chapters than this share of a volume is not worth filing, even on the last try.
const MAX_MISSING_SHARE = 0.5;
const PENDING_RETRY_DEFAULT_MS = 5000;
const PENDING_RETRY_MIN_MS = 1000;
const PENDING_RETRY_MAX_MS = 60_000;

type RouteTimeout = keyof typeof NOVEL_SOURCES_ROUTE_TIMEOUTS_MS;

export interface NovelSourceEntry {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  iconUrl?: string | null;
  installed: boolean;
  installedVersion?: string | null;
  updateAvailable?: boolean;
  broken?: boolean;
  filters?: unknown;
}

export interface NovelBrowseOptions {
  latest: boolean;
  /** The source's own filter definitions with one value changed; omitted to use the source defaults. */
  filters?: Record<string, unknown> | null;
}

export interface SourceNovelHit {
  name: string;
  path: string;
  url?: string | null;
  cover?: string | null;
}

export interface SourceSearchPage {
  items: SourceNovelHit[];
  page: number;
  hasMore: boolean;
}

interface SourceChapter {
  name: string;
  path: string;
  url?: string | null;
  releaseTime?: string | number | null;
  chapterNumber?: number | null;
  page?: number | null;
}

interface SourceNovel extends SourceNovelHit {
  author?: string | null;
  artist?: string | null;
  summary?: string | null;
  summaryHtml?: string | null;
  status?: string | null;
  genres?: string[] | null;
  chapters?: SourceChapter[] | null;
}

interface UnitRemote {
  sourceId: string;
  seriesPath: string;
  seriesTitle: string;
  authors: string[];
  cover: string | null;
  language?: string | null;
  chapterPaths: string[];
  chapterTitles: string[];
  chapterUrls: Array<string | null>;
  volumeIndex: string;
  workDir?: string;
}

@Injectable()
export class NovelSourcesClient implements WebSerialEngineClient {
  readonly kind = 'novel' as const;
  readonly requiresUnitWorkDir = true;
  private readonly logger = new Logger(NovelSourcesClient.name);
  /** Display names of the installed sources, so a failure names the site and not its plugin id. Bounded by the installed list. */
  private readonly sourceNames = new Map<string, string>();

  constructor(
    private readonly epub: WebSerialsEpubBuilder,
    private readonly lncrawl: LncrawlClient,
  ) {}

  async health(conn: EngineConnection): Promise<WebSerialEngineHealth> {
    const startedAt = Date.now();
    this.logger.log(`[${HEALTH_EVENT}] [start] - engine health check started`);
    try {
      const response = await fetchEngineResponse(
        conn.url,
        '/api/v1/health',
        { method: 'GET' },
        { timeoutMs: NOVEL_SOURCES_ROUTE_TIMEOUTS_MS.health },
      );
      if (!response.ok)
        throw new BadGatewayException(codedError(`The remote service answered with status ${response.status}`, WebSerialErrorCode.EngineError));
      const health = await readEngineJson<{ ok?: boolean; version?: string | null; installed?: number; solver?: boolean }>(response);
      const solver = health.solver === true;
      // Health is open to anyone; the source list is not, so asking for it proves the token.
      await this.listInstalled(conn);
      const searchableSources = Number.isSafeInteger(health.installed) && (health.installed ?? 0) >= 0 ? health.installed! : 0;
      const result = {
        ok: health.ok === true,
        checkedAt: new Date().toISOString(),
        version: health.version ?? null,
        searchableSources,
        solver,
        error: health.ok === true ? null : 'The novel sources service is not ready',
      };
      logEngineHealthEnd(this.logger, HEALTH_EVENT, startedAt, searchableSources);
      return result;
    } catch (error) {
      const message = logEngineHealthFail(this.logger, HEALTH_EVENT, startedAt, error);
      return { ok: false, checkedAt: new Date().toISOString(), version: null, searchableSources: 0, solver: false, error: message };
    }
  }

  listAvailable(conn: EngineConnection, language = 'English'): Promise<NovelSourceEntry[]> {
    return this.getJson(conn, `/api/v1/sources/available?lang=${encodeURIComponent(language)}`);
  }

  listInstalled(conn: EngineConnection): Promise<NovelSourceEntry[]> {
    return this.getJson<NovelSourceEntry[]>(conn, '/api/v1/sources').then((sources) => {
      this.sourceNames.clear();
      for (const source of sources) if (source.name) this.sourceNames.set(source.id, source.name);
      return sources.map((source) => ({ ...source, installed: true, installedVersion: source.installedVersion ?? source.version }));
    });
  }

  /** One page of a source's own catalogue listing, used to fill the light novel index. */
  browse(conn: EngineConnection, sourceId: string, page: number, options: NovelBrowseOptions, signal?: AbortSignal): Promise<SourceSearchPage> {
    const params = new URLSearchParams({ page: String(page), latest: options.latest ? '1' : '0', priority: 'bulk' });
    if (options.filters) params.set('filters', JSON.stringify(options.filters));
    return this.getJson<SourceSearchPage>(conn, `/api/v1/sources/${encodeURIComponent(sourceId)}/browse?${params.toString()}`, signal, 'browse');
  }

  async updateSource(conn: EngineConnection, sourceId: string, action: 'install' | 'update' | 'remove'): Promise<void> {
    const method = action === 'remove' ? 'DELETE' : 'POST';
    await this.request(
      conn,
      `/api/v1/sources/${encodeURIComponent(sourceId)}${action === 'remove' ? '' : `/${action}`}`,
      { method },
      undefined,
      'install',
    );
  }

  async search(
    conn: EngineConnection,
    query: string,
    allowedSources: string[],
    signal?: AbortSignal,
  ): Promise<{ hits: EngineSearchHit[]; failedSources: string[] }> {
    const text = query.trim();
    if (text.length < 2 || allowedSources.length === 0) return { hits: [], failedSources: [] };
    const sources = (await this.listInstalled(conn)).filter((source) => allowedSources.includes(source.id));
    const sourceTimeoutMs = novelSourceLimits(conn).sourceSearchMs;
    const startedAt = Date.now();
    logNovelSearchStart(this.logger, 'lnreader', sources.length, text.length);
    const results = await mapWithConcurrency(sources, SEARCH_CONCURRENCY, async (source) => {
      try {
        const timeout = AbortSignal.timeout(sourceTimeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const page = await this.getJson<SourceSearchPage>(
          conn,
          `/api/v1/sources/${encodeURIComponent(source.id)}/search?q=${encodeURIComponent(text)}&page=1`,
          combined,
          sourceTimeoutMs + NOVEL_SOURCES_SEARCH_MARGIN_MS,
        );
        return { hits: page.items.map((item) => this.mapHit(source, item)), failed: null };
      } catch {
        return { hits: [] as EngineSearchHit[], failed: source.name };
      }
    });
    const hits = results.flatMap((result) => result.hits);
    const failedSources = results.flatMap((result) => (result.failed ? [result.failed] : []));
    logNovelSearchEnd(this.logger, 'lnreader', startedAt, hits.length, failedSources.length);
    return { hits, failedSources };
  }

  async resolveUrl(conn: EngineConnection, rawUrl: string): Promise<EngineSeriesRef | null> {
    let pasted: URL;
    try {
      pasted = new URL(rawUrl);
    } catch {
      throw new BadRequestException(codedError('That novel link is not valid', WebSerialErrorCode.LinkInvalid));
    }
    const sources = await this.listInstalled(conn);
    const source = sources.find((candidate) => {
      try {
        return normalizedHost(new URL(candidate.site).hostname) === normalizedHost(pasted.hostname);
      } catch {
        return false;
      }
    });
    if (source) {
      const site = new URL(source.site);
      const prefix = site.pathname.replace(/\/+$/, '');
      const withinPrefix = prefix.length > 0 && (pasted.pathname === prefix || pasted.pathname.startsWith(`${prefix}/`));
      // Sources report paths relative to their site with no leading slash; a pasted link must give the same key.
      const path = (withinPrefix ? pasted.pathname.slice(prefix.length) : pasted.pathname).replace(/^\/+/, '');
      if (!path) return null;
      return { kind: 'novel', remoteId: encodeNovelRemoteId(source.id, path) };
    }
    if (conn.fallback) return this.lncrawl.resolveUrl(conn.fallback, rawUrl);
    throw new BadRequestException({
      message: 'No installed novel source supports that link',
      errorCode: WebSerialErrorCode.NovelSourceUnsupported,
    });
  }

  async getSeries(conn: EngineConnection, remoteId: string, options: EngineSeriesOptions = {}): Promise<EngineSeries> {
    const ref = decodeNovelRemoteId(remoteId);
    const [source, novel] = await Promise.all([
      this.source(conn, ref.sourceId),
      this.loadNovel(conn, ref, options.priority === 'bulk', options.signal),
    ]);
    const authors = unique([novel.author ?? '']);
    const chapters = novel.chapters ?? [];
    const status = novelStatus(novel.status);
    const units: EngineUnitSpec[] = [];
    for (let index = 0; index < chapters.length; index += VOLUME_SIZE) {
      const group = chapters.slice(index, index + VOLUME_SIZE);
      const sequence = String(Math.floor(index / VOLUME_SIZE) + 1);
      // Blocks go by list position, never by the site's numbering (a prologue 0 or a skipped number would shift every key).
      const chapterRange = { from: index + 1, to: index + group.length };
      // A short last block can still grow, even on a novel marked completed (an epilogue): the range keeps it from passing
      // for a later, longer copy.
      const ranged = group.length < VOLUME_SIZE;
      units.push({
        unitKey: ranged ? `volume-${sequence}:${chapterRange.from}-${chapterRange.to}` : `volume-${sequence}`,
        label: `Volume ${sequence}`,
        sequence,
        chapterCount: group.length,
        publishedAt: null,
        packaging: 'volume',
        chapterRange,
        remote: unitRemote(ref.sourceId, ref.path, novel, authors, group, sequence, source.lang || null) as unknown as Record<string, unknown>,
      });
    }
    return {
      kind: 'novel',
      title: novel.name,
      author: authors.length > 0 ? authors.join(', ') : null,
      authors,
      ...(novel.artist ? { artists: unique([novel.artist]) } : {}),
      synopsis: htmlToPlainText(novel.summary || novel.summaryHtml || '', { preserveLineBreaks: true }) || null,
      tags: novel.genres ?? [],
      language: source.lang || null,
      remoteCoverPath: novel.cover ?? null,
      sourceName: source.name,
      sourceId: source.id,
      sourceUrl: novel.url ?? absoluteNovelUrl(source.site, ref.path),
      status,
      chapterCount: chapters.length,
      units,
      packagingOptions: ['volume', 'series'],
      defaultPackaging: 'volume',
    };
  }

  /**
   * The service answers 202 while a long chapter list is still loading and keeps loading it. Someone waiting on a preview
   * is told to come back; background work asks again until the service's own deadline for the load has passed.
   */
  private async loadNovel(
    conn: EngineConnection,
    ref: { sourceId: string; path: string },
    bulk: boolean,
    signal?: AbortSignal,
  ): Promise<SourceNovel> {
    const params = new URLSearchParams({ path: ref.path, priority: bulk ? 'bulk' : 'interactive' });
    const path = `/api/v1/sources/${encodeURIComponent(ref.sourceId)}/novel?${params.toString()}`;
    const deadline = Date.now() + NOVEL_SOURCES_NOVEL_LOAD_CAP_MS;
    for (;;) {
      const response = await this.request(conn, path, { method: 'GET' }, signal, bulk ? 'novel' : 'novelInteractive');
      if (response.status !== 202) return readEngineJson<SourceNovel>(response);
      const retryAfterMs = pendingRetryDelay(await readEngineJson<{ retryAfterMs?: unknown }>(response).catch(() => ({})));
      if (!bulk) {
        throw new ServiceUnavailableException(
          codedError('The chapter list is still loading', WebSerialErrorCode.SeriesLoading, {
            source: this.sourceNames.get(ref.sourceId) ?? ref.sourceId,
            retryAfterMs,
          }),
        );
      }
      if (Date.now() + retryAfterMs > deadline) {
        throw withEngineFailure(
          new GatewayTimeoutException(
            this.sourceError(path, 'The novel source did not finish loading the chapter list', WebSerialErrorCode.EngineTimeout),
          ),
          { status: 504, code: 'TIMEOUT' },
        );
      }
      await this.wait(retryAfterMs, signal);
    }
  }

  protected wait(ms: number, signal?: AbortSignal): Promise<void> {
    return abortableDelay(ms, signal);
  }

  startUnit(_conn: EngineConnection, _remoteId: string, unit: EngineUnitSpec): Promise<EngineUnitHandle> {
    const remotes = unit.packaging === 'series' ? requiredRemoteArray(unit.remote, 'volumes') : [unit.remote];
    const first = asUnitRemote(remotes[0]);
    return Promise.resolve({
      unitKey: unit.unitKey,
      remote: {
        ...first,
        chapterPaths: remotes.flatMap((remote) => asUnitRemote(remote).chapterPaths),
        chapterTitles: remotes.flatMap((remote) => asUnitRemote(remote).chapterTitles),
        chapterUrls: remotes.flatMap((remote) => asUnitRemote(remote).chapterUrls),
        volumeIndex: unit.packaging === 'series' ? '1' : first.volumeIndex,
        identityKey: unit.packaging === 'series' ? `series:${unit.unitKey}` : first.volumeIndex,
        volumeLabel: unit.label,
        workDir: unit.remote['workDir'],
      },
    });
  }

  pollUnit(): Promise<EngineUnitProgress> {
    return Promise.resolve({ state: 'done' });
  }

  async download(
    conn: EngineConnection,
    handle: EngineUnitHandle,
    signal?: AbortSignal,
    onProgress?: EngineDownloadProgress,
    options: EngineDownloadOptions = {},
  ): Promise<EngineDownload> {
    const remote = asUnitRemote(handle.remote);
    if (!remote.workDir) throw new BadGatewayException('The novel download work directory is missing');
    const chapterDir = join(remote.workDir, 'chapters');
    await mkdir(chapterDir, { recursive: true });
    const chapterFile = (index: number) => join(chapterDir, `${String(index + 1).padStart(4, '0')}.html`);
    const chapterTitle = (index: number) => remote.chapterTitles[index] || `Chapter ${index + 1}`;
    const total = remote.chapterPaths.length;
    const missing = new Set<number>();
    let consecutiveFailures = 0;
    for (let index = 0; index < total; index += 1) {
      signal?.throwIfAborted();
      if (await options.shouldStop?.()) throw new UnitDownloadStopped('The download was stopped');
      const path = chapterFile(index);
      if (await exists(path)) consecutiveFailures = 0;
      else {
        let html: string | null = null;
        try {
          html = await this.fetchChapterWithRetry(conn, remote.sourceId, remote.chapterPaths[index]!, signal);
        } catch (error) {
          if (signal?.aborted || !isChapterFailure(error)) throw error;
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_CHAPTER_FAILURES) throw error;
          missing.add(index);
        }
        if (html !== null) {
          await writeChapter(path, html);
          consecutiveFailures = 0;
        }
      }
      await onProgress?.({ chaptersDone: index + 1, chaptersTotal: total, stage: 'fetching' });
    }
    const missingChapters = [...missing].map(chapterTitle);
    if (missing.size > total * MAX_MISSING_SHARE) throw new TooManyMissingChaptersError(missingChapters, total);
    if (missing.size > 0 && !options.allowMissingChapters) throw new MissingChaptersError(missingChapters);
    await onProgress?.({ chaptersDone: total, chaptersTotal: total, stage: 'building' });
    const cover = remote.cover ? await this.fetchCover(conn, remote.cover).catch(() => null) : null;
    const outputPath = join(remote.workDir, 'book.epub');
    const volumeLabel = typeof handle.remote['volumeLabel'] === 'string' ? handle.remote['volumeLabel'] : remote.seriesTitle;
    const identityKey = typeof handle.remote['identityKey'] === 'string' ? handle.remote['identityKey'] : undefined;
    const built = await this.epub.build({
      outputPath,
      workDir: remote.workDir,
      sourceId: remote.sourceId,
      seriesPath: remote.seriesPath,
      seriesTitle: remote.seriesTitle,
      authors: remote.authors,
      volumeLabel,
      volumeIndex: remote.volumeIndex,
      identityKey,
      language: remote.language ?? null,
      chapters: remote.chapterPaths.map((_path, index) => ({
        title: chapterTitle(index),
        htmlPath: chapterFile(index),
        sourceUrl: remote.chapterUrls[index] ?? null,
        ...(missing.has(index) ? { missing: true } : {}),
      })),
      cover,
      signal,
    });
    return {
      stream: createReadStream(built.path),
      fileName: `${safeName(volumeLabel)}.epub`,
      format: 'epub',
      size: built.size,
      ...(missingChapters.length > 0 ? { missingChapters } : {}),
    };
  }

  async fetchCover(_conn: EngineConnection, remoteCoverPath: string): Promise<{ body: Buffer; contentType: string }> {
    if (!/^https?:\/\//i.test(remoteCoverPath)) throw new BadRequestException('The remote cover path is invalid');
    const response = await fetchUntrusted(remoteCoverPath, { headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(12_000) });
    const declared = declaredContentType(response);
    if (!response.ok || !mayBeImageType(declared)) {
      void response.body?.cancel().catch(() => undefined);
      throw new BadGatewayException(response.ok ? 'The cover is not a supported image' : 'The cover could not be loaded');
    }
    let body: Buffer;
    try {
      body = await readBoundedBytes(response, COVER_MAX_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw new BadGatewayException('The cover is too large');
      throw error;
    }
    // Some image hosts label every file application/octet-stream, so the bytes decide.
    const contentType = resolveImageType(declared, body);
    if (!contentType) throw new BadGatewayException('The cover is not a supported image');
    return { body, contentType };
  }

  private async fetchChapterWithRetry(conn: EngineConnection, sourceId: string, chapterPath: string, signal?: AbortSignal): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal?.throwIfAborted();
      try {
        const result = await this.getJson<{ html: string }>(
          conn,
          `/api/v1/sources/${encodeURIComponent(sourceId)}/chapter?path=${encodeURIComponent(chapterPath)}&priority=bulk`,
          signal,
          'chapter',
        );
        if (typeof result.html !== 'string') throw new BadGatewayException('The novel source returned invalid chapter content');
        if (!looksLikeChapter(result.html)) throw new BadGatewayException('The novel source returned an empty or blocked chapter page');
        return result.html;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        if (attempt < 2) await abortableDelay(250 * 3 ** attempt, signal);
      }
    }
    throw lastError;
  }

  private mapHit(source: NovelSourceEntry, item: SourceNovelHit): EngineSearchHit {
    return {
      remoteId: encodeNovelRemoteId(source.id, item.path),
      url: item.url ?? absoluteNovelUrl(source.site, item.path),
      title: item.name,
      author: null,
      remoteCoverPath: item.cover ?? null,
      sourceName: source.name,
      chapterCount: null,
      status: 'unknown',
      ...(isMachineTranslationTitle(item.name) ? { mtl: true } : {}),
    };
  }

  private async source(conn: EngineConnection, sourceId: string): Promise<NovelSourceEntry> {
    const source = (await this.listInstalled(conn)).find((entry) => entry.id === sourceId);
    if (!source) throw new BadRequestException(codedError('That novel source is not installed', WebSerialErrorCode.NovelSourceNotInstalled));
    return source;
  }

  /** A failure inside one source names it, so the reader can pick another; anything else is the service's own. */
  private sourceError(path: string, message: string, fallback: WebSerialErrorCode) {
    const match = /^\/api\/v1\/sources\/([^/?]+)\/(?:novel|chapter|search|browse)\b/.exec(path);
    if (!match) return codedError(message, fallback);
    const sourceId = decodeURIComponent(match[1]!);
    return codedError(message, WebSerialErrorCode.SourceFailed, { source: this.sourceNames.get(sourceId) ?? sourceId });
  }

  private async getJson<T>(conn: EngineConnection, path: string, signal?: AbortSignal, timeout: RouteTimeout | number = 'list'): Promise<T> {
    const response = await this.request(conn, path, { method: 'GET' }, signal, timeout);
    return readEngineJson<T>(response);
  }

  private async request(
    conn: EngineConnection,
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    timeout: RouteTimeout | number = 'list',
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (conn.password) headers.set('Authorization', `Bearer ${conn.password}`);
    const timeoutMs = typeof timeout === 'number' ? timeout : NOVEL_SOURCES_ROUTE_TIMEOUTS_MS[timeout];
    const response = await fetchEngineResponse(conn.url, path, { ...init, headers }, { signal, timeoutMs });
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) throw new EngineCredentialsRejectedException();
    let detail = '';
    let code: string | null = null;
    try {
      const body = JSON.parse(await readEngineText(response)) as { error?: unknown; code?: unknown };
      detail = typeof body.error === 'string' ? body.error : '';
      code = typeof body.code === 'string' ? body.code : null;
    } catch {
      // An unreadable error body still fails with the status alone.
    }
    const failure = { status: response.status, code };
    if (code === 'TIMEOUT')
      throw withEngineFailure(
        new GatewayTimeoutException(this.sourceError(path, detail || 'The novel source timed out', WebSerialErrorCode.EngineTimeout)),
        failure,
      );
    throw withEngineFailure(
      new BadGatewayException(
        this.sourceError(
          path,
          detail || `The novel sources service rejected the request with status ${response.status}`,
          WebSerialErrorCode.EngineError,
        ),
      ),
      failure,
    );
  }
}

function encodeNovelRemoteId(sourceId: string, path: string): string {
  return `${sourceId}:${Buffer.from(path).toString('base64url')}`;
}

export function decodeNovelRemoteId(remoteId: string): { sourceId: string; path: string } {
  const split = remoteId.indexOf(':');
  if (split < 1) throw new BadRequestException('Invalid novel source series key');
  const sourceId = remoteId.slice(0, split);
  try {
    const path = Buffer.from(remoteId.slice(split + 1), 'base64url').toString('utf8');
    if (!path) throw new Error('empty');
    return { sourceId, path };
  } catch {
    throw new BadRequestException('Invalid novel source series key');
  }
}

function pendingRetryDelay(body: { retryAfterMs?: unknown }): number {
  const value = typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs) ? body.retryAfterMs : PENDING_RETRY_DEFAULT_MS;
  return Math.min(Math.max(Math.round(value), PENDING_RETRY_MIN_MS), PENDING_RETRY_MAX_MS);
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function absoluteNovelUrl(site: string, path: string): string | null {
  try {
    return new URL(path, site.endsWith('/') ? site : `${site}/`).href;
  } catch {
    return null;
  }
}

function novelStatus(status: string | null | undefined): WebSerialSeriesStatus {
  const value = status?.toLowerCase() ?? '';
  if (value.includes('complete')) return 'completed';
  if (value.includes('hiatus')) return 'hiatus';
  if (value.includes('cancel') || value.includes('drop')) return 'cancelled';
  if (value.includes('ongoing') || value.includes('publishing')) return 'ongoing';
  return 'unknown';
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function unitRemote(
  sourceId: string,
  seriesPath: string,
  novel: SourceNovel,
  authors: string[],
  chapters: SourceChapter[],
  volumeIndex: string,
  language: string | null,
): UnitRemote {
  return {
    sourceId,
    seriesPath,
    seriesTitle: novel.name,
    authors,
    cover: novel.cover ?? null,
    language,
    chapterPaths: chapters.map((chapter) => chapter.path),
    chapterTitles: chapters.map((chapter, index) => chapter.name?.trim() || `Chapter ${index + 1}`),
    chapterUrls: chapters.map((chapter) => chapter.url ?? null),
    volumeIndex,
  };
}

function asUnitRemote(value: Record<string, unknown> | undefined): UnitRemote {
  if (!value || typeof value['sourceId'] !== 'string' || !Array.isArray(value['chapterPaths'])) {
    throw new BadRequestException('The novel unit description is invalid');
  }
  return value as unknown as UnitRemote;
}

function requiredRemoteArray(remote: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = remote[key];
  if (!Array.isArray(value) || value.length === 0) throw new BadRequestException('The novel unit description is invalid');
  return value as Record<string, unknown>[];
}

/** Written beside its final name first, so a crash mid-write never leaves a cut-off chapter that a resume would take as complete. */
async function writeChapter(path: string, html: string): Promise<void> {
  const partial = `${path}.part`;
  await writeFile(partial, html);
  await rename(partial, path);
}

/** A chapter that fails on its own is a gap in the book; an engine that is down or refuses the credentials fails the whole unit. */
function isChapterFailure(error: unknown): boolean {
  const reason = classifyFailure(error);
  return reason !== 'engine_unreachable' && reason !== 'engine_credentials';
}

/**
 * An empty page, or a short page that is a Cloudflare or DDoS-Guard challenge or a login form, is a failed fetch and never
 * saved as the chapter. Text alone decides nothing: a short chapter may well ask the reader to sign in for a bonus.
 */
function looksLikeChapter(html: string): boolean {
  const text = htmlToPlainText(html).trim();
  if (!text) return /<img\b/i.test(html);
  if (text.length > BLOCKED_PAGE_MAX_TEXT) return true;
  const head = html.slice(0, 20_000);
  return !CHALLENGE_TITLE.test(head) && !CHALLENGE_MARKUP.test(head) && !LOGIN_FORM.test(head);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'novel';
}
