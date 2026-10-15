import { createHash } from 'node:crypto';

import { BadGatewayException, BadRequestException, GatewayTimeoutException, Injectable, Logger } from '@nestjs/common';
import type { WebSerialEngineHealth, WebSerialNovelSource, WebSerialSeriesStatus } from '@bookorbit/types';

import { mapWithConcurrency } from '../../../common/utils/batch.utils';
import {
  assertEngineResponseOk,
  uniqueStrings,
  EngineCredentialsRejectedException,
  fetchEngineResponse,
  fetchEngineStream,
  readEngineCover,
  readEngineJson,
  responseContentType,
  responseSize,
} from './engine-http.utils';
import type {
  EngineConnection,
  EngineDownload,
  EngineSearchHit,
  EngineSeries,
  EngineSeriesRef,
  EngineUnitHandle,
  EngineUnitProgress,
  EngineUnitSpec,
  WebSerialEngineClient,
} from './web-serial-engine';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from '../web-serials-error.utils';
import { logEngineHealthEnd, logEngineHealthFail, logNovelSearchEnd, logNovelSearchStart } from './engine-log.utils';

const HEALTH_EVENT = 'web_serials.lncrawl_health';

const SEARCH_CONCURRENCY = 3;
const SEARCH_BUDGET_MS = 12_000;
const SEARCH_POLL_MS = 400;
const SEARCH_STABLE_POLLS = 2;
const SEARCH_QUERY_MAX = 50;
const SEARCH_HITS_PER_SOURCE = 25;
const RESOLVE_BUDGET_MS = 60_000;
const RESOLVE_POLL_MS = 1_000;
const ARTIFACT_PAGE_SIZE = 100;
const ARTIFACT_MAX_PAGES = 20;
const FETCH_PROGRESS_SHARE = 0.9;
const EPUB_CONTENT_TYPES = new Set(['application/epub+zip', 'application/zip', 'application/octet-stream']);

interface LncrawlJob {
  id: string;
  status: number;
  is_done: boolean;
  is_running?: number | boolean;
  progress: number;
  done: number;
  failed: number;
  total: number;
  error: string | null;
  extra: Record<string, unknown>;
}

interface LncrawlNovel {
  id: string;
  url: string;
  title: string;
  synopsis: string | null;
  cover_file?: string | null;
  cover_available?: boolean;
  authors: string | null;
  tags: string[] | null;
  language: string | null;
  chapter_count: number;
  domain: string;
}

interface LncrawlVolume {
  id: string;
  serial: number;
  title: string;
  chapter_count: number;
}

interface LncrawlArtifact {
  id: string;
  novel_id: string;
  format: string;
  volume: number | null;
  file_name: string;
  file_size: number;
  created_at: number;
  is_available: boolean;
}

interface LncrawlSource {
  domain: string;
  language: string;
  can_search: boolean;
  is_disabled: boolean;
}

interface Paginated<T> {
  total: number;
  offset: number;
  limit: number;
  items: T[];
}

interface VolumeRef {
  volumeId: string;
  serial: number;
}

type UnitStage = 'fetching' | 'building';

@Injectable()
export class LncrawlClient implements WebSerialEngineClient {
  readonly kind = 'novel' as const;
  private readonly logger = new Logger(LncrawlClient.name);
  private readonly tokens = new Map<string, string>();
  private readonly logins = new Map<string, Promise<string>>();

  async health(conn: EngineConnection, allowedSources: string[]): Promise<WebSerialEngineHealth> {
    const startedAt = Date.now();
    this.logger.log(`[${HEALTH_EVENT}] [start] - engine health check started`);
    try {
      const response = await fetchEngineResponse(conn.url, '/health', { method: 'GET' });
      assertEngineResponseOk(response);
      const info = await readEngineJson<{ version?: string | null }>(response);
      const sources = await this.listSources(conn);
      const allowed = new Set(allowedSources.map((domain) => domain.trim().toLowerCase()));
      const searchableSources = sources.filter((source) => source.canSearch && !source.disabled && allowed.has(source.domain.toLowerCase())).length;
      logEngineHealthEnd(this.logger, HEALTH_EVENT, startedAt, searchableSources);
      return {
        ok: true,
        checkedAt: new Date().toISOString(),
        version: typeof info.version === 'string' ? info.version : null,
        searchableSources,
        error: null,
      };
    } catch (error) {
      const message = logEngineHealthFail(this.logger, HEALTH_EVENT, startedAt, error);
      return { ok: false, checkedAt: new Date().toISOString(), version: null, searchableSources: 0, error: message };
    }
  }

