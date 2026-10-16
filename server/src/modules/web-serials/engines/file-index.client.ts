import { BadGatewayException, GatewayTimeoutException, Injectable, NotFoundException } from '@nestjs/common';

import { normalizeSerialTitle, WebSerialErrorCode, type WebSerialEngineHealth } from '@bookorbit/types';
import { readBoundedBytes, ResponseTooLargeError } from '../../../common/utils/bounded-response';
import { assertFileIndexOk, fetchFileIndex } from '../file-index/file-index-http';
import { listingFileUrl, relativeListingPath } from '../file-index/file-index-listing';
import { fileIndexUnits, type FileIndexUnitRemote } from '../file-index/file-index-units';
import type { WebSerialFileIndexRow } from '../schema/web-serials.schema';
import { codedError } from '../web-serials-error.utils';
import { WebSerialsFileIndexRepository, type FileIndexSeriesHit } from '../web-serials-file-index.repository';
import { WebSerialsSecretService } from '../web-serials-secret.service';
import { fileIndexRemoteId, parseFileIndexRemoteId } from '../web-serials-series-key.utils';
import { basicAuthHeaders } from './engine-http.utils';
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

/** `allowedSources` entries naming a file index: `fi-<id>`. */
export const FILE_INDEX_SOURCE_PREFIX = 'fi-';
const TITLE_KEY_MAX = 1000;
const HEADERS_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;
const COVER_MAX_BYTES = 5 * 1024 * 1024;
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function fileIndexSourceId(indexId: number): string {
  return `${FILE_INDEX_SOURCE_PREFIX}${indexId}`;
}

/** The index ids among `allowedSources`; every other entry belongs to another engine. */
export function fileIndexIds(allowedSources: readonly string[]): number[] {
  return allowedSources.flatMap((entry) => {
    const match = /^fi-(\d{1,9})$/.exec(entry);
    return match ? [Number(match[1])] : [];
  });
}

/**
 * Light novels from admin-configured file indexes. Everything but the download is answered from BookOrbit's own tables,
 * so search and previews never touch the remote listing. The connection argument is unused: each index has its own.
 */
@Injectable()
export class FileIndexClient implements WebSerialEngineClient {
  readonly kind = 'novel' as const;

  constructor(
    private readonly repo: WebSerialsFileIndexRepository,
    private readonly secrets: WebSerialsSecretService,
  ) {}

