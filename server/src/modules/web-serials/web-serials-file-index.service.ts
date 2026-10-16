import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy } from '@nestjs/common';

import {
  WebSerialErrorCode,
  type WebSerialFileIndex,
  type WebSerialFileIndexFormat,
  type WebSerialFileIndexInput,
  type WebSerialFileIndexKeyMap,
  type WebSerialFileIndexPreview,
} from '@bookorbit/types';
import { SystemCron } from '../../common/decorators/system-cron.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { basicAuthHeaders } from './engines/engine-http.utils';
import { groupListing } from './file-index/file-index-grouping';
import { readListing, type FileIndexSource } from './file-index/file-index-reader';
import type { NewWebSerialFileIndexRow, WebSerialFileIndexRow } from './schema/web-serials.schema';
import { codedError } from './web-serials-error.utils';
import { WebSerialsFileIndexRepository } from './web-serials-file-index.repository';
import { describeError } from './web-serials-log.utils';
import { WebSerialsSecretService } from './web-serials-secret.service';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { ensureSafeEngineUrl } from './web-serials-url.utils';

const REFRESH_EVENT = 'web_serials.file_index_refresh';
const ADMIN_EVENT = 'web_serials.file_index_admin';
const TEST_EVENT = 'web_serials.file_index_test';
const JSON_READ_TIMEOUT_MS = 5 * 60_000;
const HTML_READ_TIMEOUT_MS = 60 * 60_000;
const TEST_TIMEOUT_MS = 2 * 60_000;
const TEST_HTML_PAGE_DELAY_MS = 100;
const PREVIEW_SERIES = 20;
const PREVIEW_VOLUMES = 10;
const ERROR_MAX_LENGTH = 300;
const DEFAULT_REFRESH_HOURS = 24;

export type FileIndexTestInput = WebSerialFileIndexInput & { id?: number };

@Injectable()
export class WebSerialsFileIndexService implements OnModuleDestroy {
  private readonly logger = new Logger(WebSerialsFileIndexService.name);
  private running: Promise<void> | null = null;
  private current: { id: number; controller: AbortController } | null = null;
  private readonly requested = new Set<number>();

  constructor(
    private readonly repo: WebSerialsFileIndexRepository,
    private readonly secrets: WebSerialsSecretService,
    private readonly settings: WebSerialsSettingsService,
  ) {}

  onModuleDestroy(): void {
    this.current?.controller.abort();
  }

  async list(): Promise<WebSerialFileIndex[]> {
    return (await this.repo.listIndexes()).map((row) => this.view(row));
  }

  async create(input: WebSerialFileIndexInput, user: RequestUser): Promise<WebSerialFileIndex> {
    const startedAt = Date.now();
    if (!input.name?.trim() || !input.listingUrl?.trim()) {
      throw new BadRequestException(codedError('A file index needs a name and a listing URL', WebSerialErrorCode.EngineUrlInvalid));
    }
    const listingUrl = await safeListingUrl(input.listingUrl);
    const baseUrl = await safeBaseUrl(input.baseUrl, listingUrl);
    const row = await this.repo.createIndex({
      name: input.name.trim(),
      listingUrl,
      baseUrl,
      format: input.format ?? (await this.detectFormat({ ...input, listingUrl, baseUrl })),
      keyMap: cleanKeyMap(input.keyMap),
      username: blankToNull(input.username),
      passwordEnc: input.password ? this.secrets.encrypt(input.password) : null,
      enabled: input.enabled ?? true,
      refreshHours: input.refreshHours ?? DEFAULT_REFRESH_HOURS,
    });
    this.logger.log(
      `[${ADMIN_EVENT}] [end] indexId=${row.id} userId=${user.id} action=create format=${row.format} durationMs=${Date.now() - startedAt} - file index created`,
    );
    this.settings.bumpCatalogVersion();
    if (row.enabled) this.queue(row.id);
    return this.view(row);
  }