  async listSources(conn: EngineConnection): Promise<WebSerialNovelSource[]> {
    const response = await this.api(conn, '/api/sources', { method: 'GET' });
    assertEngineResponseOk(response);
    const sources = await readEngineJson<LncrawlSource[]>(response);
    if (!Array.isArray(sources))
      throw new BadGatewayException(codedError('The remote service returned an unexpected source list', WebSerialErrorCode.EngineError));
    return sources.map((source) => ({
      domain: source.domain,
      language: source.language,
      canSearch: source.can_search === true,
      disabled: source.is_disabled === true,
    }));
  }

  async search(
    conn: EngineConnection,
    query: string,
    allowedSources: string[],
    signal?: AbortSignal,
  ): Promise<{ hits: EngineSearchHit[]; failedSources: string[] }> {
    const startedAt = Date.now();
    const text = query.trim().slice(0, SEARCH_QUERY_MAX);
    const domains = [...new Set(allowedSources.map((domain) => domain.trim()).filter(Boolean))];
    if (text.length < 2 || domains.length === 0) return { hits: [], failedSources: [] };
    logNovelSearchStart(this.logger, 'lncrawl', domains.length, text.length);

    const deadline = startedAt + SEARCH_BUDGET_MS;
    const results = await mapWithConcurrency(domains, SEARCH_CONCURRENCY, async (domain) => {
      if (Date.now() >= deadline || signal?.aborted) return { hits: [], failedSource: domain };
      try {
        const searched = await this.searchDomain(conn, text, domain, deadline, signal);
        return { hits: searched.hits, failedSource: searched.complete ? null : domain };
      } catch {
        return { hits: [], failedSource: domain };
      }
    });
    const hits = results.flatMap((result) => result.hits);
    const failedSources = results.flatMap((result) => (result.failedSource ? [result.failedSource] : []));
    logNovelSearchEnd(this.logger, 'lncrawl', startedAt, hits.length, failedSources.length);
    return { hits, failedSources };
  }

  async resolveUrl(conn: EngineConnection, url: string): Promise<EngineSeriesRef | null> {
    const startedAt = Date.now();
    this.logger.log(`[web_serials.novel_resolve] [start] - resolve started`);
    let job: LncrawlJob;
    try {
      job = await this.createJob(conn, 'fetch-novels', { urls: [url], full: false });
    } catch (error) {
      if (error instanceof EngineCredentialsRejectedException) throw error;
      if (error instanceof BadGatewayException) return null;
      throw error;
    }
    const finished = await this.waitForJob(conn, job.id, startedAt + RESOLVE_BUDGET_MS, RESOLVE_POLL_MS);
    if (!finished) {
      await this.cancelJob(conn, job.id);
      throw new GatewayTimeoutException(codedError('The remote service did not resolve the link in time', WebSerialErrorCode.EngineTimeout));
    }
    const novelId = finished.extra['novel_id'];
    const ok = isSuccess(finished) && typeof novelId === 'string' && novelId.length > 0;
    this.logger.log(`[web_serials.novel_resolve] [end] durationMs=${Date.now() - startedAt} resolved=${ok} - resolve completed`);
    return ok ? { kind: this.kind, remoteId: novelId } : null;
  }

  async getSeries(conn: EngineConnection, remoteId: string): Promise<EngineSeries> {
    const novelId = encodeURIComponent(remoteId);
    const [novel, volumes] = await Promise.all([
      this.getJson<LncrawlNovel>(conn, `/api/novel/${novelId}`),
      this.getJson<LncrawlVolume[]>(conn, `/api/novel/${novelId}/volumes`),
    ]);
    const authors = uniqueStrings((novel.authors ?? '').split(','));
    const sortedVolumes = [...volumes].sort((left, right) => left.serial - right.serial);
    let position = 0;
    const ranges = sortedVolumes.map((volume) => {
      const from = position + 1;
      position += Math.max(0, volume.chapter_count);
      return volume.chapter_count > 0 ? { from, to: position } : null;
    });
    return {
      kind: this.kind,
      title: novel.title,
      author: authors.length > 0 ? authors.join(', ') : null,
      authors,
      synopsis: novel.synopsis?.trim() || null,
      tags: novel.tags ?? [],
      language: novel.language ?? null,
      remoteCoverPath: novel.cover_available && novel.cover_file ? novel.cover_file : null,
      sourceName: novel.domain,
      sourceUrl: novel.url ?? null,
      status: 'unknown',
      chapterCount: novel.chapter_count,
      units: sortedVolumes.map((volume, index) => {
        const chapterRange = ranges[index] ?? null;
        // lightnovel-crawler never knows whether a novel is finished, so its last volume can always grow: the range keeps
        // a grown copy from passing for the shorter one already filed.
        const ranged = index === sortedVolumes.length - 1 && chapterRange !== null;
        return {
          unitKey: ranged ? `${volume.id}:${chapterRange.from}-${chapterRange.to}` : volume.id,
          label: volume.title,
          sequence: String(volume.serial),
          chapterCount: volume.chapter_count,
          publishedAt: null,
          packaging: 'volume' as const,
          chapterRange,
          remote: { volumeId: volume.id, serial: volume.serial },
        };
      }),
      packagingOptions: ['volume', 'series'],
      defaultPackaging: 'volume',
    };
  }

