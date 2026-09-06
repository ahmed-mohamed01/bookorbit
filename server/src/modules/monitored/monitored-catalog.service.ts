import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  isAudioFormat,
  MONITORED_FORMATS,
  normalizeWorkToken,
  type MonitoredAuthorConfig,
  type MonitoredFormat,
  type MonitoredWork,
  type ProviderConfigurations,
} from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookAuthors, bookFiles, bookMetadata, books } from '../../db/schema';
import { AudibleBibliographyProvider } from './providers/audible-bibliography.provider';
import { enabledBibliographyProviders, type AuthorBibliographyProvider, type BibliographyAuthorRef } from './providers/author-bibliography-provider';
import { GoodreadsBibliographyProvider } from './providers/goodreads-bibliography.provider';
import { HardcoverBibliographyProvider } from './providers/hardcover-bibliography.provider';
import { mergeCluster } from './reconcile/cluster-merger';
import { matchObservations, normalizeCore } from './reconcile/observation-matcher';
import type { MergedWork, Observation } from './reconcile/observation.types';
import { assignVerdict, computePopularityFloor, type VerdictResult } from './reconcile/verdict';
import { foldDiacritics, normalizeMonitoredName } from './monitored-text.utils';
import { MonitoredStoreService, type MonitoredCatalog } from './monitored-store.service';

export { normalizeMonitoredName };

type Db = NodePgDatabase<typeof schema>;
const normalizeToken = normalizeWorkToken;

/** How long one work is left alone after a targeted rematch, however many views ask for it. */
const AVAILABILITY_RECOMPUTE_COOLDOWN_MS = 60 * 1000;
/** Ceilings for one read: works rematched, and matching passes (one per local author) run for them. */
const AVAILABILITY_RECOMPUTE_MAX_WORKS = 24;
const AVAILABILITY_RECOMPUTE_MAX_PASSES = 4;
const AVAILABILITY_COOLDOWN_MAX_ENTRIES = 5000;
const LOGGED_WORK_ID_LIMIT = 5;

/** The works of one monitored author a read wants brought up to date. */
export interface WorkAvailabilityGroup {
  monitor: MonitoredAuthorConfig;
  works: MonitoredWork[];
}

/**
 * A work whose owner filed a request for a format that still has no book behind it. That is the
 * ordinary state of a queued work right up until its download lands, which is exactly the moment
 * the stored match goes stale, so it is a candidate for a rematch rather than a fault.
 */
export function needsAvailabilityRecompute(work: MonitoredWork): boolean {
  return MONITORED_FORMATS.some((format) => work.requestIds?.[format] != null && work.matchedBookIds?.[format] == null);
}

/** Work ids for a log line: enough to find the work, capped so a batch cannot become a blob. */
function formatWorkIds(works: MonitoredWork[]): string {
  const ids = works.slice(0, LOGGED_WORK_ID_LIMIT).map((work) => sanitizeLogValue(work.id));
  return works.length > LOGGED_WORK_ID_LIMIT ? `${ids.join(',')},+${works.length - LOGGED_WORK_ID_LIMIT}` : ids.join(',');
}

/** One owned book of the monitored author, with every signal that can tell it from a namesake. */
export interface OwnedCandidate {
  bookId: number;
  titleKey: string;
  seriesName: string | null;
  seriesIndex: string | null;
  publishedYear: number | null;
  formats: Set<string>;
}

/** How the candidate was reached. Lower is stronger, and a stronger tier settles a tie outright. */
export const OWNED_MATCH_TIER = { providerId: 0, seriesSlot: 1, titleCore: 2, seriesPrefix: 3 } as const;

export interface OwnedClaim {
  candidate: OwnedCandidate;
  tier: number;
}

