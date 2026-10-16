import { HttpException, Injectable } from '@nestjs/common';

import type { WebSerialSeriesKey } from '@bookorbit/types';
import { authorsMatch, baseSeriesTitle, normalizeSerialTitle, WebSerialErrorCode } from '@bookorbit/types';
import { mapWithConcurrency } from '../../common/utils/batch.utils';
import { novelSourceLimits } from './engines/novel-source-limits';
import type { EngineConnection, EngineSearchHit, EngineSeries } from './engines/web-serial-engine';
import { WebSerialsLookupService } from './lookup/web-serials-lookup.service';
import { WebSerialsCatalogService } from './web-serials-catalog.service';
import {
  beforeDeadline,
  pickOnePerSource,
  rankDiscoverOptions,
  shortlistHits,
  TIMED_OUT,
  type ClassifiedHit,
  type LoadedSourceCandidate,
  type SourceCandidates,
  type SourceConfidence,
} from './web-serials-candidate.utils';
import { WebSerialsEngineRegistry } from './web-serials-engine-registry.service';
import { WebSerialsNovelIndexService, type NovelIndexCandidate, type NovelIndexScope } from './web-serials-novel-index.service';
import { makeSeriesKey } from './web-serials-series-key.utils';
import type { WebSerialEngineConfig } from './web-serials-settings.service';
import { MAX_SOURCE_CANDIDATES } from './web-serials-source.utils';

const CONCURRENCY = 3;
/** The novel service answers a chapter list request within its own 45 s wait, either with the list or "still loading". */
const INTERACTIVE_LOAD_WAIT_MS = 45_000;
const MAX_QUERIES = 2;

export interface NovelCandidateInput {
  /** The details database's official title. */
  title: string;
  altTitles: string[];
  /** The database's credited authors: a site carrying the whole series of a part only counts when one of them agrees. */
  authors?: string[];
  /** Credited artists: a site crediting one of them is not a different work. */
  artists?: string[];
  matchId: string;
  /** Domains this user switched off; the admin's selection still bounds the search. */
  disabledDomains: readonly string[];
}

type UrlHit = EngineSearchHit & { url: string };
type ClassifiedNovelHit = Omit<ClassifiedHit, 'hit' | 'seriesKey' | 'confidence'> & { hit: UrlHit; confidence: SourceConfidence };

/**
 * Finds the sites carrying one details-database novel. The engine only returns titles and links, so a hit counts when
 * the database resolves its title to the same series, or (without a database answer) its title equals one of the series' titles.
 * Only when nothing counts that way, a site whose title names the whole series this one is a part of (same base title,
 * same author) is offered instead: the database files some light novels per arc while the sites carry the web novel whole.
 */
@Injectable()
export class WebSerialsNovelCandidatesService {
  constructor(
    private readonly engines: WebSerialsEngineRegistry,
    private readonly catalog: WebSerialsCatalogService,
    private readonly lookupService: WebSerialsLookupService,
    private readonly novelIndex?: WebSerialsNovelIndexService,
  ) {}

  async find(input: NovelCandidateInput): Promise<SourceCandidates> {
    const [engine, files] = await Promise.all([this.findOnEngine(input), this.findInFileIndexes(input)]);
    if (!engine || !files) return engine ?? files ?? { candidates: [], failedSources: ['novel'] };
    const candidates = [...files.candidates, ...engine.candidates];
    const order = new Map(rankDiscoverOptions(candidates).map((option, position) => [option.seriesKey, position]));
    candidates.sort((left, right) => order.get(left.seriesKey)! - order.get(right.seriesKey)!);
    const failedSources = engine.failedSources.filter(
      (source) => source !== WebSerialErrorCode.NovelSourcesAllDisabled || files.candidates.length === 0,
    );
    return { candidates: candidates.slice(0, MAX_SOURCE_CANDIDATES), failedSources: [...new Set([...files.failedSources, ...failedSources])] };
  }

