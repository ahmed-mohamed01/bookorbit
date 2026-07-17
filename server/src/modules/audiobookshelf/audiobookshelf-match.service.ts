import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { AudiobookshelfRescanResult, ContentFilterRules } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { normalizeIsbn, normalizeName, normalizedLevenshtein, scoreAuthors, scoreTitle, tokenOverlap } from '../../common/utils/book-match.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { LibraryService } from '../library/library.service';
import { AudiobookshelfClientService, type AbsLibraryItem } from './audiobookshelf-client.service';
import { AudiobookshelfRepository, type AbsBookStateUpsert, type AbsExactMatchRow, type AbsFuzzyCandidateSeries } from './audiobookshelf.repository';

export interface AbsMatchInput {
  absLibraryItemId: string;
  asin: string | null;
  isbn: string | null;
  title: string | null;
  author: string | null;
  seriesName: string | null;
}

export interface AudiobookshelfMatchSummary {
  totalItems: number;
  processed: number;
  autoLinked: number;
  needsReview: number;
  unmatched: number;
  errors: number;
  skipped: number;
  pruned: number;
}

const FUZZY_CANDIDATE_LIMIT = 20;
const FUZZY_TITLE_MIN = 0.8;
const FUZZY_AUTHOR_MIN = 0.7;
const FUZZY_ACCEPT_CONFIDENCE = 84;
const SERIES_NAME_MIN = 0.6;
const SERIES_BONUS_WEIGHT = 0.1;
const ABS_LIBRARY_ITEMS_PAGE_SIZE = 500;

interface ParsedSeries {
  name: string | null;
  sequence: number | null;
}

