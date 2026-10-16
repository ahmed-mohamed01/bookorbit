import { Injectable, Logger } from '@nestjs/common';
import type { BookRequestMediaKind, IndexerSettingsField, IndexerTestResult } from '@bookorbit/types';
import { MAX_INDEXER_RELEASE_GUID_LENGTH } from '@bookorbit/types';

import { readBoundedText, ResponseTooLargeError } from '../../../../common/utils/bounded-response';
import { mainTitlePart } from '../../../../common/text-match/title-match';
import { sanitizeLogValue } from '../../../../common/utils/log-sanitize.utils';
import { safeFetch } from '../../../../common/utils/safe-fetch';
import { PrivateAddressException } from '../../../../common/utils/ssrf.utils';
import {
  DEFAULT_SHELFMARK_SOURCE,
  MAX_SHELFMARK_RELEASE_BYTES,
  parseShelfmarkSize,
  redactShelfmarkText,
  shelfmarkSourceCarries,
  shelfmarkSourceLabel,
  SHELFMARK_SOURCES,
  shelfmarkReleaseGuid,
  type ShelfmarkRelease,
} from '../../shelfmark/shelfmark-release';
import {
  IndexerSearchException,
  type IndexerAdapter,
  type ReleaseCandidate,
  type ReleaseQuery,
  type ResolvedIndexerConfig,
} from '../indexer-adapter';

/** A search answers with every release a source found, and each carries a little metadata. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TEST_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 1_000;
/** Left between the slowest source giving up and the indexer's deadline, to merge what did answer. */
const SOURCE_DEADLINE_MARGIN_MS = 1_500;
/** A source that failed after this long was waited on for nothing, which is what a blocked or dead site looks like. */
const SLOW_FAILURE_MS = 8_000;
/** How long a source that hung keeps its short budget, so one blip does not cost it for the day. */
const SLOW_SOURCE_COOLDOWN_MS = 10 * 60 * 1000;
/** Enough for a source that has recovered to answer, short of holding every search to its timeout. */
const SLOW_SOURCE_BUDGET_MS = 4_000;

/**
 * Shelfmark only searches by book, never by free text, so a request's own title and author stand in
 * for the metadata-provider book it would normally look up. The id is never resolved against
 * anything; Shelfmark only needs one to be present.
 */
const MANUAL_BOOK_ID = 'bookorbit';

const SETTINGS_FIELDS: readonly IndexerSettingsField[] = [
  {
    key: 'shelfmarkSources',
    type: 'string',
    label: 'Shelfmark sources',
    hint: 'Which of your Shelfmark sources this indexer searches. Add one indexer per source to choose between them per release.',
    default: DEFAULT_SHELFMARK_SOURCE,
    format: 'list',
    options: SHELFMARK_SOURCES,
    minItems: 1,
  },
];

interface ShelfmarkSearchResponse {
  releases?: unknown;
  error?: unknown;
}

interface ShelfmarkSourceInfo {
  name?: unknown;
  display_name?: unknown;
  enabled?: unknown;
}

/**
 * Searches a Shelfmark instance, which does the source-specific work (Anna's Archive's browser
 * checks, AudiobookBay, IRC) and hands back releases. Grabs go to the Shelfmark download client,
 * because a Shelfmark release is a task in that instance's queue, not a file anyone else can fetch.
 */
@Injectable()
export class ShelfmarkIndexerAdapter implements IndexerAdapter {
  readonly type = 'shelfmark' as const;
  readonly label = 'Shelfmark';
  readonly mediaKinds: readonly BookRequestMediaKind[] = ['ebook', 'audiobook'];
  readonly supportsIsbnSearch = false;
  readonly requiresCredential = true;
  readonly searchesConcurrently = true;
  readonly selfHosted = true;
  readonly skipsTitleOnlyRetry = true;
  readonly settingsFields = SETTINGS_FIELDS;

  private readonly logger = new Logger(ShelfmarkIndexerAdapter.name);
  /** When each `indexerId:source` that last hung may have its full budget back. */
  private readonly slowUntil = new Map<string, number>();

