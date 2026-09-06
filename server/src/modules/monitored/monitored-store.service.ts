import { randomUUID } from 'node:crypto';

import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type {
  MonitoredAuthorConfig,
  MonitoredAuthorListSort,
  MonitoredBookEntry,
  MonitoredBookListSort,
  MonitoredFormat,
  MonitoredListOrder,
  MonitoredReleaseFilter,
  MonitoredReleaseListSort,
  MonitoredSummary,
  MonitoredWork,
  MonitoredWorkPatch,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { accentInsensitiveIlike, buildSearchPattern } from '../../common/utils/accent-insensitive-search.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { applySchemaStatements, findMissingTables } from '../../common/utils/schema-bootstrap.utils';
import { normalizeMonitoredName } from './monitored-text.utils';
import { DB } from '../../db';
import * as dbSchema from '../../db/schema';
import { books as upstreamBooks } from '../../db/schema';
import { LibraryService } from '../library/library.service';
import * as schema from './schema/monitored.schema';
import type { AuthorCatalogWorkRow, MonitoredAuthorRow, MonitoredAuthorWorkRow } from './schema/monitored.schema';

const WRITE_BATCH_SIZE = 250;

function batches<T>(values: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += WRITE_BATCH_SIZE) result.push(values.slice(index, index + WRITE_BATCH_SIZE));
  return result;
}

export interface MonitoredCatalog {
  works: MonitoredWork[];
  fetchedAt: string;
}

export interface MonitoredWorkEntry {
  monitor: MonitoredAuthorConfig;
  work: MonitoredWork;
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
  releaseDate: string;
}

export type MonitoredCounts = Pick<MonitoredSummary, 'authors' | 'books' | 'releases'>;

interface ReleasePageRef extends Record<string, unknown> {
  workId: string;
  monitorAuthorId: string;
  format: MonitoredFormat;
  releaseDate: string;
}

type AuthorWrite = Omit<MonitoredAuthorConfig, 'id'> & { id?: string };
type AuthorFields = Partial<Omit<MonitoredAuthorConfig, 'id'>>;
type BookWrite = Omit<MonitoredBookEntry, 'id'> & { id?: string };
type Db = NodePgDatabase<typeof dbSchema>;
type DbSnapshot = Parameters<Parameters<Db['transaction']>[0]>[0];
type WorkStatePatch = MonitoredWorkPatch & {
  monitorState?: MonitoredWork['monitorState'];
  requestIds?: MonitoredWork['requestIds'];
};

/** What owned-matching decides about a work: system truth, never the owner's overlay. */
export type WorkMatchUpdate = Pick<MonitoredWork, 'matchedBookId' | 'matchedBookIds' | 'ownedFormats'>;

export function releaseRangeOverlapsSql(date: AnyPgColumn, precision: AnyPgColumn, earliest: string, latest: string) {
  // A stored precision of NULL is not day precision: release-window.ts reads the precision off the
  // value's shape, so the SQL prefilter has to infer it the same way. Treating a null-precision
  // '2026' as 2026-01-01 dropped the row from every window the JS path still matched.
  const effective = sql`case when ${precision} is not null then ${precision} when length(${date}) = 4 then 'year' when length(${date}) = 7 then 'month' else 'day' end`;
  const rangeStart = sql<string>`case ${effective} when 'year' then ${date} || '-01-01' when 'month' then ${date} || '-01' else ${date} end`;
  const rangeEnd = sql<string>`case ${effective} when 'year' then ${date} || '-12-31' when 'month' then ${date} || '-31' else ${date} end`;
  return sql<boolean>`${rangeStart} <= ${latest} and ${rangeEnd} >= ${earliest}`;
}