  /** File index series titled exactly like the novel; they come from BookOrbit's own tables, so they never time out a site. */
  private async findInFileIndexes(input: NovelCandidateInput): Promise<SourceCandidates | null> {
    const config = await this.engines.fileIndexConfig();
    if (!config) return null;
    const allowed = config.allowedSources.filter((id) => !input.disabledDomains.includes(id));
    if (allowed.length === 0) return { candidates: [], failedSources: [] };
    try {
      const hits = await this.engines.fileIndexClient().candidates([input.title, ...input.altTitles], input.matchId, allowed, MAX_SOURCE_CANDIDATES);
      const loaded = await mapWithConcurrency(hits, CONCURRENCY, async (hit): Promise<LoadedSourceCandidate | null> => {
        if (!hit.remoteId) return null;
        const seriesKey = makeSeriesKey('novel', hit.remoteId);
        const series = await this.catalog.loadSeries('novel', hit.remoteId, seriesKey);
        return series.units.length > 0 ? { hit: { ...hit, remoteId: hit.remoteId }, seriesKey, confidence: 'title_match', series } : null;
      });
      return { candidates: loaded.filter((candidate) => candidate !== null), failedSources: [] };
    } catch {
      return { candidates: [], failedSources: ['novel'] };
    }
  }

  private async findOnEngine(input: NovelCandidateInput): Promise<SourceCandidates | null> {
    const config = await this.engines.getConfig('novel');
    if (!config) return null;
    const lnreader = config.engine === 'lnreader';
    const disabled = new Set(input.disabledDomains.map((domain) => (lnreader ? domain : domain.toLowerCase())));
    const allowed = config.allowedSources.filter((domain) => !disabled.has(lnreader ? domain : domain.toLowerCase()));
    if (allowed.length === 0) return { candidates: [], failedSources: [WebSerialErrorCode.NovelSourcesAllDisabled] };
    const titles = [input.title, ...input.altTitles];
    const authors = input.authors ?? [];
    const bases = authors.length > 0 ? wholeSeriesBases(titles) : new Set<string>();
    if (lnreader && this.novelIndex) {
      const scope = { connection: config.connection, enabledSourceIds: config.allowedSources };
      const indexed = await this.novelIndex.candidates(scope, input.matchId, titles, allowed, [...authors, ...(input.artists ?? [])]).catch(() => []);
      if (indexed.length > 0) {
        const fromIndex = await this.fromIndex(indexed);
        const answered = new Set(indexed.map((entry) => entry.row.sourceId));
        const unfilled = await this.unfilledSources(allowed.filter((id) => !answered.has(id)));
        if (unfilled.length === 0) return fromIndex;
        const live = await this.searchLive(config, input, unfilled, titles, bases, authors);
        return {
          candidates: [...fromIndex.candidates, ...live.candidates].slice(0, MAX_SOURCE_CANDIDATES),
          failedSources: [...new Set([...fromIndex.failedSources, ...live.failedSources])],
        };
      }
      if (bases.size > 0) {
        const whole = await this.wholeSeriesFromIndex(scope, bases, authors, allowed);
        if (whole.candidates.length > 0) return whole;
      }
    }
    return this.searchLive(config, input, allowed, titles, bases, authors);
  }

  /** Sources whose index is not complete yet: the index cannot tell that they lack the series, so they are asked live. */
  private async unfilledSources(sourceIds: string[]): Promise<string[]> {
    if (sourceIds.length === 0) return [];
    const states = await this.novelIndex!.fillStates(sourceIds).catch(() => new Map<string, string>());
    return sourceIds.filter((id) => states.get(id) !== 'done');
  }