  async search(query: ReleaseQuery, config: ResolvedIndexerConfig, signal: AbortSignal): Promise<ReleaseCandidate[]> {
    const configured = configuredSources(config);
    const sources = configured.filter((source) => shelfmarkSourceCarries(source, query.mediaKind));
    if (sources.length === 0) return [];
    const startedAt = Date.now();
    // One search per source rather than one across all of them, so a source that is down or still
    // solving a challenge costs only its own releases.
    const settled = await Promise.allSettled(sources.map((source) => this.searchSourceTimed(query, config, source, signal)));

    const releases: ReleaseCandidate[] = [];
    const failures: unknown[] = [];
    const failedSources: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        releases.push(...result.value);
      } else {
        failures.push(result.reason);
        failedSources.push(sources[index]!);
      }
    });
    if (releases.length === 0 && failures.length > 0) throw failures[0];

    this.logger.log(
      `[request_indexer.shelfmark_search] [end] indexerId=${config.id} medium=${query.mediaKind} sources=${sources.join(',')} skippedSources=${configured.filter((source) => !sources.includes(source)).join(',') || 'none'} durationMs=${Date.now() - startedAt} found=${releases.length} failedSources=${failedSources.join(',') || 'none'} - shelfmark search finished`,
    );
    return releases.slice(0, Math.max(query.limit, 1) * sources.length);
  }

  async test(config: ResolvedIndexerConfig): Promise<IndexerTestResult> {
    const startedAt = Date.now();
    try {
      const body = await this.callJson(config, '/api/release-sources', AbortSignal.timeout(TEST_TIMEOUT_MS));
      if (!Array.isArray(body)) return { success: false, error: 'That URL answered, but not with a list of Shelfmark sources' };

      const known = new Map((body as ShelfmarkSourceInfo[]).map((source) => [text(source?.name) ?? '', source]));
      const unavailable = configuredSources(config).filter((name) => known.get(name)?.enabled !== true);
      if (unavailable.length > 0) {
        return { success: false, error: `Shelfmark has these sources turned off or not set up: ${unavailable.join(', ')}` };
      }
      return { success: true, indexerName: 'Shelfmark' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[request_indexer.test] [fail] indexerId=${config.id} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.constructor.name : 'Error'} error="${sanitizeLogValue(message)}" - shelfmark test failed`,
      );
      return { success: false, error: message };
    }
  }

  /**
   * Each source stops a moment before the indexer's own deadline, which would otherwise discard the
   * releases the faster sources already returned along with the slow one. A source that recently
   * hung gets only a short budget, so a blocked site does not hold every search to its timeout.
   */
  private async searchSourceTimed(
    query: ReleaseQuery,
    config: ResolvedIndexerConfig,
    source: string,
    signal: AbortSignal,
  ): Promise<ReleaseCandidate[]> {
    const slowKey = `${config.id}:${source}`;
    const knownSlow = (this.slowUntil.get(slowKey) ?? 0) > Date.now();
    const budgetMs = knownSlow ? Math.min(SLOW_SOURCE_BUDGET_MS, sourceBudgetMs(config)) : sourceBudgetMs(config);
    const startedAt = Date.now();
    try {
      const releases = await this.searchSource(query, config, source, AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]));
      if (releases.length > 0) this.slowUntil.delete(slowKey);
      return releases;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      // The whole search ending is no verdict on this source; its own budget running out is. A source
      // already on the short budget is not penalised again, or one that simply needs longer than it
      // would never get the full-budget try that lets it recover.
      const hung = durationMs >= SLOW_FAILURE_MS || (error instanceof IndexerSearchException && error.failure === 'timeout');
      if (!signal.aborted && !knownSlow && hung) {
        this.slowUntil.set(slowKey, Date.now() + SLOW_SOURCE_COOLDOWN_MS);
      }
      // A source already on its short budget fails the same way on every search until it recovers.
      const log = knownSlow ? this.logger.debug.bind(this.logger) : this.logger.warn.bind(this.logger);
      log(
        `[request_indexer.shelfmark_search] [fail] indexerId=${config.id} source=${source} knownSlow=${knownSlow} durationMs=${durationMs} errorClass=${error instanceof Error ? error.constructor.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - shelfmark source failed`,
      );
      throw error;
    }
  }

  private async searchSource(query: ReleaseQuery, config: ResolvedIndexerConfig, source: string, signal: AbortSignal): Promise<ReleaseCandidate[]> {
    const params = new URLSearchParams({
      provider: 'manual',
      book_id: MANUAL_BOOK_ID,
      title: query.title,
      source,
      content_type: query.mediaKind,
    });
    if (query.author) params.set('author', query.author);

    const body = (await this.callJson(config, `/api/releases?${params.toString()}`, signal)) as ShelfmarkSearchResponse;
    if (!body || typeof body !== 'object' || !Array.isArray(body.releases)) {
      throw new IndexerSearchException('error', `${config.name} answered without a release list`);
    }
    return body.releases.flatMap((raw) => {
      const candidate = toCandidate(raw, config.id, query);
      return candidate ? [candidate] : [];
    });
  }

  private async callJson(config: ResolvedIndexerConfig, path: string, signal: AbortSignal): Promise<unknown> {
    const apiKey = config.credential?.trim();
    if (!apiKey) throw new IndexerSearchException('unauthorized', `${config.name} has no Shelfmark API key`);

    let response: Response;
    try {
      response = await safeFetch(
        endpoint(config.baseUrl, path),
        { signal, redirect: 'manual', headers: { Accept: 'application/json', 'X-Api-Key': apiKey } },
        { allowPrivate: config.allowPrivateAddress, profile: config.networkProfile, pinResolvedAddress: true },
      );
    } catch (error) {
      if (error instanceof PrivateAddressException) throw new IndexerSearchException('error', error.message);
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new IndexerSearchException('timeout', `${config.name} did not answer in time. Shelfmark may still be solving a browser check.`);
      }
      throw new IndexerSearchException('unreachable', `Could not reach ${config.name}: ${error instanceof Error ? error.message : String(error)}`);
    }

    let text: string;
    try {
      text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError)
        throw new IndexerSearchException('error', `${config.name} answered with more data than BookOrbit will read`);
      throw error;
    }

    if (response.status === 401 || response.status === 403) throw new IndexerSearchException('unauthorized', `${config.name} rejected the API key`);
    if (response.status === 429) throw new IndexerSearchException('throttled', `${config.name} is rate limiting us`);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new IndexerSearchException('error', `${config.name} answered ${response.status} with something that is not JSON`);
    }
    if (!response.ok) {
      const detail =
        body && typeof body === 'object' && typeof (body as ShelfmarkSearchResponse).error === 'string' ? (body as { error: string }).error : null;
      // Shelfmark answers 503 when every source it was asked to search failed, with that source's own reason.
      const failure = response.status === 503 ? 'unreachable' : 'error';
      throw new IndexerSearchException(
        failure,
        `${config.name}: ${(detail ? redactShelfmarkText(detail) : `answered ${response.status}`).slice(0, 300)}`,
      );
    }
    return body;
  }
}

function sourceBudgetMs(config: ResolvedIndexerConfig): number {
  return Math.max(1_000, (config.perIndexerTimeoutSeconds ?? 20) * 1000 - SOURCE_DEADLINE_MARGIN_MS);
}

function configuredSources(config: ResolvedIndexerConfig): string[] {
  const raw = config.settings?.shelfmarkSources;
  const chosen = (typeof raw === 'string' ? raw : '')
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is string => (SHELFMARK_SOURCES as readonly string[]).includes(value));
  return chosen.length > 0 ? [...new Set(chosen)] : [DEFAULT_SHELFMARK_SOURCE];
}

function toCandidate(raw: unknown, indexerId: number, query: ReleaseQuery): ReleaseCandidate | null {
  const mediaKind = query.mediaKind;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const source = text(record.source);
  const sourceId = text(record.source_id);
  const title = text(record.title);
  if (!source || !sourceId || !title) return null;

  const release: ShelfmarkRelease = { ...record, source, source_id: sourceId, content_type: text(record.content_type) ?? mediaKind };
  const guid = shelfmarkReleaseGuid(release);
  if (guid.length > MAX_INDEXER_RELEASE_GUID_LENGTH || JSON.stringify(release).length > MAX_SHELFMARK_RELEASE_BYTES) return null;

  const extra = record.extra && typeof record.extra === 'object' ? (record.extra as Record<string, unknown>) : {};
  const format = text(record.format)?.toLowerCase();
  const language = text(record.language);
  const author = text(record.author) ?? text(extra.author);
  const seeders = count(record.seeders);
  // Shelfmark titles are catalogue titles, subtitle and series note included, so a request for the
  // bare title would read "Antimage: An Isekai LitRPG Adventure (Ends of Magic Book 1)" as a poor match.
  const mainTitle = mainTitlePart(title);
  const bookTitle = mainTitle !== title && mainTitlePart(query.title) === query.title.trim() ? mainTitle : undefined;
  // A non-swarm release is one file, which is what a profile asking for a single file checks.
  const singleFile = text(record.protocol) !== 'torrent';
  const origin = shelfmarkSourceLabel(source);

  return {
    indexerId,
    guid,
    title,
    ...(bookTitle ? { bookTitle } : {}),
    origin,
    ...(singleFile ? { primaryFileCount: 1 } : {}),
    sizeBytes: count(record.size_bytes) ?? parseShelfmarkSize(record.size),
    // Null rather than zero: most Shelfmark sources are not swarms, and a zero reads as a dead torrent.
    seeders,
    leechers: null,
    ...(format ? { format } : {}),
    ...(language ? { language } : {}),
    ...(author ? { author } : {}),
    shelfmarkRelease: release,
  };
}

/** Joined under the base's own path, so a Shelfmark behind a reverse proxy subpath still works. */
function endpoint(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const [pathname, search] = path.split('?');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${pathname}`;
  base.search = search ?? '';
  base.hash = '';
  return base.href;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_CHARS) : undefined;
}

function count(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}