  async health(_conn: EngineConnection, allowedSources: string[]): Promise<WebSerialEngineHealth> {
    const enabled = new Set((await this.repo.enabledIndexes()).map((index) => index.id));
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      version: null,
      searchableSources: fileIndexIds(allowedSources).filter((id) => enabled.has(id)).length,
      error: null,
    };
  }

  /** `fi-<id>` for every enabled index, the file index counterpart of an engine's enabled sources. */
  async enabledSourceIds(): Promise<string[]> {
    return (await this.repo.enabledIndexes()).map((index) => fileIndexSourceId(index.id));
  }

  /** Display names of the enabled indexes by source id, for the user's source list. */
  async enabledSources(): Promise<Array<{ id: string; name: string }>> {
    return (await this.repo.enabledIndexes()).map((index) => ({ id: fileIndexSourceId(index.id), name: index.name }));
  }

  async search(_conn: EngineConnection, query: string, allowedSources: string[]): Promise<{ hits: EngineSearchHit[]; failedSources: string[] }> {
    const titleKey = normalizeSerialTitle(query).slice(0, TITLE_KEY_MAX);
    const rows = await this.repo.searchSeries(titleKey, fileIndexIds(allowedSources));
    return { hits: rows.map(toSearchHit), failedSources: [] };
  }

  /** Series of the given indexes titled exactly like one of the titles, or matched to the details-database series. */
  async candidates(titles: readonly string[], matchId: string | null, allowedSources: readonly string[], limit: number): Promise<EngineSearchHit[]> {
    const keys = [...new Set(titles.map((title) => normalizeSerialTitle(title).slice(0, TITLE_KEY_MAX)).filter(Boolean))];
    const rows = await this.repo.findCandidates(keys, matchId, fileIndexIds(allowedSources), limit);
    return rows.map(toSearchHit);
  }

  /** A link to a series folder or one of its files, under the base URL of an enabled index. */
  async resolveUrl(_conn: EngineConnection, url: string): Promise<EngineSeriesRef | null> {
    let normalized: string;
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      parsed.search = '';
      normalized = parsed.href;
    } catch {
      return null;
    }
    for (const index of await this.repo.enabledIndexes()) {
      const path = relativeListingPath(normalized, index.baseUrl);
      if (!path) continue;
      const trimmed = path.replace(/\/+$/, '');
      const folder = normalized.endsWith('/') ? trimmed : trimmed.slice(0, Math.max(trimmed.lastIndexOf('/'), 0));
      const seriesId =
        (await this.repo.findSeriesIdByFolder(index.id, trimmed)) ?? (folder ? await this.repo.findSeriesIdByFolder(index.id, folder) : null);
      if (seriesId !== null) return { kind: 'novel', remoteId: fileIndexRemoteId(index.id, seriesId) };
    }
    return null;
  }

  async getSeries(_conn: EngineConnection, remoteId: string): Promise<EngineSeries> {
    const { index, series } = await this.requireSeries(remoteId);
    const files = await this.repo.listSeriesFiles(series.id);
    const units = fileIndexUnits(files);
    return {
      kind: 'novel',
      title: series.title,
      author: null,
      authors: [],
      synopsis: null,
      tags: [],
      language: null,
      remoteCoverPath: series.coverPath,
      sourceName: index.name,
      sourceId: fileIndexSourceId(index.id),
      sourceUrl: `${listingFileUrl(index.baseUrl, series.folderPath)}/`,
      status: 'unknown',
      chapterCount: units.length,
      units,
      packagingOptions: ['volume'],
      defaultPackaging: 'volume',
    };
  }

  startUnit(_conn: EngineConnection, remoteId: string, unit: EngineUnitSpec): Promise<EngineUnitHandle> {
    return Promise.resolve({ unitKey: unit.unitKey, remote: { ...unit.remote, remoteId } });
  }

  /** Nothing is prepared remotely: the file is ready to stream as soon as it is asked for. */
  pollUnit(): Promise<EngineUnitProgress> {
    return Promise.resolve({ state: 'done' });
  }

  async download(_conn: EngineConnection, handle: EngineUnitHandle, signal?: AbortSignal): Promise<EngineDownload> {
    const remote = handle.remote as unknown as FileIndexUnitRemote & { remoteId?: string };
    const { index, series } = await this.requireSeries(String(remote.remoteId ?? ''));
    const file = await this.repo.findFile(series.id, Number(remote.fileId));
    if (!file) throw new NotFoundException(codedError('The file is no longer in the file index', WebSerialErrorCode.FileIndexNotFound));

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const headersTimer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);
    headersTimer.unref();
    let response: Response;
    try {
      response = await fetchFileIndex(listingFileUrl(index.baseUrl, file.path), {
        headers: { Accept: 'application/epub+zip, application/octet-stream;q=0.9, */*;q=0.5' },
        authorization: this.authorization(index),
        signal: controller.signal,
      });
      assertFileIndexOk(response);
    } catch (error) {
      signal?.removeEventListener('abort', onAbort);
      throw error;
    } finally {
      clearTimeout(headersTimer);
    }

    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (type.startsWith('text/html') || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      signal?.removeEventListener('abort', onAbort);
      throw new BadGatewayException(codedError('The file index sent a web page instead of the book', WebSerialErrorCode.EngineError));
    }
    const declared = Number(response.headers.get('content-length'));
    return {
      stream: epubStream(response.body, controller, () => signal?.removeEventListener('abort', onAbort)),
      fileName: file.name,
      format: 'epub',
      size: Number.isSafeInteger(declared) && declared > 0 ? declared : (file.size ?? null),
    };
  }

  async fetchCover(_conn: EngineConnection, remoteCoverPath: string): Promise<{ body: Buffer; contentType: string }> {
    const [indexPart, ...rest] = remoteCoverPath.split('|');
    const index = await this.repo.findIndex(Number(indexPart));
    if (!index?.enabled || rest.length === 0) throw new NotFoundException('No cover for this series');
    const response = await fetchFileIndex(listingFileUrl(index.baseUrl, rest.join('|')), {
      headers: { Accept: 'image/*' },
      authorization: this.authorization(index),
      signal: AbortSignal.timeout(HEADERS_TIMEOUT_MS),
    });
    assertFileIndexOk(response);
    try {
      return { body: await readBoundedBytes(response, COVER_MAX_BYTES), contentType: response.headers.get('content-type') ?? '' };
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw new BadGatewayException('The cover is too large');
      throw error;
    }
  }

  private async requireSeries(remoteId: string) {
    const ref = parseFileIndexRemoteId(remoteId);
    const found = ref ? await this.repo.findSeries(ref.indexId, ref.seriesId) : null;
    if (!found) throw new NotFoundException(codedError('That series is no longer in the file index', WebSerialErrorCode.FileIndexNotFound));
    if (!found.index.enabled) throw new NotFoundException(codedError('That file index is not enabled', WebSerialErrorCode.SourceDisabled));
    // The cover path carries its index so a cover request needs no series lookup.
    return {
      index: found.index,
      series: { ...found.series, coverPath: found.series.coverPath ? `${found.index.id}|${found.series.coverPath}` : null },
    };
  }

  private authorization(index: WebSerialFileIndexRow): string | null {
    return basicAuthHeaders(index.username, index.passwordEnc ? this.secrets.decrypt(index.passwordEnc) : null).Authorization ?? null;
  }
}