  async startUnit(conn: EngineConnection, remoteId: string, unit: EngineUnitSpec): Promise<EngineUnitHandle> {
    const volumes = unitVolumes(unit);
    if (volumes.length === 0) throw new BadRequestException('No volumes were selected');
    const job = await this.createJob(conn, 'fetch-volumes', { volumes: volumes.map((volume) => volume.volumeId) });
    return {
      unitKey: unit.unitKey,
      remote: {
        stage: 'fetching' satisfies UnitStage,
        novelId: remoteId,
        jobId: job.id,
        volumes,
        serial: unit.packaging === 'series' ? null : volumes[0].serial,
      },
    };
  }

  async pollUnit(conn: EngineConnection, handle: EngineUnitHandle): Promise<EngineUnitProgress> {
    const remote = handle.remote;
    const stage = remote['stage'] === 'building' ? 'building' : 'fetching';
    const job = await this.getJob(conn, requiredString(remote, 'jobId'));

    if (!job.is_done) return jobProgress(job, stage);
    if (!isSuccess(job)) return { state: 'failed', reason: failureReason(job, stage) };
    if (stage === 'building') return { state: 'done' };

    const serial = typeof remote['serial'] === 'number' ? remote['serial'] : null;
    const build = await this.createJob(conn, 'make-artifacts', {
      novel_id: requiredString(remote, 'novelId'),
      formats: ['epub'],
      ...(serial === null ? {} : { volume: serial }),
    });
    remote['stage'] = 'building';
    remote['jobId'] = build.id;
    return { state: 'running', progress: FETCH_PROGRESS_SHARE, stage: 'building' };
  }

  async download(conn: EngineConnection, handle: EngineUnitHandle, signal?: AbortSignal): Promise<EngineDownload> {
    const novelId = requiredString(handle.remote, 'novelId');
    const serial = typeof handle.remote['serial'] === 'number' ? handle.remote['serial'] : null;
    const artifact = await this.findArtifact(conn, novelId, serial);
    if (!artifact) throw new BadGatewayException('The remote service has no finished file for this unit');

    const path = `/static/novels/${encodeURIComponent(novelId)}/artifacts/${encodeURIComponent(artifact.file_name)}`;
    const response = await this.staticFetch(conn, path, true, signal);
    const contentType = responseContentType(response);
    if (!EPUB_CONTENT_TYPES.has(contentType)) {
      void response.body?.cancel().catch(() => undefined);
      throw new BadGatewayException('The remote service did not return an EPUB file');
    }
    if (!response.body) throw new BadGatewayException('The remote service returned an empty EPUB file');
    return {
      stream: response.body,
      fileName: artifact.file_name,
      format: 'epub',
      size: responseSize(response) ?? (artifact.file_size > 0 ? artifact.file_size : null),
    };
  }

  async cancelUnit(conn: EngineConnection, handle: EngineUnitHandle): Promise<void> {
    const jobId = handle.remote['jobId'];
    if (typeof jobId !== 'string' || !jobId) return;
    await this.cancelJob(conn, jobId);
  }