function uniqueIds(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** First origin row per monitored format, from format->bookId pairs gathered across all tiers. */
function toMatchedBookIds(origins: Map<string, number>): Partial<Record<MonitoredFormat, number>> {
  const result: Partial<Record<MonitoredFormat, number>> = {};
  for (const [format, bookId] of origins) {
    const kind: MonitoredFormat = isAudioFormat(format) ? 'audiobook' : 'ebook';
    if (result[kind] === undefined) result[kind] = bookId;
  }
  return result;
}

function sameSeriesSlot(work: Pick<MonitoredWork, 'seriesName' | 'seriesIndex'>, candidate: OwnedCandidate): boolean {
  if (!work.seriesName || work.seriesIndex == null || !candidate.seriesName || candidate.seriesIndex == null) return false;
  return (
    normalizeMonitoredName(work.seriesName) === normalizeMonitoredName(candidate.seriesName) &&
    normalizeSeriesIndex(work.seriesIndex) === normalizeSeriesIndex(candidate.seriesIndex)
  );
}

/**
 * The one owned book a work may claim for a format, or null when the evidence ties. Two different
 * books can normalize to one core - an author's "Collected Poems" of 1990 and of 2020 - and marking
 * both owned from a single file, or picking whichever row the database returned first, invents
 * ownership the data does not support. Signals are applied strongest first: the tier that found the
 * candidate, then the series slot, then how close the file's publication year sits to the work's. A
 * tie none of them breaks stays UNMATCHED, because a wrong owned badge hides a book the user does not
 * have from every search that would otherwise go and get it.
 */
export function chooseOwnedCandidate(
  work: Pick<MonitoredWork, 'seriesName' | 'seriesIndex' | 'releaseYear'>,
  claims: OwnedClaim[],
): OwnedClaim | null {
  if (claims.length <= 1) return claims[0] ?? null;
  const strongest = Math.min(...claims.map((claim) => claim.tier));
  let pool = claims.filter((claim) => claim.tier === strongest);
  if (pool.length === 1) return pool[0];
  const inSlot = pool.filter((claim) => sameSeriesSlot(work, claim.candidate));
  if (inSlot.length === 1) return inSlot[0];
  if (inSlot.length > 1) pool = inSlot;
  if (work.releaseYear != null) {
    const nearYear = pool.filter(
      (claim) => claim.candidate.publishedYear != null && Math.abs(claim.candidate.publishedYear - work.releaseYear!) <= 1,
    );
    if (nearYear.length === 1) return nearYear[0];
    if (nearYear.length > 1) pool = nearYear;
  }
  if (pool.length === 1) return pool[0];
  // Several rows that agree on title and year are not a collision at all - they are the same book
  // shelved more than once (under "vs." in one copy and "Versus" in the next), which real libraries
  // are full of. Refusing those would drop ownership the
  // user plainly has. Only candidates that disagree about WHICH book they are stay unresolved, and
  // the lowest id keeps that choice stable across refreshes.
  if (new Set(pool.map((claim) => claim.candidate.titleKey)).size > 1) return null;
  // Same title, and printings no further apart than a reissue: still one book. A real namesake - an
  // author's "Collected Poems" of 1990 beside the one of 2020 - opens a gap no reissue explains, and
  // that stays unresolved.
  const years = pool.map((claim) => claim.candidate.publishedYear).filter((year): year is number => year != null);
  if (years.length > 0 && Math.max(...years) - Math.min(...years) > 1) return null;
  return pool.reduce((best, claim) => (claim.candidate.bookId < best.candidate.bookId ? claim : best));
}

/**
 * Every normalized key a title can match under. Library and provider titles drift in fixed, boring
 * ways - "vs." vs "versus", an appended subtitle after a colon, a trailing parenthetical, an edition
 * tail, a "Part 1" split - and the exact-token fallback treated each drift as a different book.
 * Every key is a whole normalized CORE, never a prefix or a substring: an edition of the same book
 * reduces to the same core ("The Way of Kings: The Stormlight Archive", "The Way of Kings, Part 1",
 * "The Way of Kings (3 of 5) [Dramatized Adaptation]"), while a different book that merely starts
 * with the same words ("The Way of Kings Prime") or names it inside a compilation ("Brandon
 * Sanderson Sampler: The Way of Kings and Mistborn") reduces to a core of its own and cannot claim
 * the file. The stripped variants are gated on length so a short core ("Lux") cannot alias works.
 */
/** The title with the spellings that drift between a library and a provider folded together. */
export function foldedTitleKey(title: string): string {
  return normalizeToken(
    title
      .toLowerCase()
      .replace(/\bversus\b/g, 'vs')
      .replace(/&/g, ' and '),
  );
}

export function titleMatchKeys(title: string): string[] {
  const folded = title
    .toLowerCase()
    .replace(/\bversus\b/g, 'vs')
    .replace(/&/g, ' and ');
  const keys = [normalizeToken(title), foldedTitleKey(title)];
  const coreSources = [folded.split(':')[0], folded.replace(/\s*\([^)]*\)?\s*$/, '')];
  for (const source of coreSources) {
    for (const variant of [source, normalizeCore(source)]) {
      const key = normalizeToken(variant);
      if (key.length >= 6) keys.push(key);
    }
  }
  return [...new Set(keys.filter(Boolean))];
}

// Words that carry no identity on their own, so a title that differs from another only by these is
// the same title ("Bands of Mourning" against "The Bands of Mourning").
const FILLER_TITLE_TOKENS = new Set(['the', 'a', 'an', 'of', 'and']);

/**
 * True when one title is the other plus a series prefix both sides already agree on. Catalog titles
 * are often the bare work name while the library file carries the series in front ("The Shattered
 * Lens" vs "Alcatraz versus the Shattered Lens"), and no exact core can bridge that.
 *
 * Containment alone is NOT that shape and must not be treated as it: "The Way of Kings" is contained
 * in "The Way of Kings Prime" (a different book) and in "Brandon Sanderson Sampler: The Way of Kings
 * and Mistborn" (a compilation), and both were claiming the owner's Way of Kings files. So every
 * surplus token has to be explained - by a series name one of the two sides carries, or by a filler
 * word - which is exactly what a series prefix is and what a distinct title is not.
 */
export function seriesPrefixMatch(left: string, right: string, seriesTokens: Set<string>): boolean {
  const leftTokens = left.split(' ').filter(Boolean);
  const rightTokens = right.split(' ').filter(Boolean);
  const [short, long] = leftTokens.length <= rightTokens.length ? [leftTokens, rightTokens] : [rightTokens, leftTokens];
  if (short.length < 3 || short.join('').length < 10) return false;
  const longSet = new Set(long);
  if (!short.every((token) => longSet.has(token))) return false;
  const shortSet = new Set(short);
  return long.every((token) => shortSet.has(token) || seriesTokens.has(token) || FILLER_TITLE_TOKENS.has(token));
}

