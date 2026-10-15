import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { WebSerialEngineHealth, WebSerialMangaSource, WebSerialSeriesStatus } from '@bookorbit/types';

import { mapWithConcurrency } from '../../../common/utils/batch.utils';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { sequenceKey } from '../web-serials-selection.utils';
import {
  assertEngineResponseOk,
  errorMessage,
  uniqueStrings,
  basicAuthHeaders,
  fetchEngineStream,
  responseContentType,
  responseFileName,
  responseSize,
} from './engine-http.utils';
import { describeError } from '../web-serials-log.utils';
import { fetchSuwayomiImage, suwayomiGraphql } from './suwayomi-graphql';
import {
  SOURCE_ID_PREFIX,
  type EngineConnection,
  type EngineDownload,
  type EngineSearchHit,
  type EngineSeries,
  type EngineSeriesRef,
  type EngineUnitHandle,
  type EngineUnitProgress,
  type EngineUnitSpec,
  type WebSerialEngineClient,
} from './web-serial-engine';

const SEARCH_CONCURRENCY = 4;
/** About two minutes of polls with the downloader stopped, each one asking it to start again. */
const MAX_STOPPED_POLLS = 24;
export const DOWNLOADER_STOPPED_REASON = "The download service's downloader is stopped and could not be started";
const SOURCE_SEARCH_TIMEOUT_MS = 12_000;
const CBZ_CONTENT_TYPES = new Set(['application/zip', 'application/x-cbz', 'application/vnd.comicbook+zip', 'application/octet-stream']);

interface SuwayomiSource {
  id: string;
  name: string;
  lang: string;
  displayName: string;
  isNsfw: boolean;
}

interface SuwayomiManga {
  id: string;
  title: string;
  author: string | null;
  artist?: string | null;
  description?: string | null;
  genre?: string[] | null;
  status: string;
  thumbnailUrl: string | null;
  realUrl?: string | null;
  source?: { id?: string | null; displayName?: string | null; lang?: string | null } | null;
}

interface SuwayomiChapter {
  id: string;
  name: string;
  chapterNumber: number;
  uploadDate: number | string;
  sourceOrder: number;
  scanlator: string | null;
  isDownloaded: boolean;
  pageCount: number;
}

interface OrderedChapter {
  chapter: SuwayomiChapter;
  sequence: string;
  volume: string | null;
  positional: boolean;
}

@Injectable()
export class SuwayomiClient implements WebSerialEngineClient {
  readonly kind = 'manga' as const;
  private readonly logger = new Logger(SuwayomiClient.name);
  /** Polls that found the downloader stopped, per handle this run holds: a stored handle (a resume) starts counting afresh. */
  private readonly stoppedPolls = new WeakMap<EngineUnitHandle['remote'], number>();

