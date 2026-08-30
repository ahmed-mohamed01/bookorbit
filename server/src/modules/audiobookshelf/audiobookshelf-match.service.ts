import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type {
  AudiobookshelfCleanupResult,
  AudiobookshelfMappingSuggestions,
  AudiobookshelfPathMapping,
  AudiobookshelfPathMappingSuggestion,
  AudiobookshelfRescanResult,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import {
  normalizeIsbn,
  normalizeName,
  normalizedLevenshtein,
  scoreAuthors,
  scoreTitle,
  titleVolumeConflict,
  tokenOverlap,
} from '../../common/utils/fuzzy-match.utils';
import {
  isMappablePathPrefix,
  mapAbsItemPath,
  normalizeAsin,
  splitPathSuffixKey,
  toPlannerPathMappings,
  stripSharedTrailingSegments,
} from './audiobookshelf-match.utils';
import { LibraryService } from '../library/library.service';
import { AudiobookshelfClientService, type AbsLibraryItem } from './audiobookshelf-client.service';
import {
  AudiobookshelfRepository,
  type AbsBookStateUpsert,
  type AbsExactMatchRow,
  type AbsFuzzyCandidate,
  type AbsFuzzyCandidateSeries,
} from './audiobookshelf.repository';
import { buildBookAccessScope, describeError, isAbsSyncConfigured } from './audiobookshelf-user.utils';

export interface AbsMatchInput {
  absLibraryItemId: string;
  asin: string | null;
  isbn: string | null;
  title: string | null;
  author: string | null;
  seriesName: string | null;
  path: string | null;
  libraryName: string | null;
}

export interface AudiobookshelfMatchSummary {
  totalItems: number;
  processed: number;
  autoLinked: number;
  /** Pending-review proposals a forced rescan replaced with an exact identity match. */
  upgradedFromReview: number;
  needsReview: number;
  unmatched: number;
  errors: number;
  skipped: number;
}

/** A resolved exact tier: one book, or several books sharing the key (never guessed between). */
type AbsExactHit = { bookId: number; method: string } | { ambiguousError: string };

const FUZZY_CANDIDATE_LIMIT = 20;
const FUZZY_TITLE_MIN = 0.8;
const FUZZY_AUTHOR_MIN = 0.7;
const FUZZY_ACCEPT_CONFIDENCE = 84;
// Minimum confidence gap (in 0-100 points) the top fuzzy candidate must clear over the runner-up.
// Within this margin the two are treated as ambiguous and left for human review rather than
// auto-suggesting a single pick.
const FUZZY_AMBIGUITY_MARGIN = 4;
const SERIES_NAME_MIN = 0.6;
const SERIES_BONUS_WEIGHT = 0.1;
const ABS_LIBRARY_ITEMS_PAGE_SIZE = 500;
const CLEANUP_SCAN_PAGE_SIZE = 1000;
const LOCAL_FOLDER_SCAN_PAGE_SIZE = 2000;
// How many agreeing items a prefix pair needs before it is offered. A handful of coincidental
// author/book folder matches is not evidence of a shared mount; dozens or hundreds are.
const MAPPING_SUGGESTION_MIN_SUPPORT = 5;
const MAPPING_SUGGESTION_LIMIT = 10;
// Ceiling on the distinct trailing keys the suggestion pass indexes, so one walk of a very large
// remote library cannot grow an unbounded map. Well above what any real mount needs: agreement is
// counted per prefix pair, and a pair worth offering is already decided long before this.
const MAPPING_SUGGESTION_KEY_LIMIT = 5000;
// Match methods a person owns, which no forced rescan may overwrite. Only a manual link writes one:
// confirming a proposal clears needsReview instead of rewriting the method, so a confirmed row falls
// outside the upgrade pass on its needsReview flag rather than on its method.
const USER_BLESSED_MATCH_METHODS = new Set(['manual']);

interface ParsedSeries {
  name: string | null;
  sequence: number | null;
}

function parseAbsSeries(seriesName: string | null): ParsedSeries {
  if (!seriesName) return { name: null, sequence: null };
  const first = seriesName.split(',')[0]?.trim() ?? '';
  if (!first) return { name: null, sequence: null };
  const match = first.match(/^(.*?)\s*#\s*([\d.]+)\s*$/);
  if (match && /^\d+(\.\d+)?$/.test(match[2]!)) {
    const sequence = Number.parseFloat(match[2]!);
    return { name: match[1]!.trim() || null, sequence: Number.isFinite(sequence) ? sequence : null };
  }
  if (match) return { name: match[1]!.trim() || null, sequence: null };
  return { name: first, sequence: null };
}

function groupByKey(rows: AbsExactMatchRow[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const row of rows) {
    const set = map.get(row.key) ?? new Set<number>();
    set.add(row.bookId);
    map.set(row.key, set);
  }
  return map;
}

@Injectable()
export class AudiobookshelfMatchService {
  private readonly logger = new Logger(AudiobookshelfMatchService.name);
  // Shared by every user-triggered operation that walks the whole remote inventory, so one user can
  // never have two full walks hammering their Audiobookshelf server at once.
  private readonly walkingUsers = new Set<number>();

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly libraryService: LibraryService,
  ) {}

  async rescan(user: RequestUser): Promise<AudiobookshelfRescanResult> {
    const settings = await this.repo.findSettings(user.id);
    if (!settings || !isAbsSyncConfigured(settings)) {
      throw new BadRequestException('Audiobookshelf sync is not configured');
    }
    if (this.walkingUsers.has(user.id)) {
      throw new ConflictException('An Audiobookshelf inventory walk is already running');
    }
    this.walkingUsers.add(user.id);

    const startedAt = Date.now();
    this.logger.log(`[abs.match] [start] userId=${user.id} trigger=rescan - library rescan started`);
    try {
      const summary = await this.matchLibrary(user, settings.serverUrl, settings.apiToken, {
        force: true,
        excludedLibraryIds: settings.excludedLibraryIds ?? [],
        pathMappings: settings.pathMappings ?? [],
      });
      this.logger.log(
        `[abs.match] [end] userId=${user.id} trigger=rescan durationMs=${Date.now() - startedAt} totalItems=${summary.totalItems} autoLinked=${summary.autoLinked} upgradedFromReview=${summary.upgradedFromReview} needsReview=${summary.needsReview} unmatched=${summary.unmatched} errors=${summary.errors} skipped=${summary.skipped} - library rescan completed`,
      );
      return { queued: summary.processed };
    } catch (err) {
      const { errorClass, error } = describeError(err);
      this.logger.error(
        `[abs.match] [fail] userId=${user.id} trigger=rescan durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${error}" - library rescan failed`,
      );
      throw err;
    } finally {
      this.walkingUsers.delete(user.id);
    }
  }

  /**
   * Explicit, user-triggered removal of book-state rows whose Audiobookshelf item no longer shows up
   * in the selected libraries. Matching itself never prunes (an empty or failed inventory must never
   * wipe state), so this is the only path that deletes, and it deletes only what it can prove is gone:
   * the walk must complete without a single fetch error and must see at least one item, and only pure
   * unmatched rows are removed. Anything still carrying a link or an exclusion is counted and kept, and
   * a manually unlinked row (a deliberate user decision) is counted and kept unless the caller opts in.
   */
  async cleanupStale(user: RequestUser, options: { includeManuallyUnlinked: boolean }): Promise<AudiobookshelfCleanupResult> {
    const settings = await this.repo.findSettings(user.id);
    if (!settings || !isAbsSyncConfigured(settings)) {
      throw new BadRequestException('Audiobookshelf sync is not configured');
    }
    if (this.walkingUsers.has(user.id)) {
      throw new ConflictException('An Audiobookshelf cleanup is already running');
    }
    this.walkingUsers.add(user.id);

    const startedAt = Date.now();
    this.logger.log(
      `[abs.cleanup_stale] [start] userId=${user.id} includeManuallyUnlinked=${options.includeManuallyUnlinked} - stale cleanup started`,
    );
    try {
      const seen = new Set<string>();
      try {
        await this.forEachInventoryPage(user.id, settings.serverUrl, settings.apiToken, settings.excludedLibraryIds ?? [], (pageItems) => {
          for (const item of pageItems) seen.add(item.absLibraryItemId);
          return Promise.resolve();
        });
      } catch (err) {
        throw new ServiceUnavailableException('Could not read the full Audiobookshelf inventory, so nothing was removed', { cause: err });
      }
      if (seen.size === 0) {
        throw new BadRequestException('Refusing to clean against an empty inventory, so nothing was removed');
      }

      const { deletable, staleLinked, staleExcluded, staleManuallyUnlinked } = await this.collectStale(user.id, seen, options);
      const removed = await this.repo.deleteBookStatesByAbsItemIds(user.id, deletable, options);
      // What a repeat cleanup with the box ticked would still find: normally zero deletable survivors
      // plus whatever manually unlinked rows this run chose to keep.
      const staleCount = Math.max(0, deletable.length - removed) + staleManuallyUnlinked;
      await this.repo.updateStaleCount(user.id, staleCount);
      this.logger.log(
        `[abs.cleanup_stale] [end] userId=${user.id} durationMs=${Date.now() - startedAt} seenItems=${seen.size} removed=${removed} staleLinked=${staleLinked} staleExcluded=${staleExcluded} staleManuallyUnlinked=${staleManuallyUnlinked} staleCount=${staleCount} - stale cleanup completed`,
      );
      return { removed, staleLinked, staleExcluded, staleManuallyUnlinked, seenItems: seen.size };
    } catch (err) {
      // A failed inventory walk is rethrown wrapped, so log the cause it carries: the wrapper message
      // is fixed text, the root error is what identifies the failure.
      const { errorClass, error } = describeError(err instanceof Error && err.cause instanceof Error ? err.cause : err);
      this.logger.error(
        `[abs.cleanup_stale] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${error}" - stale cleanup failed`,
      );
      throw err;
    } finally {
      this.walkingUsers.delete(user.id);
    }
  }

  /**
   * Infers folder mappings instead of asking the user to type them. Both servers scan the same
   * storage under different mounts, so an item's trailing author/book folders are identical on each
   * side and only the leading mount differs: an ABS item whose trailing key names exactly one local
   * book folder votes for the prefix pair those two paths differ by. A key that names several local
   * folders proves nothing about which mount is meant, so that item abstains rather than guessing.
   *
   * Nothing is saved here. The suggestions are returned for the user to review and save with the
   * rest of the sync options, and the same all-or-nothing guards as the cleanup apply: a failed or
   * empty inventory walk yields an error rather than a partial answer built from half a library.
   */
  async suggestPathMappings(user: RequestUser): Promise<AudiobookshelfMappingSuggestions> {
    const settings = await this.repo.findSettings(user.id);
    if (!settings || !isAbsSyncConfigured(settings)) {
      throw new BadRequestException('Audiobookshelf sync is not configured');
    }
    if (this.walkingUsers.has(user.id)) {
      throw new ConflictException('An Audiobookshelf inventory walk is already running');
    }
    this.walkingUsers.add(user.id);

    const startedAt = Date.now();
    this.logger.log(`[abs.suggest_mappings] [start] userId=${user.id} - mapping suggestion started`);
    try {
      const absPrefixesByKey = new Map<string, Map<string, number>>();
      let scannedItems = 0;
      let skippedOverKeyLimit = 0;
      try {
        await this.forEachInventoryPage(user.id, settings.serverUrl, settings.apiToken, settings.excludedLibraryIds ?? [], (pageItems) => {
          scannedItems += pageItems.length;
          for (const item of pageItems) {
            const split = splitPathSuffixKey(item.path);
            if (!split) continue;
            let byPrefix = absPrefixesByKey.get(split.key);
            if (!byPrefix) {
              if (absPrefixesByKey.size >= MAPPING_SUGGESTION_KEY_LIMIT) {
                skippedOverKeyLimit++;
                continue;
              }
              byPrefix = new Map<string, number>();
              absPrefixesByKey.set(split.key, byPrefix);
            }
            byPrefix.set(split.prefix, (byPrefix.get(split.prefix) ?? 0) + 1);
          }
          return Promise.resolve();
        });
      } catch (err) {
        throw new ServiceUnavailableException('Could not read the full Audiobookshelf inventory, so no mappings were suggested', { cause: err });
      }
      if (scannedItems === 0) {
        throw new BadRequestException('Audiobookshelf returned no items, so no mappings were suggested');
      }
      if (skippedOverKeyLimit > 0) {
        this.logger.warn(
          `[abs.suggest_mappings] [end] userId=${user.id} keyLimit=${MAPPING_SUGGESTION_KEY_LIMIT} skippedItems=${skippedOverKeyLimit} - key index hit its cap, later items contributed no votes`,
        );
      }

      const localPrefixesByKey = await this.collectLocalPrefixes(user, absPrefixesByKey);
      const suggestions = this.rankMappingSuggestions(absPrefixesByKey, localPrefixesByKey, settings.pathMappings ?? []);
      this.logger.log(
        `[abs.suggest_mappings] [end] userId=${user.id} durationMs=${Date.now() - startedAt} scannedItems=${scannedItems} suggestionCount=${suggestions.length} - mapping suggestion completed`,
      );
      return { suggestions, scannedItems };
    } catch (err) {
      const { errorClass, error } = describeError(err instanceof Error && err.cause instanceof Error ? err.cause : err);
      this.logger.error(
        `[abs.suggest_mappings] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${error}" - mapping suggestion failed`,
      );
      throw err;
    } finally {
      this.walkingUsers.delete(user.id);
    }
  }

  /**
   * Walks the user's accessible book folders in keyset pages and indexes them by trailing key. Only
   * keys the remote inventory actually produced are kept, and a key stops collecting once it holds
   * two prefixes, so the index stays bounded by the ABS side no matter how large the local library.
   */
  private async collectLocalPrefixes(user: RequestUser, absPrefixesByKey: Map<string, Map<string, number>>): Promise<Map<string, Set<string>>> {
    const byKey = new Map<string, Set<string>>();
    if (absPrefixesByKey.size === 0) return byKey;

    const { libraryIds, contentFilters } = await buildBookAccessScope(user, this.libraryService);
    if (libraryIds.length === 0) return byKey;

    let afterPath: string | null = null;
    while (true) {
      const paths = await this.repo.findDistinctBookFolderPaths(libraryIds, contentFilters, afterPath, LOCAL_FOLDER_SCAN_PAGE_SIZE);
      if (paths.length === 0) break;
      for (const path of paths) {
        const split = splitPathSuffixKey(path);
        if (!split || !absPrefixesByKey.has(split.key)) continue;
        const prefixes = byKey.get(split.key) ?? new Set<string>();
        if (prefixes.size < 2) prefixes.add(split.prefix);
        byKey.set(split.key, prefixes);
      }
      afterPath = paths[paths.length - 1]!;
      if (paths.length < LOCAL_FOLDER_SCAN_PAGE_SIZE) break;
    }
    return byKey;
  }

  /** Tallies the per-item votes into prefix pairs, drops the already-saved and weakly supported ones. */
  private rankMappingSuggestions(
    absPrefixesByKey: Map<string, Map<string, number>>,
    localPrefixesByKey: Map<string, Set<string>>,
    savedMappings: readonly AudiobookshelfPathMapping[],
  ): AudiobookshelfPathMappingSuggestion[] {
    const pairKey = (absPrefix: string, localPrefix: string) => `${absPrefix}\u0000${localPrefix}`;
    const votes = new Map<string, AudiobookshelfPathMappingSuggestion>();
    for (const [key, byPrefix] of absPrefixesByKey) {
      const localPrefixes = localPrefixesByKey.get(key);
      if (localPrefixes?.size !== 1) continue;
      const localPrefix = localPrefixes.values().next().value!;
      for (const [absPrefix, count] of byPrefix) {
        const rooted = stripSharedTrailingSegments(absPrefix, localPrefix);
        // An item sitting directly under a filesystem root roots its side at `/`, which matches every
        // absolute path while rewriting nothing. Never offer that as half of a mapping.
        if (!isMappablePathPrefix(rooted.absPrefix) || !isMappablePathPrefix(rooted.localPrefix)) continue;
        const pair = votes.get(pairKey(rooted.absPrefix, rooted.localPrefix)) ?? {
          absPrefix: rooted.absPrefix,
          localPrefix: rooted.localPrefix,
          supportCount: 0,
        };
        pair.supportCount += count;
        votes.set(pairKey(rooted.absPrefix, rooted.localPrefix), pair);
      }
    }

    const saved = new Set(toPlannerPathMappings(savedMappings).map((mapping) => pairKey(mapping.sourcePrefix, mapping.targetPrefix)));
    return [...votes]
      .filter(([pair, suggestion]) => suggestion.supportCount >= MAPPING_SUGGESTION_MIN_SUPPORT && !saved.has(pair))
      .map(([, suggestion]) => suggestion)
      .sort((a, b) => b.supportCount - a.supportCount || a.absPrefix.localeCompare(b.absPrefix) || a.localPrefix.localeCompare(b.localPrefix))
      .slice(0, MAPPING_SUGGESTION_LIMIT);
  }

  /**
   * Walks the user's book-state rows in keyset pages and splits the ones the inventory did not see
   * into deletable ids and retained counters. A stale row is counted as linked before excluded before
   * manually unlinked, so the four outcome counts stay disjoint and sum to the total stale rows. A
   * manually unlinked row is a deliberate user decision, so it is kept (counted, not deleted) unless
   * `includeManuallyUnlinked` opts in.
   */
  private async collectStale(
    userId: number,
    seen: Set<string>,
    options: { includeManuallyUnlinked: boolean },
  ): Promise<{ deletable: string[]; staleLinked: number; staleExcluded: number; staleManuallyUnlinked: number }> {
    const deletable: string[] = [];
    let staleLinked = 0;
    let staleExcluded = 0;
    let staleManuallyUnlinked = 0;
    let afterId = 0;
    while (true) {
      const rows = await this.repo.findBookStateCleanupCandidates(userId, afterId, CLEANUP_SCAN_PAGE_SIZE);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (seen.has(row.absLibraryItemId)) continue;
        if (row.bookId != null) staleLinked++;
        else if (row.syncExcluded) staleExcluded++;
        else if (row.manualUnlinked && !options.includeManuallyUnlinked) staleManuallyUnlinked++;
        else deletable.push(row.absLibraryItemId);
      }
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < CLEANUP_SCAN_PAGE_SIZE) break;
    }
    return { deletable, staleLinked, staleExcluded, staleManuallyUnlinked };
  }

  /**
   * Full inventory reconcile: paginate the selected ABS inventory and match each bounded page. Only
   * item IDs are retained across pages (for the stale count), never the items themselves. No pruning.
   * This is the slow-cadence path (rescan / scheduled deep run), not the frequent progress poll.
   */
  async matchLibrary(
    user: RequestUser,
    serverUrl: string,
    token: string,
    options: { force: boolean; excludedLibraryIds?: string[]; pathMappings?: AudiobookshelfPathMapping[] },
  ): Promise<AudiobookshelfMatchSummary> {
    const summary: AudiobookshelfMatchSummary = {
      totalItems: 0,
      processed: 0,
      autoLinked: 0,
      upgradedFromReview: 0,
      needsReview: 0,
      unmatched: 0,
      errors: 0,
      skipped: 0,
    };

    // Shared across pages so the library-changed probe runs at most once per reconcile, not per page.
    const changedAtMemo: { value?: Date | null } = {};
    const seen = new Set<string>();
    await this.forEachInventoryPage(user.id, serverUrl, token, options.excludedLibraryIds ?? [], async (pageItems) => {
      summary.totalItems += pageItems.length;
      for (const item of pageItems) seen.add(item.absLibraryItemId);
      const pageSummary = await this.matchItems(user, pageItems, {
        force: options.force,
        changedAtMemo,
        pathMappings: options.pathMappings,
      });
      summary.processed += pageSummary.processed;
      summary.autoLinked += pageSummary.autoLinked;
      summary.upgradedFromReview += pageSummary.upgradedFromReview;
      summary.needsReview += pageSummary.needsReview;
      summary.unmatched += pageSummary.unmatched;
      summary.errors += pageSummary.errors;
      summary.skipped += pageSummary.skipped;
    });

    // Only reached once every selected library has been walked without a fetch error, so the seen set
    // is complete and what it does not contain is genuinely gone.
    const staleCount = await this.recordStaleCount(user.id, seen);

    this.logger.log(
      `[abs.match] [end] userId=${user.id} trigger=${options.force ? 'rescan' : 'incremental'} totalItems=${summary.totalItems} autoLinked=${summary.autoLinked} upgradedFromReview=${summary.upgradedFromReview} needsReview=${summary.needsReview} unmatched=${summary.unmatched} errors=${summary.errors} skipped=${summary.skipped} staleCount=${staleCount ?? 'skipped'} - reconcile completed`,
    );
    return summary;
  }

  /**
   * Persists how many stale rows a cleanup could remove, from a walk that already covered every
   * selected library. An empty inventory is not evidence of staleness (an unreachable or
   * misconfigured server would report the whole library as gone), so the stored count is left alone.
   * `staleCount` is "rows a cleanup could remove", including manually unlinked ones: excluding them
   * here would hide the only control that can clear them once the box is ticked.
   */
  private async recordStaleCount(userId: number, seen: Set<string>): Promise<number | null> {
    if (seen.size === 0) return null;
    const { deletable } = await this.collectStale(userId, seen, { includeManuallyUnlinked: true });
    await this.repo.updateStaleCount(userId, deletable.length);
    return deletable.length;
  }

  async matchItems(
    user: RequestUser,
    items: AbsMatchInput[],
    options: { force: boolean; changedAtMemo?: { value?: Date | null }; pathMappings?: AudiobookshelfPathMapping[] },
  ): Promise<AudiobookshelfMatchSummary> {
    const summary: AudiobookshelfMatchSummary = {
      totalItems: items.length,
      processed: 0,
      autoLinked: 0,
      upgradedFromReview: 0,
      needsReview: 0,
      unmatched: 0,
      errors: 0,
      skipped: 0,
    };
    if (items.length === 0) return summary;

    const startedAt = Date.now();
    // Everything below is decided from the state read a line later, and the write lands seconds after
    // the candidate queries. Stamping the batch with a time taken before that read lets the write
    // yield to any user decision made in between; erring early only costs a re-evaluation next run.
    const readAt = new Date(startedAt);
    const { libraryIds: accessibleLibraryIds, contentFilters } = await buildBookAccessScope(user, this.libraryService);

    const existing = await this.repo.findBookStatesByAbsItemIds(
      user.id,
      items.map((item) => item.absLibraryItemId),
    );
    const stateByItemId = new Map(existing.map((state) => [state.absLibraryItemId, state]));

    const changedAtMemo = options.changedAtMemo ?? {};
    const toMatch: AbsMatchInput[] = [];
    // Pending-review rows a forced rescan re-tests. An exact hit replaces the stored proposal;
    // otherwise they join the residuals and are re-scored by the fuzzy tier like fresh items.
    const toUpgrade: AbsMatchInput[] = [];
    // Skipped rows still get their ABS context (library, series, path) refreshed: matching writes it
    // through the upsert, but settled rows never reach the upsert again.
    const skippedWithState: AbsMatchInput[] = [];
    for (const item of items) {
      const state = stateByItemId.get(item.absLibraryItemId);
      if (state) {
        // Linked (auto/manual/confirmed) or pending review already carries a bookId. Settled rows stay
        // untouched; a pending-review proposal is re-tested only under force, and only exactly.
        if (state.bookId != null || state.matchMethod === 'manual') {
          if (options.force && state.bookId != null && state.needsReview && !USER_BLESSED_MATCH_METHODS.has(state.matchMethod ?? '')) {
            toUpgrade.push(item);
          } else {
            summary.skipped++;
            skippedWithState.push(item);
          }
          continue;
        }
        if (!options.force && state.manualUnlinked) {
          summary.skipped++;
          skippedWithState.push(item);
          continue;
        }
        if (!options.force && state.lastMatchAttemptAt) {
          if (changedAtMemo.value === undefined) changedAtMemo.value = await this.repo.findLibraryChangedAt(accessibleLibraryIds);
          const unchanged = !changedAtMemo.value || state.lastMatchAttemptAt.getTime() >= changedAtMemo.value.getTime();
          if (unchanged) {
            summary.skipped++;
            skippedWithState.push(item);
            continue;
          }
        }
      }
      toMatch.push(item);
    }

    await this.repo.refreshAbsContext(
      user.id,
      skippedWithState.map((item) => ({
        absLibraryItemId: item.absLibraryItemId,
        absSeriesName: item.seriesName,
        absLibraryName: item.libraryName,
        absPath: item.path,
      })),
    );

    summary.processed = toMatch.length + toUpgrade.length;
    if (toMatch.length === 0 && toUpgrade.length === 0) {
      this.logger.log(
        `[abs.match] [end] userId=${user.id} trigger=${options.force ? 'rescan' : 'incremental'} durationMs=${Date.now() - startedAt} totalItems=${summary.totalItems} processed=0 skipped=${summary.skipped} - nothing to match`,
      );
      return summary;
    }

    // Both passes read the same exact-tier lookups, so the keys are collected once across them.
    const exactCandidates = toUpgrade.length > 0 ? [...toMatch, ...toUpgrade] : toMatch;
    const asins = [...new Set(exactCandidates.map((item) => normalizeAsin(item.asin)).filter((value): value is string => Boolean(value)))];
    const isbns = [...new Set(exactCandidates.map((item) => normalizeIsbn(item.isbn)).filter((value): value is string => Boolean(value)))];
    const asinMap = groupByKey(asins.length ? await this.repo.findBookIdsByAudibleIds(accessibleLibraryIds, contentFilters, asins) : []);
    const isbnMap = groupByKey(isbns.length ? await this.repo.findBookIdsByIsbns(accessibleLibraryIds, contentFilters, isbns) : []);

    // Path tier inputs. Only items a configured mapping actually covers get a candidate BookOrbit
    // path, so with no mappings (or no path on the item) the tier costs no query and is skipped.
    const plannerMappings = toPlannerPathMappings(options.pathMappings);
    const localPathByItemId = new Map<string, string>();
    if (plannerMappings.length > 0) {
      for (const item of exactCandidates) {
        const localPath = mapAbsItemPath(item.path, plannerMappings);
        if (localPath) localPathByItemId.set(item.absLibraryItemId, localPath);
      }
    }
    const pathMap = groupByKey(
      localPathByItemId.size > 0
        ? await this.repo.findBookIdsByPaths(accessibleLibraryIds, contentFilters, [...new Set(localPathByItemId.values())])
        : [],
    );

    const now = new Date();
    const upserts: AbsBookStateUpsert[] = [];
    const residuals: AbsMatchInput[] = [];
    const baseFor = (item: AbsMatchInput) => ({
      absLibraryItemId: item.absLibraryItemId,
      absTitle: item.title,
      absAuthorName: item.author,
      absSeriesName: item.seriesName,
      absLibraryName: item.libraryName,
      absPath: item.path,
      lastMatchAttemptAt: now,
    });

    const exactMatchFor = (item: AbsMatchInput) =>
      this.findExactMatch(item, asinMap, isbnMap, pathMap, localPathByItemId.get(item.absLibraryItemId) ?? null);
    const linkUpsert = (item: AbsMatchInput, hit: { bookId: number; method: string }): AbsBookStateUpsert => ({
      ...baseFor(item),
      bookId: hit.bookId,
      matchMethod: hit.method,
      matchConfidence: 100,
      needsReview: false,
      matchError: null,
    });

    for (const item of toMatch) {
      const hit = exactMatchFor(item);
      if (!hit) {
        residuals.push(item);
        continue;
      }
      if ('bookId' in hit) {
        upserts.push(linkUpsert(item, hit));
        summary.autoLinked++;
      } else {
        upserts.push({
          ...baseFor(item),
          bookId: null,
          matchMethod: null,
          matchConfidence: null,
          needsReview: false,
          matchError: hit.ambiguousError,
        });
        summary.errors++;
      }
    }

    // A forced rescan re-evaluates pending-review rows exactly like fresh items: an exact identity
    // hit outranks and replaces the stored fuzzy proposal, and otherwise the fuzzy tier re-runs so a
    // proposal that no longer qualifies (scoring changes, library changes) is replaced or cleared
    // instead of lingering. Manual links and already-confirmed rows never reach here.
    for (const item of toUpgrade) {
      const hit = exactMatchFor(item);
      if (!hit) {
        residuals.push(item);
        continue;
      }
      if ('bookId' in hit) {
        upserts.push(linkUpsert(item, hit));
        summary.autoLinked++;
        summary.upgradedFromReview++;
      } else {
        upserts.push({
          ...baseFor(item),
          bookId: null,
          matchMethod: null,
          matchConfidence: null,
          needsReview: false,
          matchError: hit.ambiguousError,
        });
        summary.errors++;
      }
    }

    if (residuals.length > 0) {
      const fuzzyTitles = residuals.filter((item) => item.title?.trim() && item.author?.trim()).map((item) => item.title!.trim());
      const candidatesByTitle = fuzzyTitles.length
        ? await this.repo.findFuzzyCandidatesForTitles(accessibleLibraryIds, contentFilters, fuzzyTitles, FUZZY_CANDIDATE_LIMIT)
        : new Map<string, AbsFuzzyCandidate[]>();

      for (const item of residuals) {
        const base = baseFor(item);
        const candidates = item.title?.trim() ? (candidatesByTitle.get(item.title.trim()) ?? []) : [];
        const fuzzy = this.scoreFuzzy(item, candidates);
        if (fuzzy === 'ambiguous') {
          upserts.push({ ...base, bookId: null, matchMethod: null, matchConfidence: null, needsReview: false, matchError: 'ambiguous_fuzzy' });
          summary.errors++;
        } else if (fuzzy) {
          upserts.push({
            ...base,
            bookId: fuzzy.bookId,
            matchMethod: 'title_author_series',
            matchConfidence: fuzzy.confidence,
            needsReview: true,
            matchError: null,
          });
          summary.needsReview++;
        } else {
          upserts.push({ ...base, bookId: null, matchMethod: null, matchConfidence: null, needsReview: false, matchError: null });
          summary.unmatched++;
        }
      }
    }

    // A page of nothing but untouched review rows writes nothing at all.
    if (upserts.length > 0) await this.repo.bulkUpsertBookStates(user.id, upserts, readAt);
    this.logger.log(
      `[abs.match] [end] userId=${user.id} trigger=${options.force ? 'rescan' : 'incremental'} durationMs=${Date.now() - startedAt} totalItems=${summary.totalItems} processed=${summary.processed} autoLinked=${summary.autoLinked} upgradedFromReview=${summary.upgradedFromReview} needsReview=${summary.needsReview} unmatched=${summary.unmatched} errors=${summary.errors} skipped=${summary.skipped} - match completed`,
    );
    return summary;
  }

  /**
   * ASIN before ISBN before path: the cascade order is load-bearing. ASIN is the highest-precedence
   * exact tier, and a shared-storage path match only decides items the published identifiers could
   * not. The first tier holding the item's key answers, even when it holds several books - a shared
   * key is reported as ambiguous rather than falling through to a weaker tier.
   */
  private findExactMatch(
    item: AbsMatchInput,
    asinMap: Map<string, Set<number>>,
    isbnMap: Map<string, Set<number>>,
    pathMap: Map<string, Set<number>>,
    localPath: string | null,
  ): AbsExactHit | null {
    const exactTiers: Array<[key: string | null, map: Map<string, Set<number>>, method: string, ambiguousError: string]> = [
      [normalizeAsin(item.asin), asinMap, 'asin', 'ambiguous_asin'],
      [normalizeIsbn(item.isbn), isbnMap, 'isbn', 'ambiguous_isbn'],
      [localPath, pathMap, 'path', 'ambiguous_path'],
    ];

    for (const [key, map, method, ambiguousError] of exactTiers) {
      const bookIds = key ? map.get(key) : undefined;
      if (!bookIds) continue;
      if (bookIds.size === 1) return { bookId: bookIds.values().next().value!, method };
      return { ambiguousError };
    }
    return null;
  }

  /**
   * Pure scoring over already-loaded candidates. Returns the single best pick, `'ambiguous'` when the
   * top two are within `FUZZY_AMBIGUITY_MARGIN` (leave for human review, never auto-suggest), or null
   * when nothing clears the thresholds.
   */
  private scoreFuzzy(item: AbsMatchInput, candidates: AbsFuzzyCandidate[]): { bookId: number; confidence: number } | 'ambiguous' | null {
    if (!item.title?.trim() || !item.author?.trim() || candidates.length === 0) return null;

    const scored = candidates
      .map((candidate) => {
        const titleScore = candidate.title && !titleVolumeConflict(item.title!, candidate.title) ? scoreTitle(item.title!, candidate.title) : 0;
        const authorScore = candidate.authors.length ? scoreAuthors([item.author!], candidate.authors) : 0;
        const seriesScore = item.seriesName ? this.scoreSeries(item.seriesName, candidate.series) : 0;
        const base = titleScore * 0.7 + authorScore * 0.3;
        const combined = Math.min(1, seriesScore > 0 ? base + seriesScore * SERIES_BONUS_WEIGHT : base);
        return { bookId: candidate.bookId, titleScore, authorScore, confidence: Math.round(combined * 100) };
      })
      .filter((row) => row.titleScore >= FUZZY_TITLE_MIN && row.authorScore >= FUZZY_AUTHOR_MIN && row.confidence >= FUZZY_ACCEPT_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence || a.bookId - b.bookId);

    const best = scored[0];
    if (!best) return null;
    const runnerUp = scored[1];
    if (runnerUp && best.confidence - runnerUp.confidence < FUZZY_AMBIGUITY_MARGIN) return 'ambiguous';
    return { bookId: best.bookId, confidence: best.confidence };
  }

  private scoreSeries(absSeriesName: string, memberships: AbsFuzzyCandidateSeries[]): number {
    const parsed = parseAbsSeries(absSeriesName);
    const absName = parsed.name ? normalizeName(parsed.name) : '';
    if (!absName || memberships.length === 0) return 0;

    let best = 0;
    for (const membership of memberships) {
      const localName = normalizeName(membership.name);
      if (!localName) continue;
      const nameScore = localName === absName ? 1 : Math.max(tokenOverlap(localName, absName), normalizedLevenshtein(localName, absName));
      if (nameScore < SERIES_NAME_MIN) continue;
      let score = nameScore * 0.7;
      const membershipIndex = membership.seriesIndex != null ? Number.parseFloat(membership.seriesIndex) : null;
      if (
        parsed.sequence != null &&
        membershipIndex != null &&
        Number.isFinite(membershipIndex) &&
        Math.abs(parsed.sequence - membershipIndex) < 0.001
      ) {
        score += 0.3;
      }
      best = Math.max(best, score);
    }
    return best;
  }

  /**
   * Stream the selected ABS inventory one bounded page at a time, invoking `onPage` per page so the
   * whole remote library is never held in memory at once.
   */
  private async forEachInventoryPage(
    userId: number,
    serverUrl: string,
    token: string,
    excludedLibraryIds: string[],
    onPage: (items: AbsMatchInput[]) => Promise<void>,
  ): Promise<void> {
    const { libraries } = await this.client.getLibraries(userId, serverUrl, token);
    const excluded = new Set(excludedLibraryIds);
    const bookLibraries = libraries.filter((library) => library.mediaType === 'book' && !excluded.has(library.id));

    for (const library of bookLibraries) {
      let page = 0;
      while (true) {
        const response = await this.client.getLibraryItems(userId, serverUrl, token, library.id, { limit: ABS_LIBRARY_ITEMS_PAGE_SIZE, page });
        const items = response.results.map((item) => this.toMatchInput(item, library.name));
        if (items.length > 0) await onPage(items);
        // Actual items retrieved so far: every prior page in this loop was full-size (or the loop would
        // already have exited), so this is exact, not an estimate.
        const fetched = page * ABS_LIBRARY_ITEMS_PAGE_SIZE + response.results.length;
        const total = Number.isFinite(response.total) ? response.total : null;
        if (response.results.length < ABS_LIBRARY_ITEMS_PAGE_SIZE) {
          // A short page normally ends the library, but only when `total` agrees there is nothing left
          // to fetch: a short page while `total` says more remain means the server under-delivered this
          // page, and treating that as the end would make the cleanup delete every unwalked item.
          if (total != null && fetched < total) {
            throw new ServiceUnavailableException(`Audiobookshelf returned an incomplete page for library ${library.id}`);
          }
          break;
        }
        if (total != null && fetched >= total) break;
        page++;
      }
    }
  }

  private toMatchInput(item: AbsLibraryItem, libraryName: string | null): AbsMatchInput {
    const metadata = item.media?.metadata;
    return {
      absLibraryItemId: item.id,
      asin: metadata?.asin ?? null,
      isbn: metadata?.isbn ?? null,
      title: metadata?.title ?? null,
      author: metadata?.authorName ?? null,
      seriesName: metadata?.seriesName ?? null,
      path: item.path ?? null,
      libraryName,
    };
  }
}