  private async searchLive(
    config: WebSerialEngineConfig,
    input: NovelCandidateInput,
    allowed: string[],
    titles: string[],
    bases: ReadonlySet<string>,
    authors: readonly string[],
  ): Promise<SourceCandidates> {
    const limits = novelSourceLimits(config.connection);
    const deadline = Date.now() + limits.candidateSearchMs;
    const failedSources = new Set<string>();
    const wanted = new Set(titles.map(normalizeSerialTitle));
    const hits = await this.searchHits(config.connection, config.engine, allowed, queriesFor(input, bases), wanted, deadline, failedSources);

    const classified = await mapWithConcurrency(shortlistHits(hits, titles, bases), CONCURRENCY, async (hit): Promise<ClassifiedNovelHit | null> => {
      if (Date.now() >= deadline) {
        failedSources.add(hit.sourceName);
        return null;
      }
      const match = await beforeDeadline(this.lookupService.findMatch('novel', hit.title, null, hit.url), deadline);
      if (match === TIMED_OUT) {
        failedSources.add(hit.sourceName);
        return null;
      }
      // A part match names the first part of the series, which is not what decides the part asked about.
      if (match && match.scope !== 'part') return match.id === input.matchId ? { hit, confidence: 'same_series' } : null;
      if (wanted.has(normalizeSerialTitle(hit.title))) return { hit, confidence: 'title_match' };
      return bases.has(baseSeriesTitle(hit.title)) ? { hit, confidence: 'whole_series' } : null;
    });

    const found = classified.filter((entry) => entry !== null);
    const exact = found.filter((entry) => entry.confidence !== 'whole_series');
    const finalists = pickOnePerSource(exact.length > 0 ? exact : found).slice(0, MAX_SOURCE_CANDIDATES);
    const loadDeadline = Date.now() + limits.candidateLoadMs;
    const candidates = await mapWithConcurrency(finalists, CONCURRENCY, (entry) => this.load(entry, authors, loadDeadline, failedSources));
    return { candidates: candidates.filter((candidate) => candidate !== null), failedSources: [...failedSources] };
  }

  /** Index candidates answer at once; only the one the preview preselects is opened, so its chapter count is real. */
  private async fromIndex(indexed: NovelIndexCandidate[]): Promise<SourceCandidates> {
    const failedSources: string[] = [];
    const candidates: LoadedSourceCandidate[] = indexed.map((entry) => ({
      hit: entry.hit,
      seriesKey: entry.seriesKey,
      confidence: entry.matched ? 'same_series' : 'title_match',
      series: indexSeries(entry),
    }));
    const order = new Map(rankDiscoverOptions(candidates).map((option, position) => [option.seriesKey, position]));
    candidates.sort((left, right) => order.get(left.seriesKey)! - order.get(right.seriesKey)!);
    const chosen = candidates[0];
    if (chosen) {
      try {
        const series = await beforeDeadline(
          this.catalog.loadSeries('novel', chosen.hit.remoteId, chosen.seriesKey),
          Date.now() + INTERACTIVE_LOAD_WAIT_MS,
        );
        if (series !== TIMED_OUT) candidates[0] = { ...chosen, series };
      } catch (error) {
        // A long chapter list still loading on the service is not a failed site: the index already knows the series.
        if (!isSeriesLoading(error)) failedSources.push(chosen.hit.sourceName);
      }
    }
    return { candidates: candidates.slice(0, MAX_SOURCE_CANDIDATES), failedSources };
  }

  /** Index entries named like the whole series, kept only when the opened page credits the same author; bounded to a few opens. */
  private async wholeSeriesFromIndex(
    scope: NovelIndexScope,
    bases: ReadonlySet<string>,
    authors: readonly string[],
    sourceIds: string[],
  ): Promise<SourceCandidates> {
    const indexed = await this.novelIndex!.wholeSeriesCandidates(scope, [...bases], sourceIds).catch(() => []);
    const shortlist = indexed.filter((entry) => bases.has(baseSeriesTitle(entry.hit.title))).slice(0, MAX_SOURCE_CANDIDATES);
    const deadline = Date.now() + novelSourceLimits(scope.connection).candidateLoadMs;
    const failedSources: string[] = [];
    const loaded = await mapWithConcurrency(shortlist, CONCURRENCY, async (entry): Promise<LoadedSourceCandidate | null> => {
      try {
        const series = await beforeDeadline(this.catalog.loadSeries('novel', entry.hit.remoteId, entry.seriesKey), deadline);
        if (series === TIMED_OUT) {
          failedSources.push(entry.hit.sourceName);
          return null;
        }
        if (!authorsMatch(seriesAuthors(series), authors)) return null;
        return { hit: entry.hit, seriesKey: entry.seriesKey, confidence: 'whole_series', series };
      } catch {
        failedSources.push(entry.hit.sourceName);
        return null;
      }
    });
    return { candidates: loaded.filter((entry) => entry !== null), failedSources };
  }