  async update(id: number, input: WebSerialFileIndexInput, user: RequestUser): Promise<WebSerialFileIndex> {
    const startedAt = Date.now();
    const existing = await this.requireIndex(id);
    const patch: Partial<NewWebSerialFileIndexRow> = {};
    if (input.name !== undefined) {
      if (!input.name.trim()) throw new BadRequestException(codedError('A file index needs a name', WebSerialErrorCode.EngineUrlInvalid));
      patch.name = input.name.trim();
    }
    const listingUrl = input.listingUrl !== undefined ? await safeListingUrl(input.listingUrl) : existing.listingUrl;
    if (listingUrl !== existing.listingUrl) patch.listingUrl = listingUrl;
    if (input.baseUrl !== undefined || patch.listingUrl) {
      const baseUrl = await safeBaseUrl(input.baseUrl, listingUrl);
      if (baseUrl !== existing.baseUrl) patch.baseUrl = baseUrl;
    }
    if (input.format !== undefined) patch.format = input.format;
    if (input.keyMap !== undefined) patch.keyMap = cleanKeyMap(input.keyMap);
    if (input.username !== undefined) patch.username = blankToNull(input.username);
    if (input.password !== undefined) patch.passwordEnc = input.password ? this.secrets.encrypt(input.password) : null;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.refreshHours !== undefined) patch.refreshHours = input.refreshHours;

    const sourceChanged = ['listingUrl', 'baseUrl', 'format', 'keyMap', 'username', 'passwordEnc'].some((key) => key in patch);
    // A changed source makes the stored validators meaningless: the next refresh must read the listing in full.
    if (sourceChanged) Object.assign(patch, { lastEtag: null, lastModified: null, lastRefreshAt: null });
    if (sourceChanged || patch.enabled === false) this.stopIfRunning(id);