function toSearchHit(row: FileIndexSeriesHit): EngineSearchHit {
  return {
    remoteId: fileIndexRemoteId(row.indexId, row.id),
    url: null,
    title: row.title,
    author: null,
    remoteCoverPath: row.coverPath ? `${row.indexId}|${row.coverPath}` : null,
    sourceName: row.indexName,
    chapterCount: null,
    status: 'unknown',
  };
}

/**
 * The response body, refused unless it starts like a ZIP (an EPUB is one), and failed when it stalls. The first bytes are
 * held back until the signature is known, so a non-book never reaches the importer.
 */
function epubStream(body: ReadableStream<Uint8Array>, controller: AbortController, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let head: Buffer | null = Buffer.alloc(0);
  let idle: NodeJS.Timeout | null = null;
  const stopIdle = () => {
    if (idle) clearTimeout(idle);
    idle = null;
  };
  const finish = () => {
    stopIdle();
    done();
  };
  return new ReadableStream<Uint8Array>({
    async pull(out) {
      for (;;) {
        idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
        idle.unref();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          finish();
          out.error(new GatewayTimeoutException(codedError('The file download stalled or was cancelled', WebSerialErrorCode.EngineTimeout)));
          return;
        }
        stopIdle();
        if (head === null) {
          if (chunk.done) {
            finish();
            out.close();
          } else out.enqueue(chunk.value);
          return;
        }
        head = chunk.done ? head : Buffer.concat([head, chunk.value]);
        if (head.length < ZIP_SIGNATURE.length && !chunk.done) continue;
        if (!head.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) {
          finish();
          controller.abort();
          out.error(new BadGatewayException(codedError('The downloaded file is not an EPUB', WebSerialErrorCode.EngineError)));
          return;
        }
        out.enqueue(new Uint8Array(head));
        head = null;
        if (chunk.done) {
          finish();
          out.close();
        }
        return;
      }
    },
    async cancel(reason) {
      finish();
      controller.abort();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