function releaseRangeStartSql(date: AnyPgColumn, precision: AnyPgColumn) {
  const effective = sql`case when ${precision} is not null then ${precision} when length(${date}) = 4 then 'year' when length(${date}) = 7 then 'month' else 'day' end`;
  return sql<string>`case ${effective} when 'year' then ${date} || '-01-01' when 'month' then ${date} || '-01' else ${date} end`;
}

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
    const { viewer } = params;
    const scope = this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared);
    const where = and(scope, params.q ? accentInsensitiveIlike(schema.monitoredAuthors.authorName, buildSearchPattern(params.q)) : undefined)!;
    const visible = this.visibleWorkCondition(viewer);
    const readable = this.viewerReadableWorkCondition(viewer);
    const active = this.activeWorkCondition(visible);
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
    const totalExpr = sql<number>`count(*) filter (where ${readable} and ${visible})::int`;
    const ebookOwnedExpr = sql<number>`count(*) filter (where ${readable} and ${visible} and ${ebookOwned})::int`;
    const audioOwnedExpr = sql<number>`count(*) filter (where ${readable} and ${visible} and ${audioOwned})::int`;
    const hiddenExpr = sql<number>`count(*) filter (where ${readable} and not ${visible})::int`;
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
    const where = viewer.isSuperuser ? sql<boolean>`true` : eq(schema.monitoredAuthors.ownerUserId, viewer.id);
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
    const bookScope = this.readScope(params.viewer, schema.monitoredBooks.ownerUserId, schema.monitoredBooks.isShared);
    const authorScope = this.readScope(params.viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared);
    const qPattern = params.q ? buildSearchPattern(params.q) : null;
    const where = and(
      bookScope,
      authorScope,
      this.viewerReadableWorkCondition(params.viewer),
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

  async findReleasePage(params: {
    viewer: RequestUser;
    q?: string;
    page: number;
    size: number;
    sort: MonitoredReleaseListSort;
    order: MonitoredListOrder;
    filter: MonitoredReleaseFilter;
    earliest: string;
    latest: string;
    today: string;
    soonLatest: string;
    currentYear: string;
  }): Promise<{ items: MonitoredReleasePageEntry[]; total: number; page: number; size: number }> {
    const releaseRows = this.releaseRowsSql(params);
    const direction = sql.raw(params.order === 'asc' ? 'asc' : 'desc');
    const orderExpression =
      params.sort === 'title' ? sql.raw('title') : params.sort === 'author' ? sql.raw('"authorName"') : sql.raw('"releaseDate"');
    const secondaryOrder = params.sort === 'author' ? sql`, "releaseDate" ${direction}` : sql``;
    const [pageResult, countResult] = await Promise.all([
      this.db.execute<ReleasePageRef>(sql`
        with release_rows as (${releaseRows})
        select "workId", "monitorAuthorId", format, "releaseDate"
        from release_rows
        order by ${orderExpression} ${direction}${secondaryOrder}, "workId" asc, format asc
        limit ${params.size} offset ${params.page * params.size}
      `),
      this.db.execute<{ total: number }>(sql`
        with release_rows as (${releaseRows})
        select count(*)::int as total from release_rows
      `),
    ]);
    const refs = pageResult.rows;
    if (!refs.length) {
      return { items: [], total: Number(countResult.rows[0]?.total ?? 0), page: params.page, size: params.size };
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
      total: Number(countResult.rows[0]?.total ?? 0),
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

  async listAuthors(viewer?: RequestUser): Promise<MonitoredAuthorConfig[]> {
    const rows = await this.db
      .select()
      .from(schema.monitoredAuthors)
      .where(viewer ? this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared) : undefined);
    return this.composeAuthors(rows);
  }

  /**
   * The monitor id behind each of these author names, for the viewer's readable monitors only.
   * Annotating a ten-row search by loading EVERY readable monitor (and the provider identities
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
          this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared),
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
    if (viewer) clauses.push(this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared));
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
    return { ...input, id };
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

  async listBooks(viewer?: RequestUser): Promise<MonitoredBookEntry[]> {
    const rows = await this.db
      .select()
      .from(schema.monitoredBooks)
      .where(viewer ? this.readScope(viewer, schema.monitoredBooks.ownerUserId, schema.monitoredBooks.isShared) : undefined);
    return rows.map((row) => this.composeBook(row));
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
    if (viewer) clauses.push(this.readScope(viewer, schema.monitoredBooks.ownerUserId, schema.monitoredBooks.isShared));
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
    return { ...input, id };
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
    if (viewer) monitorClauses.push(this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared));
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
    const visible = this.visibleWorkCondition(viewer);
    const readable = this.viewerReadableWorkCondition(viewer);
    const active = this.activeWorkCondition(visible);
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
        total: sql<number>`count(*) filter (where ${readable} and ${visible})::int`,
        ebookOwned: sql<number>`count(*) filter (where ${readable} and ${visible} and ${ebookOwned})::int`,
        audioOwned: sql<number>`count(*) filter (where ${readable} and ${visible} and ${audioOwned})::int`,
        hidden: sql<number>`count(*) filter (where ${readable} and not ${visible})::int`,
        nextReleaseAt: sql<string | null>`least(
          min(case when ${ebookRelease} then ${schema.authorCatalogWorks.ebookReleaseDate} end),
          min(case when ${audioRelease} then ${schema.authorCatalogWorks.audioReleaseDate} end)
        )`,
      })
      .from(schema.monitoredAuthors)
      .innerJoin(schema.authorCatalogState, eq(schema.authorCatalogState.monitorAuthorId, schema.monitoredAuthors.id))
      .innerJoin(schema.authorCatalogWorks, eq(schema.authorCatalogWorks.monitorAuthorId, schema.monitoredAuthors.id))
      .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
      .where(
        and(
          inArray(schema.monitoredAuthors.id, monitorIds),
          this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared),
        ),
      )
      .groupBy(schema.monitoredAuthors.id);
    for (const row of rows) {
      result.set(row.monitorId, {
        counts: { total: row.total, ebookOwned: row.ebookOwned, audioOwned: row.audioOwned, hidden: row.hidden },
        nextReleaseAt: row.nextReleaseAt,
      });
    }
    return result;
  }

  async getReleaseWorks(monitorIds: string[], viewer: RequestUser, earliest: string, latest: string): Promise<Map<string, MonitoredWork[]>> {
    const result = new Map<string, MonitoredWork[]>(monitorIds.map((id) => [id, []]));
    if (!monitorIds.length) return result;
    const visible = this.visibleWorkCondition(viewer);
    const active = this.activeWorkCondition(visible);
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
    const rows = await this.db
      .select({ work: schema.authorCatalogWorks })
      .from(schema.authorCatalogWorks)
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
      .innerJoin(schema.authorCatalogState, eq(schema.authorCatalogState.monitorAuthorId, schema.monitoredAuthors.id))
      .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
      .where(
        and(
          inArray(schema.monitoredAuthors.id, monitorIds),
          this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared),
          active,
          or(ebook, audio),
        ),
      );
    const composed = await this.composeWorks(
      rows.map((row) => row.work),
      viewer,
    );
    for (const item of composed) result.set(item.monitorAuthorId, [...(result.get(item.monitorAuthorId) ?? []), item.work]);
    return result;
  }

  async getWorkWithMonitor(workId: string, viewer?: RequestUser): Promise<MonitoredWorkEntry | null> {
    const clauses = [eq(schema.authorCatalogWorks.id, workId)];
    if (viewer) clauses.push(this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared));
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

  async updateWorkUserState(workId: string, patch: WorkStatePatch, viewer?: RequestUser): Promise<MonitoredWork> {
    const [work] = await this.db.select().from(schema.authorCatalogWorks).where(eq(schema.authorCatalogWorks.id, workId)).limit(1);
    if (!work) throw new NotFoundException('Monitored work not found');
    const values = {
      workId,
      monitorAuthorId: work.monitorAuthorId,
      ...(patch.monitorState !== undefined ? { monitorState: patch.monitorState } : {}),
      ...(patch.monitorEbook !== undefined ? { monitorEbook: patch.monitorEbook } : {}),
      ...(patch.monitorAudiobook !== undefined ? { monitorAudiobook: patch.monitorAudiobook } : {}),
      ...(patch.hidden !== undefined ? { userVisibility: patch.hidden ? ('hidden' as const) : ('visible' as const) } : {}),
      ...(patch.requestIds?.ebook !== undefined ? { ebookRequestId: patch.requestIds.ebook } : {}),
      ...(patch.requestIds?.audiobook !== undefined ? { audiobookRequestId: patch.requestIds.audiobook } : {}),
    };
    await this.db.insert(schema.monitoredAuthorWorks).values(values).onConflictDoUpdate({ target: schema.monitoredAuthorWorks.workId, set: values });
    const [composed] = await this.composeWorks([work], viewer);
    if (!composed) throw new NotFoundException('Monitored work not found');
    return composed.work;
  }

  /**
   * The works behind a set of ids, composed for the viewer. Used to re-read the handful of works a
   * targeted rematch just wrote, so the viewer masking that composition applies still decides what
   * they are told they own.
   */
  async getComposedWorks(workIds: string[], viewer?: RequestUser): Promise<Map<string, MonitoredWork>> {
    if (!workIds.length) return new Map();
    const clauses = [inArray(schema.authorCatalogWorks.id, workIds)];
    if (viewer) clauses.push(this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared));
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
  async updateWorkMatch(workId: string, match: WorkMatchUpdate): Promise<void> {
    await this.db.update(schema.authorCatalogWorks).set(this.matchValues(match)).where(eq(schema.authorCatalogWorks.id, workId));
  }

  async saveCatalog(monitorId: string, catalog: MonitoredCatalog | null): Promise<void> {
    await this.db.transaction(async (tx) => {
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
      await tx
        .delete(schema.authorCatalogWorks)
        .where(
          ids.length
            ? and(eq(schema.authorCatalogWorks.monitorAuthorId, monitorId), notInArray(schema.authorCatalogWorks.id, ids))
            : eq(schema.authorCatalogWorks.monitorAuthorId, monitorId),
        );
      if (!catalog.works.length) return;
      for (const values of batches(catalog.works.map((work) => this.workValues(monitorId, work)))) {
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
              sources: sql`excluded.sources`,
              matchedBookId: sql`excluded.matched_book_id`,
              matchedEbookBookId: sql`excluded.matched_ebook_book_id`,
              matchedAudioBookId: sql`excluded.matched_audio_book_id`,
              ownedFormats: sql`excluded.owned_formats`,
            },
          });
      }
      await tx.delete(schema.authorCatalogSourceWorks).where(inArray(schema.authorCatalogSourceWorks.workId, ids));
      const sources = catalog.works.flatMap((work) => this.sourceValues(work));
      for (const batch of batches(sources)) await tx.insert(schema.authorCatalogSourceWorks).values(batch);
    });
  }

  private releaseRowsSql(params: {
    viewer: RequestUser;
    q?: string;
    filter: MonitoredReleaseFilter;
    earliest: string;
    latest: string;
    today: string;
    soonLatest: string;
    currentYear: string;
  }): SQL {
    const authorScope = this.readScope(params.viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared);
    const visible = this.visibleWorkCondition(params.viewer);
    const readable = this.viewerReadableWorkCondition(params.viewer);
    const active = this.activeWorkCondition(visible);
    const qPattern = params.q ? buildSearchPattern(params.q) : null;
    const search = qPattern
      ? or(accentInsensitiveIlike(schema.authorCatalogWorks.title, qPattern), accentInsensitiveIlike(schema.monitoredAuthors.authorName, qPattern))
      : undefined;
    const ebook = and(
      ne(schema.monitoredAuthors.ebookMode, 'off'),
      or(ne(schema.monitoredAuthorWorks.monitorEbook, false), sql`${schema.monitoredAuthorWorks.monitorEbook} is null`),
      releaseRangeOverlapsSql(
        schema.authorCatalogWorks.ebookReleaseDate,
        schema.authorCatalogWorks.ebookDatePrecision,
        params.earliest,
        params.latest,
      ),
      this.releaseTimeFilterSql(schema.authorCatalogWorks.ebookReleaseDate, schema.authorCatalogWorks.ebookDatePrecision, params),
    );
    const audiobook = and(
      ne(schema.monitoredAuthors.audiobookMode, 'off'),
      or(ne(schema.monitoredAuthorWorks.monitorAudiobook, false), sql`${schema.monitoredAuthorWorks.monitorAudiobook} is null`),
      releaseRangeOverlapsSql(
        schema.authorCatalogWorks.audioReleaseDate,
        schema.authorCatalogWorks.audioDatePrecision,
        params.earliest,
        params.latest,
      ),
      this.releaseTimeFilterSql(schema.authorCatalogWorks.audioReleaseDate, schema.authorCatalogWorks.audioDatePrecision, params),
    );
    const joins = sql`
      from ${schema.authorCatalogWorks}
      inner join ${schema.monitoredAuthors}
        on ${schema.monitoredAuthors.id} = ${schema.authorCatalogWorks.monitorAuthorId}
      inner join ${schema.authorCatalogState}
        on ${schema.authorCatalogState.monitorAuthorId} = ${schema.monitoredAuthors.id}
      left join ${schema.monitoredAuthorWorks}
        on ${schema.monitoredAuthorWorks.workId} = ${schema.authorCatalogWorks.id}
    `;
    return sql`
      select
        ${schema.authorCatalogWorks.id} as "workId",
        ${schema.monitoredAuthors.id} as "monitorAuthorId",
        'ebook'::text as format,
        ${schema.authorCatalogWorks.ebookReleaseDate} as "releaseDate",
        ${schema.authorCatalogWorks.title} as title,
        ${schema.monitoredAuthors.authorName} as "authorName"
      ${joins}
      where ${and(authorScope, readable, active, search, ebook)}
      union all
      select
        ${schema.authorCatalogWorks.id} as "workId",
        ${schema.monitoredAuthors.id} as "monitorAuthorId",
        'audiobook'::text as format,
        ${schema.authorCatalogWorks.audioReleaseDate} as "releaseDate",
        ${schema.authorCatalogWorks.title} as title,
        ${schema.monitoredAuthors.authorName} as "authorName"
      ${joins}
      where ${and(authorScope, readable, active, search, audiobook)}
    `;
  }

  private releaseTimeFilterSql(
    date: AnyPgColumn,
    precision: AnyPgColumn,
    params: { filter: MonitoredReleaseFilter; today: string; soonLatest: string; currentYear: string },
  ): SQL {
    const start = releaseRangeStartSql(date, precision);
    if (params.filter === 'recent') return sql`${start} <= ${params.today}`;
    if (params.filter === 'soon') return sql`${start} > ${params.today} and ${start} <= ${params.soonLatest}`;
    if (params.filter === 'year') return sql`left(${date}, 4) = ${params.currentYear}`;
    return sql`true`;
  }

  async countSummary(viewer: RequestUser, earliest: string, latest: string): Promise<MonitoredCounts> {
    const authorScope = this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared);
    const visible = this.visibleWorkCondition(viewer);
    const active = this.activeWorkCondition(visible);
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
    const [[authors], [books], [releases]] = await Promise.all([
      this.db.select({ value: count() }).from(schema.monitoredAuthors).where(authorScope),
      this.bookSummaryQuery(viewer),
      this.db
        .select({
          value: sql<number>`coalesce(sum((case when ${ebook} then 1 else 0 end) + (case when ${audio} then 1 else 0 end)), 0)::int`,
        })
        .from(schema.authorCatalogWorks)
        .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
        .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
        .where(and(authorScope, active)),
    ]);
    return { authors: authors.value, books: books.value, releases: releases.value };
  }

  private bookSummaryQuery(viewer: RequestUser) {
    const bookScope = this.readScope(viewer, schema.monitoredBooks.ownerUserId, schema.monitoredBooks.isShared);
    const authorScope = this.readScope(viewer, schema.monitoredAuthors.ownerUserId, schema.monitoredAuthors.isShared);
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

  /**
   * Effective visibility as the detail endpoint computes it, in SQL. Two things make it subtle.
   * The overlay is LEFT JOINed, so an unreviewed work has a NULL user_visibility and
   * `user_visibility = 'visible'` yields NULL, not false: `NULL or false` stayed NULL, and a row
   * whose visibility was NULL counted in NEITHER the visible bucket nor its negation - the author
   * list reported 7 hidden works where the detail page showed 156. coalesce puts every row in
   * exactly one bucket. The overlay is also the monitor OWNER's curation, so a viewer reading a
   * shared monitor is judged on the verdict alone, matching what masking will hand them.
   */
  private visibleWorkCondition(viewer?: RequestUser) {
    const overlayVisibility = this.viewerVisibility(viewer);
    return sql<boolean>`coalesce(${or(
      sql`${overlayVisibility} = 'visible'`,
      and(
        sql`${overlayVisibility} is null`,
        eq(schema.authorCatalogWorks.verdict, 'verified'),
        sql`jsonb_array_length(${schema.authorCatalogWorks.flags}) = 0`,
      ),
    )}, false)`;
  }

  /** The overlay visibility the viewer is allowed to be judged by: the owner's own, or nothing. */
  private viewerVisibility(viewer?: RequestUser) {
    if (!viewer || viewer.isSuperuser) return sql`${schema.monitoredAuthorWorks.userVisibility}`;
    return sql`case when ${eq(schema.monitoredAuthors.ownerUserId, viewer.id)} then ${schema.monitoredAuthorWorks.userVisibility} end`;
  }

  /** A work the owner hid is not in a viewer's list at all, so it counts in neither bucket. */
  private viewerReadableWorkCondition(viewer: RequestUser) {
    if (viewer.isSuperuser) return sql<boolean>`true`;
    return sql<boolean>`(${eq(schema.monitoredAuthors.ownerUserId, viewer.id)} or ${schema.monitoredAuthorWorks.userVisibility} is distinct from 'hidden')`;
  }

  private activeWorkCondition(visible: ReturnType<typeof this.visibleWorkCondition>) {
    return and(
      ne(schema.monitoredAuthors.paused, true),
      or(eq(schema.monitoredAuthorWorks.monitorState, 'monitoring'), sql`${schema.monitoredAuthorWorks.monitorState} is null`),
      visible,
    )!;
  }

  private ownedFormatCondition(format: 'ebook' | 'audiobook', libraryIds: number[] | null) {
    const matchedBookId = format === 'ebook' ? schema.authorCatalogWorks.matchedEbookBookId : schema.authorCatalogWorks.matchedAudioBookId;
    const hasOwnedFormat = sql`${schema.authorCatalogWorks.ownedFormats} @> ${JSON.stringify([format])}::jsonb`;
    if (libraryIds === null) return and(hasOwnedFormat, sql`${matchedBookId} is not null`)!;
    if (!libraryIds.length) return sql<boolean>`false`;
    return and(
      hasOwnedFormat,
      sql`exists (
        select 1 from ${upstreamBooks}
        where ${upstreamBooks.id} = ${matchedBookId}
          and ${inArray(upstreamBooks.libraryId, libraryIds)}
      )`,
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
      isShared: row.isShared,
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
    }));
  }

  /**
   * The single enforcement point for viewer-aware work data. A shared monitor is readable by
   * everyone, but the per-work overlay on it is the owner's own: which requests they filed, and which
   * works they curated out of their list. A viewer gets the EFFECT of that curation (a hidden work is
   * not returned at all) and never the state behind it. Internal callers pass no viewer and keep the
   * full row, so the pipeline still sees everything it writes.
   */
  private async composeWorks(rows: AuthorCatalogWorkRow[], viewer?: RequestUser): Promise<Array<{ monitorAuthorId: string; work: MonitoredWork }>> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [sources, overlays] = await Promise.all([
      this.db.select().from(schema.authorCatalogSourceWorks).where(inArray(schema.authorCatalogSourceWorks.workId, ids)),
      this.db.select().from(schema.monitoredAuthorWorks).where(inArray(schema.monitoredAuthorWorks.workId, ids)),
    ]);
    const overlayMap = new Map(overlays.map((overlay) => [overlay.workId, overlay]));
    const sourceMap = new Map<string, Array<typeof schema.authorCatalogSourceWorks.$inferSelect>>();
    for (const source of sources) sourceMap.set(source.workId, [...(sourceMap.get(source.workId) ?? []), source]);
    const [accessibleBooks, ownedMonitorIds] = await Promise.all([this.accessibleMatchedBooks(rows, viewer), this.ownedMonitorIds(rows, viewer)]);
    return rows.flatMap((row) => {
      const overlay = overlayMap.get(row.id);
      const isOwner = ownedMonitorIds === null || ownedMonitorIds.has(row.monitorAuthorId);
      if (!isOwner && overlay?.userVisibility === 'hidden') return [];
      return [
        {
          monitorAuthorId: row.monitorAuthorId,
          work: this.composeWork(row, sourceMap.get(row.id) ?? [], overlay, accessibleBooks, isOwner),
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
  ): MonitoredWork {
    const ebookId =
      row.matchedEbookBookId != null && (!accessibleBooks || accessibleBooks.has(row.matchedEbookBookId)) ? row.matchedEbookBookId : undefined;
    const audioId =
      row.matchedAudioBookId != null && (!accessibleBooks || accessibleBooks.has(row.matchedAudioBookId)) ? row.matchedAudioBookId : undefined;
    const matchedBookId =
      row.matchedBookId != null && (!accessibleBooks || accessibleBooks.has(row.matchedBookId)) ? row.matchedBookId : (ebookId ?? audioId ?? null);
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
      coverUrl: row.coverUrl,
      description: row.description,
      verdict: row.verdict,
      flags: row.flags,
      sources: row.sources,
      providerWorkIds: Object.fromEntries(sources.map((source) => [source.source, source.providerWorkId])),
      monitorState: overlay?.monitorState ?? 'monitoring',
      matchedBookId,
      matchedBookIds: { ...(ebookId ? { ebook: ebookId } : {}), ...(audioId ? { audiobook: audioId } : {}) },
      ownedFormats: row.ownedFormats.filter((format) => (format === 'ebook' ? ebookId != null : audioId != null)),
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
    };
  }

  private async accessibleMatchedBooks(rows: AuthorCatalogWorkRow[], viewer?: RequestUser): Promise<Set<number> | null> {
    if (!viewer || viewer.isSuperuser) return null;
    const libraryIds = await this.libraries.findAccessibleLibraryIds(viewer);
    if (!libraryIds.length) return new Set();
    const ids = [
      ...new Set(rows.flatMap((row) => [row.matchedBookId, row.matchedEbookBookId, row.matchedAudioBookId]).filter((id): id is number => id != null)),
    ];
    if (!ids.length) return new Set();
    const books = await this.db
      .select({ id: upstreamBooks.id })
      .from(upstreamBooks)
      .where(and(inArray(upstreamBooks.id, ids), inArray(upstreamBooks.libraryId, libraryIds)));
    return new Set(books.map((book) => book.id));
  }

  private authorValues(author: MonitoredAuthorConfig) {
    return { id: author.id, ...this.authorUpdateValues(author) };
  }

  private authorUpdateValues(author: Omit<MonitoredAuthorConfig, 'id'>) {
    return {
      ownerUserId: author.ownerUserId,
      isShared: author.isShared,
      authorName: author.authorName,
      localAuthorId: author.localAuthorId,
      paused: author.paused,
      ebookMode: author.formats.ebook.mode,
      ebookLibraryId: author.formats.ebook.libraryId,
      ebookFolderId: author.formats.ebook.folderId,
      audiobookMode: author.formats.audiobook.mode,
      audiobookLibraryId: author.formats.audiobook.libraryId,
      audiobookFolderId: author.formats.audiobook.folderId,
      addedAt: new Date(author.addedAt),
      lastRefreshedAt: author.lastRefreshedAt ? new Date(author.lastRefreshedAt) : null,
    };
  }

  private authorFieldUpdateValues(fields: AuthorFields): Partial<typeof schema.monitoredAuthors.$inferInsert> {
    return {
      ...(fields.ownerUserId !== undefined ? { ownerUserId: fields.ownerUserId } : {}),
      ...(fields.isShared !== undefined ? { isShared: fields.isShared } : {}),
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
      sources: work.sources,
      ...this.matchValues(work),
    };
  }

  private sourceValues(work: MonitoredWork) {
    return Object.entries(work.providerWorkIds).flatMap(([source, providerWorkId]) =>
      providerWorkId ? [{ workId: work.id, source, providerWorkId }] : [],
    );
  }

  private bookValues(book: MonitoredBookEntry) {
    return { id: book.id, ...this.bookUpdateValues(book) };
  }

  private bookUpdateValues(book: Omit<MonitoredBookEntry, 'id'>) {
    return {
      ownerUserId: book.ownerUserId,
      isShared: book.isShared,
      monitorAuthorId: book.monitorAuthorId,
      workId: book.workId,
      formats: book.formats,
      paused: book.paused,
      addedAt: new Date(book.addedAt),
    };
  }

  private composeBook(row: typeof schema.monitoredBooks.$inferSelect): MonitoredBookEntry {
    return { ...row, addedAt: row.addedAt.toISOString() };
  }

  private readScope(user: RequestUser, owner: AnyPgColumn, shared: AnyPgColumn) {
    return user.isSuperuser ? sql`true` : or(eq(owner, user.id), eq(shared, true))!;
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
    if (!user.isSuperuser && row.ownerUserId !== user.id) throw new ForbiddenException('No access to this monitored author');
  }

  private async assertBookWritable(id: string, user: RequestUser): Promise<void> {
    const [row] = await this.db
      .select({ ownerUserId: schema.monitoredBooks.ownerUserId })
      .from(schema.monitoredBooks)
      .where(eq(schema.monitoredBooks.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Monitored book not found');
    if (!user.isSuperuser && row.ownerUserId !== user.id) throw new ForbiddenException('No access to this monitored book');
  }

  private logFailure(event: string, idKey: string, id: string, startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[${event}] [fail] ${idKey}="${sanitizeLogValue(id)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - monitored store operation failed`,
    );
  }
}
