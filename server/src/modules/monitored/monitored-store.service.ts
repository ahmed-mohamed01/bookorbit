import { assertOffsetWithinLimit } from '../../common/constants/pagination.constants';
import { randomUUID } from 'node:crypto';

import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type {
  MonitoredFetchState,
  MonitoredFetchErrorKind,
  MonitoredClassSelection,
  MonitoredDisplayClassCounts,
  MonitoredMarkKind,
  MonitoredReviewFlag,
  MonitoredAuthorConfig,
  MonitoredAuthorListSort,
  MonitoredBookEntry,
  MonitoredBookListSort,
  MonitoredBulkWorkPatch,
  MonitoredCatalogSearchHit,
  MonitoredFormat,
  MonitoredMatchHolder,
  MonitoredListOrder,
  MonitoredMatchDecision,
  MonitoredPossibleMatch,
  MonitoredReleaseFilter,
  MonitoredReleaseListSort,
  MonitoredReleaseCardCounts,
  MonitoredStatusFilter,
  MonitoredSummary,
  MonitoredWork,
  MonitoredWorkPatch,
  MonitoredWorkRating,
  MonitoredWorkSearchItem,
  BookRequestStatus,
} from '@bookorbit/types';
import { countWorkClasses, isDefaultClassSelection, MONITORED_ACQUISITION_STATE_BY_REQUEST_STATUS } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { accentInsensitiveIlike, buildSearchPattern, escapeLikePattern } from '../../common/utils/accent-insensitive-search.utils';
import { chunk } from '../../common/utils/batch.utils';
import { normalizeMetadataText } from '../../common/utils/metadata-text-normalize.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { applySchemaStatements, findMissingTables } from '../../common/utils/schema-bootstrap.utils';
import { dueForAutomaticFetchSql } from './monitored-fetch-due';
import { identityLikePattern, identityLikeRun, normalizeMonitoredName, titleAuthorKey } from './monitored-text.utils';
import { enrolReleaseProbes, reapplyReleaseOverlay } from './monitored-release-probe-store.service';
import { recordChoiceLedger, restoreChoiceLedger } from './monitored-choice-ledger';
import { recordRequestLedger, restoreRequestLedger, workProviderKeysSql } from './monitored-request-ledger';
import {
  activeWorkCondition,
  bookClassSql,
  classSelectionMatchSql,
  releaseRangeOverlapsSql,
  unconfirmedWorkSql,
  visibleWorkCondition,
  workClassKeySql,
} from './monitored-work-conditions';
export { releaseRangeOverlapsSql } from './monitored-work-conditions';
import { DB } from '../../db';
import * as dbSchema from '../../db/schema';
import { books as upstreamBooks } from '../../db/schema';
import { LibraryService } from '../library/library.service';
import * as schema from './schema/monitored.schema';
import type { AuthorCatalogWorkRow, MonitoredAuthorRow, MonitoredAuthorWorkRow, MonitoredMatchOverrideRow } from './schema/monitored.schema';

const WRITE_BATCH_SIZE = 250;
/** The OR arms the identity prefilter may spend on one candidate list, so a query stays bounded. */
const IDENTITY_LIKE_MAX_RUNS = 10;

function storedRatings(sources: Array<typeof schema.authorCatalogSourceWorks.$inferSelect>): { ratings?: MonitoredWorkRating[] } {
  const ratings = sources.flatMap((source) =>
    source.ratingAverage != null
      ? [{ source: source.source as MonitoredWorkRating['source'], average: source.ratingAverage, count: source.ratingCount }]
      : [],
  );
  return ratings.length > 0 ? { ratings } : {};
}

export interface MonitoredCatalog {
  works: MonitoredWork[];
  fetchedAt: string;
}

export interface MonitoredWorkEntry {
  monitor: MonitoredAuthorConfig;
  work: MonitoredWork;
}

/** One work and format whose release window has opened and which the owner has not been told about. */
export interface MonitoredDueRelease extends Record<string, unknown> {
  workId: string;
  title: string;
  identityKeys: string[];
  seriesName: string | null;
  seriesIndex: string | null;
  format: MonitoredFormat;
  /** The first day the release window covers, already resolved from the stored date's precision. */
  releaseDate: string;
  /**
   * The date exactly as the catalog holds it - '2026', '2026-09' or '2026-09-10'. `releaseDate`
   * resolves a coarse date to its first day so it can be compared, which is right for the ledger and
   * wrong for prose: telling somebody a book "released on 2026-01-01" when all we know is the year
   * invents a day we were never given.
   */
  storedDate: string;
  /** True when a ledger row already exists, i.e. this is a retry of a dispatch that failed. */
  claimed: boolean;
}

export interface MonitoredAuthorAggregate {
  counts: {
    total: number;
    ebookOwned: number;
    audioOwned: number;
    hidden: number;
  };
  nextReleaseAt: string | null;
}

export interface MonitoredAuthorPageEntry {
  author: MonitoredAuthorConfig;
  aggregate: MonitoredAuthorAggregate;
}

export interface MonitoredBookPageEntry {
  entry: MonitoredBookEntry;
  authorName: string;
  work: MonitoredWork;
}

export interface MonitoredReleasePageEntry {
  monitor: MonitoredAuthorConfig;
  work: MonitoredWork;
  format: MonitoredFormat;
  releaseDate: string | null;
}

export type MonitoredCounts = Pick<MonitoredSummary, 'authors' | 'books' | 'releases' | 'releaseCards'>;

interface ReleasePageRef extends Record<string, unknown> {
  workId: string;
  monitorAuthorId: string;
  format: MonitoredFormat;
  releaseDate: string | null;
}

interface RequestProjection {
  id: number;
  status: BookRequestStatus;
  matchedBookId: number | null;
}

/** A per-format alias of the release probe table, so one query can read both formats' probes. */
function releaseProbeAlias(name: string) {
  const column = (field: string) => sql<string>`${sql.identifier(name)}.${sql.identifier(field)}`;
  return {
    status: column('status'),
    releaseDate: column('release_date'),
    datePrecision: column('date_precision'),
    join: (format: MonitoredFormat) => sql`left join ${schema.authorCatalogWorkReleases} as ${sql.identifier(name)}
        on ${column('work_id')} = ${schema.authorCatalogWorks.id}
        and ${column('format')} = ${format}`,
  };
}
type ReleaseProbeAlias = ReturnType<typeof releaseProbeAlias>;

type AuthorWrite = Omit<MonitoredAuthorConfig, 'id' | 'fetch'> & {
  id?: string;
  fetchState?: MonitoredFetchState;
  lastReleaseCheckAt?: string | null;
};
type AuthorFields = Partial<Omit<MonitoredAuthorConfig, 'id'>>;
type BookWrite = Omit<MonitoredBookEntry, 'id'> & { id?: string };
type Db = NodePgDatabase<typeof dbSchema>;
type DbSnapshot = Parameters<Parameters<Db['transaction']>[0]>[0];
type WorkStatePatch = MonitoredWorkPatch & {
  monitorState?: MonitoredWork['monitorState'];
  requestIds?: MonitoredWork['requestIds'];
};

/** What owned-matching decides about a work: system truth, never the owner's overlay. */
type WorkMatchUpdate = Pick<
  MonitoredWork,
  'matchedBookId' | 'matchedBookIds' | 'ownedFormats' | 'linkedFormats' | 'answeredFormats' | 'possibleMatches'
>;

/** One answer as the override table stores it: a book for a link or a rejection, none to go back to automatic. */
export type StoredMatchAnswer = { decision: 'automatic' } | { decision: Exclude<MonitoredMatchDecision, 'automatic'>; bookId: number };

type OverlayStatePatch = Pick<MonitoredWorkPatch, 'hidden' | 'automaticVisibility' | 'kind'>;

/**
 * The visibility and mark columns one patch writes, shared by the single and bulk routes. `values`
 * is what a fresh overlay row gets; `conflictSet` overrides the columns an existing row must decide
 * from what it already holds:
 * - a mark other than Book drops a kept choice, so the work really goes to review, but never a hidden one;
 * - Keep drops a mark other than Book, so the kept work shows;
 * - back to automatic drops the mark too, except on unhide, where the work was hidden and its mark stays.
 */
function overlayStateWrite(patch: OverlayStatePatch) {
  const overlay = schema.monitoredAuthorWorks;
  const marksForReview = patch.kind !== undefined && patch.kind !== 'book' && patch.hidden === undefined;
  const keeps = patch.hidden === false && patch.kind === undefined;
  const values = {
    ...(patch.hidden !== undefined ? { userVisibility: patch.hidden ? ('hidden' as const) : ('visible' as const) } : {}),
    ...(patch.kind !== undefined ? { userKind: patch.kind } : {}),
    ...(marksForReview ? { userVisibility: null } : {}),
    ...(keeps ? { userKind: null } : {}),
    ...(patch.automaticVisibility === true ? { userVisibility: null, userKind: null } : {}),
  };
  const conflictSet: Partial<Record<'userVisibility' | 'userKind', SQL>> = {};
  if (patch.hidden !== undefined || patch.automaticVisibility === true) conflictSet.userVisibility = sql`excluded.user_visibility`;
  if (marksForReview) {
    conflictSet.userVisibility = sql`case when ${overlay.userVisibility} = 'visible' then null else ${overlay.userVisibility} end`;
  }
  if (patch.kind !== undefined) conflictSet.userKind = sql`excluded.user_kind`;
  if (keeps) conflictSet.userKind = sql`case when ${overlay.userKind} = 'book' then ${overlay.userKind} else null end`;
  if (patch.automaticVisibility === true) {
    conflictSet.userKind = sql`case when ${overlay.userVisibility} = 'hidden' then ${overlay.userKind} else null end`;
  }
  return { values, conflictSet };
}

export function releaseEventKey(workId: string, format: MonitoredFormat): string {
  return `${workId}:${format}`;
}

/** Where a release sits Released rather than Upcoming; the cards view cuts its sections at the same UTC date. */
function releasedBySql(date: AnyPgColumn | SQL, today: string): SQL {
  return sql`${date} <= ${today}`;
}

function releaseRangeStartSql(date: AnyPgColumn | SQL, precision: AnyPgColumn | SQL) {
  const effective = sql`case when ${precision} is not null then ${precision} when length(${date}) = 4 then 'year' when length(${date}) = 7 then 'month' else 'day' end`;
  return sql<string>`case ${effective} when 'year' then ${date} || '-01-01' when 'month' then ${date} || '-01' else ${date} end`;
}

const PARTIAL_RELEASE_DATE_PATTERN = '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$';

/**
 * The SQL twin of `monitoredReleaseStarted`: true only for a well-formed value whose window has
 * opened, so a malformed or too-short value is never "released" and reads as still to come.
 */
function releaseStartedSql(date: SQL, precision: SQL, today: string): SQL<boolean> {
  const value = sql`btrim(${date})`;
  const effective = sql`coalesce(${precision}, case when length(${value}) = 4 then 'year' when length(${value}) = 7 then 'month' else 'day' end)`;
  return sql<boolean>`coalesce(
    ${value} ~ ${PARTIAL_RELEASE_DATE_PATTERN}
    and case ${effective}
      when 'year' then left(${value}, 4) || '-01-01' <= ${today}
      when 'month' then length(${value}) >= 7 and left(${value}, 7) || '-01' <= ${today}
      else length(${value}) = 10 and ${value} <= ${today}
    end,
    false
  )`;
}

const REQUEST_STATUSES = Object.keys(MONITORED_ACQUISITION_STATE_BY_REQUEST_STATUS) as BookRequestStatus[];
const IN_PROGRESS_REQUEST_STATUSES = REQUEST_STATUSES.filter((status) => {
  const state = MONITORED_ACQUISITION_STATE_BY_REQUEST_STATUS[status];
  return state !== null && state !== 'needs_review';
});
const ATTENTION_REQUEST_STATUSES: BookRequestStatus[] = [
  ...REQUEST_STATUSES.filter((status) => MONITORED_ACQUISITION_STATE_BY_REQUEST_STATUS[status] === 'needs_review'),
  'failed',
];

function sqlList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function releaseDueSql(date: AnyPgColumn, precision: AnyPgColumn, addedDay: string, today: string) {
  const effective = sql`case when ${precision} is not null then ${precision} when length(${date}) = 4 then 'year' when length(${date}) = 7 then 'month' else 'day' end`;
  const rangeStart = sql<string>`case ${effective} when 'year' then ${date} || '-01-01' when 'month' then ${date} || '-01' else ${date} end`;
  const rangeEnd = sql<string>`case ${effective} when 'year' then ${date} || '-12-31' when 'month' then ${date} || '-31' else ${date} end`;
  // Strict comparison with lexical padding makes coarse dates due on the day after their real range ends.
  return sql<boolean>`case when ${effective} = 'day' then ${rangeStart} <= ${today} else ${rangeEnd} < ${today} end and ${rangeEnd} >= ${addedDay}`;
}

export type MonitoredWorkSearchRow = Omit<MonitoredWorkSearchItem, 'isOwner'> & { ownerUserId: number };

@Injectable()
export class MonitoredStoreService {
  private readonly logger = new Logger(MonitoredStoreService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly libraries: LibraryService,
  ) {}