function parseAbsSeries(seriesName: string | null): ParsedSeries {
  if (!seriesName) return { name: null, sequence: null };
  const first = seriesName.split(',')[0]?.trim() ?? '';
  if (!first) return { name: null, sequence: null };
  const match = first.match(/^(.*?)\s*#\s*([\d.]+)\s*$/);
  if (match) {
    const sequence = Number.parseFloat(match[2]!);
    return { name: match[1]!.trim() || null, sequence: Number.isFinite(sequence) ? sequence : null };
  }
  return { name: first, sequence: null };
}

function normalizeAsin(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly client: AudiobookshelfClientService,
    private readonly libraryService: LibraryService,
  ) {}

  async rescan(user: RequestUser): Promise<AudiobookshelfRescanResult> {
    const settings = await this.repo.findSettings(user.id);
    if (!settings || !settings.enabled || !settings.serverUrl || !settings.apiToken) {
      throw new BadRequestException('Audiobookshelf sync is not configured');
    }

    const startedAt = Date.now();
    this.logger.log(`[abs.match] [start] userId=${user.id} trigger=rescan - library rescan started`);
    try {
      const summary = await this.matchLibrary(user, settings.serverUrl, settings.apiToken, { force: true });
      this.logger.log(
        `[abs.match] [end] userId=${user.id} trigger=rescan durationMs=${Date.now() - startedAt} totalItems=${summary.totalItems} autoLinked=${summary.autoLinked} needsReview=${summary.needsReview} unmatched=${summary.unmatched} errors=${summary.errors} skipped=${summary.skipped} pruned=${summary.pruned} - library rescan completed`,
      );
      return { queued: summary.processed };
    } catch (err) {
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(
        `[abs.match] [fail] userId=${user.id} trigger=rescan durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${error}" - library rescan failed`,
      );
      throw err;
    }
  }

  async matchLibrary(user: RequestUser, serverUrl: string, token: string, options: { force: boolean }): Promise<AudiobookshelfMatchSummary> {
    const items = await this.fetchMatchInputs(user.id, serverUrl, token);
    const summary = await this.matchItems(user, items, options);
    if (items.length === 0) {
      this.logger.warn(
        `[abs.match] [end] userId=${user.id} trigger=${options.force ? 'rescan' : 'incremental'} inventoryEmpty=true pruned=0 - empty ABS inventory, prune skipped to protect existing links`,
      );
      return summary;
    }
    summary.pruned = await this.repo.deleteBookStatesNotIn(
      user.id,
      items.map((item) => item.absLibraryItemId),
    );
    return summary;
  }

  async matchItems(user: RequestUser, items: AbsMatchInput[], options: { force: boolean }): Promise<AudiobookshelfMatchSummary> {
    const summary: AudiobookshelfMatchSummary = {
      totalItems: items.length,
      processed: 0,
      autoLinked: 0,
      needsReview: 0,
      unmatched: 0,
      errors: 0,
      skipped: 0,
      pruned: 0,
    };
    if (items.length === 0) return summary;

    const startedAt = Date.now();
    const accessibleLibraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;

    const existing = await this.repo.findBookStatesByAbsItemIds(
      user.id,
      items.map((item) => item.absLibraryItemId),
    );
    const stateByItemId = new Map(existing.map((state) => [state.absLibraryItemId, state]));

    let libraryChangedAt: Date | null | undefined;
    const toMatch: AbsMatchInput[] = [];
    for (const item of items) {
      const state = stateByItemId.get(item.absLibraryItemId);
      if (state) {
        // Linked (auto/manual/confirmed) or pending review already carries a bookId - leave it untouched.
        if (state.bookId != null || state.matchMethod === 'manual') {
          summary.skipped++;
          continue;
        }
        if (!options.force && state.lastMatchAttemptAt) {
          if (libraryChangedAt === undefined) libraryChangedAt = await this.repo.findLibraryChangedAt(accessibleLibraryIds);
          const unchanged = !libraryChangedAt || state.lastMatchAttemptAt.getTime() >= libraryChangedAt.getTime();
          if (unchanged) {
            summary.skipped++;
            continue;
          }
        }
      }
      toMatch.push(item);
    }

    summary.processed = toMatch.length;
    if (toMatch.length === 0) {
      this.logger.log(
        `[abs.match] [end] userId=${user.id} trigger=${options.force ? 'rescan' : 'incremental'} durationMs=${Date.now() - startedAt} totalItems=${summary.totalItems} processed=0 skipped=${summary.skipped} - nothing to match`,
      );
      return summary;
    }

    const asins = [...new Set(toMatch.map((item) => normalizeAsin(item.asin)).filter((value): value is string => Boolean(value)))];
    const isbns = [...new Set(toMatch.map((item) => normalizeIsbn(item.isbn)).filter((value): value is string => Boolean(value)))];
    const asinMap = groupByKey(asins.length ? await this.repo.findBookIdsByAudibleIds(accessibleLibraryIds, contentFilters, asins) : []);
    const isbnMap = groupByKey(isbns.length ? await this.repo.findBookIdsByIsbns(accessibleLibraryIds, contentFilters, isbns) : []);

    const now = new Date();
    const upserts: AbsBookStateUpsert[] = [];
    for (const item of toMatch) {
      const base = { absLibraryItemId: item.absLibraryItemId, absTitle: item.title, absAuthorName: item.author, lastMatchAttemptAt: now };

      const asin = normalizeAsin(item.asin);
      if (asin && asinMap.has(asin)) {
        const bookIds = asinMap.get(asin)!;
        if (bookIds.size === 1) {
          upserts.push({
            ...base,
            bookId: bookIds.values().next().value!,
            matchMethod: 'asin',
            matchConfidence: 100,
            needsReview: false,
            matchError: null,
          });
          summary.autoLinked++;
        } else {
          upserts.push({ ...base, bookId: null, matchMethod: null, matchConfidence: null, needsReview: false, matchError: 'ambiguous_asin' });
          summary.errors++;
        }
        continue;
      }

      const isbn = normalizeIsbn(item.isbn);
      if (isbn && isbnMap.has(isbn)) {
        const bookIds = isbnMap.get(isbn)!;
        if (bookIds.size === 1) {
          upserts.push({
            ...base,
            bookId: bookIds.values().next().value!,
            matchMethod: 'isbn',
            matchConfidence: 100,
            needsReview: false,
            matchError: null,
          });
          summary.autoLinked++;
        } else {
          upserts.push({ ...base, bookId: null, matchMethod: null, matchConfidence: null, needsReview: false, matchError: 'ambiguous_isbn' });
          summary.errors++;
        }
        continue;
      }

      const fuzzy = await this.matchFuzzy(item, accessibleLibraryIds, contentFilters);
      if (fuzzy) {
        upserts.push({
          ...base,
          bookId: fuzzy.bookId,
          matchMethod: 'title_author_series',
          matchConfidence: fuzzy.confidence,
          needsReview: true,
          matchError: null,
        });
        summary.needsReview++;
        continue;
      }

      upserts.push({ ...base, bookId: null, matchMethod: null, matchConfidence: null, needsReview: false, matchError: null });
      summary.unmatched++;
    }

    await this.repo.bulkUpsertBookStates(user.id, upserts);
    this.logger.log(
      `[abs.match] [end] userId=${user.id} trigger=${options.force ? 'rescan' : 'incremental'} durationMs=${Date.now() - startedAt} totalItems=${summary.totalItems} processed=${summary.processed} autoLinked=${summary.autoLinked} needsReview=${summary.needsReview} unmatched=${summary.unmatched} errors=${summary.errors} skipped=${summary.skipped} - match completed`,
    );
    return summary;
  }

  private async matchFuzzy(
    item: AbsMatchInput,
    libraryIds: number[],
    contentFilters: ContentFilterRules | undefined,
  ): Promise<{ bookId: number; confidence: number } | null> {
    if (!item.title?.trim() || !item.author?.trim()) return null;
    const candidates = await this.repo.findFuzzyCandidates(libraryIds, contentFilters, item.title, FUZZY_CANDIDATE_LIMIT);
    if (candidates.length === 0) return null;

    const scored = candidates
      .map((candidate) => {
        const titleScore = candidate.title ? scoreTitle(item.title!, candidate.title) : 0;
        const authorScore = candidate.authors.length ? scoreAuthors([item.author!], candidate.authors) : 0;
        const seriesScore = item.seriesName ? this.scoreSeries(item.seriesName, candidate.series) : 0;
        const base = titleScore * 0.7 + authorScore * 0.3;
        const combined = Math.min(1, seriesScore > 0 ? base + seriesScore * SERIES_BONUS_WEIGHT : base);
        return { bookId: candidate.bookId, titleScore, authorScore, confidence: Math.round(combined * 100) };
      })
      .filter((row) => row.titleScore >= FUZZY_TITLE_MIN && row.authorScore >= FUZZY_AUTHOR_MIN && row.confidence >= FUZZY_ACCEPT_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence || a.bookId - b.bookId);

    const best = scored[0];
    return best ? { bookId: best.bookId, confidence: best.confidence } : null;
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
      if (parsed.sequence != null && membership.seriesIndex != null && Math.abs(parsed.sequence - membership.seriesIndex) < 0.001) {
        score += 0.3;
      }
      best = Math.max(best, score);
    }
    return best;
  }

  private async fetchMatchInputs(userId: number, serverUrl: string, token: string): Promise<AbsMatchInput[]> {
    const { libraries } = await this.client.getLibraries(userId, serverUrl, token);
    const bookLibraries = libraries.filter((library) => library.mediaType === 'book');
    const inputs: AbsMatchInput[] = [];

    for (const library of bookLibraries) {
      let page = 0;
      while (true) {
        const response = await this.client.getLibraryItems(userId, serverUrl, token, library.id, { limit: ABS_LIBRARY_ITEMS_PAGE_SIZE, page });
        for (const item of response.results) inputs.push(this.toMatchInput(item));
        const fetched = (page + 1) * ABS_LIBRARY_ITEMS_PAGE_SIZE;
        if (response.results.length < ABS_LIBRARY_ITEMS_PAGE_SIZE || fetched >= response.total) break;
        page++;
      }
    }

    return inputs;
  }

  private toMatchInput(item: AbsLibraryItem): AbsMatchInput {
    const metadata = item.media?.metadata;
    return {
      absLibraryItemId: item.id,
      asin: metadata?.asin ?? null,
      isbn: metadata?.isbn ?? null,
      title: metadata?.title ?? null,
      author: metadata?.authorName ?? null,
      seriesName: metadata?.seriesName ?? null,
    };
  }
}