    const row = Object.keys(patch).length > 0 ? ((await this.repo.updateIndex(id, patch)) ?? existing) : existing;
    this.logger.log(
      `[${ADMIN_EVENT}] [end] indexId=${id} userId=${user.id} action=update sourceChanged=${sourceChanged} enabled=${row.enabled} durationMs=${Date.now() - startedAt} - file index updated`,
    );
    this.settings.bumpCatalogVersion();
    if (sourceChanged && row.enabled) this.queue(id);
    return this.view(row);
  }

  async remove(id: number, user: RequestUser): Promise<void> {
    const startedAt = Date.now();
    this.stopIfRunning(id);
    if (!(await this.repo.deleteIndex(id))) throw notFound();
    this.requested.delete(id);
    this.settings.bumpCatalogVersion();
    this.logger.log(`[${ADMIN_EVENT}] [end] indexId=${id} userId=${user.id} action=remove durationMs=${Date.now() - startedAt} - file index removed`);
  }

  async refreshNow(id: number, user: RequestUser): Promise<WebSerialFileIndex> {
    const row = await this.requireIndex(id);
    if (!row.enabled) throw new BadRequestException(codedError('Enable this file index before refreshing it', WebSerialErrorCode.SourceDisabled));
    if (this.current?.id === id)
      throw new ConflictException(codedError('This file index is being refreshed right now', WebSerialErrorCode.FileIndexBusy));
    this.logger.log(`[${ADMIN_EVENT}] [end] indexId=${id} userId=${user.id} action=refresh durationMs=0 - file index refresh requested`);
    await this.repo.updateIndex(id, { lastEtag: null, lastModified: null });
    this.queue(id);
    return this.view(row);
  }

  /** Reads a listing the way a refresh would and reports what it would store, without storing anything. */
  async test(input: FileIndexTestInput, user: RequestUser): Promise<WebSerialFileIndexPreview> {
    const startedAt = Date.now();
    const stored = input.id !== undefined ? await this.requireIndex(input.id) : null;
    const listingUrl = await safeListingUrl(input.listingUrl ?? stored?.listingUrl ?? '');
    const baseUrl = await safeBaseUrl(
      input.baseUrl !== undefined ? input.baseUrl : listingUrl === stored?.listingUrl ? stored.baseUrl : null,
      listingUrl,
    );
    const source: FileIndexSource = {
      listingUrl,
      baseUrl,
      format: input.format ?? stored?.format ?? null,
      keyMap: cleanKeyMap(input.keyMap ?? stored?.keyMap),
      authorization: this.authorization(
        input.username !== undefined ? blankToNull(input.username) : (stored?.username ?? null),
        input.password !== undefined ? input.password || null : stored?.passwordEnc ? this.secrets.decrypt(stored.passwordEnc) : null,
      ),
    };
    this.logger.log(
      `[${TEST_EVENT}] [start] indexId=${stored?.id ?? 'new'} userId=${user.id} format=${source.format ?? 'auto'} - file index test started`,
    );
    try {
      const read = await readListing(source, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS), pageDelayMs: TEST_HTML_PAGE_DELAY_MS });
      if (read.notModified) throw new BadRequestException(codedError('The file index sent no listing', WebSerialErrorCode.FileIndexUnreadable));
      const grouped = groupListing(read.listing.files);
      this.logger.log(
        `[${TEST_EVENT}] [end] indexId=${stored?.id ?? 'new'} userId=${user.id} durationMs=${Date.now() - startedAt} format=${read.format} pages=${read.pages} series=${grouped.series.length} files=${grouped.fileCount} truncated=${read.listing.truncated} - file index test completed`,
      );
      return {
        format: read.format,
        series: grouped.series.length,
        files: grouped.fileCount,
        skippedFiles: grouped.skippedFiles,
        unnumberedFiles: grouped.unnumberedFiles,
        truncated: read.listing.truncated,
        sample: grouped.series.slice(0, PREVIEW_SERIES).map((series) => ({
          folderPath: series.folderPath,
          title: series.title,
          volumes: series.files.slice(0, PREVIEW_VOLUMES).map((file) => ({ name: file.name, volume: file.volume })),
        })),
      };
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${TEST_EVENT}] [fail] indexId=${stored?.id ?? 'new'} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - file index test failed`,
      );
      throw error;
    }
  }

  @SystemCron('*/10 * * * *')
  async tick(): Promise<void> {
    if (!this.running) {
      this.running = this.runDue().finally(() => {
        this.running = null;
      });
    }
    await this.running;
  }

  private queue(id: number): void {
    this.requested.add(id);
    if (!this.running) void this.tick().catch(() => undefined);
  }

  private stopIfRunning(id: number): void {
    if (this.current?.id === id) this.current.controller.abort();
  }

  /** Requested indexes first, then due ones; an index whose failure could not be recorded is not retried in the same run. */
  private async runDue(): Promise<void> {
    const attempted = new Set<number>();
    for (;;) {
      const due = (await this.repo.dueIndexIds(new Date())).map((row) => row.id).filter((id) => !attempted.has(id));
      const next = this.requested.values().next().value ?? due[0];
      if (next === undefined) return;
      this.requested.delete(next);
      attempted.add(next);
      const row = await this.repo.findIndex(next);
      if (row?.enabled) await this.refresh(row);
    }
  }

  private async refresh(row: WebSerialFileIndexRow): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), row.format === 'html' ? HTML_READ_TIMEOUT_MS : JSON_READ_TIMEOUT_MS);
    timeout.unref();
    this.current = { id: row.id, controller };
    this.logger.log(
      `[${REFRESH_EVENT}] [start] indexId=${row.id} format=${row.format} conditional=${Boolean(row.lastEtag || row.lastModified)} - file index refresh started`,
    );
    try {
      const read = await readListing(this.source(row), {
        signal: controller.signal,
        validators: { etag: row.lastEtag, lastModified: row.lastModified },
      });
      const refreshedAt = new Date();
      if (read.notModified) {
        await this.repo.updateIndex(row.id, { lastRefreshAt: refreshedAt, lastError: null });
        this.logger.log(`[${REFRESH_EVENT}] [end] indexId=${row.id} durationMs=${Date.now() - startedAt} notModified=true - file index unchanged`);
        return;
      }
      const grouped = groupListing(read.listing.files);
      if (controller.signal.aborted)
        throw new ConflictException(codedError('The file index changed during the refresh', WebSerialErrorCode.FileIndexBusy));
      const written = await this.repo.writeListing(row.id, grouped.series, refreshedAt);
      this.settings.bumpCatalogVersion();
      await this.repo.updateIndex(row.id, {
        lastRefreshAt: refreshedAt,
        lastEtag: read.etag?.slice(0, 512) ?? null,
        lastModified: read.lastModified?.slice(0, 100) ?? null,
        seriesCount: written.series,
        fileCount: written.files,
        lastError: read.listing.truncated ? 'The listing is larger than BookOrbit reads; only part of it was indexed' : null,
      });
      this.logger.log(
        `[${REFRESH_EVENT}] [end] indexId=${row.id} durationMs=${Date.now() - startedAt} notModified=false pages=${read.pages} series=${written.series} files=${written.files} removedSeries=${written.removedSeries} removedFiles=${written.removedFiles} skippedFiles=${grouped.skippedFiles} unnumberedFiles=${grouped.unnumberedFiles} truncated=${read.listing.truncated} - file index refreshed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[${REFRESH_EVENT}] [fail] indexId=${row.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - file index refresh failed`,
      );
      await this.repo.updateIndex(row.id, { lastRefreshAt: new Date(), lastError: message.slice(0, ERROR_MAX_LENGTH) }).catch(() => null);
    } finally {
      clearTimeout(timeout);
      this.current = null;
    }
  }

  private async detectFormat(input: WebSerialFileIndexInput & { listingUrl: string; baseUrl: string }): Promise<WebSerialFileIndexFormat> {
    try {
      const read = await readListing(
        {
          listingUrl: input.listingUrl,
          baseUrl: input.baseUrl,
          format: null,
          keyMap: {},
          authorization: this.authorization(blankToNull(input.username), input.password || null),
        },
        // Only the first page decides the format; a crawl of the whole tree waits for the first refresh.
        { signal: AbortSignal.timeout(TEST_TIMEOUT_MS), pageDelayMs: 0, maxPages: 1 },
      );
      return read.notModified ? 'json' : read.format;
    } catch {
      return /\.json(?:$|\?)/i.test(input.listingUrl) ? 'json' : 'html';
    }
  }

  private source(row: WebSerialFileIndexRow): FileIndexSource {
    return {
      listingUrl: row.listingUrl,
      baseUrl: row.baseUrl,
      format: row.format,
      keyMap: row.keyMap,
      authorization: this.authorization(row.username, row.passwordEnc ? this.secrets.decrypt(row.passwordEnc) : null),
    };
  }

  private authorization(username: string | null, password: string | null): string | null {
    return basicAuthHeaders(username, password).Authorization ?? null;
  }

  private async requireIndex(id: number): Promise<WebSerialFileIndexRow> {
    const row = await this.repo.findIndex(id);
    if (!row) throw notFound();
    return row;
  }

  private view(row: WebSerialFileIndexRow): WebSerialFileIndex {
    return {
      id: row.id,
      name: row.name,
      listingUrl: row.listingUrl,
      baseUrl: row.baseUrl,
      format: row.format,
      keyMap: row.keyMap,
      username: row.username,
      hasPassword: row.passwordEnc !== null,
      enabled: row.enabled,
      refreshHours: row.refreshHours,
      lastRefreshAt: row.lastRefreshAt?.toISOString() ?? null,
      series: row.seriesCount,
      files: row.fileCount,
      lastError: row.lastError,
      running: this.current?.id === row.id,
    };
  }
}

function notFound(): NotFoundException {
  return new NotFoundException(codedError('That file index does not exist', WebSerialErrorCode.FileIndexNotFound));
}

async function safeListingUrl(raw: string): Promise<string> {
  const url = parseHttpUrl(raw.trim());
  if (!url) throw new BadRequestException(codedError('The listing URL must be a valid http or https URL', WebSerialErrorCode.EngineUrlInvalid));
  await ensureSafeEngineUrl(url);
  return url;
}

/** The given base URL, else the folder the listing sits in: a listing file's folder, or the directory page itself. */
async function safeBaseUrl(raw: string | null | undefined, listingUrl: string): Promise<string> {
  const trimmed = raw?.trim();
  if (trimmed) {
    const url = parseHttpUrl(trimmed);
    if (!url) throw new BadRequestException(codedError('The base URL must be a valid http or https URL', WebSerialErrorCode.EngineUrlInvalid));
    await ensureSafeEngineUrl(url);
    return url.endsWith('/') ? url : `${url}/`;
  }
  const listing = new URL(listingUrl);
  const lastSegment = listing.pathname.slice(listing.pathname.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return new URL('.', listing).href;
  listing.search = '';
  return listing.href.endsWith('/') ? listing.href : `${listing.href}/`;
}

function parseHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function cleanKeyMap(keyMap: WebSerialFileIndexKeyMap | null | undefined): WebSerialFileIndexKeyMap {
  const entries = Object.entries(keyMap ?? {}).filter(([, value]) => typeof value === 'string' && value.trim());
  return Object.fromEntries(entries.map(([key, value]) => [key, (value as string).trim()]));
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