  private async searchHits(
    connection: EngineConnection,
    engine: WebSerialEngineConfig['engine'],
    allowed: string[],
    queries: string[],
    wanted: Set<string>,
    deadline: number,
    failedSources: Set<string>,
  ): Promise<UrlHit[]> {
    const found = new Map<string, UrlHit>();
    for (const query of queries) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const result = await this.engines.client('novel', undefined, engine).search(connection, query, allowed, AbortSignal.timeout(remaining));
        for (const source of result.failedSources) failedSources.add(source);
        for (const hit of result.hits) if (hit.url && !found.has(hit.url)) found.set(hit.url, { ...hit, url: hit.url });
      } catch {
        failedSources.add('novel');
      }
      // The second query only exists for series the sites list under another title.
      if ([...found.values()].some((hit) => wanted.has(normalizeSerialTitle(hit.title)))) break;
    }
    return [...found.values()];
  }

  private async load(
    entry: ClassifiedNovelHit,
    authors: readonly string[],
    deadline: number,
    failedSources: Set<string>,
  ): Promise<LoadedSourceCandidate | null> {
    if (Date.now() >= deadline) {
      failedSources.add(entry.hit.sourceName);
      return null;
    }
    try {
      const loaded = await beforeDeadline(this.resolveAndLoad(entry), deadline);
      if (loaded === TIMED_OUT || !loaded) {
        failedSources.add(entry.hit.sourceName);
        return null;
      }
      if (entry.confidence === 'whole_series' && !authorsMatch(seriesAuthors(loaded.series), authors)) return null;
      return { ...entry, ...loaded };
    } catch {
      failedSources.add(entry.hit.sourceName);
      return null;
    }
  }

  private async resolveAndLoad(entry: ClassifiedNovelHit): Promise<Pick<LoadedSourceCandidate, 'hit' | 'seriesKey' | 'series'> | null> {
    const config = await this.engines.requireConfig('novel');
    const ref = await this.engines.client('novel', undefined, config.engine).resolveUrl(config.connection, entry.hit.url);
    if (!ref) return null;
    const seriesKey: WebSerialSeriesKey = makeSeriesKey('novel', ref.remoteId);
    const series = await this.catalog.loadSeries('novel', ref.remoteId, seriesKey);
    return { hit: { ...entry.hit, remoteId: ref.remoteId }, seriesKey, series };
  }
}

/** Series names of the titles, most shared first, for finding a site that carries the whole series. */
function wholeSeriesBases(titles: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const base of titles.map(baseSeriesTitle)) if (base) counts.set(base, (counts.get(base) ?? 0) + 1);
  return new Set([...counts].sort((left, right) => right[1] - left[1]).map(([base]) => base));
}

function queriesFor(input: NovelCandidateInput, bases: ReadonlySet<string>): string[] {
  const queries = [input.title];
  const seen = new Set([normalizeSerialTitle(input.title)]);
  for (const alt of input.altTitles) {
    const key = normalizeSerialTitle(alt);
    if (!key || seen.has(key) || !/[a-z0-9]/i.test(alt)) continue;
    seen.add(key);
    queries.push(alt);
  }
  const limited = queries.slice(0, MAX_QUERIES);
  const base = [...bases].find((value) => !seen.has(value) && /[a-z0-9]/.test(value));
  // The series name goes last: it only helps when no site lists the part under its own title.
  if (base) limited.push(base);
  return limited;
}

function seriesAuthors(series: EngineSeries): string[] {
  if (series.authors.length > 0) return series.authors;
  return series.author ? [series.author] : [];
}

function indexSeries(entry: NovelIndexCandidate): LoadedSourceCandidate['series'] {
  return {
    kind: 'novel',
    title: entry.hit.title,
    author: null,
    authors: [],
    synopsis: null,
    tags: [],
    language: null,
    remoteCoverPath: entry.hit.remoteCoverPath,
    sourceName: entry.hit.sourceName,
    sourceId: entry.row.sourceId,
    sourceUrl: entry.hit.url || null,
    status: entry.hit.status,
    chapterCount: entry.row.chapterCount ?? 0,
    units: [],
    packagingOptions: ['volume', 'series'],
    defaultPackaging: 'volume',
  };
}

function isSeriesLoading(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && (body as { errorCode?: unknown }).errorCode === WebSerialErrorCode.SeriesLoading;
}