  async findMissingTables(tableNames: readonly string[]): Promise<string[]> {
    return findMissingTables(this.db, tableNames);
  }

  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    return applySchemaStatements(this.db, statements);
  }

  async findAuthorPage(params: {
    viewer: RequestUser;
    q?: string;
    page: number;
    size: number;
    sort: MonitoredAuthorListSort;
    order: MonitoredListOrder;
    today: string;
  }): Promise<{ items: MonitoredAuthorPageEntry[]; total: number; page: number; size: number }> {
    assertOffsetWithinLimit(params.page, params.size);
    const { viewer } = params;
    const scope = this.readScope(viewer, schema.monitoredAuthors.ownerUserId);
    const where = and(scope, params.q ? accentInsensitiveIlike(schema.monitoredAuthors.authorName, buildSearchPattern(params.q)) : undefined)!;
    const visible = visibleWorkCondition();
    const active = activeWorkCondition(visible);
    const ebookRelease = and(
      active,
      ne(schema.monitoredAuthors.ebookMode, 'off'),
      or(ne(schema.monitoredAuthorWorks.monitorEbook, false), sql`${schema.monitoredAuthorWorks.monitorEbook} is null`),
      releaseRangeOverlapsSql(schema.authorCatalogWorks.ebookReleaseDate, schema.authorCatalogWorks.ebookDatePrecision, params.today, '9999-12-31'),
    );
    const audioRelease = and(
      active,
      ne(schema.monitoredAuthors.audiobookMode, 'off'),
      or(ne(schema.monitoredAuthorWorks.monitorAudiobook, false), sql`${schema.monitoredAuthorWorks.monitorAudiobook} is null`),
      releaseRangeOverlapsSql(schema.authorCatalogWorks.audioReleaseDate, schema.authorCatalogWorks.audioDatePrecision, params.today, '9999-12-31'),
    );
    const libraryIds = viewer.isSuperuser ? null : await this.libraries.findAccessibleLibraryIds(viewer);
    const ebookOwned = this.ownedFormatCondition('ebook', libraryIds);
    const audioOwned = this.ownedFormatCondition('audiobook', libraryIds);
    const totalExpr = sql<number>`count(*) filter (where ${visible})::int`;
    const ebookOwnedExpr = sql<number>`count(*) filter (where ${visible} and ${ebookOwned})::int`;
    const audioOwnedExpr = sql<number>`count(*) filter (where ${visible} and ${audioOwned})::int`;
    const hiddenExpr = sql<number>`count(*) filter (where not ${visible})::int`;
    const progressExpr = sql<number>`(${ebookOwnedExpr} + ${audioOwnedExpr})::float / greatest((${totalExpr}) * 2, 1)`;
    const sortExpression =
      params.sort === 'added'
        ? schema.monitoredAuthors.addedAt
        : params.sort === 'books'
          ? totalExpr
          : params.sort === 'progress'
            ? progressExpr
            : schema.monitoredAuthors.authorName;
    const direction = params.order === 'asc' ? asc : desc;

    const [rows, [countRow]] = await this.snapshotRead(async (tx) => {
      const dataQuery = tx
        .select({
          author: schema.monitoredAuthors,
          total: totalExpr,
          ebookOwned: ebookOwnedExpr,
          audioOwned: audioOwnedExpr,
          hidden: hiddenExpr,
          nextReleaseAt: sql<string | null>`least(
            min(case when ${ebookRelease} then ${schema.authorCatalogWorks.ebookReleaseDate} end),
            min(case when ${audioRelease} then ${schema.authorCatalogWorks.audioReleaseDate} end)
          )`,
        })
        .from(schema.monitoredAuthors)
        .leftJoin(schema.authorCatalogWorks, eq(schema.authorCatalogWorks.monitorAuthorId, schema.monitoredAuthors.id))
        .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
        .where(where)
        .groupBy(schema.monitoredAuthors.id)
        .orderBy(direction(sortExpression), asc(schema.monitoredAuthors.authorName), asc(schema.monitoredAuthors.id))
        .limit(params.size)
        .offset(params.page * params.size);
      const countQuery = tx.select({ total: count() }).from(schema.monitoredAuthors).where(where);
      return Promise.all([dataQuery, countQuery]);
    });
    const authors = await this.composeAuthors(rows.map((row) => row.author));
    const byId = new Map(authors.map((author) => [author.id, author]));

    return {
      items: rows.flatMap((row) => {
        const author = byId.get(row.author.id);
        if (!author) return [];
        return [
          {
            author,
            aggregate: {
              counts: {
                total: Number(row.total),
                ebookOwned: Number(row.ebookOwned),
                audioOwned: Number(row.audioOwned),
                hidden: Number(row.hidden),
              },
              nextReleaseAt: row.nextReleaseAt,
            },
          },
        ];
      }),
      total: Number(countRow?.total ?? 0),
      page: params.page,
      size: params.size,
    };
  }

  async findOwnedAuthorIdsPage(
    viewer: RequestUser,
    page: number,
    size: number,
  ): Promise<{ items: string[]; total: number; page: number; size: number }> {
    assertOffsetWithinLimit(page, size);
    const where = this.readScope(viewer, schema.monitoredAuthors.ownerUserId);
    const [rows, [countRow]] = await this.snapshotRead(async (tx) => {
      const dataQuery = tx
        .select({ id: schema.monitoredAuthors.id })
        .from(schema.monitoredAuthors)
        .where(where)
        .orderBy(asc(schema.monitoredAuthors.id))
        .limit(size)
        .offset(page * size);
      const countQuery = tx.select({ total: count() }).from(schema.monitoredAuthors).where(where);
      return Promise.all([dataQuery, countQuery]);
    });
    return { items: rows.map((row) => row.id), total: Number(countRow?.total ?? 0), page, size };
  }

  async findBookPage(params: {
    viewer: RequestUser;
    q?: string;
    page: number;
    size: number;
    sort: MonitoredBookListSort;
    order: MonitoredListOrder;
  }): Promise<{ items: MonitoredBookPageEntry[]; total: number; page: number; size: number }> {
    assertOffsetWithinLimit(params.page, params.size);
    const bookScope = this.readScope(params.viewer, schema.monitoredBooks.ownerUserId);
    const authorScope = this.readScope(params.viewer, schema.monitoredAuthors.ownerUserId);
    const qPattern = params.q ? buildSearchPattern(params.q) : null;
    const where = and(
      bookScope,
      authorScope,
      qPattern
        ? or(accentInsensitiveIlike(schema.authorCatalogWorks.title, qPattern), accentInsensitiveIlike(schema.monitoredAuthors.authorName, qPattern))
        : undefined,
    )!;
    const direction = params.order === 'asc' ? asc : desc;
    const sortExpression =
      params.sort === 'title'
        ? schema.authorCatalogWorks.title
        : params.sort === 'author'
          ? schema.monitoredAuthors.authorName
          : schema.monitoredBooks.addedAt;
    const [rows, [countRow]] = await this.snapshotRead(async (tx) => {
      const dataQuery = tx
        .select({ entry: schema.monitoredBooks, authorName: schema.monitoredAuthors.authorName, work: schema.authorCatalogWorks })
        .from(schema.monitoredBooks)
        .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.monitoredBooks.monitorAuthorId))
        .innerJoin(
          schema.authorCatalogWorks,
          and(
            eq(schema.authorCatalogWorks.id, schema.monitoredBooks.workId),
            eq(schema.authorCatalogWorks.monitorAuthorId, schema.monitoredBooks.monitorAuthorId),
          ),
        )
        .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
        .where(where)
        .orderBy(direction(sortExpression), direction(schema.authorCatalogWorks.title), asc(schema.monitoredBooks.id))
        .limit(params.size)
        .offset(params.page * params.size);
      const countQuery = tx
        .select({ total: count() })
        .from(schema.monitoredBooks)
        .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.monitoredBooks.monitorAuthorId))
        .innerJoin(
          schema.authorCatalogWorks,
          and(
            eq(schema.authorCatalogWorks.id, schema.monitoredBooks.workId),
            eq(schema.authorCatalogWorks.monitorAuthorId, schema.monitoredBooks.monitorAuthorId),
          ),
        )
        .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
        .where(where);
      return Promise.all([dataQuery, countQuery]);
    });
    const composed = await this.composeWorks(
      rows.map((row) => row.work),
      params.viewer,
    );
    const byWorkId = new Map(composed.map((item) => [item.work.id, item.work]));
    return {
      items: rows.flatMap((row) => {
        const work = byWorkId.get(row.work.id);
        return work ? [{ entry: this.composeBook(row.entry), authorName: row.authorName, work }] : [];
      }),
      total: Number(countRow?.total ?? 0),
      page: params.page,
      size: params.size,
    };
  }

  /**
   * Watchlist works for the command palette: the caller's monitored authors' catalog works the
   * caller does not own in any format, title-prefix matches first. The watchlist is a read of the
   * caller's own monitors, so the plain owner scope is the whole access check; which works count as
   * active is the shared work-visibility condition, never a local variant of it.
   */
  async searchCatalogWorks(viewer: RequestUser, q: string, limit: number): Promise<MonitoredCatalogSearchHit[]> {
    const term = normalizeMetadataText(q);
    if (!term) return [];
    const libraryIds = await this.accessibleLibraryIds(viewer);
    // The same per-viewer ownership the watchlist page reads, negated per format: a work held only
    // in a library the viewer cannot reach counts as not owned for them.
    const unowned = sql`not (${this.ownedFormatCondition('ebook', libraryIds)} or ${this.ownedFormatCondition('audiobook', libraryIds)})`;
    const where = and(this.workSearchCondition(viewer, term), unowned)!;
    const rows = await this.db
      .select({
        work: schema.authorCatalogWorks,
        authorName: schema.monitoredAuthors.authorName,
        ebookMode: schema.monitoredAuthors.ebookMode,
        audiobookMode: schema.monitoredAuthors.audiobookMode,
      })
      .from(schema.authorCatalogWorks)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
      .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
      .where(where)
      .orderBy(...this.workSearchOrder(term))
      .limit(limit);
    const composed = await this.composeWorks(
      rows.map((row) => row.work),
      viewer,
    );
    const byWorkId = new Map(composed.map((item) => [item.work.id, item]));
    return rows.flatMap((row) => {
      const item = byWorkId.get(row.work.id);
      return item
        ? [
            {
              work: item.work,
              monitorAuthorId: item.monitorAuthorId,
              authorName: row.authorName,
              authorModes: { ebook: row.ebookMode, audiobook: row.audiobookMode },
            },
          ]
        : [];
    });
  }

  /**
   * The Watchlist page search: the same matching and visibility as the palette's, but paged and
   * without the not-owned filter, because the page lists every watchlist book owned or not.
   */
  async searchWorks(params: { viewer: RequestUser; q: string; page: number; size: number }): Promise<{
    items: MonitoredWorkSearchRow[];
    total: number;
    page: number;
    size: number;
  }> {
    assertOffsetWithinLimit(params.page, params.size);
    const term = normalizeMetadataText(params.q);
    if (!term) return { items: [], total: 0, page: params.page, size: params.size };
    const where = this.workSearchCondition(params.viewer, term);
    const [rows, [countRow]] = await Promise.all([
      this.db
        .select({
          work: schema.authorCatalogWorks,
          authorName: schema.monitoredAuthors.authorName,
          ownerUserId: schema.monitoredAuthors.ownerUserId,
          lastRefreshedAt: schema.monitoredAuthors.lastRefreshedAt,
          ebookMode: schema.monitoredAuthors.ebookMode,
          audiobookMode: schema.monitoredAuthors.audiobookMode,
        })
        .from(schema.authorCatalogWorks)
        .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
        .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
        .where(where)
        .orderBy(...this.workSearchOrder(term))
        .limit(params.size)
        .offset(params.page * params.size),
      this.db
        .select({ total: count() })
        .from(schema.authorCatalogWorks)
        .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
        .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
        .where(where),
    ]);
    const total = Number(countRow?.total ?? 0);
    if (!rows.length) return { items: [], total, page: params.page, size: params.size };
    const composed = await this.composeWorks(
      rows.map((row) => row.work),
      params.viewer,
    );
    const byWorkId = new Map(composed.map((item) => [item.work.id, item]));
    return {
      items: rows.flatMap((row) => {
        const item = byWorkId.get(row.work.id);
        return item
          ? [
              {
                work: item.work,
                monitorAuthorId: item.monitorAuthorId,
                authorName: row.authorName,
                authorModes: { ebook: row.ebookMode, audiobook: row.audiobookMode },
                ownerUserId: row.ownerUserId,
                authorLastRefreshedAt: row.lastRefreshedAt ? row.lastRefreshedAt.toISOString() : null,
              },
            ]
          : [];
      }),
      total,
      page: params.page,
      size: params.size,
    };
  }

  private workSearchCondition(viewer: RequestUser, term: string): SQL {
    const pattern = buildSearchPattern(term);
    const matchingAuthors = this.db
      .select({ id: schema.monitoredAuthors.id })
      .from(schema.monitoredAuthors)
      .where(and(this.readScope(viewer, schema.monitoredAuthors.ownerUserId), accentInsensitiveIlike(schema.monitoredAuthors.authorName, pattern)));
    return and(
      this.readScope(viewer, schema.monitoredAuthors.ownerUserId),
      // Both sides test author_catalog_works itself, so the planner can BitmapOr the title trigram index
      // with the monitor_author_id index; testing the joined author name instead unaccented every catalog
      // row. The author ids go through array(): a bare IN (subquery) under OR is a hashed subplan that
      // forces a sequential scan of every catalog work.
      or(
        accentInsensitiveIlike(schema.authorCatalogWorks.title, pattern),
        sql`${schema.authorCatalogWorks.monitorAuthorId} = any(array(${matchingAuthors}))`,
      ),
      activeWorkCondition(visibleWorkCondition()),
    )!;
  }

  /**
   * Works whose title or series starts with the term lead, then each series runs in reading order.
   * A leading article is ignored so "The Primal Hunter" sorts and matches as "Primal Hunter", and
   * series_index is text, so only a plain number is read as one; "2-3" or "1a" fall after them.
   */
  private workSearchOrder(term: string): SQL[] {
    const work = schema.authorCatalogWorks;
    const prefix = `${escapeLikePattern(term)}%`;
    const withoutLeadingArticle = (value: AnyPgColumn) =>
      sql`regexp_replace(public.bookorbit_unaccent(${value}), '^(the|an|a)[[:space:]]+', '', 'i')`;
    const startsWith = (value: AnyPgColumn) =>
      or(accentInsensitiveIlike(value, prefix), sql`${withoutLeadingArticle(value)} ILIKE public.bookorbit_unaccent(${prefix})`);
    return [
      asc(sql`case when ${or(startsWith(work.title), startsWith(work.seriesName))} then 0 else 1 end`),
      asc(sql`lower(coalesce(${withoutLeadingArticle(work.seriesName)}, ${withoutLeadingArticle(work.title)}))`),
      asc(sql`case when ${work.seriesIndex} ~ '^[0-9]+([.][0-9]+)?$' then ${work.seriesIndex}::numeric end`),
      asc(sql`lower(${withoutLeadingArticle(work.title)})`),
      asc(work.id),
    ];
  }

  async findReleasePage(params: {
    kinds?: MonitoredMarkKind[];
    more?: MonitoredReviewFlag[];
    viewer: RequestUser;
    q?: string;
    page: number;
    size: number;
    sort: MonitoredReleaseListSort;
    order: MonitoredListOrder;
    filter: MonitoredReleaseFilter;
    status?: MonitoredStatusFilter[];
    earliest: string;
    latest: string;
    today: string;
    soonLatest: string;
    currentYear: string;
  }): Promise<{ items: MonitoredReleasePageEntry[]; total: number; cards: MonitoredReleaseCardCounts; page: number; size: number }> {
    assertOffsetWithinLimit(params.page, params.size);
    const hasStatusBuckets = params.status?.some((status) => status !== 'hidden');
    const libraryIds = hasStatusBuckets && !params.viewer.isSuperuser ? await this.libraries.findAccessibleLibraryIds(params.viewer) : null;
    const releaseRows = this.releaseRowsSql({ ...params, libraryIds });
    const direction = sql.raw(params.order === 'asc' ? 'asc' : 'desc');
    const orderExpression =
      params.sort === 'title' ? sql.raw('title') : params.sort === 'author' ? sql.raw('"authorName"') : sql.raw('"releaseDate"');
    const secondaryOrder = params.sort === 'author' ? sql`, "releaseDate" ${direction} nulls last` : sql``;
    const [pageResult, countResult] = await Promise.all([
      this.db.execute<ReleasePageRef>(sql`
        with release_rows as (${releaseRows})
        select "workId", "monitorAuthorId", format, "releaseDate"
        from release_rows
        order by ${orderExpression} ${direction} nulls last${secondaryOrder}, "workId" asc, format asc
        limit ${params.size} offset ${params.page * params.size}
      `),
      this.db.execute<{ total: number; byStatus: number; byWork: number }>(sql`
        with release_rows as (${releaseRows})
        select
          count(*)::int as total,
          count(distinct "workId" || case when "releaseDate" is null then ':undated' when ${releasedBySql(sql.raw('"releaseDate"'), params.today)} then ':released' else ':upcoming' end)::int as "byStatus",
          count(distinct "workId")::int as "byWork"
        from release_rows
      `),
    ]);
    const counts = countResult.rows[0];
    const total = Number(counts?.total ?? 0);
    const cards = { byStatus: Number(counts?.byStatus ?? 0), byWork: Number(counts?.byWork ?? 0) };
    const refs = pageResult.rows;
    if (!refs.length) {
      return { items: [], total, cards, page: params.page, size: params.size };
    }
    const workIds = [...new Set(refs.map((row) => row.workId))];
    const monitorIds = [...new Set(refs.map((row) => row.monitorAuthorId))];
    const [workRows, authorRows] = await Promise.all([
      this.db.select().from(schema.authorCatalogWorks).where(inArray(schema.authorCatalogWorks.id, workIds)),
      this.db.select().from(schema.monitoredAuthors).where(inArray(schema.monitoredAuthors.id, monitorIds)),
    ]);
    const [composedWorks, monitors] = await Promise.all([this.composeWorks(workRows, params.viewer), this.composeAuthors(authorRows)]);
    const worksById = new Map(composedWorks.map((item) => [item.work.id, item.work]));
    const monitorsById = new Map(monitors.map((monitor) => [monitor.id, monitor]));
    return {
      items: refs.flatMap((ref) => {
        const monitor = monitorsById.get(ref.monitorAuthorId);
        const work = worksById.get(ref.workId);
        return monitor && work ? [{ monitor, work, format: ref.format, releaseDate: ref.releaseDate }] : [];
      }),
      total,
      cards,
      page: params.page,
      size: params.size,
    };
  }

  /**
   * Rows and their total read from ONE snapshot. Issued as two independent statements, a write landing
   * between them makes the envelope contradict itself - a total that no longer describes the rows it
   * shipped with, or a page index past an end that has since moved - which the list then renders as a
   * phantom empty page. READ COMMITTED would hand each statement its own snapshot even inside a
   * transaction, so the level has to be REPEATABLE READ; the read-only mode keeps it free of write
   * serialization costs.
   */
  private snapshotRead<T>(run: (tx: DbSnapshot) => Promise<T>): Promise<T> {
    return this.db.transaction(run, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  /**
   * The monitor id behind each of these author names, for the viewer's own monitors only.
   * Annotating a ten-row search by loading EVERY monitor owned by the viewer (and the provider identities
   * hanging off each of them) scaled with how much the viewer monitors instead of with the answer.
   * The SQL fold mirrors normalizeMonitoredName, and the names that come back are re-folded in
   * TypeScript so that function stays the authority on what counts as the same name.
   */
  async findMonitoredIdsByNames(names: string[], viewer: RequestUser): Promise<Map<string, string>> {
    const normalized = [...new Set(names.map(normalizeMonitoredName).filter(Boolean))];
    if (normalized.length === 0) return new Map();
    const rows = await this.db
      .select({ id: schema.monitoredAuthors.id, authorName: schema.monitoredAuthors.authorName })
      .from(schema.monitoredAuthors)
      .where(
        and(
          this.readScope(viewer, schema.monitoredAuthors.ownerUserId),
          inArray(sql`regexp_replace(lower(public.bookorbit_unaccent(${schema.monitoredAuthors.authorName})), '[^[:alnum:]]', '', 'g')`, normalized),
        ),
      );
    const byName = new Map<string, string>();
    for (const row of rows) {
      const key = normalizeMonitoredName(row.authorName);
      if (key && !byName.has(key)) byName.set(key, row.id);
    }
    return byName;
  }

  /**
   * The viewer's monitor for each library author: one linked by id wins, otherwise an unlinked one
   * whose name folds to the same key. A monitor linked to some other author never matches by name,
   * or a namesake would show as monitored and its removal would delete the other author's monitor.
   */
  async findMonitoredIdsByLocalAuthors(localAuthors: { id: number; name: string }[], viewer: RequestUser): Promise<Map<number, string>> {
    if (localAuthors.length === 0) return new Map();
    const ids = [...new Set(localAuthors.map((author) => author.id))];
    const normalized = [...new Set(localAuthors.map((author) => normalizeMonitoredName(author.name)).filter(Boolean))];
    const nameMatch = normalized.length
      ? inArray(sql`regexp_replace(lower(public.bookorbit_unaccent(${schema.monitoredAuthors.authorName})), '[^[:alnum:]]', '', 'g')`, normalized)
      : undefined;
    const rows = await this.db
      .select({
        id: schema.monitoredAuthors.id,
        authorName: schema.monitoredAuthors.authorName,
        localAuthorId: schema.monitoredAuthors.localAuthorId,
      })
      .from(schema.monitoredAuthors)
      .where(and(this.readScope(viewer, schema.monitoredAuthors.ownerUserId), or(inArray(schema.monitoredAuthors.localAuthorId, ids), nameMatch)));
    const byLocalId = new Map<number, string>();
    const byName = new Map<string, string>();
    for (const row of rows) {
      if (row.localAuthorId != null) {
        if (!byLocalId.has(row.localAuthorId)) byLocalId.set(row.localAuthorId, row.id);
        continue;
      }
      const key = normalizeMonitoredName(row.authorName);
      if (key && !byName.has(key)) byName.set(key, row.id);
    }
    const result = new Map<number, string>();
    for (const author of localAuthors) {
      const monitoredId = byLocalId.get(author.id) ?? byName.get(normalizeMonitoredName(author.name));
      if (monitoredId) result.set(author.id, monitoredId);
    }
    return result;
  }

  /**
   * The ILIKE prefilter over a candidate list of names or titles: each value narrows the scan by
   * its longest letter-or-digit run, matched as a plain substring, so spellings that differ only in
   * separator positions still pass from either side. It is an index narrowing, never the identity
   * decision: the folded key comparison after it stays the final word. Undefined when no value
   * holds a run; callers then answer from the candidate list alone instead of querying.
   */
  private identityLikeAny(column: AnyPgColumn, values: string[]): SQL | undefined {
    const runs = [
      ...new Set(
        values.flatMap((value) => {
          const run = identityLikeRun(value.trim());
          return run ? [run] : [];
        }),
      ),
    ].slice(0, IDENTITY_LIKE_MAX_RUNS);
    if (!runs.length) return undefined;
    return or(...runs.map((run) => accentInsensitiveIlike(column, `%${run}%`)));
  }

  /**
   * The viewer's accessible libraries, or null when the viewer can reach every library. Callers that
   * need it more than once resolve it a single time and share the answer, so a search pays for the
   * libraries read once, not once per lookup.
   */
  async accessibleLibraryIds(viewer: RequestUser): Promise<number[] | null> {
    return viewer.isSuperuser ? null : await this.libraries.findAccessibleLibraryIds(viewer);
  }

  /**
   * Hardcover slugs the given accessible libraries already hold, so the palette's Hardcover step can
   * drop books the user owns. A viewer with no accessible library owns nothing fetchable.
   */
  async findLibraryHardcoverIds(libraryIds: number[] | null, slugs: string[]): Promise<Set<string>> {
    const unique = [...new Set(slugs.filter(Boolean))];
    if (!unique.length) return new Set();
    if (libraryIds && !libraryIds.length) return new Set();
    const rows = await this.db
      .select({ hardcoverId: dbSchema.bookMetadata.hardcoverId })
      .from(dbSchema.bookMetadata)
      .innerJoin(upstreamBooks, eq(upstreamBooks.id, dbSchema.bookMetadata.bookId))
      .where(and(inArray(dbSchema.bookMetadata.hardcoverId, unique), libraryIds ? inArray(upstreamBooks.libraryId, libraryIds) : undefined));
    return new Set(rows.flatMap((row) => (row.hardcoverId ? [row.hardcoverId] : [])));
  }

  async findCatalogHardcoverIds(viewer: RequestUser, slugs: string[]): Promise<Set<string>> {
    const unique = [...new Set(slugs.filter(Boolean))];
    if (!unique.length) return new Set();
    const rows = await this.db
      .select({ providerWorkId: schema.authorCatalogSourceWorks.providerWorkId })
      .from(schema.authorCatalogSourceWorks)
      .innerJoin(schema.authorCatalogWorks, eq(schema.authorCatalogWorks.id, schema.authorCatalogSourceWorks.workId))
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
      .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
      .where(
        and(
          this.readScope(viewer, schema.monitoredAuthors.ownerUserId),
          eq(schema.authorCatalogSourceWorks.source, 'hardcover'),
          inArray(schema.authorCatalogSourceWorks.providerWorkId, unique),
          activeWorkCondition(visibleWorkCondition()),
        ),
      );
    return new Set(rows.map((row) => row.providerWorkId));
  }

  /**
   * `title|author` identity keys for the library books titled like one of the given titles, one
   * query for the whole candidate list. The title filter is a substring ILIKE on each title's
   * longest run so the trigram index narrows the scan; the exact identity check happens on the
   * folded keys after. Every author of each book contributes a key, because a provider hit that
   * lists any of them is a duplicate.
   */
  async findLibraryTitleAuthorKeys(libraryIds: number[] | null, titles: string[]): Promise<Set<string>> {
    const unique = [...new Set(titles.filter((title) => identityLikePattern(title) != null))];
    if (!unique.length) return new Set();
    if (libraryIds && !libraryIds.length) return new Set();
    const like = this.identityLikeAny(dbSchema.bookMetadata.title, unique);
    if (!like) return new Set();
    const rows = await this.db
      .select({ title: dbSchema.bookMetadata.title, authorName: dbSchema.authors.name })
      .from(dbSchema.bookMetadata)
      .innerJoin(upstreamBooks, eq(upstreamBooks.id, dbSchema.bookMetadata.bookId))
      .innerJoin(dbSchema.bookAuthors, eq(dbSchema.bookAuthors.bookId, dbSchema.bookMetadata.bookId))
      .innerJoin(dbSchema.authors, eq(dbSchema.authors.id, dbSchema.bookAuthors.authorId))
      .where(and(like, libraryIds ? inArray(upstreamBooks.libraryId, libraryIds) : undefined));
    return new Set(rows.map((row) => titleAuthorKey(row.title, row.authorName)));
  }

  /**
   * `title|author` identity keys for the watchlist works titled like one of the given titles, under
   * the same active-work visibility the watchlist itself reads, so a work the watchlist never shows
   * cannot suppress a Hardcover hit either.
   */
  async findCatalogTitleAuthorKeys(viewer: RequestUser, titles: string[]): Promise<Set<string>> {
    const unique = [...new Set(titles.filter((title) => identityLikePattern(title) != null))];
    if (!unique.length) return new Set();
    const like = this.identityLikeAny(schema.authorCatalogWorks.title, unique);
    if (!like) return new Set();
    const rows = await this.db
      .select({ title: schema.authorCatalogWorks.title, authorName: schema.monitoredAuthors.authorName })
      .from(schema.authorCatalogWorks)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
      .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
      .where(and(this.readScope(viewer, schema.monitoredAuthors.ownerUserId), like, activeWorkCondition(visibleWorkCondition())));
    return new Set(rows.map((row) => titleAuthorKey(row.title, row.authorName)));
  }

  async findMonitoredHardcoverProviderIds(viewer: RequestUser, providerIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(providerIds.filter(Boolean))];
    if (!unique.length) return new Set();
    const rows = await this.db
      .select({ providerId: schema.authorProviderIdentities.providerId })
      .from(schema.authorProviderIdentities)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorProviderIdentities.monitorAuthorId))
      .where(
        and(
          this.readScope(viewer, schema.monitoredAuthors.ownerUserId),
          eq(schema.authorProviderIdentities.source, 'hardcover'),
          inArray(schema.authorProviderIdentities.providerId, unique),
        ),
      );
    return new Set(rows.map((row) => row.providerId));
  }

  /**
   * Identity keys of the given author names that already exist on books in the given accessible
   * libraries, one query for the whole candidate list. The run-substring ILIKE prefilter keeps the
   * scan on the author name trigram index; the folded key comparison after it stays the final word
   * on what counts as the same name, and it is Unicode-aware, so a non-Latin name never collapses
   * onto the empty key.
   */
  async findLocalAuthorNameKeys(libraryIds: number[] | null, names: string[]): Promise<Set<string>> {
    const keys = new Set(names.map(normalizeMonitoredName).filter(Boolean));
    if (!keys.size) return new Set();
    if (libraryIds && !libraryIds.length) return new Set();
    const like = this.identityLikeAny(dbSchema.authors.name, names);
    if (!like) return new Set();
    const rows = await this.db
      .selectDistinct({ name: dbSchema.authors.name })
      .from(dbSchema.authors)
      .innerJoin(dbSchema.bookAuthors, eq(dbSchema.bookAuthors.authorId, dbSchema.authors.id))
      .innerJoin(upstreamBooks, eq(upstreamBooks.id, dbSchema.bookAuthors.bookId))
      .where(and(like, libraryIds ? inArray(upstreamBooks.libraryId, libraryIds) : undefined));
    const found = new Set<string>();
    for (const row of rows) {
      const key = normalizeMonitoredName(row.name);
      if (keys.has(key)) found.add(key);
    }
    return found;
  }

  /**
   * Whether this owner already monitors that author name, in exactly the terms the unique index
   * uses. Loading the owner's whole monitor list (and every provider identity on it) to compare names
   * in memory scaled with the library instead of with the answer.
   */
  async hasAuthorNamed(ownerUserId: number, authorName: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.monitoredAuthors.id })
      .from(schema.monitoredAuthors)
      .where(and(eq(schema.monitoredAuthors.ownerUserId, ownerUserId), sql`lower(${schema.monitoredAuthors.authorName}) = lower(${authorName})`))
      .limit(1);
    return Boolean(row);
  }

  async getAuthor(id: string, viewer?: RequestUser): Promise<MonitoredAuthorConfig | null> {
    const clauses = [eq(schema.monitoredAuthors.id, id)];
    if (viewer) clauses.push(this.readScope(viewer, schema.monitoredAuthors.ownerUserId));
    const [row] = await this.db
      .select()
      .from(schema.monitoredAuthors)
      .where(and(...clauses))
      .limit(1);
    if (!row) return null;
    return (await this.composeAuthors([row]))[0];
  }

  async upsertAuthor(input: AuthorWrite, actor?: RequestUser): Promise<MonitoredAuthorConfig> {
    const id = input.id ?? randomUUID();
    if (input.id && actor) await this.assertAuthorWritable(id, actor, true);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.monitoredAuthors)
        .values(this.authorValues({ ...input, id }))
        .onConflictDoUpdate({ target: schema.monitoredAuthors.id, set: this.authorUpdateValues(input) });
      await tx.delete(schema.authorProviderIdentities).where(eq(schema.authorProviderIdentities.monitorAuthorId, id));
      const identities = Object.entries(input.providerIds).flatMap(([source, providerId]) =>
        providerId ? [{ monitorAuthorId: id, source, providerId }] : [],
      );
      if (identities.length) await tx.insert(schema.authorProviderIdentities).values(identities);
    });
    return {
      id,
      ownerUserId: input.ownerUserId,
      authorName: input.authorName,
      localAuthorId: input.localAuthorId,
      providerIds: input.providerIds,
      formats: input.formats,
      paused: input.paused,
      addedAt: input.addedAt,
      lastRefreshedAt: input.lastRefreshedAt,
      fetch: { state: input.fetchState ?? 'idle', errorKind: null, errorAt: null, retryAt: null },
    };
  }

  async markFetchQueued(monitorId: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.monitoredAuthors)
      .set({ fetchState: 'queued', fetchErrorKind: null, fetchErrorAt: null, fetchRetryAt: null })
      .where(and(eq(schema.monitoredAuthors.id, monitorId), inArray(schema.monitoredAuthors.fetchState, ['idle', 'failed'])))
      .returning({ id: schema.monitoredAuthors.id });
    return rows.length > 0;
  }

  async claimFetch(monitorId: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.monitoredAuthors)
      .set({ fetchState: 'fetching' })
      .where(and(eq(schema.monitoredAuthors.id, monitorId), eq(schema.monitoredAuthors.fetchState, 'queued')))
      .returning({ id: schema.monitoredAuthors.id });
    return rows.length > 0;
  }

  async releaseFetch(monitorId: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.monitoredAuthors)
      .set({ fetchState: 'idle' })
      .where(and(eq(schema.monitoredAuthors.id, monitorId), eq(schema.monitoredAuthors.fetchState, 'fetching')))
      .returning({ id: schema.monitoredAuthors.id });
    return rows.length > 0;
  }

  async finishFetchSucceeded(
    monitorId: string,
    fields: { lastRefreshedAt: string; hardcoverAuthorId: string | null; localAuthorId: number | null },
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.monitoredAuthors)
        .set({
          fetchState: 'idle',
          fetchErrorKind: null,
          fetchErrorAt: null,
          fetchRetryAt: null,
          fetchAttempts: 0,
          lastRefreshedAt: new Date(fields.lastRefreshedAt),
          ...(fields.localAuthorId !== null ? { localAuthorId: fields.localAuthorId } : {}),
        })
        .where(and(eq(schema.monitoredAuthors.id, monitorId), eq(schema.monitoredAuthors.fetchState, 'fetching')))
        .returning({ id: schema.monitoredAuthors.id });
      if (!rows.length) return false;
      if (fields.hardcoverAuthorId !== null) {
        await tx
          .insert(schema.authorProviderIdentities)
          .values({ monitorAuthorId: monitorId, source: 'hardcover', providerId: fields.hardcoverAuthorId })
          .onConflictDoUpdate({
            target: [schema.authorProviderIdentities.monitorAuthorId, schema.authorProviderIdentities.source],
            set: { providerId: fields.hardcoverAuthorId },
          });
      }
      return true;
    });
  }

  async finishFetchFailed(
    monitorId: string,
    failure: { kind: MonitoredFetchErrorKind; at: string; retryAt: string | null; attempts: number },
  ): Promise<boolean> {
    const rows = await this.db
      .update(schema.monitoredAuthors)
      .set({
        fetchState: 'failed',
        fetchErrorKind: failure.kind,
        fetchErrorAt: new Date(failure.at),
        fetchRetryAt: failure.retryAt ? new Date(failure.retryAt) : null,
        fetchAttempts: Math.min(failure.attempts, 3),
      })
      .where(and(eq(schema.monitoredAuthors.id, monitorId), eq(schema.monitoredAuthors.fetchState, 'fetching')))
      .returning({ id: schema.monitoredAuthors.id });
    return rows.length > 0;
  }

  async resetInterruptedFetches(): Promise<number> {
    const rows = await this.db
      .update(schema.monitoredAuthors)
      .set({ fetchState: 'queued' })
      .where(eq(schema.monitoredAuthors.fetchState, 'fetching'))
      .returning({ id: schema.monitoredAuthors.id });
    return rows.length;
  }

  async findQueuedFetches(after: { addedAt: string; id: string } | null, limit: number): Promise<Array<{ id: string; addedAt: string }>> {
    const t = schema.monitoredAuthors;
    const rows = await this.db
      .select({ id: t.id, addedAt: t.addedAt })
      .from(t)
      .where(and(eq(t.fetchState, 'queued'), after ? sql`(${t.addedAt}, ${t.id}) > (${new Date(after.addedAt)}, ${after.id})` : undefined))
      .orderBy(asc(t.addedAt), asc(t.id))
      .limit(limit);
    return rows.map((row) => ({ id: row.id, addedAt: row.addedAt.toISOString() }));
  }

  async findPendingRetries(): Promise<Array<{ id: string; retryAt: string }>> {
    const t = schema.monitoredAuthors;
    const rows = await this.db
      .select({ id: t.id, retryAt: t.fetchRetryAt })
      .from(t)
      .where(and(eq(t.fetchState, 'failed'), sql`${t.fetchRetryAt} is not null`));
    return rows.map((row) => ({ id: row.id, retryAt: row.retryAt!.toISOString() }));
  }

  async getMonitorForFetch(monitorId: string): Promise<(MonitoredAuthorConfig & { fetchAttempts: number }) | null> {
    const [row] = await this.db.select().from(schema.monitoredAuthors).where(eq(schema.monitoredAuthors.id, monitorId)).limit(1);
    if (!row) return null;
    const [monitor] = await this.composeAuthors([row]);
    return { ...monitor, fetchAttempts: row.fetchAttempts };
  }

  async updateAuthorFields(id: string, fields: AuthorFields, actor?: RequestUser): Promise<MonitoredAuthorConfig> {
    if (actor) await this.assertAuthorWritable(id, actor);
    const values = this.authorFieldUpdateValues(fields);
    await this.db.transaction(async (tx) => {
      if (Object.keys(values).length) {
        const updated = await tx
          .update(schema.monitoredAuthors)
          .set(values)
          .where(eq(schema.monitoredAuthors.id, id))
          .returning({ id: schema.monitoredAuthors.id });
        if (!updated.length) throw new NotFoundException('Monitored author not found');
      }
      for (const [source, providerId] of Object.entries(fields.providerIds ?? {})) {
        if (!providerId) continue;
        await tx
          .insert(schema.authorProviderIdentities)
          .values({ monitorAuthorId: id, source, providerId })
          .onConflictDoUpdate({
            target: [schema.authorProviderIdentities.monitorAuthorId, schema.authorProviderIdentities.source],
            set: { providerId },
          });
      }
    });
    const updated = await this.getAuthor(id);
    if (!updated) throw new NotFoundException('Monitored author not found');
    return updated;
  }

  async removeAuthor(id: string, actor?: RequestUser): Promise<boolean> {
    const startedAt = Date.now();
    this.logger.log(`[monitored.store.remove_author] [start] monitorId="${sanitizeLogValue(id)}" - monitored author cascade started`);
    try {
      if (actor) await this.assertAuthorWritable(id, actor);
      const result = await this.db
        .delete(schema.monitoredAuthors)
        .where(eq(schema.monitoredAuthors.id, id))
        .returning({ id: schema.monitoredAuthors.id });
      if (!result.length) throw new NotFoundException('Monitored author not found');
      this.logger.log(
        `[monitored.store.remove_author] [end] monitorId="${sanitizeLogValue(id)}" durationMs=${Date.now() - startedAt} deleted=1 - monitored author cascade completed`,
      );
      return true;
    } catch (error) {
      this.logFailure('monitored.store.remove_author', 'monitorId', id, startedAt, error);
      throw error;
    }
  }

  /**
   * Whether this owner already tracks that work on that monitor. The duplicate check used to read
   * every monitored_books row of every user and filter in memory, which scaled with the deployment
   * instead of with the answer and bypassed read scope on the way.
   */
  async hasBookForWork(ownerUserId: number, monitorAuthorId: string, workId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.monitoredBooks.id })
      .from(schema.monitoredBooks)
      .where(
        and(
          eq(schema.monitoredBooks.ownerUserId, ownerUserId),
          eq(schema.monitoredBooks.monitorAuthorId, monitorAuthorId),
          eq(schema.monitoredBooks.workId, workId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async getBook(id: string, viewer?: RequestUser): Promise<MonitoredBookEntry | null> {
    const clauses = [eq(schema.monitoredBooks.id, id)];
    if (viewer) clauses.push(this.readScope(viewer, schema.monitoredBooks.ownerUserId));
    const [row] = await this.db
      .select()
      .from(schema.monitoredBooks)
      .where(and(...clauses))
      .limit(1);
    return row ? this.composeBook(row) : null;
  }

  async upsertBook(input: BookWrite, actor?: RequestUser): Promise<MonitoredBookEntry> {
    const id = input.id ?? randomUUID();
    if (input.id && actor) await this.assertBookWritable(id, actor);
    await this.db
      .insert(schema.monitoredBooks)
      .values(this.bookValues({ ...input, id }))
      .onConflictDoUpdate({ target: schema.monitoredBooks.id, set: this.bookUpdateValues(input) });
    return {
      id,
      ownerUserId: input.ownerUserId,
      monitorAuthorId: input.monitorAuthorId,
      workId: input.workId,
      formats: input.formats,
      paused: input.paused,
      addedAt: input.addedAt,
    };
  }

  async removeBook(id: string, actor?: RequestUser): Promise<boolean> {
    if (actor) await this.assertBookWritable(id, actor);
    const result = await this.db.delete(schema.monitoredBooks).where(eq(schema.monitoredBooks.id, id)).returning({ id: schema.monitoredBooks.id });
    if (!result.length) throw new NotFoundException('Monitored book not found');
    return true;
  }

  async getCatalog(monitorId: string, viewer?: RequestUser): Promise<MonitoredCatalog | null> {
    return (await this.getCatalogs([monitorId], viewer)).get(monitorId) ?? null;
  }

  async getCatalogs(monitorIds: string[], viewer?: RequestUser): Promise<Map<string, MonitoredCatalog | null>> {
    const result = new Map<string, MonitoredCatalog | null>(monitorIds.map((id) => [id, null]));
    if (!monitorIds.length) return result;
    const monitorClauses = [inArray(schema.monitoredAuthors.id, monitorIds)];
    if (viewer) monitorClauses.push(this.readScope(viewer, schema.monitoredAuthors.ownerUserId));
    const states = await this.db
      .select({ monitorId: schema.monitoredAuthors.id, fetchedAt: schema.authorCatalogState.fetchedAt })
      .from(schema.monitoredAuthors)
      .innerJoin(schema.authorCatalogState, eq(schema.authorCatalogState.monitorAuthorId, schema.monitoredAuthors.id))
      .where(and(...monitorClauses));
    if (!states.length) return result;
    const readableIds = states.map((row) => row.monitorId);
    const works = await this.db.select().from(schema.authorCatalogWorks).where(inArray(schema.authorCatalogWorks.monitorAuthorId, readableIds));
    const composed = await this.composeWorks(works, viewer);
    const byMonitor = new Map<string, MonitoredWork[]>();
    for (const item of composed) byMonitor.set(item.monitorAuthorId, [...(byMonitor.get(item.monitorAuthorId) ?? []), item.work]);
    for (const state of states) {
      result.set(state.monitorId, {
        fetchedAt: state.fetchedAt.toISOString(),
        works: byMonitor.get(state.monitorId) ?? [],
      });
    }
    return result;
  }

  async getAuthorAggregates(monitorIds: string[], viewer: RequestUser, today: string): Promise<Map<string, MonitoredAuthorAggregate>> {
    const result = new Map<string, MonitoredAuthorAggregate>(
      monitorIds.map((id) => [id, { counts: { total: 0, ebookOwned: 0, audioOwned: 0, hidden: 0 }, nextReleaseAt: null }]),
    );
    if (!monitorIds.length) return result;
    const visible = visibleWorkCondition();
    const active = activeWorkCondition(visible);
    const ebookRelease = and(
      active,
      ne(schema.monitoredAuthors.ebookMode, 'off'),
      or(ne(schema.monitoredAuthorWorks.monitorEbook, false), sql`${schema.monitoredAuthorWorks.monitorEbook} is null`),
      releaseRangeOverlapsSql(schema.authorCatalogWorks.ebookReleaseDate, schema.authorCatalogWorks.ebookDatePrecision, today, '9999-12-31'),
    );
    const audioRelease = and(
      active,
      ne(schema.monitoredAuthors.audiobookMode, 'off'),
      or(ne(schema.monitoredAuthorWorks.monitorAudiobook, false), sql`${schema.monitoredAuthorWorks.monitorAudiobook} is null`),
      releaseRangeOverlapsSql(schema.authorCatalogWorks.audioReleaseDate, schema.authorCatalogWorks.audioDatePrecision, today, '9999-12-31'),
    );
    const libraryIds = viewer.isSuperuser ? null : await this.libraries.findAccessibleLibraryIds(viewer);
    const ebookOwned = this.ownedFormatCondition('ebook', libraryIds);
    const audioOwned = this.ownedFormatCondition('audiobook', libraryIds);
    const rows = await this.db
      .select({
        monitorId: schema.monitoredAuthors.id,
        total: sql<number>`count(*) filter (where ${visible})::int`,
        ebookOwned: sql<number>`count(*) filter (where ${visible} and ${ebookOwned})::int`,
        audioOwned: sql<number>`count(*) filter (where ${visible} and ${audioOwned})::int`,
        hidden: sql<number>`count(*) filter (where not ${visible})::int`,
        nextReleaseAt: sql<string | null>`least(
          min(case when ${ebookRelease} then ${schema.authorCatalogWorks.ebookReleaseDate} end),
          min(case when ${audioRelease} then ${schema.authorCatalogWorks.audioReleaseDate} end)
        )`,
      })
      .from(schema.monitoredAuthors)
      .innerJoin(schema.authorCatalogState, eq(schema.authorCatalogState.monitorAuthorId, schema.monitoredAuthors.id))
      .innerJoin(schema.authorCatalogWorks, eq(schema.authorCatalogWorks.monitorAuthorId, schema.monitoredAuthors.id))
      .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
      .where(and(inArray(schema.monitoredAuthors.id, monitorIds), this.readScope(viewer, schema.monitoredAuthors.ownerUserId)))
      .groupBy(schema.monitoredAuthors.id);
    for (const row of rows) {
      result.set(row.monitorId, {
        counts: { total: row.total, ebookOwned: row.ebookOwned, audioOwned: row.audioOwned, hidden: row.hidden },
        nextReleaseAt: row.nextReleaseAt,
      });
    }
    return result;
  }

  async getWorkWithMonitor(workId: string, viewer?: RequestUser): Promise<MonitoredWorkEntry | null> {
    const clauses = [eq(schema.authorCatalogWorks.id, workId)];
    if (viewer) clauses.push(this.readScope(viewer, schema.monitoredAuthors.ownerUserId));
    const [row] = await this.db
      .select({ work: schema.authorCatalogWorks, monitor: schema.monitoredAuthors })
      .from(schema.authorCatalogWorks)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
      .where(and(...clauses))
      .limit(1);
    if (!row) return null;
    const [monitor] = await this.composeAuthors([row.monitor]);
    const [composed] = await this.composeWorks([row.work], viewer);
    if (!composed) return null;
    return { monitor, work: composed.work };
  }

  async getWorksWithMonitors(workIds: string[], viewer: RequestUser): Promise<Map<string, MonitoredWorkEntry>> {
    if (!workIds.length) return new Map();
    const rows = await this.db
      .select({ work: schema.authorCatalogWorks, monitor: schema.monitoredAuthors })
      .from(schema.authorCatalogWorks)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
      .where(inArray(schema.authorCatalogWorks.id, workIds));
    const monitorRows = [...new Map(rows.map((row) => [row.monitor.id, row.monitor])).values()];
    const [monitors, works] = await Promise.all([
      this.composeAuthors(monitorRows),
      // Retain hidden foreign rows only long enough for the service to report forbidden instead of not_found.
      this.composeWorks(
        rows.map((row) => row.work),
        viewer,
        true,
      ),
    ]);
    const monitorMap = new Map(monitors.map((monitor) => [monitor.id, monitor]));
    const workMap = new Map(works.map((item) => [item.work.id, item.work]));
    const result = new Map<string, MonitoredWorkEntry>();
    for (const row of rows) {
      const monitor = monitorMap.get(row.monitor.id);
      const work = workMap.get(row.work.id);
      if (monitor && work) result.set(row.work.id, { monitor, work });
    }
    return result;
  }

  /**
   * The viewer's own work whose stored match is the given library book. The three match columns each
   * carry an index, so this is a bitmap-or over them filtered by the owner, never a catalog scan.
   */
  async findWorkIdByMatchedBook(bookId: number, viewer: RequestUser): Promise<string | null> {
    const works = schema.authorCatalogWorks;
    const [row] = await this.db
      .select({ id: works.id })
      .from(works)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, works.monitorAuthorId))
      .where(
        and(
          this.readScope(viewer, schema.monitoredAuthors.ownerUserId),
          or(eq(works.matchedBookId, bookId), eq(works.matchedEbookBookId, bookId), eq(works.matchedAudioBookId, bookId)),
        ),
      )
      .orderBy(asc(works.id))
      .limit(1);
    return row?.id ?? null;
  }

  async updateWorkUserState(workId: string, patch: WorkStatePatch, actor: RequestUser): Promise<MonitoredWork> {
    await this.assertWorkWritable(workId, actor);
    const [work] = await this.db.select().from(schema.authorCatalogWorks).where(eq(schema.authorCatalogWorks.id, workId)).limit(1);
    if (!work) throw new NotFoundException('Monitored work not found');
    const overlayState = overlayStateWrite(patch);
    const values = {
      workId,
      monitorAuthorId: work.monitorAuthorId,
      ...(patch.monitorState !== undefined ? { monitorState: patch.monitorState } : {}),
      ...(patch.monitorEbook !== undefined ? { monitorEbook: patch.monitorEbook } : {}),
      ...(patch.monitorAudiobook !== undefined ? { monitorAudiobook: patch.monitorAudiobook } : {}),
      ...(patch.autoDownloadEbook !== undefined ? { autoDownloadEbook: patch.autoDownloadEbook } : {}),
      ...(patch.autoDownloadAudiobook !== undefined ? { autoDownloadAudiobook: patch.autoDownloadAudiobook } : {}),
      ...overlayState.values,
      ...(patch.requestIds?.ebook !== undefined ? { ebookRequestId: patch.requestIds.ebook } : {}),
      ...(patch.requestIds?.audiobook !== undefined ? { audiobookRequestId: patch.requestIds.audiobook } : {}),
    };
    const set: {
      [K in keyof typeof schema.monitoredAuthorWorks.$inferInsert]?: (typeof schema.monitoredAuthorWorks.$inferInsert)[K] | SQL;
    } = { ...values, ...overlayState.conflictSet };
    await this.db.insert(schema.monitoredAuthorWorks).values(values).onConflictDoUpdate({ target: schema.monitoredAuthorWorks.workId, set });
    const [composed] = await this.composeWorks([work], actor);
    if (!composed) throw new NotFoundException('Monitored work not found');
    return composed.work;
  }

  async updateWorksUserState(workIds: string[], patch: MonitoredBulkWorkPatch, actor: RequestUser): Promise<MonitoredWork[]> {
    if (!workIds.length) return [];
    const works = await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(schema.authorCatalogWorks).where(inArray(schema.authorCatalogWorks.id, workIds));
      if (!rows.length) return [];
      const overlayState = overlayStateWrite(patch);
      const values = rows.map((work) => ({
        workId: work.id,
        monitorAuthorId: work.monitorAuthorId,
        ...(patch.monitorEbook !== undefined ? { monitorEbook: patch.monitorEbook } : {}),
        ...(patch.monitorAudiobook !== undefined ? { monitorAudiobook: patch.monitorAudiobook } : {}),
        ...overlayState.values,
      }));
      const set: Record<string, SQL> = { ...overlayState.conflictSet };
      if (patch.monitorEbook !== undefined) set.monitorEbook = sql`excluded.monitor_ebook`;
      if (patch.monitorAudiobook !== undefined) set.monitorAudiobook = sql`excluded.monitor_audiobook`;
      await tx.insert(schema.monitoredAuthorWorks).values(values).onConflictDoUpdate({ target: schema.monitoredAuthorWorks.workId, set });
      return rows;
    });
    const composed = await this.composeWorks(works, actor);
    const byId = new Map(composed.map((item) => [item.work.id, item.work]));
    return workIds.flatMap((workId) => {
      const work = byId.get(workId);
      return work ? [work] : [];
    });
  }

  /**
   * The works behind a set of ids, composed for the viewer. Used to re-read the handful of works a
   * targeted rematch just wrote, so the viewer masking that composition applies still decides what
   * they are told they own.
   */
  async getComposedWorks(workIds: string[], viewer?: RequestUser): Promise<Map<string, MonitoredWork>> {
    if (!workIds.length) return new Map();
    const clauses = [inArray(schema.authorCatalogWorks.id, workIds)];
    if (viewer) clauses.push(this.readScope(viewer, schema.monitoredAuthors.ownerUserId));
    const rows = await this.db
      .select({ work: schema.authorCatalogWorks })
      .from(schema.authorCatalogWorks)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
      .where(and(...clauses));
    const composed = await this.composeWorks(
      rows.map((row) => row.work),
      viewer,
    );
    return new Map(composed.map((item) => [item.work.id, item.work]));
  }

  /**
   * The owned-match columns of one work, rewritten outside a full catalog refresh. Only what
   * matching decides is touched: the overlay beside it is the owner's own curation, and a rematch
   * has no business in it.
   */
  async updateWorkMatch(workId: string, match: WorkMatchUpdate, options: { withPossibleMatches?: boolean } = {}): Promise<void> {
    const values = options.withPossibleMatches ? { ...this.matchValues(match), ...this.possibleMatchValues(match) } : this.matchValues(match);
    await this.db.update(schema.authorCatalogWorks).set(values).where(eq(schema.authorCatalogWorks.id, workId));
  }

  /** Whether a library book is present and sits in a library the viewer can open. */
  async isBookReadable(bookId: number, viewer: RequestUser): Promise<boolean> {
    const clauses = [eq(upstreamBooks.id, bookId), eq(upstreamBooks.status, 'present')];
    if (!viewer.isSuperuser) {
      const libraryIds = await this.libraries.findAccessibleLibraryIds(viewer);
      if (!libraryIds.length) return false;
      clauses.push(inArray(upstreamBooks.libraryId, libraryIds));
    }
    const [row] = await this.db
      .select({ id: upstreamBooks.id })
      .from(upstreamBooks)
      .where(and(...clauses))
      .limit(1);
    return row != null;
  }

  /** Every answer the owners of these monitors gave about which library book is a work's book. */
  async findMatchOverrides(monitorIds: string[]): Promise<MonitoredMatchOverrideRow[]> {
    if (!monitorIds.length) return [];
    return this.db.select().from(schema.monitoredMatchOverrides).where(inArray(schema.monitoredMatchOverrides.monitorAuthorId, monitorIds));
  }

  /**
   * Files the owner's answer about one format's library book under every identity key of the work.
   * A link replaces any earlier link for the format and lifts a rejection of the same book; a
   * rejection drops a link to that book; `automatic` drops every answer for the format.
   */
  async writeMatchOverride(
    work: { id: string; monitorAuthorId: string; identityKeys: string[] },
    format: MonitoredFormat,
    answer: StoredMatchAnswer,
  ): Promise<void> {
    const overrides = schema.monitoredMatchOverrides;
    // Answers filed from this work under a provider id it no longer carries count too, or a later
    // refresh that brings that id back would revive an answer the owner already replaced.
    const scope = and(
      eq(overrides.monitorAuthorId, work.monitorAuthorId),
      eq(overrides.format, format),
      or(inArray(overrides.identityKey, work.identityKeys), eq(overrides.workId, work.id)),
    );
    await this.db.transaction(async (tx) => {
      if (answer.decision === 'automatic') {
        await tx.delete(overrides).where(scope);
        return;
      }
      const { decision, bookId } = answer;
      if (decision === 'link') await tx.delete(overrides).where(and(scope, eq(overrides.decision, 'link')));
      else await tx.delete(overrides).where(and(scope, eq(overrides.bookId, bookId)));
      const decidedAt = new Date();
      await tx
        .insert(overrides)
        .values(
          work.identityKeys.map((identityKey) => ({
            monitorAuthorId: work.monitorAuthorId,
            format,
            identityKey,
            bookId,
            decision,
            workId: work.id,
            decidedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [overrides.monitorAuthorId, overrides.format, overrides.identityKey, overrides.bookId],
          set: { decision: sql`excluded.decision`, workId: sql`excluded.work_id`, decidedAt: sql`excluded.decided_at` },
        });
    });
  }

  /** Library books the monitor's other works own, so a one-work rematch can tell a sibling volume from a candidate. */
  /**
   * The `bookId|kind` keys the monitor's other works hold through the matcher, or are still asking
   * about as a possible match. A hand-made link is left out: it does not keep the matcher from giving
   * the same file to another work. A possible match is kept in: a full refresh gave that file to
   * nobody, and a pass over one work must not settle that question behind the owner's back.
   */
  async findClaimedBookKeys(monitorId: string, exceptWorkIds: string[]): Promise<Set<string>> {
    const works = schema.authorCatalogWorks;
    const rows = await this.db
      .select({
        ebook: works.matchedEbookBookId,
        audiobook: works.matchedAudioBookId,
        possibleEbook: works.possibleEbookBookId,
        possibleAudiobook: works.possibleAudioBookId,
        linkedFormats: works.linkedFormats,
      })
      .from(works)
      .where(and(eq(works.monitorAuthorId, monitorId), exceptWorkIds.length > 0 ? notInArray(works.id, exceptWorkIds) : undefined));
    const keys = new Set<string>();
    for (const row of rows) {
      const linked = new Set(row.linkedFormats ?? []);
      if (row.ebook != null && !linked.has('ebook')) keys.add(`${row.ebook}|ebook`);
      if (row.audiobook != null && !linked.has('audiobook')) keys.add(`${row.audiobook}|audiobook`);
      if (row.possibleEbook != null) keys.add(`${row.possibleEbook}|ebook`);
      if (row.possibleAudiobook != null) keys.add(`${row.possibleAudiobook}|audiobook`);
    }
    return keys;
  }

  async findMatchHolders(
    monitorId: string,
    bookId: number,
    format: MonitoredFormat,
    exceptWorkId: string,
  ): Promise<Omit<MonitoredMatchHolder, 'sharesAnswers'>[]> {
    const works = schema.authorCatalogWorks;
    const column = format === 'audiobook' ? works.matchedAudioBookId : works.matchedEbookBookId;
    const rows = await this.db
      .select({ monitorId: works.monitorAuthorId, workId: works.id, title: works.title, linkedFormats: works.linkedFormats })
      .from(works)
      .where(and(eq(works.monitorAuthorId, monitorId), eq(column, bookId), ne(works.id, exceptWorkId)))
      .orderBy(asc(works.title))
      .limit(20);
    return rows.map((row) => ({
      monitorId: row.monitorId,
      workId: row.workId,
      title: row.title,
      linkedByHand: (row.linkedFormats ?? []).includes(format),
    }));
  }

  async saveCatalog(monitorId: string, catalog: MonitoredCatalog | null, options: { enrolReleaseProbes?: boolean } = {}): Promise<void> {
    await this.db.transaction(async (tx) => {
      await recordRequestLedger(tx, monitorId);
      await recordChoiceLedger(tx, monitorId);
      if (catalog === null) {
        await tx.delete(schema.authorCatalogState).where(eq(schema.authorCatalogState.monitorAuthorId, monitorId));
        await tx.delete(schema.authorCatalogWorks).where(eq(schema.authorCatalogWorks.monitorAuthorId, monitorId));
        return;
      }
      await tx
        .insert(schema.authorCatalogState)
        .values({ monitorAuthorId: monitorId, fetchedAt: new Date(catalog.fetchedAt) })
        .onConflictDoUpdate({ target: schema.authorCatalogState.monitorAuthorId, set: { fetchedAt: new Date(catalog.fetchedAt) } });
      const ids = catalog.works.map((work) => work.id);
      // Only works this save adds may take recorded choices; the ones already here keep their own.
      const previousWorkIds = (
        await tx
          .select({ id: schema.authorCatalogWorks.id })
          .from(schema.authorCatalogWorks)
          .where(eq(schema.authorCatalogWorks.monitorAuthorId, monitorId))
      ).map((row) => row.id);
      await tx
        .delete(schema.authorCatalogWorks)
        .where(
          ids.length
            ? and(eq(schema.authorCatalogWorks.monitorAuthorId, monitorId), notInArray(schema.authorCatalogWorks.id, ids))
            : eq(schema.authorCatalogWorks.monitorAuthorId, monitorId),
        );
      if (!catalog.works.length) {
        await reapplyReleaseOverlay(tx, monitorId);
        if (options.enrolReleaseProbes) await enrolReleaseProbes(tx, monitorId, catalog.fetchedAt.slice(0, 10));
        return;
      }
      for (const values of chunk(
        catalog.works.map((work) => this.workValues(monitorId, work)),
        WRITE_BATCH_SIZE,
      )) {
        await tx
          .insert(schema.authorCatalogWorks)
          .values(values)
          .onConflictDoUpdate({
            target: schema.authorCatalogWorks.id,
            set: {
              monitorAuthorId: sql`excluded.monitor_author_id`,
              title: sql`excluded.title`,
              subtitle: sql`excluded.subtitle`,
              seriesName: sql`excluded.series_name`,
              seriesIndex: sql`excluded.series_index`,
              seriesMemberships: sql`excluded.series_memberships`,
              releaseYear: sql`excluded.release_year`,
              ebookReleaseDate: sql`excluded.ebook_release_date`,
              ebookDatePrecision: sql`excluded.ebook_date_precision`,
              audioReleaseDate: sql`excluded.audio_release_date`,
              audioDatePrecision: sql`excluded.audio_date_precision`,
              coverUrl: sql`excluded.cover_url`,
              description: sql`excluded.description`,
              verdict: sql`excluded.verdict`,
              flags: sql`excluded.flags`,
              kind: sql`excluded.kind`,
              sources: sql`excluded.sources`,
              matchedBookId: sql`excluded.matched_book_id`,
              matchedEbookBookId: sql`excluded.matched_ebook_book_id`,
              matchedAudioBookId: sql`excluded.matched_audio_book_id`,
              ownedFormats: sql`excluded.owned_formats`,
              linkedFormats: sql`excluded.linked_formats`,
              answeredFormats: sql`excluded.answered_formats`,
              possibleEbookBookId: sql`excluded.possible_ebook_book_id`,
              possibleAudioBookId: sql`excluded.possible_audio_book_id`,
            },
          });
      }
      await tx.delete(schema.authorCatalogSourceWorks).where(inArray(schema.authorCatalogSourceWorks.workId, ids));
      const sources = catalog.works.flatMap((work) => this.sourceValues(work));
      for (const batch of chunk(sources, WRITE_BATCH_SIZE)) await tx.insert(schema.authorCatalogSourceWorks).values(batch);
      await restoreRequestLedger(tx, monitorId);
      await restoreChoiceLedger(tx, monitorId, previousWorkIds);
      await reapplyReleaseOverlay(tx, monitorId);
      if (options.enrolReleaseProbes) await enrolReleaseProbes(tx, monitorId, catalog.fetchedAt.slice(0, 10));
    });
  }

  /**
   * Monitors the release watcher should look at, oldest check first so a big instance works through
   * them evenly instead of starving the tail. A monitor with both formats off is excluded: nothing
   * it holds could produce a release anybody asked to hear about.
   */
  async findMonitorsDueForReleaseCheck(limit: number): Promise<Array<{ monitor: MonitoredAuthorConfig; lastReleaseCheckAt: Date | null }>> {
    const rows = await this.db
      .select()
      .from(schema.monitoredAuthors)
      .where(
        and(
          ne(schema.monitoredAuthors.paused, true),
          or(ne(schema.monitoredAuthors.ebookMode, 'off'), ne(schema.monitoredAuthors.audiobookMode, 'off')),
        ),
      )
      .orderBy(sql`${schema.monitoredAuthors.lastReleaseCheckAt} asc nulls first`, asc(schema.monitoredAuthors.id))
      .limit(limit);
    const monitors = await this.composeAuthors(rows);
    return monitors.map((monitor, index) => ({ monitor, lastReleaseCheckAt: rows[index]?.lastReleaseCheckAt ?? null }));
  }

  /**
   * Monitors whose latest sync attempt or refresh is older than the interval, staleness first.
   */
  async findMonitorsDueForSync(staleBefore: Date, limit: number): Promise<MonitoredAuthorConfig[]> {
    const now = new Date();
    const lastAttempt = sql`greatest(${schema.monitoredAuthors.lastSyncAttemptedAt}, ${schema.monitoredAuthors.lastRefreshedAt})`;
    const rows = await this.db
      .select()
      .from(schema.monitoredAuthors)
      .where(dueForAutomaticFetchSql(now, (now.getTime() - staleBefore.getTime()) / 3_600_000))
      .orderBy(sql`${lastAttempt} asc nulls first`, asc(schema.monitoredAuthors.id))
      .limit(limit);
    return this.composeAuthors(rows);
  }

  async countMonitorsDueForSync(staleBefore: Date): Promise<number> {
    const now = new Date();
    const [row] = await this.db
      .select({ total: count() })
      .from(schema.monitoredAuthors)
      .where(dueForAutomaticFetchSql(now, (now.getTime() - staleBefore.getTime()) / 3_600_000));
    return Number(row?.total ?? 0);
  }

  /** Null when the release watcher has never swept this monitor, which is what triggers seeding. */
  async findReleaseCheckStamp(monitorId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ lastReleaseCheckAt: schema.monitoredAuthors.lastReleaseCheckAt })
      .from(schema.monitoredAuthors)
      .where(eq(schema.monitoredAuthors.id, monitorId))
      .limit(1);
    return row?.lastReleaseCheckAt ?? null;
  }

  /**
   * Works of one monitor whose release window has opened since the owner started monitoring, in a
   * format they do not already own and have not been told about.
   *
   * The window is `[monitor.addedAt, today]` on purpose, for every mode including `auto-all`. A
   * back-catalog book is not news: `auto-all` may legitimately go and fetch it, but announcing that
   * a twenty-year-old novel is "out now" is never right.
   *
   * A row whose ledger entry exists but never got its `notifiedAt` stamp comes back again - that is
   * the retry for a dispatch that threw, and it costs one extra arm on the join rather than a
   * second pass.
   */
  async findDueReleases(params: {
    owner: RequestUser;
    monitor: MonitoredAuthorConfig;
    today: string;
    limit: number;
  }): Promise<MonitoredDueRelease[]> {
    const { monitor, today } = params;
    const addedDay = monitor.addedAt.slice(0, 10);
    if (addedDay > today) return [];
    const libraryIds = params.owner.isSuperuser ? null : await this.libraries.findAccessibleLibraryIds(params.owner);
    const visible = visibleWorkCondition();
    const active = activeWorkCondition(visible);

    const leg = (format: MonitoredFormat): SQL => {
      const isEbook = format === 'ebook';
      const date = isEbook ? schema.authorCatalogWorks.ebookReleaseDate : schema.authorCatalogWorks.audioReleaseDate;
      const precision = isEbook ? schema.authorCatalogWorks.ebookDatePrecision : schema.authorCatalogWorks.audioDatePrecision;
      const mode = isEbook ? schema.monitoredAuthors.ebookMode : schema.monitoredAuthors.audiobookMode;
      const toggle = isEbook ? schema.monitoredAuthorWorks.monitorEbook : schema.monitoredAuthorWorks.monitorAudiobook;
      const owned = this.ownedFormatCondition(format, libraryIds);
      const where = and(
        eq(schema.monitoredAuthors.id, monitor.id),
        active,
        ne(mode, 'off'),
        or(ne(toggle, false), sql`${toggle} is null`),
        releaseDueSql(date, precision, addedDay, today),
        sql`not ${owned}`,
        sql`(${schema.monitoredReleaseEvents.workId} is null or ${schema.monitoredReleaseEvents.notifiedAt} is null)`,
        sql`not exists (
          select 1 from ${schema.monitoredReleaseEvents} as prior_release
          where prior_release.monitor_author_id = ${monitor.id}
            and prior_release.format = ${format}
            and prior_release.notified_at is not null
            and (
              (prior_release.title is not null
                and lower(public.bookorbit_unaccent(prior_release.title)) = lower(public.bookorbit_unaccent(${schema.authorCatalogWorks.title})))
              or prior_release.identity_keys && ${workProviderKeysSql(sql`${schema.authorCatalogWorks.id}`)}
            )
        )`,
      );
      return sql`
        select
          ${schema.authorCatalogWorks.id} as "workId",
          ${schema.authorCatalogWorks.title} as title,
          ${schema.authorCatalogWorks.seriesName} as "seriesName",
          ${schema.authorCatalogWorks.seriesIndex} as "seriesIndex",
          ${format}::text as format,
          ${workProviderKeysSql(sql`${schema.authorCatalogWorks.id}`)} as "identityKeys",
          ${releaseRangeStartSql(date, precision)} as "releaseDate",
          ${date} as "storedDate",
          (${schema.monitoredReleaseEvents.workId} is not null) as "claimed"
        from ${schema.authorCatalogWorks}
        inner join ${schema.monitoredAuthors}
          on ${schema.monitoredAuthors.id} = ${schema.authorCatalogWorks.monitorAuthorId}
        left join ${schema.monitoredAuthorWorks}
          on ${schema.monitoredAuthorWorks.workId} = ${schema.authorCatalogWorks.id}
        left join ${schema.monitoredReleaseEvents}
          on ${schema.monitoredReleaseEvents.workId} = ${schema.authorCatalogWorks.id}
          and ${schema.monitoredReleaseEvents.format} = ${format}
        where ${where}
      `;
    };

    const result = await this.db.execute<MonitoredDueRelease>(
      sql`${leg('ebook')} union all ${leg('audiobook')} order by "releaseDate" asc, "workId" asc limit ${params.limit}`,
    );
    return result.rows;
  }

  /**
   * Writes missing ledger rows. Dispatch ownership is established separately by leasing notifiedAt.
   */
  async claimReleaseEvents(monitor: MonitoredAuthorConfig, releases: MonitoredDueRelease[], notify: boolean): Promise<Set<string>> {
    const won = new Set<string>();
    const fresh = releases.filter((release) => !release.claimed);
    if (!fresh.length) return won;
    const detectedAt = new Date();
    for (const batch of chunk(fresh, WRITE_BATCH_SIZE)) {
      const inserted = await this.db
        .insert(schema.monitoredReleaseEvents)
        .values(
          batch.map((release) => ({
            workId: release.workId,
            monitorAuthorId: monitor.id,
            ownerUserId: monitor.ownerUserId,
            format: release.format,
            title: release.title,
            identityKeys: release.identityKeys,
            releaseDate: release.releaseDate,
            detectedAt,
            // A seeding pass records the release without announcing it, so the row is born notified.
            notifiedAt: notify ? null : detectedAt,
          })),
        )
        .onConflictDoNothing()
        .returning({ workId: schema.monitoredReleaseEvents.workId, format: schema.monitoredReleaseEvents.format });
      for (const row of inserted) won.add(releaseEventKey(row.workId, row.format));
    }
    return won;
  }

  async leaseReleaseEvent(workId: string, format: MonitoredFormat, ownerUserId: number): Promise<boolean> {
    const rows = await this.db
      .update(schema.monitoredReleaseEvents)
      .set({ notifiedAt: sql`now()` })
      .where(
        and(
          eq(schema.monitoredReleaseEvents.workId, workId),
          eq(schema.monitoredReleaseEvents.format, format),
          eq(schema.monitoredReleaseEvents.ownerUserId, ownerUserId),
          sql`${schema.monitoredReleaseEvents.notifiedAt} is null`,
        ),
      )
      .returning({ workId: schema.monitoredReleaseEvents.workId });
    return rows.length > 0;
  }

  async releaseReleaseEventLease(workId: string, format: MonitoredFormat, ownerUserId: number): Promise<void> {
    await this.db
      .update(schema.monitoredReleaseEvents)
      .set({ notifiedAt: null })
      .where(
        and(
          eq(schema.monitoredReleaseEvents.workId, workId),
          eq(schema.monitoredReleaseEvents.format, format),
          eq(schema.monitoredReleaseEvents.ownerUserId, ownerUserId),
        ),
      );
  }

  async stampReleaseCheck(monitorId: string, at: Date): Promise<void> {
    await this.db.update(schema.monitoredAuthors).set({ lastReleaseCheckAt: at }).where(eq(schema.monitoredAuthors.id, monitorId));
  }

  async stampSyncAttempt(monitorId: string, at: Date): Promise<void> {
    await this.db.update(schema.monitoredAuthors).set({ lastSyncAttemptedAt: at }).where(eq(schema.monitoredAuthors.id, monitorId));
  }

  private releaseRowsSql(params: {
    kinds?: MonitoredMarkKind[];
    more?: MonitoredReviewFlag[];
    viewer: RequestUser;
    q?: string;
    filter: MonitoredReleaseFilter;
    earliest: string;
    latest: string;
    today: string;
    soonLatest: string;
    currentYear: string;
    status?: MonitoredStatusFilter[];
    libraryIds?: number[] | null;
  }): SQL {
    const authorScope = this.readScope(params.viewer, schema.monitoredAuthors.ownerUserId);
    const visible = visibleWorkCondition();
    const selection: MonitoredClassSelection = { kinds: params.kinds ?? ['book'], more: params.more ?? [] };
    const defaultSelection = isDefaultClassSelection(selection);
    const buckets = params.status?.filter((status) => status !== 'hidden');
    const statusFilters = buckets?.length ? buckets : null;
    const active = activeWorkCondition(defaultSelection ? visible : sql<boolean>`true`);
    const book = bookClassSql();
    const review = sql<boolean>`(${classSelectionMatchSql(selection)} and not ${book})`;
    const probes: Record<MonitoredFormat, ReleaseProbeAlias> = {
      ebook: releaseProbeAlias('ebook_probe'),
      audiobook: releaseProbeAlias('audiobook_probe'),
    };
    const effective = {
      ebook: this.effectiveReleaseSql(probes.ebook, schema.authorCatalogWorks.ebookReleaseDate, schema.authorCatalogWorks.ebookDatePrecision),
      audiobook: this.effectiveReleaseSql(probes.audiobook, schema.authorCatalogWorks.audioReleaseDate, schema.authorCatalogWorks.audioDatePrecision),
    };
    const undated = sql<boolean>`(${schema.monitoredAuthors.ebookMode} = 'off' or ${effective.ebook.date} is null)
      and (${schema.monitoredAuthors.audiobookMode} = 'off' or ${effective.audiobook.date} is null)`;
    const rowClass = (format: MonitoredFormat, date: AnyPgColumn, precision: AnyPgColumn, watched: SQL | undefined) => {
      const window = releaseRangeOverlapsSql(date, precision, params.earliest, params.latest);
      if (defaultSelection) return [watched, window];
      return [
        or(
          selection.kinds.includes('book') ? and(book, watched, window) : undefined,
          and(review, or(sql`${effective[format].date} is not null`, undated)),
        ),
      ];
    };
    const timeFilter = (format: MonitoredFormat, date: AnyPgColumn, precision: AnyPgColumn) =>
      defaultSelection
        ? this.releaseTimeFilterSql(date, precision, params)
        : this.releaseTimeFilterSql(effective[format].date, effective[format].precision, params);
    const statusMatch = (format: MonitoredFormat) =>
      statusFilters ? this.releaseStatusMatchSql(format, probes[format], statusFilters, params.today, params.libraryIds ?? null) : undefined;
    const ebookWatched = statusFilters
      ? undefined
      : or(ne(schema.monitoredAuthorWorks.monitorEbook, false), sql`${schema.monitoredAuthorWorks.monitorEbook} is null`);
    const audiobookWatched = statusFilters
      ? undefined
      : or(ne(schema.monitoredAuthorWorks.monitorAudiobook, false), sql`${schema.monitoredAuthorWorks.monitorAudiobook} is null`);
    const qPattern = params.q ? buildSearchPattern(params.q) : null;
    const search = qPattern
      ? or(accentInsensitiveIlike(schema.authorCatalogWorks.title, qPattern), accentInsensitiveIlike(schema.monitoredAuthors.authorName, qPattern))
      : undefined;
    const ebook = and(
      ne(schema.monitoredAuthors.ebookMode, 'off'),
      ...rowClass('ebook', schema.authorCatalogWorks.ebookReleaseDate, schema.authorCatalogWorks.ebookDatePrecision, ebookWatched),
      timeFilter('ebook', schema.authorCatalogWorks.ebookReleaseDate, schema.authorCatalogWorks.ebookDatePrecision),
      statusMatch('ebook'),
    );
    const audiobook = and(
      ne(schema.monitoredAuthors.audiobookMode, 'off'),
      ...rowClass('audiobook', schema.authorCatalogWorks.audioReleaseDate, schema.authorCatalogWorks.audioDatePrecision, audiobookWatched),
      timeFilter('audiobook', schema.authorCatalogWorks.audioReleaseDate, schema.authorCatalogWorks.audioDatePrecision),
      statusMatch('audiobook'),
    );
    const joins = (format: MonitoredFormat) => sql`
      from ${schema.authorCatalogWorks}
      inner join ${schema.monitoredAuthors}
        on ${schema.monitoredAuthors.id} = ${schema.authorCatalogWorks.monitorAuthorId}
      inner join ${schema.authorCatalogState}
        on ${schema.authorCatalogState.monitorAuthorId} = ${schema.monitoredAuthors.id}
      left join ${schema.monitoredAuthorWorks}
        on ${schema.monitoredAuthorWorks.workId} = ${schema.authorCatalogWorks.id}
      ${defaultSelection ? (statusFilters ? probes[format].join(format) : sql``) : sql`${probes.ebook.join('ebook')} ${probes.audiobook.join('audiobook')}`}
    `;
    return sql`
      select
        ${schema.authorCatalogWorks.id} as "workId",
        ${schema.monitoredAuthors.id} as "monitorAuthorId",
        'ebook'::text as format,
        ${defaultSelection ? schema.authorCatalogWorks.ebookReleaseDate : effective.ebook.date} as "releaseDate",
        ${schema.authorCatalogWorks.title} as title,
        ${schema.monitoredAuthors.authorName} as "authorName"
      ${joins('ebook')}
      where ${and(authorScope, active, search, ebook)}
      union all
      select
        ${schema.authorCatalogWorks.id} as "workId",
        ${schema.monitoredAuthors.id} as "monitorAuthorId",
        'audiobook'::text as format,
        ${defaultSelection ? schema.authorCatalogWorks.audioReleaseDate : effective.audiobook.date} as "releaseDate",
        ${schema.authorCatalogWorks.title} as title,
        ${schema.monitoredAuthors.authorName} as "authorName"
      ${joins('audiobook')}
      where ${and(authorScope, active, search, audiobook)}
    `;
  }

  /** Status buckets apply to every selected class; the date fallback includes undated formats in upcoming. */
  private releaseStatusMatchSql(
    format: MonitoredFormat,
    probe: ReleaseProbeAlias,
    filters: readonly MonitoredStatusFilter[],
    today: string,
    libraryIds: number[] | null,
  ): SQL<boolean> {
    const isEbook = format === 'ebook';
    const requestId = isEbook ? schema.monitoredAuthorWorks.ebookRequestId : schema.monitoredAuthorWorks.audiobookRequestId;
    const monitorFormat = isEbook ? schema.monitoredAuthorWorks.monitorEbook : schema.monitoredAuthorWorks.monitorAudiobook;
    const catalogDate = isEbook ? schema.authorCatalogWorks.ebookReleaseDate : schema.authorCatalogWorks.audioReleaseDate;
    const catalogPrecision = isEbook ? schema.authorCatalogWorks.ebookDatePrecision : schema.authorCatalogWorks.audioDatePrecision;
    const { date, precision } = this.effectiveReleaseSql(probe, catalogDate, catalogPrecision);
    const requestStatus = sql`(select ${dbSchema.bookRequests.status} from ${dbSchema.bookRequests} where ${dbSchema.bookRequests.id} = ${requestId})`;
    const category = sql<string>`case
      when ${this.ownedFormatCondition(format, libraryIds)} then 'in_library'
      when ${requestStatus} in (${sqlList(IN_PROGRESS_REQUEST_STATUSES)}) then 'in_progress'
      when ${requestStatus} in (${sqlList(ATTENTION_REQUEST_STATUSES)}) then 'needs_attention'
      when ${monitorFormat} = false then 'not_watched'
      when ${releaseStartedSql(date, precision, today)} then 'missing'
      else 'upcoming'
    end`;
    const buckets = filters.filter((filter) => filter !== 'hidden');
    return buckets.length ? sql<boolean>`${category} in (${sqlList(buckets)})` : sql<boolean>`true`;
  }

  /**
   * The date a format is expected on, as `monitoredFormatReleaseDate` reads it: a probe row that
   * says the format is unlisted means no date, a probe row with a date beats the catalog column
   * and brings its own precision, and anything else falls back to the catalog column.
   */
  private effectiveReleaseSql(
    probe: ReleaseProbeAlias,
    catalogDate: AnyPgColumn,
    catalogPrecision: AnyPgColumn,
  ): { date: SQL<string>; precision: SQL<string> } {
    const probeDate = sql`nullif(${probe.releaseDate}, '')`;
    return {
      date: sql<string>`case when ${probe.status} = 'unlisted' then null when ${probeDate} is not null then ${probeDate} else ${catalogDate} end`,
      precision: sql<string>`case when ${probe.status} = 'unlisted' then null when ${probeDate} is not null then ${probe.datePrecision} else ${catalogPrecision} end`,
    };
  }

  private releaseTimeFilterSql(
    date: AnyPgColumn | SQL,
    precision: AnyPgColumn | SQL,
    params: { filter: MonitoredReleaseFilter; today: string; soonLatest: string; currentYear: string },
  ): SQL {
    const start = releaseRangeStartSql(date, precision);
    if (params.filter === 'recent') return sql`${start} <= ${params.today}`;
    if (params.filter === 'soon') return sql`${start} > ${params.today} and ${start} <= ${params.soonLatest}`;
    if (params.filter === 'year') return sql`left(${date}, 4) = ${params.currentYear}`;
    return sql`true`;
  }

  async countSummary(viewer: RequestUser, earliest: string, latest: string, today: string): Promise<MonitoredCounts> {
    const authorScope = this.readScope(viewer, schema.monitoredAuthors.ownerUserId);
    const visible = visibleWorkCondition();
    const active = activeWorkCondition(visible);
    const ebook = and(
      ne(schema.monitoredAuthors.ebookMode, 'off'),
      or(ne(schema.monitoredAuthorWorks.monitorEbook, false), sql`${schema.monitoredAuthorWorks.monitorEbook} is null`),
      releaseRangeOverlapsSql(schema.authorCatalogWorks.ebookReleaseDate, schema.authorCatalogWorks.ebookDatePrecision, earliest, latest),
    );
    const audio = and(
      ne(schema.monitoredAuthors.audiobookMode, 'off'),
      or(ne(schema.monitoredAuthorWorks.monitorAudiobook, false), sql`${schema.monitoredAuthorWorks.monitorAudiobook} is null`),
      releaseRangeOverlapsSql(schema.authorCatalogWorks.audioReleaseDate, schema.authorCatalogWorks.audioDatePrecision, earliest, latest),
    );
    const ebookReleased = releasedBySql(schema.authorCatalogWorks.ebookReleaseDate, today);
    const audioReleased = releasedBySql(schema.authorCatalogWorks.audioReleaseDate, today);
    const anyReleased = sql`(${ebook} and ${ebookReleased}) or (${audio} and ${audioReleased})`;
    const anyUpcoming = sql`(${ebook} and not ${ebookReleased}) or (${audio} and not ${audioReleased})`;
    const [[authors], [books], [releases]] = await Promise.all([
      this.db.select({ value: count() }).from(schema.monitoredAuthors).where(authorScope),
      this.bookSummaryQuery(viewer),
      this.db
        .select({
          value: sql<number>`coalesce(sum((case when ${ebook} then 1 else 0 end) + (case when ${audio} then 1 else 0 end)), 0)::int`,
          byStatus: sql<number>`coalesce(sum((case when ${anyReleased} then 1 else 0 end) + (case when ${anyUpcoming} then 1 else 0 end)), 0)::int`,
          byWork: sql<number>`coalesce(sum(case when ${ebook} or ${audio} then 1 else 0 end), 0)::int`,
        })
        .from(schema.authorCatalogWorks)
        .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
        .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
        .where(and(authorScope, active)),
    ]);
    return {
      authors: authors.value,
      books: books.value,
      releases: releases.value,
      releaseCards: { byStatus: releases.byStatus, byWork: releases.byWork },
    };
  }

  async countWorkClasses(viewer: RequestUser): Promise<MonitoredDisplayClassCounts> {
    const classKey = workClassKeySql();
    const unconfirmed = unconfirmedWorkSql();
    const rows = await this.db
      .select({ classKey: sql<string>`${classKey}`, unconfirmed: sql<boolean>`${unconfirmed}`, total: sql<number>`count(*)::int` })
      .from(schema.authorCatalogWorks)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
      .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
      .where(and(this.readScope(viewer, schema.monitoredAuthors.ownerUserId), activeWorkCondition(sql`true`)))
      // Ordinals, because the repeated expressions carry separate bind params and Postgres cannot match them to the select list.
      .groupBy(sql`1`, sql`2`);
    const counts = countWorkClasses([]);
    for (const row of rows) {
      const total = Number(row.total);
      if (row.classKey === 'hidden' || row.classKey === 'placeholder') counts[row.classKey] += total;
      else if (row.classKey in counts.kinds) counts.kinds[row.classKey as MonitoredMarkKind] += total;
      if (row.unconfirmed) counts.unconfirmed += total;
    }
    return counts;
  }

  private bookSummaryQuery(viewer: RequestUser) {
    const bookScope = this.readScope(viewer, schema.monitoredBooks.ownerUserId);
    const authorScope = this.readScope(viewer, schema.monitoredAuthors.ownerUserId);
    return this.db
      .select({ value: count() })
      .from(schema.monitoredBooks)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.monitoredBooks.monitorAuthorId))
      .innerJoin(
        schema.authorCatalogWorks,
        and(
          eq(schema.authorCatalogWorks.id, schema.monitoredBooks.workId),
          eq(schema.authorCatalogWorks.monitorAuthorId, schema.monitoredBooks.monitorAuthorId),
        ),
      )
      .where(and(bookScope, authorScope));
  }

  private ownedFormatCondition(format: 'ebook' | 'audiobook', libraryIds: number[] | null) {
    const matchedBookId = format === 'ebook' ? schema.authorCatalogWorks.matchedEbookBookId : schema.authorCatalogWorks.matchedAudioBookId;
    const requestId = format === 'ebook' ? schema.monitoredAuthorWorks.ebookRequestId : schema.monitoredAuthorWorks.audiobookRequestId;
    const hasOwnedFormat = sql`${schema.authorCatalogWorks.ownedFormats} @> ${JSON.stringify([format])}::jsonb`;
    const requestFiled = sql<boolean>`exists (
      select 1 from ${dbSchema.bookRequests}
      where ${dbSchema.bookRequests.id} = ${requestId}
        and ${dbSchema.bookRequests.status} = 'available'
        and ${dbSchema.bookRequests.matchedBookId} is not null
    )`;
    if (libraryIds === null) return or(and(hasOwnedFormat, sql`${matchedBookId} is not null`), requestFiled)!;
    if (!libraryIds.length) return sql<boolean>`false`;
    return and(
      or(
        and(
          hasOwnedFormat,
          sql`exists (
            select 1 from ${upstreamBooks}
            where ${upstreamBooks.id} = ${matchedBookId}
              and ${inArray(upstreamBooks.libraryId, libraryIds)}
          )`,
        ),
        sql`exists (
          select 1 from ${dbSchema.bookRequests}
          inner join ${upstreamBooks} on ${upstreamBooks.id} = ${dbSchema.bookRequests.matchedBookId}
          where ${dbSchema.bookRequests.id} = ${requestId}
            and ${dbSchema.bookRequests.status} = 'available'
            and ${inArray(upstreamBooks.libraryId, libraryIds)}
        )`,
      ),
    )!;
  }

  private async composeAuthors(rows: MonitoredAuthorRow[]): Promise<MonitoredAuthorConfig[]> {
    if (!rows.length) return [];
    const identities = await this.db
      .select()
      .from(schema.authorProviderIdentities)
      .where(
        inArray(
          schema.authorProviderIdentities.monitorAuthorId,
          rows.map((row) => row.id),
        ),
      );
    const byAuthor = new Map<string, Array<typeof schema.authorProviderIdentities.$inferSelect>>();
    for (const identity of identities) {
      byAuthor.set(identity.monitorAuthorId, [...(byAuthor.get(identity.monitorAuthorId) ?? []), identity]);
    }
    return rows.map((row) => ({
      id: row.id,
      ownerUserId: row.ownerUserId,
      authorName: row.authorName,
      localAuthorId: row.localAuthorId,
      providerIds: Object.fromEntries((byAuthor.get(row.id) ?? []).map((identity) => [identity.source, identity.providerId])),
      formats: {
        ebook: { mode: row.ebookMode, libraryId: row.ebookLibraryId, folderId: row.ebookFolderId },
        audiobook: { mode: row.audiobookMode, libraryId: row.audiobookLibraryId, folderId: row.audiobookFolderId },
      },
      paused: row.paused,
      addedAt: row.addedAt.toISOString(),
      lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
      fetch: {
        state: row.fetchState,
        errorKind: row.fetchErrorKind,
        errorAt: row.fetchErrorAt?.toISOString() ?? null,
        retryAt: row.fetchRetryAt?.toISOString() ?? null,
      },
    }));
  }

  private async composeWorks(
    rows: AuthorCatalogWorkRow[],
    viewer?: RequestUser,
    retainHiddenForOwnershipCheck = false,
  ): Promise<Array<{ monitorAuthorId: string; work: MonitoredWork }>> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [sources, overlays, releases] = await Promise.all([
      this.db.select().from(schema.authorCatalogSourceWorks).where(inArray(schema.authorCatalogSourceWorks.workId, ids)),
      this.db.select().from(schema.monitoredAuthorWorks).where(inArray(schema.monitoredAuthorWorks.workId, ids)),
      this.db.select().from(schema.authorCatalogWorkReleases).where(inArray(schema.authorCatalogWorkReleases.workId, ids)),
    ]);
    const overlayMap = new Map(overlays.map((overlay) => [overlay.workId, overlay]));
    const sourceMap = new Map<string, Array<typeof schema.authorCatalogSourceWorks.$inferSelect>>();
    for (const source of sources) sourceMap.set(source.workId, [...(sourceMap.get(source.workId) ?? []), source]);
    const releaseMap = new Map<string, Array<typeof schema.authorCatalogWorkReleases.$inferSelect>>();
    for (const release of releases) releaseMap.set(release.workId, [...(releaseMap.get(release.workId) ?? []), release]);
    const requestIds = [
      ...new Set(overlays.flatMap((overlay) => [overlay.ebookRequestId, overlay.audiobookRequestId]).filter((id): id is number => id != null)),
    ];
    // Only the accessible-book read depends on the requests, so the ownership read runs beside them
    // rather than behind: a works page is a hot path and this keeps it at two waits, not three.
    const [requestRows, ownedMonitorIds, possibleBooks] = await Promise.all([
      this.requestProjections(requestIds),
      this.ownedMonitorIds(rows, viewer),
      this.possibleMatchBooks(rows),
    ]);
    const requestMap = new Map(requestRows.map((request) => [request.id, request]));
    const requestedBookIds = requestRows.map((request) => request.matchedBookId).filter((id): id is number => id != null);
    const accessibleBooks = await this.accessibleMatchedBooks(rows, requestedBookIds, viewer);
    return rows.flatMap((row) => {
      const overlay = overlayMap.get(row.id);
      const isOwner = ownedMonitorIds === null || ownedMonitorIds.has(row.monitorAuthorId);
      if (!retainHiddenForOwnershipCheck && !isOwner && overlay?.userVisibility === 'hidden') return [];
      return [
        {
          monitorAuthorId: row.monitorAuthorId,
          work: this.composeWork(
            row,
            sourceMap.get(row.id) ?? [],
            overlay,
            accessibleBooks,
            isOwner,
            requestMap,
            releaseMap.get(row.id) ?? [],
            possibleBooks,
          ),
        },
      ];
    });
  }

  /** Monitor ids the viewer owns, or null when every row is theirs to read in full. */
  private async ownedMonitorIds(rows: AuthorCatalogWorkRow[], viewer?: RequestUser): Promise<Set<string> | null> {
    if (!viewer || viewer.isSuperuser) return null;
    const monitorIds = [...new Set(rows.map((row) => row.monitorAuthorId))];
    const owned = await this.db
      .select({ id: schema.monitoredAuthors.id })
      .from(schema.monitoredAuthors)
      .where(and(inArray(schema.monitoredAuthors.id, monitorIds), eq(schema.monitoredAuthors.ownerUserId, viewer.id)));
    return new Set(owned.map((row) => row.id));
  }

  private composeWork(
    row: AuthorCatalogWorkRow,
    sources: Array<typeof schema.authorCatalogSourceWorks.$inferSelect>,
    overlay: MonitoredAuthorWorkRow | undefined,
    accessibleBooks: Set<number> | null,
    isOwner = true,
    requests = new Map<number, RequestProjection>(),
    releases: Array<typeof schema.authorCatalogWorkReleases.$inferSelect> = [],
    possibleBooks = new Map<number, MonitoredPossibleMatch>(),
  ): MonitoredWork {
    const ebookRequest = overlay?.ebookRequestId == null ? undefined : requests.get(overlay.ebookRequestId);
    const audiobookRequest = overlay?.audiobookRequestId == null ? undefined : requests.get(overlay.audiobookRequestId);
    const accessible = (bookId: number | null | undefined): bookId is number => bookId != null && (!accessibleBooks || accessibleBooks.has(bookId));
    // A format the owner answered about by hand is settled by the stored match, so the book a request
    // filed cannot bring back a match the owner rejected or replace one they linked.
    const answered = (format: MonitoredFormat) => row.answeredFormats.includes(format);
    const filedEbookId =
      !answered('ebook') && ebookRequest?.status === 'available' && accessible(ebookRequest.matchedBookId) ? ebookRequest.matchedBookId : undefined;
    const filedAudioId =
      !answered('audiobook') && audiobookRequest?.status === 'available' && accessible(audiobookRequest.matchedBookId)
        ? audiobookRequest.matchedBookId
        : undefined;
    const storedEbookId = accessible(row.matchedEbookBookId) ? row.matchedEbookBookId : undefined;
    const storedAudioId = accessible(row.matchedAudioBookId) ? row.matchedAudioBookId : undefined;
    const ebookId = filedEbookId ?? storedEbookId;
    const audioId = filedAudioId ?? storedAudioId;
    // Same precedence the catalog persists when it writes the primary match, so a filed request
    // cannot make the audiobook the primary of a work whose ebook is already in the library.
    const matchedBookId = ebookId ?? audioId ?? (accessible(row.matchedBookId) ? row.matchedBookId : null);
    const ownedFormats = row.ownedFormats.filter((format) => (format === 'ebook' ? storedEbookId != null : storedAudioId != null));
    if (filedEbookId != null && !ownedFormats.includes('ebook')) ownedFormats.push('ebook');
    if (filedAudioId != null && !ownedFormats.includes('audiobook')) ownedFormats.push('audiobook');
    // Only the owner can answer a possible match, and a format already in the library has no question left.
    const possibleFor = (bookId: number | null, ownedId: number | undefined) =>
      isOwner && ownedId == null && accessible(bookId) ? possibleBooks.get(bookId) : undefined;
    const possibleEbook = possibleFor(row.possibleEbookBookId, ebookId);
    const possibleAudio = possibleFor(row.possibleAudioBookId, audioId);
    const userKind = isOwner ? overlay?.userKind : null;
    const effectiveKind = userKind === 'book' ? undefined : (userKind ?? row.kind ?? undefined);
    return {
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      seriesName: row.seriesName,
      seriesIndex: row.seriesIndex,
      seriesMemberships: row.seriesMemberships,
      releaseYear: row.releaseYear,
      ebookReleaseDate: row.ebookReleaseDate,
      ebookDatePrecision: row.ebookDatePrecision,
      audioReleaseDate: row.audioReleaseDate,
      audioDatePrecision: row.audioDatePrecision,
      ...(releases.length
        ? {
            formatReleases: Object.fromEntries(
              releases.map((release) => {
                const showDateHistory = release.source !== 'user' && release.releaseDate !== null && release.releaseDate === release.lastReleaseDate;
                // Only a date the owner chose can disagree with the automatic check, and only an
                // automatic value they have not acknowledged is worth an alert.
                const suggested =
                  release.source === 'user' &&
                  release.autoChangedAt !== null &&
                  release.autoReleaseDate !== null &&
                  release.autoReleaseDate !== release.releaseDate
                    ? {
                        releaseDate: release.autoReleaseDate,
                        precision: release.autoDatePrecision,
                        source: release.autoSource,
                        changedAt: release.autoChangedAt.toISOString(),
                      }
                    : null;
                return [
                  release.format,
                  {
                    status: release.status,
                    releaseDate: release.releaseDate,
                    precision: release.datePrecision,
                    source: release.source,
                    checkedAt: release.checkedAt?.toISOString() ?? null,
                    dateChangedAt: showDateHistory ? (release.dateChangedAt?.toISOString() ?? null) : null,
                    previousReleaseDate: showDateHistory ? release.previousReleaseDate : null,
                    previousPrecision: showDateHistory ? release.previousDatePrecision : null,
                    suggested,
                  },
                ];
              }),
            ),
          }
        : {}),
      coverUrl: row.coverUrl,
      description: row.description,
      verdict: row.verdict,
      flags: row.flags,
      ...(effectiveKind ? { kind: effectiveKind } : {}),
      ...(userKind ? { userKind } : {}),
      sources: row.sources,
      providerWorkIds: Object.fromEntries(sources.map((source) => [source.source, source.providerWorkId])),
      ...storedRatings(sources),
      monitorState: overlay?.monitorState ?? 'monitoring',
      matchedBookId,
      matchedBookIds: { ...(ebookId ? { ebook: ebookId } : {}), ...(audioId ? { audiobook: audioId } : {}) },
      ownedFormats,
      ...(possibleEbook || possibleAudio
        ? { possibleMatches: { ...(possibleEbook ? { ebook: possibleEbook } : {}), ...(possibleAudio ? { audiobook: possibleAudio } : {}) } }
        : {}),
      ...(isOwner && row.linkedFormats.length > 0 ? { linkedFormats: row.linkedFormats } : {}),
      autoDownload: {
        ...(overlay?.autoDownloadEbook != null ? { ebook: overlay.autoDownloadEbook } : {}),
        ...(overlay?.autoDownloadAudiobook != null ? { audiobook: overlay.autoDownloadAudiobook } : {}),
      },
      monitorFormats: {
        ...(overlay?.monitorEbook != null ? { ebook: overlay.monitorEbook } : {}),
        ...(overlay?.monitorAudiobook != null ? { audiobook: overlay.monitorAudiobook } : {}),
      },
      ...(isOwner && overlay?.userVisibility ? { userVisibility: overlay.userVisibility } : {}),
      requestIds: isOwner
        ? {
            ...(overlay?.ebookRequestId != null ? { ebook: overlay.ebookRequestId } : {}),
            ...(overlay?.audiobookRequestId != null ? { audiobook: overlay.audiobookRequestId } : {}),
          }
        : {},
      requestStatuses: isOwner
        ? {
            ...(ebookRequest ? { ebook: ebookRequest.status } : {}),
            ...(audiobookRequest ? { audiobook: audiobookRequest.status } : {}),
          }
        : {},
    };
  }

  /** The live state of the requests a page of works points at, so a settled id is read as history. */
  private async requestProjections(requestIds: number[]): Promise<RequestProjection[]> {
    if (!requestIds.length) return [];
    const rows = await this.db
      .select({ id: dbSchema.bookRequests.id, status: dbSchema.bookRequests.status, matchedBookId: dbSchema.bookRequests.matchedBookId })
      .from(dbSchema.bookRequests)
      .where(inArray(dbSchema.bookRequests.id, requestIds));
    return rows as RequestProjection[];
  }

  /** The library side of each possible match on these rows, so the owner can judge it without opening the book. */
  private async possibleMatchBooks(rows: AuthorCatalogWorkRow[]): Promise<Map<number, MonitoredPossibleMatch>> {
    const ids = [...new Set(rows.flatMap((row) => [row.possibleEbookBookId, row.possibleAudioBookId]).filter((id): id is number => id != null))];
    if (!ids.length) return new Map();
    const metadata = dbSchema.bookMetadata;
    const found = await this.db
      .select({ bookId: metadata.bookId, title: metadata.title, seriesName: metadata.seriesName, seriesIndex: metadata.seriesIndex })
      .from(metadata)
      .where(inArray(metadata.bookId, ids));
    return new Map(found.map((book) => [book.bookId, book]));
  }

  private async accessibleMatchedBooks(rows: AuthorCatalogWorkRow[], requestedBookIds: number[], viewer?: RequestUser): Promise<Set<number> | null> {
    if (!viewer || viewer.isSuperuser) return null;
    const libraryIds = await this.libraries.findAccessibleLibraryIds(viewer);
    if (!libraryIds.length) return new Set();
    const ids = [
      ...new Set([
        ...rows
          .flatMap((row) => [row.matchedBookId, row.matchedEbookBookId, row.matchedAudioBookId, row.possibleEbookBookId, row.possibleAudioBookId])
          .filter((id): id is number => id != null),
        ...requestedBookIds,
      ]),
    ];
    if (!ids.length) return new Set();
    const books = await this.db
      .select({ id: upstreamBooks.id })
      .from(upstreamBooks)
      .where(and(inArray(upstreamBooks.id, ids), inArray(upstreamBooks.libraryId, libraryIds)));
    return new Set(books.map((book) => book.id));
  }

  private authorValues(author: AuthorWrite & { id: string }) {
    return { id: author.id, ...this.authorUpdateValues(author) };
  }

  private authorUpdateValues(author: Omit<AuthorWrite, 'id'>) {
    return {
      ownerUserId: author.ownerUserId,
      authorName: author.authorName,
      localAuthorId: author.localAuthorId,
      paused: author.paused,
      ...(author.fetchState !== undefined ? { fetchState: author.fetchState } : {}),
      ebookMode: author.formats.ebook.mode,
      ebookLibraryId: author.formats.ebook.libraryId,
      ebookFolderId: author.formats.ebook.folderId,
      audiobookMode: author.formats.audiobook.mode,
      audiobookLibraryId: author.formats.audiobook.libraryId,
      audiobookFolderId: author.formats.audiobook.folderId,
      addedAt: new Date(author.addedAt),
      lastRefreshedAt: author.lastRefreshedAt ? new Date(author.lastRefreshedAt) : null,
      ...(author.lastReleaseCheckAt !== undefined
        ? { lastReleaseCheckAt: author.lastReleaseCheckAt ? new Date(author.lastReleaseCheckAt) : null }
        : {}),
    };
  }

  private authorFieldUpdateValues(fields: AuthorFields): Partial<typeof schema.monitoredAuthors.$inferInsert> {
    return {
      ...(fields.ownerUserId !== undefined ? { ownerUserId: fields.ownerUserId } : {}),
      ...(fields.authorName !== undefined ? { authorName: fields.authorName } : {}),
      ...(fields.localAuthorId !== undefined ? { localAuthorId: fields.localAuthorId } : {}),
      ...(fields.paused !== undefined ? { paused: fields.paused } : {}),
      ...(fields.formats !== undefined
        ? {
            ebookMode: fields.formats.ebook.mode,
            ebookLibraryId: fields.formats.ebook.libraryId,
            ebookFolderId: fields.formats.ebook.folderId,
            audiobookMode: fields.formats.audiobook.mode,
            audiobookLibraryId: fields.formats.audiobook.libraryId,
            audiobookFolderId: fields.formats.audiobook.folderId,
          }
        : {}),
      ...(fields.addedAt !== undefined ? { addedAt: new Date(fields.addedAt) } : {}),
      ...(fields.lastRefreshedAt !== undefined ? { lastRefreshedAt: fields.lastRefreshedAt ? new Date(fields.lastRefreshedAt) : null } : {}),
    };
  }

  /** The owned-match columns, shared by the full catalog write and the targeted rematch. */
  private matchValues(work: WorkMatchUpdate) {
    return {
      matchedBookId: work.matchedBookId,
      matchedEbookBookId: work.matchedBookIds?.ebook ?? null,
      matchedAudioBookId: work.matchedBookIds?.audiobook ?? null,
      ownedFormats: work.ownedFormats,
      linkedFormats: work.linkedFormats ?? [],
      answeredFormats: work.answeredFormats ?? [],
    };
  }

  private possibleMatchValues(work: Pick<MonitoredWork, 'possibleMatches'>) {
    return {
      possibleEbookBookId: work.possibleMatches?.ebook?.bookId ?? null,
      possibleAudioBookId: work.possibleMatches?.audiobook?.bookId ?? null,
    };
  }

  private workValues(monitorAuthorId: string, work: MonitoredWork) {
    return {
      id: work.id,
      monitorAuthorId,
      title: work.title,
      subtitle: work.subtitle,
      seriesName: work.seriesName,
      seriesIndex: work.seriesIndex,
      seriesMemberships: work.seriesMemberships,
      releaseYear: work.releaseYear,
      ebookReleaseDate: work.ebookReleaseDate,
      ebookDatePrecision: work.ebookDatePrecision,
      audioReleaseDate: work.audioReleaseDate,
      audioDatePrecision: work.audioDatePrecision,
      coverUrl: work.coverUrl,
      description: work.description,
      verdict: work.verdict,
      flags: work.flags,
      kind: work.kind === 'split_part' ? null : (work.kind ?? null),
      sources: work.sources,
      ...this.matchValues(work),
      ...this.possibleMatchValues(work),
    };
  }

  private sourceValues(work: MonitoredWork) {
    const ratings = new Map((work.ratings ?? []).map((rating) => [rating.source, rating]));
    return Object.entries(work.providerWorkIds).flatMap(([source, providerWorkId]) =>
      providerWorkId
        ? [
            {
              workId: work.id,
              source,
              providerWorkId,
              ratingAverage: ratings.get(source as MonitoredWorkRating['source'])?.average ?? null,
              ratingCount: ratings.get(source as MonitoredWorkRating['source'])?.count ?? null,
            },
          ]
        : [],
    );
  }

  private bookValues(book: MonitoredBookEntry) {
    return { id: book.id, ...this.bookUpdateValues(book) };
  }

  private bookUpdateValues(book: Omit<MonitoredBookEntry, 'id'>) {
    return {
      ownerUserId: book.ownerUserId,
      monitorAuthorId: book.monitorAuthorId,
      workId: book.workId,
      formats: book.formats,
      paused: book.paused,
      addedAt: new Date(book.addedAt),
    };
  }

  private composeBook(row: typeof schema.monitoredBooks.$inferSelect): MonitoredBookEntry {
    return {
      id: row.id,
      ownerUserId: row.ownerUserId,
      monitorAuthorId: row.monitorAuthorId,
      workId: row.workId,
      formats: row.formats,
      paused: row.paused,
      addedAt: row.addedAt.toISOString(),
    };
  }

  private readScope(user: RequestUser, owner: AnyPgColumn) {
    return eq(owner, user.id);
  }

  private async assertAuthorWritable(id: string, user: RequestUser, allowMissing = false): Promise<void> {
    const [row] = await this.db
      .select({ ownerUserId: schema.monitoredAuthors.ownerUserId })
      .from(schema.monitoredAuthors)
      .where(eq(schema.monitoredAuthors.id, id))
      .limit(1);
    if (!row) {
      if (allowMissing) return;
      throw new NotFoundException('Monitored author not found');
    }
    if (row.ownerUserId !== user.id) throw new ForbiddenException('No access to this monitored author');
  }

  private async assertBookWritable(id: string, user: RequestUser): Promise<void> {
    const [row] = await this.db
      .select({ ownerUserId: schema.monitoredBooks.ownerUserId })
      .from(schema.monitoredBooks)
      .where(eq(schema.monitoredBooks.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Monitored book not found');
    if (row.ownerUserId !== user.id) throw new ForbiddenException('No access to this monitored book');
  }

  private async assertWorkWritable(id: string, user: RequestUser): Promise<void> {
    const [row] = await this.db
      .select({ ownerUserId: schema.monitoredAuthors.ownerUserId })
      .from(schema.authorCatalogWorks)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
      .where(eq(schema.authorCatalogWorks.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Monitored work not found');
    if (row.ownerUserId !== user.id) throw new ForbiddenException('No access to this monitored work');
  }

  private logFailure(event: string, idKey: string, id: string, startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[${event}] [fail] ${idKey}="${sanitizeLogValue(id)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - monitored store operation failed`,
    );
  }
}