  async health(conn: EngineConnection, allowedSources: string[]): Promise<WebSerialEngineHealth> {
    const startedAt = Date.now();
    this.logger.log(`[web_serials.manga_health] [start] - engine health check started`);
    try {
      const data = await suwayomiGraphql<{
        aboutServer: { version: string | null };
        sources: { nodes: SuwayomiSource[] };
      }>(
        conn,
        `query BookOrbitHealth {
          aboutServer { name version buildType }
          sources { nodes { id name lang displayName isNsfw } }
        }`,
      );
      const searchableSources = this.allowedSources(data.sources.nodes, allowedSources).length;
      const result: WebSerialEngineHealth = {
        ok: true,
        checkedAt: new Date().toISOString(),
        version: data.aboutServer.version,
        searchableSources,
        error: null,
      };
      this.logger.log(
        `[web_serials.manga_health] [end] durationMs=${Date.now() - startedAt} searchableSources=${searchableSources} - engine health check completed`,
      );
      return result;
    } catch (error) {
      const message = errorMessage(error);
      this.logger.warn(
        `[web_serials.manga_health] [fail] durationMs=${Date.now() - startedAt} errorClass=${describeError(error).errorClass} error="${sanitizeLogValue(message)}" - engine health check failed`,
      );
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        version: null,
        searchableSources: 0,
        error: message,
      };
    }
  }

  async listSources(conn: EngineConnection): Promise<WebSerialMangaSource[]> {
    const data = await suwayomiGraphql<{ sources: { nodes: SuwayomiSource[] } }>(
      conn,
      `query BookOrbitSourceList { sources { nodes { id name lang displayName isNsfw } } }`,
    );
    return data.sources.nodes
      .filter((source) => String(source.id) !== '0')
      .map((source) => ({ id: String(source.id), name: source.displayName || source.name, lang: source.lang, nsfw: source.isNsfw }));
  }

  async search(
    conn: EngineConnection,
    query: string,
    allowedSources: string[],
    signal?: AbortSignal,
  ): Promise<{ hits: EngineSearchHit[]; failedSources: string[] }> {
    const startedAt = Date.now();
    this.logger.log(`[web_serials.manga_search] [start] sourceCount=${allowedSources.length} queryLength=${query.length} - engine search started`);
    const sourceData = await suwayomiGraphql<{ sources: { nodes: SuwayomiSource[] } }>(
      conn,
      `query BookOrbitSources { sources { nodes { id name lang displayName isNsfw } } }`,
      signal,
    );
    const sources = this.allowedSources(sourceData.sources.nodes, allowedSources);
    const results = await mapWithConcurrency(sources, SEARCH_CONCURRENCY, async (source) => {
      try {
        const data = await suwayomiGraphql<{
          fetchSourceManga: { mangas: SuwayomiManga[]; hasNextPage: boolean };
        }>(
          conn,
          `mutation BookOrbitSearch {
            fetchSourceManga(input: { source: ${JSON.stringify(source.id)}, type: SEARCH, page: 1, query: ${JSON.stringify(query)} }) {
              mangas { id title author thumbnailUrl status url realUrl }
              hasNextPage
            }
          }`,
          signal,
          SOURCE_SEARCH_TIMEOUT_MS,
        );
        return {
          hits: data.fetchSourceManga.mangas.map((manga): EngineSearchHit => ({
            remoteId: String(manga.id),
            url: null,
            title: manga.title,
            author: manga.author,
            remoteCoverPath: manga.thumbnailUrl,
            sourceName: source.displayName,
            chapterCount: null,
            status: mapMangaStatus(manga.status),
          })),
          failedSource: null,
        };
      } catch {
        return { hits: [], failedSource: source.displayName };
      }
    });
    const hits = results.flatMap((result) => result.hits);
    const failedSources = results.flatMap((result) => (result.failedSource ? [result.failedSource] : []));
    this.logger.log(
      `[web_serials.manga_search] [end] durationMs=${Date.now() - startedAt} hits=${hits.length} failedSources=${failedSources.length} - engine search completed`,
    );
    return { hits, failedSources };
  }

  resolveUrl(): Promise<EngineSeriesRef | null> {
    return Promise.resolve(null);
  }

  async getSeries(conn: EngineConnection, remoteId: string): Promise<EngineSeries> {
    const mangaId = numericId(remoteId, 'series');
    const data = await suwayomiGraphql<{
      fetchMangaAndChapters: { manga: SuwayomiManga; chapters: SuwayomiChapter[] };
    }>(
      conn,
      `mutation BookOrbitSeries {
        fetchMangaAndChapters(input: { id: ${mangaId}, fetchManga: true, fetchChapters: true }) {
          manga { id title author artist description genre status thumbnailUrl realUrl source { id displayName lang } }
          chapters { id name chapterNumber uploadDate sourceOrder scanlator isDownloaded pageCount }
        }
      }`,
    );
    const { manga } = data.fetchMangaAndChapters;
    const ordered = orderChapters(data.fetchMangaAndChapters.chapters);
    return {
      kind: this.kind,
      title: manga.title,
      author: manga.author,
      authors: uniqueStrings([manga.author]),
      artists: uniqueStrings([manga.artist]),
      synopsis: manga.description ?? null,
      tags: manga.genre ?? [],
      language: manga.source?.lang?.trim() || null,
      remoteCoverPath: manga.thumbnailUrl,
      sourceName: manga.source?.displayName || 'Manga source',
      sourceId: manga.source?.id != null ? String(manga.source.id) : null,
      sourceUrl: manga.realUrl ?? null,
      status: mapMangaStatus(manga.status),
      chapterCount: ordered.length,
      units: ordered.map(({ chapter, sequence, volume, positional }) => {
        const publishedAt = timestampToIso(Number(chapter.uploadDate));
        return {
          unitKey: String(chapter.id),
          label: chapter.name,
          sequence,
          chapterCount: 1,
          publishedAt,
          volume,
          packaging: 'chapter' as const,
          ...(positional ? { positional: true } : {}),
          remote: {
            chapterId: String(chapter.id),
            mangaId: remoteId,
            scanlator: chapter.scanlator,
            label: chapter.name,
            sequence,
            publishedAt,
            ...(positional ? { positional: true } : {}),
          },
        };
      }),
      packagingOptions: ['chapter', 'volume', 'series'],
      defaultPackaging: 'chapter',
    };
  }

  async startUnit(conn: EngineConnection, remoteId: string, unit: EngineUnitSpec): Promise<EngineUnitHandle> {
    if (unit.packaging !== 'chapter') throw new BadRequestException('Manga downloads require chapter packaging');
    const mangaId = numericId(remoteId, 'series');
    const chapterId = numericId(recordString(unit.remote, 'chapterId'), 'chapter');
    await this.enqueue(conn, chapterId);
    return { unitKey: unit.unitKey, remote: { mangaId, chapterId } };
  }

  private async enqueue(conn: EngineConnection, chapterId: string): Promise<void> {
    await suwayomiGraphql(
      conn,
      `mutation BookOrbitDownload {
        enqueue: enqueueChapterDownloads(input: { ids: [${chapterId}] }) { downloadStatus { state } }
        start: startDownloader(input: {}) { downloadStatus { state } }
      }`,
    );
  }

  private async startDownloader(conn: EngineConnection): Promise<void> {
    await suwayomiGraphql(conn, `mutation BookOrbitStartDownloader { startDownloader(input: {}) { downloadStatus { state } } }`);
  }

  async pollUnit(conn: EngineConnection, handle: EngineUnitHandle): Promise<EngineUnitProgress> {
    const chapterId = numericId(recordString(handle.remote, 'chapterId'), 'chapter');
    const data = await suwayomiGraphql<{
      chapter: { id: string; isDownloaded: boolean } | null;
      downloadStatus: {
        state: string;
        queue: Array<{ state: string; progress: number | null; tries: number; chapter: { id: string } }>;
      };
    }>(
      conn,
      `query BookOrbitDownloadStatus {
        chapter(id: ${chapterId}) { id isDownloaded }
        downloadStatus { state queue { state progress tries chapter { id } } }
      }`,
    );
    if (data.chapter?.isDownloaded) return { state: 'done' };
    const queued = data.downloadStatus.queue.find((item) => String(item.chapter.id) === chapterId);
    // Neither downloaded nor queued: Suwayomi restarted or its queue was cleared. Queue it again.
    if (!queued) {
      await this.enqueue(conn, chapterId);
      return { state: 'pending', progress: null };
    }
    if (queued.state === 'ERROR') return { state: 'failed', reason: 'The chapter download failed' };
    // A downloader paused in Suwayomi's own UI, or not restarted after Suwayomi restarted, leaves the chapter queued for good.
    if (queued.state !== 'DOWNLOADING' && data.downloadStatus.state === 'STOPPED') {
      const stoppedPolls = (this.stoppedPolls.get(handle.remote) ?? 0) + 1;
      this.stoppedPolls.set(handle.remote, stoppedPolls);
      if (stoppedPolls > MAX_STOPPED_POLLS) return { state: 'failed', reason: DOWNLOADER_STOPPED_REASON };
      await this.startDownloader(conn);
      return { state: 'pending', progress: normalizedProgress(queued.progress) };
    }
    this.stoppedPolls.delete(handle.remote);
    if (queued.state === 'DOWNLOADING') return { state: 'running', progress: normalizedProgress(queued.progress) };
    return { state: 'pending', progress: normalizedProgress(queued.progress) };
  }

  async download(conn: EngineConnection, handle: EngineUnitHandle, signal?: AbortSignal): Promise<EngineDownload> {
    const chapterId = numericId(recordString(handle.remote, 'chapterId'), 'chapter');
    const response = await fetchEngineStream(
      conn.url,
      `/api/v1/chapter/${chapterId}/download`,
      { method: 'GET', headers: basicAuthHeaders(conn.username, conn.password) },
      { signal },
    );
    assertEngineResponseOk(response);
    const contentType = responseContentType(response);
    if (!CBZ_CONTENT_TYPES.has(contentType)) {
      void response.body?.cancel().catch(() => undefined);
      throw new BadGatewayException('The remote service did not return a CBZ file');
    }
    if (!response.body) throw new BadGatewayException('The remote service returned an empty CBZ file');
    return {
      stream: response.body,
      fileName: responseFileName(response, `${handle.unitKey}.cbz`),
      format: 'cbz',
      size: responseSize(response),
    };
  }

  async cancelUnit(conn: EngineConnection, handle: EngineUnitHandle): Promise<void> {
    try {
      const chapterId = numericId(recordString(handle.remote, 'chapterId'), 'chapter');
      await suwayomiGraphql(
        conn,
        `mutation BookOrbitDequeue {
          dequeueChapterDownloads(input: { ids: [${chapterId}] }) { downloadStatus { state } }
        }`,
      );
    } catch {
      return;
    }
  }

  async discardUnit(conn: EngineConnection, handles: EngineUnitHandle[]): Promise<void> {
    const ids = [...new Set(handles.map((handle) => numericId(recordString(handle.remote, 'chapterId'), 'chapter')))];
    if (ids.length === 0) return;
    await suwayomiGraphql(
      conn,
      `mutation BookOrbitDeleteDownloaded {
        deleteDownloadedChapters(input: { ids: [${ids.join(', ')}] }) { chapters { id isDownloaded } }
      }`,
    );
  }

  fetchCover(conn: EngineConnection, remoteCoverPath: string): Promise<{ body: Buffer; contentType: string }> {
    return fetchSuwayomiImage(conn, remoteCoverPath);
  }

  private allowedSources(sources: SuwayomiSource[], allowed: string[]): SuwayomiSource[] {
    if (allowed.some((entry) => entry.startsWith(SOURCE_ID_PREFIX))) {
      const ids = new Set(allowed.filter((entry) => entry.startsWith(SOURCE_ID_PREFIX)).map((entry) => entry.slice(SOURCE_ID_PREFIX.length)));
      return sources.filter((source) => String(source.id) !== '0' && ids.has(String(source.id)));
    }
    const allowedLanguages = allowed;
    const languages = new Set(allowedLanguages.map((language) => language.trim().toLowerCase()));
    return sources.filter((source) => {
      if (String(source.id) === '0') return false;
      const lang = source.lang.toLowerCase();
      return languages.has(lang) || languages.has(lang.split('-', 1)[0]);
    });
  }
}