  async fetchCover(conn: EngineConnection, remoteCoverPath: string): Promise<{ body: Buffer; contentType: string }> {
    const segments = remoteCoverPath.split('/');
    if (
      remoteCoverPath.length === 0 ||
      remoteCoverPath.startsWith('/') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))
    ) {
      throw new BadRequestException('The remote cover path is invalid');
    }
    const response = await this.staticFetch(conn, `/static/${segments.map(encodeURIComponent).join('/')}`, false);
    const contentType = responseContentType(response);
    if (!contentType.startsWith('image/')) {
      void response.body?.cancel().catch(() => undefined);
      throw new BadGatewayException('The remote service did not return an image');
    }
    return { body: await readEngineCover(response), contentType };
  }

  private async searchDomain(
    conn: EngineConnection,
    query: string,
    domain: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<{ hits: EngineSearchHit[]; complete: boolean }> {
    const created = await this.createJob(conn, 'search-sources', { query, domain });
    let job = created;
    let lastCount = -1;
    let stablePolls = 0;
    let cutShort = false;
    for (;;) {
      if (job.is_done) break;
      const count = searchResults(job).length;
      stablePolls = count > 0 && count === lastCount ? stablePolls + 1 : 0;
      if (stablePolls >= SEARCH_STABLE_POLLS) break;
      lastCount = count;
      if (signal?.aborted || Date.now() + SEARCH_POLL_MS >= deadline) {
        cutShort = true;
        break;
      }
      await this.sleep(SEARCH_POLL_MS);
      job = await this.getJob(conn, created.id);
    }
    if (job.is_done && !isSuccess(job) && searchResults(job).length === 0) {
      void this.cancelJob(conn, created.id);
      throw new BadGatewayException('The source did not answer');
    }
    if (!job.is_done) void this.cancelJob(conn, created.id);
    const hits = searchResults(job)
      .slice(0, SEARCH_HITS_PER_SOURCE)
      .map((entry): EngineSearchHit => ({
        remoteId: null,
        url: entry.url,
        title: entry.title,
        author: null,
        remoteCoverPath: null,
        sourceName: domain,
        chapterCount: null,
        status: mapInfoStatus(entry.info),
      }));
    return { hits, complete: !cutShort };
  }

  /** Resolves with the finished job, or with the latest job state when `early` accepts it; null on timeout. */
  private async waitForJob(
    conn: EngineConnection,
    jobId: string,
    deadline: number,
    pollMs: number,
    signal?: AbortSignal,
    early?: (job: LncrawlJob) => boolean,
  ): Promise<LncrawlJob | null> {
    let latest: LncrawlJob | null = null;
    for (;;) {
      if (signal?.aborted) return latest && early?.(latest) ? latest : null;
      latest = await this.getJob(conn, jobId);
      if (latest.is_done) return latest;
      if (Date.now() + pollMs >= deadline) return early?.(latest) ? latest : null;
      await this.sleep(pollMs);
    }
  }

  private async findArtifact(conn: EngineConnection, novelId: string, serial: number | null): Promise<LncrawlArtifact | null> {
    let newest: LncrawlArtifact | null = null;
    for (let page = 0; page < ARTIFACT_MAX_PAGES; page += 1) {
      const offset = page * ARTIFACT_PAGE_SIZE;
      const result = await this.getJson<Paginated<LncrawlArtifact>>(
        conn,
        `/api/artifacts?offset=${offset}&limit=${ARTIFACT_PAGE_SIZE}&novel_id=${encodeURIComponent(novelId)}&format=epub`,
      );
      for (const item of result.items) {
        if (item.novel_id !== novelId || item.format !== 'epub' || !item.is_available) continue;
        if ((item.volume ?? null) !== serial) continue;
        if (!newest || item.created_at > newest.created_at) newest = item;
      }
      if (offset + result.items.length >= result.total || result.items.length === 0) break;
    }
    return newest;
  }

  private async createJob(conn: EngineConnection, type: string, body: Record<string, unknown>): Promise<LncrawlJob> {
    const response = await this.api(conn, `/api/job/create/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assertEngineResponseOk(response);
    return readEngineJson<LncrawlJob>(response);
  }

  private getJob(conn: EngineConnection, jobId: string): Promise<LncrawlJob> {
    return this.getJson<LncrawlJob>(conn, `/api/job/${encodeURIComponent(jobId)}`);
  }

  private async cancelJob(conn: EngineConnection, jobId: string): Promise<void> {
    try {
      const response = await this.api(conn, `/api/job/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
      void response.body?.cancel().catch(() => undefined);
    } catch {
      return;
    }
  }

  private async getJson<T>(conn: EngineConnection, path: string): Promise<T> {
    const response = await this.api(conn, path, { method: 'GET' });
    assertEngineResponseOk(response);
    return readEngineJson<T>(response);
  }

  private async api(conn: EngineConnection, path: string, init: RequestInit): Promise<Response> {
    const send = async (token: string) =>
      fetchEngineResponse(conn.url, path, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      });
    let response = await send(await this.token(conn));
    if (response.status === 401) {
      void response.body?.cancel().catch(() => undefined);
      this.tokens.delete(tokenKey(conn));
      response = await send(await this.token(conn));
    }
    return response;
  }

  private async staticFetch(conn: EngineConnection, path: string, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const send = async (token: string) => {
      const target = `${path}?token=${encodeURIComponent(token)}`;
      const init: RequestInit = { method: 'GET' };
      return stream ? fetchEngineStream(conn.url, target, init, { signal }) : fetchEngineResponse(conn.url, target, init);
    };
    let response = await send(await this.token(conn));
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      this.tokens.delete(tokenKey(conn));
      response = await send(await this.token(conn));
    }
    assertEngineResponseOk(response);
    return response;
  }

  private async token(conn: EngineConnection): Promise<string> {
    const key = tokenKey(conn);
    const cached = this.tokens.get(key);
    if (cached) return cached;
    const pending = this.logins.get(key);
    if (pending) return pending;
    const login = this.login(conn, key).finally(() => this.logins.delete(key));
    this.logins.set(key, login);
    return login;
  }

  private async login(conn: EngineConnection, key: string): Promise<string> {
    const response = await fetchEngineResponse(conn.url, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: conn.username ?? '', password: conn.password ?? '' }),
    });
    assertEngineResponseOk(response);
    const login = await readEngineJson<{ token?: unknown }>(response);
    if (typeof login.token !== 'string' || login.token.length === 0) {
      throw new EngineCredentialsRejectedException('The remote service did not accept the configured credentials');
    }
    this.tokens.set(key, login.token);
    return login.token;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function tokenKey(conn: EngineConnection): string {
  const secret = createHash('sha256')
    .update(`${conn.username ?? ''}\u0000${conn.password ?? ''}`)
    .digest('hex');
  return `${conn.url}\u0000${secret}`;
}