/** Space-separated token form for token comparison. */
export function spacedTitleTokens(title: string): string {
  return foldDiacritics(title.toLowerCase().replace(/\bversus\b/g, 'vs'))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Tokens of the series names the catalog work and the library row carry, for the prefix bridge. */
export function seriesBridgeTokens(...seriesNames: (string | null | undefined)[]): Set<string> {
  return new Set(seriesNames.flatMap((name) => (name ? spacedTitleTokens(name).split(' ') : [])).filter(Boolean));
}

// Postgres mirrors of the TypeScript folds, used ONLY to narrow which of an author's books are worth
// loading. The TypeScript keys still decide every match, so a fold that differs in some corner costs a
// candidate rather than producing a wrong one.
const NON_ALNUM_PATTERN = String.raw`[^[:alnum:]]`;
const TRAILING_PARENTHETICAL_PATTERN = String.raw`\s*\([^)]*\)?\s*$`;
const VERSUS_PATTERN = String.raw`\yversus\y`;

function normalizedTitleSql(column: AnyPgColumn): SQL<string> {
  return sql`regexp_replace(lower(public.bookorbit_unaccent(coalesce(${column}, ''))), ${NON_ALNUM_PATTERN}, '', 'g')`;
}

/**
 * A series name folded the way the series keys are: "Alcatraz versus the Evil Librarians" and
 * "Alcatraz vs. the Evil Librarians" are one series, and library files disagree with providers about
 * which spelling to use.
 */
function normalizedSeriesSql(column: AnyPgColumn): SQL<string> {
  return sql`regexp_replace(regexp_replace(lower(public.bookorbit_unaccent(coalesce(${column}, ''))), ${VERSUS_PATTERN}, 'vs', 'g'), ${NON_ALNUM_PATTERN}, '', 'g')`;
}

/**
 * Whether a row's series is one the catalog knows, allowing either side to be the shorter name: a
 * library file shelved under "Alcatraz" belongs to the catalog's "Alcatraz vs. the Evil Librarians",
 * and a file under the full name belongs to a work that only carries the short one. The length floor
 * keeps a two-letter series from prefixing half the shelf.
 */
function seriesCandidateSql(column: AnyPgColumn, seriesKeys: string[]): SQL {
  const folded = normalizedSeriesSql(column);
  return sql`(length(${folded}) >= 4 and exists (select 1 from unnest(${sql.param(seriesKeys)}::text[]) as work_series(key) where work_series.key like ${folded} || '%' or ${folded} like work_series.key || '%'))`;
}

/** The title with any subtitle after a colon and any trailing parenthetical removed, then folded. */
function normalizedTitleCoreSql(column: AnyPgColumn): SQL<string> {
  return sql`regexp_replace(lower(public.bookorbit_unaccent(regexp_replace(split_part(coalesce(${column}, ''), ':', 1), ${TRAILING_PARENTHETICAL_PATTERN}, '', 'g'))), ${NON_ALNUM_PATTERN}, '', 'g')`;
}

function normalizeSeriesIndex(value: string): string {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? String(numeric) : value.trim().toLowerCase();
}

function seriesTitleKey(titleKey: string, seriesName: string, seriesIndex: string): string {
  return `${titleKey}|${normalizeMonitoredName(seriesName)}|${normalizeSeriesIndex(seriesIndex)}`;
}

function slotPopularity(work: MergedWork): number {
  return Math.max(0, ...Object.values(work.popularity).map((value) => value ?? 0));
}

/** Whether a provider was actually run this refresh, and whether that run errored. */
export interface ProviderOutcome {
  attempted: boolean;
  failed: boolean;
}

// Only a FAILING Hardcover spine justifies keeping a stale catalog. Counting "zero observations" as
// failure punished two innocent cases: Hardcover disabled by configuration (never attempted, so the
// catalog is legitimately Hardcover-free) and a genuinely small author with no Hardcover entries -
// both were 503'd on every refresh forever. Conversely a failing Hardcover that still returned one
// partial row silenced the guard entirely, so the collapse threshold is on the work count instead.
export function shouldKeepPreviousCatalog(previousCount: number, nextCount: number, hardcover: ProviderOutcome): boolean {
  return previousCount > 0 && hardcover.attempted && hardcover.failed && nextCount < previousCount * 0.5;
}

// Create path: a first refresh whose spine errored has nothing to fall back on, so persisting the
// empty result would bake the outage into a brand new catalog.
export function shouldRejectEmptyCatalog(hardcover: ProviderOutcome, totalObservations: number): boolean {
  return hardcover.attempted && hardcover.failed && totalObservations === 0;
}

// A fresh, cross-source release (2+ providers, upcoming or released within six months) is admitted even
// without a Hardcover edition, so indie/LitRPG titles surface on release week instead of waiting for the
// crowd-sourced Hardcover to index them (often months later). The verdict step still flags translations
// and adaptations, so junk that slips past this gate stays out of the default list.
function isFreshCorroborated(work: MergedWork, today: string): boolean {
  if (work.sources.length < 2) return false;
  const releaseValue = work.ebookReleaseDate ?? work.audioReleaseDate;
  const precision = work.ebookReleaseDate ? work.ebookDatePrecision : work.audioDatePrecision;
  const currentYear = Number(today.slice(0, 4));
  if (work.unreleased && (releaseValue != null || (work.releaseYear ?? 0) >= currentYear)) return true;
  if (precision === 'day' && releaseValue) return (Date.parse(today) - Date.parse(releaseValue)) / 2_628_000_000 <= 6;
  return (work.releaseYear ?? 0) >= currentYear;
}

// A translation or minor edition shares a (series, index) slot with its canonical work but has a tiny
// fraction of its readership (e.g. the Spanish "Aleación de ley" sits at "The Mistborn Saga #4" beside
// the far more-read "The Alloy of Law"). Demote such slot-losers to 'suspect' so they drop to the
// review tray instead of duplicating - often in another language - the canonical in the default list.
// The strict ratio protects two comparably-popular real books that share a loose meta-series index.
export function demoteSlotDuplicates(works: MergedWork[], verdicts: VerdictResult[]): void {
  const slots = new Map<string, number[]>();
  works.forEach((work, index) => {
    if (verdicts[index].verdict !== 'verified' || verdicts[index].flags.length > 0) return;
    for (const membership of work.seriesMemberships ?? []) {
      if (membership.index == null) continue;
      const key = `${normalizeMonitoredName(membership.name)}#${normalizeSeriesIndex(membership.index)}`;
      const bucket = slots.get(key);
      if (bucket) bucket.push(index);
      else slots.set(key, [index]);
    }
  });
  for (const bucket of slots.values()) {
    if (bucket.length < 2) continue;
    const winner = bucket.reduce((best, index) => (slotPopularity(works[index]) > slotPopularity(works[best]) ? index : best));
    const winnerPopularity = slotPopularity(works[winner]);
    for (const index of bucket) {
      if (index !== winner && slotPopularity(works[index]) < winnerPopularity * 0.25) verdicts[index].verdict = 'suspect';
    }
  }
}

// Strongest identity signal first: Hardcover work id, then series slot, then title. A previous work
// may be claimed by at most ONE cluster - two clusters resolving to the same previous id emit two
// works with identical ids, and the duplicate primary key aborts the entire saveCatalog transaction.
// Resolving tier by tier (rather than cluster by cluster) means the strongest claim keeps the id
// instead of whichever cluster happened to be reconciled first.
interface PreviousWorkTier {
  workKey: (work: MergedWork) => string | null;
  candidateKey: (candidate: MonitoredWork) => string | null;
}

const PREVIOUS_WORK_TIERS: PreviousWorkTier[] = [
  {
    workKey: (work) => work.providerWorkIds.hardcover ?? null,
    candidateKey: (candidate) => candidate.providerWorkIds.hardcover ?? null,
  },
  {
    workKey: (work) => (work.seriesName && work.seriesIndex != null ? `${normalizeMonitoredName(work.seriesName)}#${work.seriesIndex}` : null),
    candidateKey: (candidate) =>
      candidate.seriesName && candidate.seriesIndex != null ? `${normalizeMonitoredName(candidate.seriesName)}#${candidate.seriesIndex}` : null,
  },
  { workKey: (work) => normalizeToken(work.title), candidateKey: (candidate) => normalizeToken(candidate.title) },
];

/**
 * Previous work per merged work, positionally aligned with `works`, each previous work used once.
 * Every tier searches only UNCLAIMED candidates: matching first and discarding the match when it was
 * already claimed let the second of two same-titled previous works go unmatched, losing its stable
 * id and the user overlay hanging off it.
 */
export function resolvePreviousWorks(works: MergedWork[], previous: MonitoredCatalog | null): (MonitoredWork | undefined)[] {
  const resolved: (MonitoredWork | undefined)[] = works.map(() => undefined);
  if (!previous?.works.length) return resolved;
  const claimed = new Set<string>();
  for (const tier of PREVIOUS_WORK_TIERS) {
    const byKey = new Map<string, MonitoredWork[]>();
    for (const candidate of previous.works) {
      const key = tier.candidateKey(candidate);
      if (key == null) continue;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(candidate);
      else byKey.set(key, [candidate]);
    }
    works.forEach((work, index) => {
      if (resolved[index]) return;
      const key = tier.workKey(work);
      if (key == null) return;
      const candidate = byKey.get(key)?.find((item) => !claimed.has(item.id));
      if (!candidate) return;
      claimed.add(candidate.id);
      resolved[index] = candidate;
    });
  }
  return resolved;
}

/**
 * Last line of defence for the catalog's primary key: renames any work id that still collides and
 * returns the colliding ids so the caller can warn. Losing one work's stable id is recoverable;
 * a duplicate id aborts the whole catalog write.
 */
export function enforceUniqueWorkIds(works: MonitoredWork[]): string[] {
  const seen = new Set<string>();
  const collisions: string[] = [];
  works.forEach((work, index) => {
    if (!seen.has(work.id)) {
      seen.add(work.id);
      return;
    }
    collisions.push(work.id);
    let candidate = `${work.id}#${index}`;
    while (seen.has(candidate)) candidate = `${candidate}#`;
    work.id = candidate;
    seen.add(candidate);
  });
  return collisions;
}

export interface CatalogFetchResult {
  catalog: MonitoredCatalog;
  hardcoverAuthorId: string;
}

interface ProviderResult extends ProviderOutcome {
  source: AuthorBibliographyProvider['source'];
  authorRef: BibliographyAuthorRef | null;
  observations: Observation[];
}

@Injectable()
export class MonitoredCatalogService {
  private readonly logger = new Logger(MonitoredCatalogService.name);
  /** When each work was last rematched outside a refresh, so a busy view cannot rerun matching. */
  private readonly availabilityRecomputedAt = new Map<string, number>();

  constructor(
    private readonly hardcover: HardcoverBibliographyProvider,
    private readonly goodreads: GoodreadsBibliographyProvider,
    private readonly audible: AudibleBibliographyProvider,
    private readonly store: MonitoredStoreService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async fetchCatalog(monitor: MonitoredAuthorConfig, config: ProviderConfigurations): Promise<CatalogFetchResult> {
    const startedAt = Date.now();
    this.logger.log(
      `[monitored.catalog] [start] monitorId=${monitor.id} authorName="${sanitizeLogValue(monitor.authorName)}" - catalog fetch started`,
    );
    try {
      const providers = enabledBibliographyProviders([this.hardcover, this.goodreads, this.audible], config);
      const results = await Promise.all(providers.map((provider) => this.fetchProvider(provider, monitor, config)));
      const observations = results.flatMap((result) => result.observations);
      // A provider missing from `results` was filtered out as disabled or unconfigured, which is not
      // an outage: attempted=false keeps both guards off. Everything in `results` really ran, and its
      // `failed` flag comes from the provider throwing rather than from an empty answer.
      const hardcoverOutcome: ProviderOutcome = results.find((result) => result.source === 'hardcover') ?? { attempted: false, failed: false };
      if (shouldRejectEmptyCatalog(hardcoverOutcome, observations.length)) {
        throw new ServiceUnavailableException('Hardcover bibliography fetch failed and no source returned any book; not persisting an empty catalog');
      }
      const today = new Date().toISOString().slice(0, 10);
      // Hardcover is the catalog spine: Audible/Goodreads enrich and corroborate Hardcover works but
      // never stand alone. A cluster with no Hardcover edition is a translation-only audiobook or a
      // dramatized adaptation that has no Hardcover twin, so it is dropped rather than shown as junk.
      const merged = matchObservations(observations)
        .map((cluster) => mergeCluster(cluster, today))
        .filter((work) => work.sources.includes('hardcover') || isFreshCorroborated(work, today));
      const floor = computePopularityFloor(merged);
      const previous = await this.store.getCatalog(monitor.id);
      const verdicts = merged.map((work) => assignVerdict(work, { today, floor }));
      demoteSlotDuplicates(merged, verdicts);
      const previousWorks = resolvePreviousWorks(merged, previous);
      const works = merged.map((work, index) => this.mapWork(monitor.id, work, verdicts[index], previousWorks[index]));
      for (const collision of enforceUniqueWorkIds(works)) {
        this.logger.warn(
          `[monitored.catalog.work_id] [fail] monitorId=${monitor.id} workId="${sanitizeLogValue(collision)}" errorClass=DuplicateWorkId error="two clusters resolved to one previous work" - duplicate work id renamed to keep the catalog writable`,
        );
      }
      // A rate-limited or failing Hardcover spine yields a near-empty merge; persisting that would
      // destroy a known-good catalog over a transient outage. Keep
      // the previous catalog and surface the failure instead.
      if (previous && shouldKeepPreviousCatalog(previous.works.length, works.length, hardcoverOutcome)) {
        throw new ServiceUnavailableException('The Hardcover bibliography fetch failed for this author; keeping the previous catalog');
      }
      await this.matchOwnedBooks(works, monitor.localAuthorId);
      const catalog = { works, fetchedAt: new Date().toISOString() };
      await this.store.saveCatalog(monitor.id, catalog);
      const hardcoverAuthorId = results.find((result) => result.source === 'hardcover')?.authorRef?.id ?? monitor.providerIds.hardcover ?? '';
      this.logger.log(
        `[monitored.catalog] [end] monitorId=${monitor.id} durationMs=${Date.now() - startedAt} observations=${observations.length} clusters=${merged.length} verified=${works.filter((work) => work.verdict === 'verified' && work.flags.length === 0).length} - catalog fetch completed`,
      );
      return { catalog, hardcoverAuthorId };
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.catalog] [fail] monitorId=${monitor.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - catalog fetch failed`,
      );
      throw error;
    }
  }

  /**
   * Owned-matching for the few works a read is showing that could have gained a file since the last
   * author refresh. A download files into the library minutes before that ten-minute, hand-pulled
   * refresh would recompute anything, so without this the work the user just grabbed keeps saying
   * "queued" over a book they already have.
   *
   * Candidates go through the same tiered matching a full refresh uses rather than a cheaper
   * lookalike, batched into one pass per local author so the candidate queries stay as bounded as
   * that path already makes them. A rematch is opportunistic, so a failing one is logged and
   * swallowed: it must never take a read down with it. Returns the ids whose stored match changed.
   */
  async recomputeWorkAvailability(groups: WorkAvailabilityGroup[]): Promise<Set<string>> {
    const healed = new Set<string>();
    const due = this.selectAvailabilityRecomputes(groups);
    if (due.size === 0) return healed;
    const startedAt = Date.now();
    const works = [...due.values()].flat();
    this.logger.log(
      `[monitored.work.recompute_availability] [start] workIds="${formatWorkIds(works)}" works=${works.length} passes=${due.size} - work availability recompute started`,
    );
    try {
      for (const [localAuthorId, pass] of due) {
        // Cleared copies: the answer has to be what the library supports now, not a merge with what
        // the row already claimed, and the works the caller is rendering are not ours to mutate.
        const probes = pass.map((work): MonitoredWork => ({ ...work, matchedBookId: null, matchedBookIds: {}, ownedFormats: [] }));
        await this.matchOwnedBooks(probes, localAuthorId);
        for (const probe of probes) {
          if (probe.matchedBookId == null) continue;
          await this.store.updateWorkMatch(probe.id, {
            matchedBookId: probe.matchedBookId,
            matchedBookIds: probe.matchedBookIds,
            ownedFormats: probe.ownedFormats,
          });
          healed.add(probe.id);
        }
      }
      this.logger.log(
        `[monitored.work.recompute_availability] [end] workIds="${formatWorkIds(works)}" works=${works.length} durationMs=${Date.now() - startedAt} matched=${healed.size} - work availability recompute completed`,
      );
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.work.recompute_availability] [fail] workIds="${formatWorkIds(works)}" works=${works.length} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - work availability recompute failed`,
      );
    }
    return healed;
  }

  /** The works worth rematching on this read, grouped into one matching pass per local author. */
  private selectAvailabilityRecomputes(groups: WorkAvailabilityGroup[]): Map<number | null, MonitoredWork[]> {
    const now = Date.now();
    this.pruneAvailabilityCooldowns(now);
    const due = new Map<number | null, MonitoredWork[]>();
    let selected = 0;
    for (const group of groups) {
      const localAuthorId = group.monitor.localAuthorId;
      for (const work of group.works) {
        if (selected >= AVAILABILITY_RECOMPUTE_MAX_WORKS) return due;
        if (!needsAvailabilityRecompute(work)) continue;
        const last = this.availabilityRecomputedAt.get(work.id);
        if (last != null && now - last < AVAILABILITY_RECOMPUTE_COOLDOWN_MS) continue;
        const pass = due.get(localAuthorId);
        if (!pass && due.size >= AVAILABILITY_RECOMPUTE_MAX_PASSES) continue;
        // Claimed before the work is done, so parallel reads of one view do not all rematch it, and
        // a work that matches nothing yet is not retried on every scroll.
        this.availabilityRecomputedAt.set(work.id, now);
        if (pass) pass.push(work);
        else due.set(localAuthorId, [work]);
        selected += 1;
      }
    }
    return due;
  }

  /**
   * The cooldown is keyed by work id, so a long-lived process browsing a large library has to be
   * able to forget. Expired entries go first; a map still over the cap is dropped whole, which costs
   * at worst one extra rematch and never a wrong answer.
   */
  private pruneAvailabilityCooldowns(now: number): void {
    if (this.availabilityRecomputedAt.size < AVAILABILITY_COOLDOWN_MAX_ENTRIES) return;
    for (const [workId, at] of this.availabilityRecomputedAt) {
      if (now - at >= AVAILABILITY_RECOMPUTE_COOLDOWN_MS) this.availabilityRecomputedAt.delete(workId);
    }
    if (this.availabilityRecomputedAt.size >= AVAILABILITY_COOLDOWN_MAX_ENTRIES) this.availabilityRecomputedAt.clear();
  }

  private async fetchProvider(
    provider: AuthorBibliographyProvider,
    monitor: MonitoredAuthorConfig,
    config: ProviderConfigurations,
  ): Promise<ProviderResult> {
    const startedAt = Date.now();
    try {
      let authorRef: BibliographyAuthorRef | null;
      if (provider.source === 'hardcover') {
        const authorId = await this.resolveHardcoverAuthorId(monitor, config);
        authorRef = authorId == null ? null : { id: String(authorId), name: monitor.authorName, bookCount: null, imageUrl: null };
      } else {
        authorRef = await provider.resolveAuthor(monitor.authorName, config, monitor.providerIds[provider.source]);
      }
      if (!authorRef) return { source: provider.source, authorRef: null, observations: [], attempted: true, failed: false };
      return {
        source: provider.source,
        authorRef,
        observations: await provider.fetchObservations(authorRef, config),
        attempted: true,
        failed: false,
      };
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.catalog.provider] [fail] monitorId=${monitor.id} source=${provider.source} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - provider catalog fetch failed`,
      );
      return { source: provider.source, authorRef: null, observations: [], attempted: true, failed: true };
    }
  }

  private async resolveHardcoverAuthorId(monitor: MonitoredAuthorConfig, config: ProviderConfigurations): Promise<number | null> {
    const author = await this.hardcover.resolveAuthor(monitor.authorName, config, monitor.providerIds.hardcover);
    const authorId = Number(author?.id);
    return Number.isSafeInteger(authorId) && authorId > 0 ? authorId : null;
  }

  private mapWork(monitorId: string, work: MergedWork, result: ReturnType<typeof assignVerdict>, old: MonitoredWork | undefined): MonitoredWork {
    const seedSource = work.sources.find((source) => work.providerWorkIds[source]) ?? work.sources[0];
    const seedId = seedSource ? work.providerWorkIds[seedSource] : null;
    return {
      id: old?.id ?? `${monitorId}:${seedSource ?? 'work'}:${seedId ?? normalizeMonitoredName(work.title)}`,
      title: work.title,
      subtitle: work.subtitle,
      seriesName: work.seriesName,
      seriesIndex: work.seriesIndex,
      seriesMemberships: work.seriesMemberships ?? [],
      releaseYear: work.releaseYear,
      ebookReleaseDate: work.ebookReleaseDate,
      ebookDatePrecision: work.ebookDatePrecision,
      audioReleaseDate: work.audioReleaseDate,
      audioDatePrecision: work.audioDatePrecision,
      coverUrl: work.cover,
      description: work.description,
      verdict: result.verdict,
      flags: result.flags,
      sources: work.sources,
      providerWorkIds: work.providerWorkIds,
      monitorState: 'monitoring',
      monitorFormats: {},
      matchedBookId: null,
      matchedBookIds: {},
      ownedFormats: [],
      requestIds: {},
    };
  }

  // Match each work to an owned book by strongest signal first: Hardcover id, then Audible ASIN, then
  // Goodreads id (all exact provider-id matches across the whole present library), then a title + series
  // + author fallback scoped to the monitored author's own books. ISBN belongs between the ids and the
  // title fallback, but MonitoredWork does not carry an ISBN yet (needs sourcing from Hardcover editions).
  private async matchOwnedBooks(works: MonitoredWork[], localAuthorId: number | null): Promise<void> {
    if (works.length === 0) return;

    const hardcoverIds = uniqueIds(works.map((work) => work.providerWorkIds.hardcover));
    const asins = uniqueIds(works.map((work) => work.providerWorkIds.audible));
    const goodreadsIds = uniqueIds(works.map((work) => work.providerWorkIds.goodreads));

    const idClauses: SQL[] = [];
    if (hardcoverIds.length) idClauses.push(inArray(bookMetadata.hardcoverId, hardcoverIds));
    if (asins.length) idClauses.push(inArray(bookMetadata.audibleId, asins));
    if (goodreadsIds.length) idClauses.push(inArray(bookMetadata.goodreadsId, goodreadsIds));

    const identifierRows = idClauses.length
      ? await this.db
          .select({
            bookId: books.id,
            hardcoverId: bookMetadata.hardcoverId,
            audibleId: bookMetadata.audibleId,
            goodreadsId: bookMetadata.goodreadsId,
            title: bookMetadata.title,
            seriesName: bookMetadata.seriesName,
            seriesIndex: bookMetadata.seriesIndex,
            publishedYear: bookMetadata.publishedYear,
            format: bookFiles.format,
          })
          .from(bookMetadata)
          .innerJoin(books, eq(books.id, bookMetadata.bookId))
          .leftJoin(bookFiles, and(eq(bookFiles.bookId, books.id), eq(bookFiles.role, 'content')))
          .where(and(or(...idClauses), eq(books.status, 'present')))
      : [];

    // Candidates are bounded by what the catalog can actually match: a book of this author whose
    // title folds onto one of the works' keys, or that sits in a series one of the works belongs to
    // (the only shape the series-prefix bridge can reach). Loading the author's entire shelf was
    // unbounded, and a catch-all author - "Various", an anthology filler - carries the whole library.
    // The lowercase twin of each key is carried alongside it: the shared token normalizer lowercases
    // BEFORE NFKD, so a decomposition that yields letters ("Stormlight(tm)" -> "...TM") keeps them
    // uppercase, while any SQL fold lowercases last. Without the twin those rows silently fail to be
    // fetched as candidates. The keys only narrow the query; TypeScript still decides every match.
    const titleKeys = [...new Set(works.flatMap((work) => titleMatchKeys(work.title)).flatMap((key) => [key, key.toLowerCase()]))];
    const seriesKeys = [
      ...new Set(
        works
          .flatMap((work) => [work.seriesName, ...(work.seriesMemberships ?? []).map((membership) => membership.name)])
          .map((name) => (name ? normalizeMonitoredName(name.toLowerCase().replace(/\bversus\b/g, 'vs')) : ''))
          .filter(Boolean),
      ),
    ];
    const candidateClauses: SQL[] = [];
    if (titleKeys.length) {
      candidateClauses.push(inArray(normalizedTitleSql(bookMetadata.title), titleKeys));
      candidateClauses.push(inArray(normalizedTitleCoreSql(bookMetadata.title), titleKeys));
    }
    if (seriesKeys.length) candidateClauses.push(seriesCandidateSql(bookMetadata.seriesName, seriesKeys));

    const authorRows =
      localAuthorId == null || candidateClauses.length === 0
        ? []
        : await this.db
            .select({
              bookId: books.id,
              title: bookMetadata.title,
              seriesName: bookMetadata.seriesName,
              seriesIndex: bookMetadata.seriesIndex,
              publishedYear: bookMetadata.publishedYear,
              format: bookFiles.format,
            })
            .from(bookAuthors)
            .innerJoin(books, eq(books.id, bookAuthors.bookId))
            .innerJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
            .leftJoin(bookFiles, and(eq(bookFiles.bookId, books.id), eq(bookFiles.role, 'content')))
            .where(and(eq(bookAuthors.authorId, localAuthorId), eq(books.status, 'present'), or(...candidateClauses)));

    // One candidate per book, so the several file rows a book has collapse into its format set
    // instead of into several competing candidates for the same book.
    const candidates = new Map<number, OwnedCandidate>();
    const candidateFor = (row: {
      bookId: number;
      title: string | null;
      seriesName: string | null;
      seriesIndex: string | null;
      publishedYear: number | null;
    }) => {
      const existing = candidates.get(row.bookId);
      if (existing) return existing;
      const created: OwnedCandidate = {
        bookId: row.bookId,
        titleKey: foldedTitleKey(row.title ?? ''),
        seriesName: row.seriesName,
        seriesIndex: row.seriesIndex,
        publishedYear: row.publishedYear,
        formats: new Set<string>(),
      };
      candidates.set(row.bookId, created);
      return created;
    };

    const byHardcover = new Map<string, OwnedCandidate[]>();
    const byAsin = new Map<string, OwnedCandidate[]>();
    const byGoodreads = new Map<string, OwnedCandidate[]>();
    const byTitle = new Map<string, OwnedCandidate[]>();
    const byTitleSeries = new Map<string, OwnedCandidate[]>();
    const push = (map: Map<string, OwnedCandidate[]>, key: string, candidate: OwnedCandidate): void => {
      const bucket = map.get(key);
      if (!bucket) map.set(key, [candidate]);
      else if (!bucket.includes(candidate)) bucket.push(candidate);
    };

    for (const row of identifierRows) {
      const candidate = candidateFor(row);
      if (row.format) candidate.formats.add(row.format);
      if (row.hardcoverId) push(byHardcover, row.hardcoverId, candidate);
      if (row.audibleId) push(byAsin, row.audibleId, candidate);
      if (row.goodreadsId) push(byGoodreads, row.goodreadsId, candidate);
    }

    const bridgeRows: { spaced: string; seriesName: string | null; candidate: OwnedCandidate }[] = [];
    const bridgeSeen = new Set<number>();
    for (const row of authorRows) {
      if (!row.title) continue;
      const candidate = candidateFor(row);
      if (row.format) candidate.formats.add(row.format);
      for (const key of titleMatchKeys(row.title)) push(byTitle, key, candidate);
      if (row.seriesName && row.seriesIndex) {
        push(byTitleSeries, seriesTitleKey(normalizeToken(row.title), row.seriesName, row.seriesIndex), candidate);
      }
      if (bridgeSeen.has(row.bookId)) continue;
      bridgeSeen.add(row.bookId);
      bridgeRows.push({ spaced: spacedTitleTokens(row.title), seriesName: row.seriesName, candidate });
    }

    for (const work of works) {
      const titleKey = normalizeToken(work.title);
      // Every tier contributes CANDIDATES rather than a decision: the ebook and the audiobook of one
      // work are separate rows in separate libraries and usually only one of them carries a provider
      // id, so ownership has to be assembled across tiers - but assembling it by "first row wins"
      // let a namesake, or a different edition entirely, supply a format the real match did not.
      const claims = new Map<number, OwnedClaim>();
      const claim = (tier: number, found: OwnedCandidate[] | undefined): void => {
        for (const candidate of found ?? []) {
          const existing = claims.get(candidate.bookId);
          if (!existing) claims.set(candidate.bookId, { candidate, tier });
          else if (tier < existing.tier) existing.tier = tier;
        }
      };
      if (work.providerWorkIds.hardcover) claim(OWNED_MATCH_TIER.providerId, byHardcover.get(work.providerWorkIds.hardcover));
      if (work.providerWorkIds.audible) claim(OWNED_MATCH_TIER.providerId, byAsin.get(work.providerWorkIds.audible));
      if (work.providerWorkIds.goodreads) claim(OWNED_MATCH_TIER.providerId, byGoodreads.get(work.providerWorkIds.goodreads));
      if (work.seriesName && work.seriesIndex) {
        claim(OWNED_MATCH_TIER.seriesSlot, byTitleSeries.get(seriesTitleKey(titleKey, work.seriesName, work.seriesIndex)));
      }
      for (const key of titleMatchKeys(work.title)) claim(OWNED_MATCH_TIER.titleCore, byTitle.get(key));
      // Last resort, scoped to this author's own library: the series-prefix shape ("Alcatraz versus
      // the X" for the catalog's "The X"), which no exact core reaches. Every other drift is already
      // a core key above, so nothing here matches on a mere prefix or substring.
      const spacedWork = spacedTitleTokens(work.title);
      for (const row of bridgeRows) {
        if (!seriesPrefixMatch(spacedWork, row.spaced, seriesBridgeTokens(work.seriesName, row.seriesName))) continue;
        claim(OWNED_MATCH_TIER.seriesPrefix, [row.candidate]);
      }
      if (claims.size === 0) continue;

      const allClaims = [...claims.values()];
      const origins = new Map<string, number>();
      for (const format of new Set(allClaims.flatMap((entry) => [...entry.candidate.formats]))) {
        const winner = chooseOwnedCandidate(
          work,
          allClaims.filter((entry) => entry.candidate.formats.has(format)),
        );
        if (winner) origins.set(format, winner.candidate.bookId);
      }
      const matchedBookIds = toMatchedBookIds(origins);
      const primary = matchedBookIds.ebook ?? matchedBookIds.audiobook ?? null;
      if (primary == null) continue;
      work.matchedBookId = primary;
      work.matchedBookIds = matchedBookIds;
      work.ownedFormats = this.toOwnedFormats(new Set(origins.keys()));
    }
  }

  private toOwnedFormats(formats: Set<string>): MonitoredFormat[] {
    // A matched book with no content-role files owns nothing yet - claiming 'ebook' would hide
    // the work from ebook auto-search while delivering no ebook.
    if (formats.size === 0) return [];
    const result: MonitoredFormat[] = [];
    if ([...formats].some((format) => !isAudioFormat(format))) result.push('ebook');
    if ([...formats].some((format) => isAudioFormat(format))) result.push('audiobook');
    return result;
  }
}