function mapMangaStatus(status: string): WebSerialSeriesStatus {
  switch (status) {
    case 'ONGOING':
      return 'ongoing';
    case 'COMPLETED':
    case 'PUBLISHING_FINISHED':
      return 'completed';
    case 'ON_HIATUS':
      return 'hiatus';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/**
 * Chapters in reading order with one entry per chapter number. Chapters without a number (Suwayomi reports -1 for
 * extras and oneshots) take a sequence just after the numbered chapter that precedes them in the source, so they
 * can never equal a real chapter number. Duplicate releases of one number (several scanlators) collapse to the newest.
 */
function orderChapters(chapters: SuwayomiChapter[]): OrderedChapter[] {
  const ascending = sourceOrderAscends(chapters);
  const chronological = [...chapters].sort((left, right) =>
    ascending ? left.sourceOrder - right.sourceOrder : right.sourceOrder - left.sourceOrder,
  );
  const rank = new Map(chronological.map((chapter, index) => [chapter, index]));

  const newestByNumber = new Map<number, SuwayomiChapter>();
  for (const chapter of chronological) {
    if (chapter.chapterNumber < 0) continue;
    const existing = newestByNumber.get(chapter.chapterNumber);
    if (!existing || releasedAt(chapter) >= releasedAt(existing)) newestByNumber.set(chapter.chapterNumber, chapter);
  }

  const kept = chronological.filter((chapter) => chapter.chapterNumber < 0 || newestByNumber.get(chapter.chapterNumber) === chapter);
  const misnumbered = findMisnumberedExtras(kept);
  const positional = (chapter: SuwayomiChapter) => chapter.chapterNumber < 0 || misnumbered.has(chapter);
  const taken = new Set(kept.filter((chapter) => !positional(chapter)).map((chapter) => sequenceKey(formatSequence(chapter.chapterNumber))));
  const unnumberedCount = kept.filter(positional).length;
  const anchored = new Map<SuwayomiChapter, { anchor: number; sequence: string }>();
  const issued = new Map<string, number>();
  let anchor = 0;
  for (const chapter of kept) {
    if (!positional(chapter)) {
      anchor = Math.max(anchor, chapter.chapterNumber);
      anchored.set(chapter, { anchor: chapter.chapterNumber, sequence: formatSequence(chapter.chapterNumber) });
      continue;
    }
    anchored.set(chapter, { anchor, sequence: unnumberedSequence(anchor, issued, taken, unnumberedCount) });
  }

  const sorted = kept.sort((left, right) => {
    const a = anchored.get(left)!;
    const b = anchored.get(right)!;
    return a.anchor - b.anchor || Number(positional(left)) - Number(positional(right)) || (rank.get(left) ?? 0) - (rank.get(right) ?? 0);
  });
  const volumes = sorted.map((chapter) => parseVolume(chapter.name));
  return sorted.map((chapter, index) => ({
    chapter,
    sequence: anchored.get(chapter)!.sequence,
    volume: misnumbered.has(chapter) ? volumeAmongNeighbours(sorted, volumes, misnumbered, index) : volumes[index]!,
    positional: positional(chapter),
  }));
}

const MIN_VOLUME_LABELLED_CHAPTERS = 10;
const OUTLIER_VOLUME_GAP = 2;

// Sources give extras a number like 1.1 under a volume far from where that number sits (Vol.69 Ch.1.1 among Vol.1).
function findMisnumberedExtras(chapters: SuwayomiChapter[]): Set<SuwayomiChapter> {
  const labelled = chapters
    .filter((chapter) => chapter.chapterNumber >= 0)
    .map((chapter) => ({ chapter, volume: Number(parseVolume(chapter.name)) }))
    .filter((entry) => entry.volume > 0);
  const outliers = new Set<SuwayomiChapter>();
  if (labelled.length < MIN_VOLUME_LABELLED_CHAPTERS) return outliers;

  const references = labelled
    .filter((entry) => Number.isInteger(entry.chapter.chapterNumber))
    .sort((a, b) => a.chapter.chapterNumber - b.chapter.chapterNumber);
  for (const entry of labelled) {
    const number = entry.chapter.chapterNumber;
    let low = 0;
    let high = references.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (references[mid]!.chapter.chapterNumber < number) low = mid + 1;
      else high = mid;
    }
    const below = references[low - 1];
    let aboveIndex = low;
    if (references[aboveIndex]?.chapter.chapterNumber === number) aboveIndex += 1;
    const above = references[aboveIndex];
    if (!below || !above) continue;
    if (Math.abs(below.volume - entry.volume) >= OUTLIER_VOLUME_GAP && Math.abs(above.volume - entry.volume) >= OUTLIER_VOLUME_GAP) {
      outliers.add(entry.chapter);
    }
  }
  return outliers;
}

function volumeAmongNeighbours(
  chapters: SuwayomiChapter[],
  volumes: (string | null)[],
  misnumbered: Set<SuwayomiChapter>,
  index: number,
): string | null {
  const own = volumes[index];
  if (!own) return null;
  const neighbour = (step: 1 | -1): string | null => {
    for (let at = index + step; at >= 0 && at < chapters.length; at += step) {
      if (!misnumbered.has(chapters[at]!) && chapters[at]!.chapterNumber >= 0 && volumes[at]) return volumes[at]!;
    }
    return null;
  };
  return neighbour(-1) === own || neighbour(1) === own ? own : null;
}

function sourceOrderAscends(chapters: SuwayomiChapter[]): boolean {
  const numbered = chapters.filter((chapter) => chapter.chapterNumber >= 0).sort((left, right) => left.chapterNumber - right.chapterNumber);
  let concordant = 0;
  for (let index = 1; index < numbered.length; index += 1) {
    const step = numbered[index]!.sourceOrder - numbered[index - 1]!.sourceOrder;
    if (step > 0) concordant += 1;
    else if (step < 0) concordant -= 1;
  }
  return concordant >= 0;
}

function releasedAt(chapter: SuwayomiChapter): number {
  const value = Number(chapter.uploadDate);
  return Number.isFinite(value) ? value : 0;
}

function unnumberedSequence(anchor: number, issued: Map<string, number>, taken: Set<string>, unnumberedCount: number): string {
  const width = Math.max(3, String(unnumberedCount).length);
  const base = formatSequence(anchor);
  const joiner = base.includes('.') ? '' : '.';
  let next = issued.get(base) ?? 0;
  let candidate: string;
  do {
    next += 1;
    candidate = `${base}${joiner}${String(next).padStart(width, '0')}`;
  } while (taken.has(sequenceKey(candidate)));
  issued.set(base, next);
  taken.add(sequenceKey(candidate));
  return candidate;
}

function numericId(value: string, label: string): string {
  if (!/^\d+$/.test(value)) throw new BadRequestException(`The remote ${label} identifier is invalid`);
  return value;
}

function recordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequestException('The saved engine handle is invalid');
  }
  return String(value);
}

function formatSequence(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, '').replace(/\.$/, '');
}

export function parseVolume(chapterName: string): string | null {
  const match = /\b(?:vol(?:ume)?\.?)[\s]*([0-9]+(?:\.[0-9]+)?)(?![0-9])/iu.exec(chapterName);
  if (!match) return null;
  const volume = Number(match[1]);
  return Number.isFinite(volume) && volume > 0 ? formatSequence(volume) : null;
}

function timestampToIso(timestamp: number): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizedProgress(progress: number | null): number | null {
  if (progress === null || !Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(1, progress));
}