function isSuccess(job: LncrawlJob): boolean {
  return job.is_done && !job.error && (job.failed ?? 0) === 0 && job.status === 2;
}

function searchResults(job: LncrawlJob): Array<{ title: string; url: string; info: string | null }> {
  const raw = job.extra?.['search_results'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { title, url, info } = entry as Record<string, unknown>;
    if (typeof title !== 'string' || typeof url !== 'string' || !title.trim() || !/^https?:\/\//i.test(url)) return [];
    return [{ title: title.trim(), url, info: typeof info === 'string' ? info : null }];
  });
}

function mapInfoStatus(info: string | null): WebSerialSeriesStatus {
  const value = info?.trim().toLowerCase() ?? '';
  if (value === 'ongoing') return 'ongoing';
  if (value === 'completed') return 'completed';
  if (value === 'hiatus' || value === 'on hold') return 'hiatus';
  if (value === 'dropped' || value === 'cancelled') return 'cancelled';
  return 'unknown';
}

function jobProgress(job: LncrawlJob, stage: UnitStage): EngineUnitProgress {
  const fraction = Number.isFinite(job.progress) ? Math.max(0, Math.min(1, job.progress / 100)) : null;
  const progress =
    fraction === null ? null : stage === 'fetching' ? fraction * FETCH_PROGRESS_SHARE : FETCH_PROGRESS_SHARE + fraction * (1 - FETCH_PROGRESS_SHARE);
  const started = job.is_running === true || job.is_running === 1 || job.status === 1;
  const counts =
    stage === 'fetching' && Number.isFinite(job.total) && job.total > 0 && Number.isFinite(job.done)
      ? { chaptersDone: Math.max(0, Math.min(job.total, Math.floor(job.done))), chaptersTotal: Math.floor(job.total) }
      : {};
  return { state: started ? 'running' : 'pending', progress, stage, ...counts };
}

function failureReason(job: LncrawlJob, stage: UnitStage): string {
  if (job.failed > 0 && !job.error) {
    return stage === 'fetching' ? `${job.failed} chapter${job.failed === 1 ? '' : 's'} could not be fetched` : 'The book file could not be built';
  }
  if (job.status === 4) return 'The download was cancelled';
  const base = stage === 'fetching' ? 'The chapters could not be fetched' : 'The book file could not be built';
  return job.error ? `${base}: ${job.error.replace(/\s+/g, ' ').trim().slice(0, 150)}` : base;
}

function unitVolumes(unit: EngineUnitSpec): VolumeRef[] {
  const source = unit.packaging === 'series' ? unit.remote['volumes'] : [unit.remote];
  if (!Array.isArray(source)) return [];
  return source.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { volumeId, serial } = entry as Record<string, unknown>;
    if (typeof volumeId !== 'string' || typeof serial !== 'number' || !Number.isInteger(serial)) return [];
    return [{ volumeId, serial }];
  });
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new BadRequestException('The saved engine handle is invalid');
  return value;
}
