import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, getTableColumns, gt, inArray, isNotNull, like, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';

import type {
  WebSerialEngineHealth,
  WebSerialJobCurrentUnit,
  WebSerialJobItemStatus,
  WebSerialJobStatus,
  WebSerialKind,
  WebSerialLookupHealth,
  WebSerialPackaging,
  WebSerialPublishedRequest,
  WebSerialSelection,
} from '@bookorbit/types';
import {
  ACTIVE_WEB_SERIAL_JOB_STATUSES,
  normalizeSerialTitle,
  parseWebSerialVolumeUnitKey,
  WEB_SERIAL_SERIES_UNIT_KEY,
  webSerialMangaVolumeOwned,
  webSerialRangesCover,
  type WebSerialChapterRange,
} from '@bookorbit/types';
import { applySchemaStatements, findMissingTables } from '../../common/utils/schema-bootstrap.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { EngineUnitSpec } from './engines/web-serial-engine';
import { volumeKeyBase } from './web-serials-metadata.utils';
import { bookMetadata, books, comicMetadata, libraries, libraryFolders, users } from '../../db/schema';
import {
  webSerialImports,
  webSerialNovelPrefs,
  webSerialJobItems,
  webSerialJobs,
  webSerialSettings,
  webSerialVolumeRequests,
  type NewWebSerialImportRow,
  type NewWebSerialJobItemRow,
  type NewWebSerialJobRow,
  type NewWebSerialSettingsRow,
  type WebSerialJobItemRow,
  type WebSerialJobRow,
  type WebSerialSettingsRow,
} from './schema/web-serials.schema';

type Db = NodePgDatabase<typeof schema>;

/** What a job read carries of `engineState`: never the stored unit specs. Use `findJobUnits` for those. */
export interface WebSerialJobEngineProjection {
  hasCover: boolean | null;
}

/** A list selection read from a job comes back with its sequences emptied. */
export type WebSerialSelectionProjection = Exclude<WebSerialSelection, { mode: 'list' }> | { mode: 'list'; sequences: never[] };

/** Job rows read for the queue and for actions are projections: see the two types above. */
export type WebSerialJobWithLibrary = Omit<WebSerialJobRow, 'engineState' | 'selection'> & {
  engineState: WebSerialJobEngineProjection;
  selection: WebSerialSelectionProjection;
  libraryName: string | null;
  ownerName: string | null;
  /** 1-based rank among every queued job on the instance; null unless queued. */
  queuePosition: number | null;
};

export type WebSerialJobItemSummary = Pick<WebSerialJobItemRow, 'id' | 'label' | 'sequence' | 'status' | 'error' | 'bookId' | 'updatedAt'>;
export type WebSerialMoveItem = Pick<WebSerialJobItemRow, 'id' | 'sequence' | 'status' | 'unitKey' | 'remoteRef'>;

export type WebSerialJobId = Pick<WebSerialJobRow, 'id'>;

export interface WebSerialLibraryFolder {
  id: number;
  path: string;
}

export interface WebSerialImportCandidate {
  key: string;
  sequence: string;
  packaging: WebSerialPackaging;
  /** First and last chapter the unit holds; when absent it is read from the unit key where the key carries one. */
  range?: WebSerialChapterRange | null;
  /** A manga extra whose sequence only places it: matched by its key, never by number. */
  positional?: boolean;
}

/** Plain decimal chapter numbers only; ranges like "1-12" and the marked sequences of extras never equal a chapter. */
export function chapterNumber(sequence: string): number | null {
  return /^\d+(\.\d+)?$/.test(sequence.trim()) ? Number(sequence) : null;
}

/** How the ledger stores an extra's sequence, so no later chapter of that number is taken for it. */
export function positionalLedgerSequence(sequence: string): string {
  return `~${sequence}`;
}

const LNREADER_VOLUME_SIZE = 100;

/**
 * The chapters a wanted unit holds when the caller did not say: a short novel volume (`volume-3:201-250`) and a growing
 * manga volume (`vol:12:100-103`) carry them in the key, and a full LNReader volume is its 100-chapter block.
 */
export function rangeFromUnitKey(seriesKey: string, unitKey: string): WebSerialChapterRange | null {
  const partial = /^volume-\d+:(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(unitKey);
  if (partial) return { from: Number(partial[1]), to: Number(partial[2]) };
  const lncrawl = seriesKey.startsWith('n:') ? /^[^:]+:(\d+)-(\d+)$/.exec(unitKey) : null;
  if (lncrawl) return { from: Number(lncrawl[1]), to: Number(lncrawl[2]) };
  const manga = parseWebSerialVolumeUnitKey(unitKey);
  if (manga?.range) return manga.range;
  const full = seriesKey.startsWith('nl:') ? /^volume-(\d+)$/.exec(unitKey) : null;
  if (full) {
    const volume = Number(full[1]);
    return { from: (volume - 1) * LNREADER_VOLUME_SIZE + 1, to: volume * LNREADER_VOLUME_SIZE };
  }
  return null;
}

/**
 * A novel ledger row's range: its own columns, or, for rows from before ranges were stored, the `3:201-250` sequence of a
 * short volume or the block an LNReader `volume-N` key stands for.
 */
function ledgerRange(
  seriesKey: string,
  row: { unitKey: string; sequence: string; chapterFrom: number | null; chapterTo: number | null },
): WebSerialChapterRange | null {
  if (row.chapterFrom != null && row.chapterTo != null) return { from: row.chapterFrom, to: row.chapterTo };
  const legacy = /^\d+:(\d+)-(\d+)$/.exec(row.sequence);
  if (legacy) return { from: Number(legacy[1]), to: Number(legacy[2]) };
  return rangeFromUnitKey(seriesKey, row.unitKey);
}

/** The engine a series key belongs to: LNReader (`nl:`), lightnovel-crawler (`n:`) or Suwayomi (`m:`). */
function engineOf(seriesKey: string): string {
  return seriesKey.slice(0, seriesKey.indexOf(':'));
}

/** How a novel title is compared across sources, in the ledger's `title_key` and in a lookup alike. */
export function compactSerialTitle(title: string): string {
  return normalizeSerialTitle(title).replace(/\s+/g, '');
}

export interface WebSerialIllustratorBackfillBook {
  bookId: number;
  matchKey: string;
  kind: WebSerialKind;
  hasPencillers: boolean;
}

export interface WebSerialInterruptedJobs {
  requeued: number[];
}

type JobPatch = { [K in keyof NewWebSerialJobRow]?: NewWebSerialJobRow[K] | SQL };

export const ACTIVE_STATUSES: WebSerialJobStatus[] = [...ACTIVE_WEB_SERIAL_JOB_STATUSES];

/** Statuses a restart finds a job in when it died mid-run. */
const INTERRUPTED_STATUSES: WebSerialJobStatus[] = ['running', 'importing'];

const MAX_LIST_LIMIT = 100;
const MAX_GROUP_KEYS = 5000;
const MAX_VOLUME_REQUESTS_PER_SERIES = 200;
const MAX_ELSEWHERE_VOLUME_ROWS = 5000;
/** How a filed unit's note starts when chapters were missing; the job then ends as completed with gaps. */
export const GAPS_NOTE_PREFIX = 'Imported with gaps:';
export const FINISHED_STATUSES: WebSerialJobStatus[] = ['completed', 'completed_with_gaps', 'failed', 'cancelled'];
/** A finished job whose work folder has no further use: a failed or gapped one keeps it so Retry resumes. */
export const WORK_DIR_DONE_STATUSES: WebSerialJobStatus[] = ['completed', 'cancelled'];
const RETRYABLE_JOB_STATUSES: WebSerialJobStatus[] = ['completed', 'completed_with_gaps', 'failed'];
const CANCELLABLE_STATUSES: WebSerialJobStatus[] = [...ACTIVE_STATUSES, 'paused'];
const PAUSABLE_STATUSES: WebSerialJobStatus[] = [...ACTIVE_STATUSES];
const IN_FLIGHT_ITEM_STATUSES: WebSerialJobItemStatus[] = ['fetching', 'importing'];
const MOVABLE_ITEM_STATUSES: WebSerialJobItemStatus[] = ['pending', 'fetching', 'failed'];
const QUEUE_ORDER_NOW = sql`((extract(epoch from now()) * 1000)::bigint)`;
const DROPPED_HANDLE = sql`'{"handle": null, "member": null}'::jsonb`;
const RETRY_AT = sql`(${webSerialJobItems.remoteRef}->>'retryAt')::timestamptz`;

/** Drops the engine handle and the retry schedule, so a user-driven retry starts with a full set of attempts. */
function resetRetrySchedule(): SQL {
  return sql`(${webSerialJobItems.remoteRef} - 'attempts' - 'retryAt' - 'retryReason' - 'failureReason') || ${DROPPED_HANDLE}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function omitHeavyJobColumns<T extends { engineState: unknown; selection: unknown }>(columns: T): Omit<T, 'engineState' | 'selection'> {
  const rest: Partial<T> = { ...columns };
  delete rest.engineState;
  delete rest.selection;
  return rest as Omit<T, 'engineState' | 'selection'>;
}

@Injectable()
export class WebSerialsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findMissingTables(tableNames: readonly string[]): Promise<string[]> {
    return findMissingTables(this.db, tableNames);
  }

  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    return applySchemaStatements(this.db, statements);
  }

  async getSettings(): Promise<WebSerialSettingsRow | undefined> {
    const [row] = await this.db.select().from(webSerialSettings).where(eq(webSerialSettings.id, 1)).limit(1);
    return row;
  }

  async upsertSettings(values: Partial<NewWebSerialSettingsRow>): Promise<WebSerialSettingsRow> {
    const [row] = await this.db
      .insert(webSerialSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({
        target: webSerialSettings.id,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /**
   * Upserts so a test before any settings were saved still persists. `testedUrl` is the host the
   * result describes: a save can re-point the row while the round trip is in flight, and `setWhere`
   * drops the stale result in the same statement that would have written it.
   */
  async recordCheck(kind: WebSerialKind, result: WebSerialEngineHealth, testedUrl: string | null): Promise<void> {
    const urlColumn = kind === 'manga' ? webSerialSettings.mangaUrl : webSerialSettings.novelUrl;
    const checkColumns = kind === 'manga' ? { mangaLastCheck: result } : { novelLastCheck: result };
    await this.db
      .insert(webSerialSettings)
      .values({ id: 1, ...checkColumns })
      .onConflictDoUpdate({
        target: webSerialSettings.id,
        set: { ...checkColumns, updatedAt: new Date() },
        setWhere: testedUrl === null ? sql`${urlColumn} is null` : eq(urlColumn, testedUrl),
      });
  }

  async recordLookupCheck(result: WebSerialLookupHealth): Promise<void> {
    await this.db
      .insert(webSerialSettings)
      .values({ id: 1, lookupLastCheck: result })
      .onConflictDoUpdate({
        target: webSerialSettings.id,
        set: { lookupLastCheck: result, updatedAt: new Date() },
      });
  }

  async getQueuePaused(): Promise<boolean> {
    const [row] = await this.db.select({ paused: webSerialSettings.queuePaused }).from(webSerialSettings).where(eq(webSerialSettings.id, 1)).limit(1);
    return row?.paused ?? false;
  }

  async setQueuePaused(paused: boolean): Promise<void> {
    await this.upsertSettings({ queuePaused: paused });
  }

  async isIllustratorBackfillDone(): Promise<boolean> {
    const [row] = await this.db
      .select({ doneAt: webSerialSettings.illustratorBackfillDoneAt })
      .from(webSerialSettings)
      .where(eq(webSerialSettings.id, 1))
      .limit(1);
    return row?.doneAt != null;
  }

  async markIllustratorBackfillDone(): Promise<void> {
    await this.upsertSettings({ illustratorBackfillDoneAt: new Date() });
  }

  /** The next books after `afterBookId` that the ledger ties to a MangaBaka series, one row per book with its latest match. */
  async findIllustratorBackfillBooks(afterBookId: number, limit: number): Promise<WebSerialIllustratorBackfillBook[]> {
    const rows = await this.db
      .selectDistinctOn([webSerialImports.bookId], {
        bookId: webSerialImports.bookId,
        matchKey: webSerialImports.matchKey,
        kind: webSerialImports.kind,
        hasPencillers: sql<boolean>`coalesce(cardinality(${comicMetadata.pencillers}), 0) > 0`,
      })
      .from(webSerialImports)
      .innerJoin(books, eq(books.id, webSerialImports.bookId))
      .leftJoin(comicMetadata, eq(comicMetadata.bookId, webSerialImports.bookId))
      .where(and(isNotNull(webSerialImports.bookId), gt(webSerialImports.bookId, afterBookId), like(webSerialImports.matchKey, 'mb:%')))
      .orderBy(asc(webSerialImports.bookId), desc(webSerialImports.id))
      .limit(limit);
    return rows.map((row) => ({ bookId: row.bookId!, matchKey: row.matchKey!, kind: row.kind, hasPencillers: row.hasPencillers }));
  }

  async bookHasPencillers(bookId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ has: sql<boolean>`coalesce(cardinality(${comicMetadata.pencillers}), 0) > 0` })
      .from(comicMetadata)
      .where(eq(comicMetadata.bookId, bookId))
      .limit(1);
    return row?.has ?? false;
  }

  async getDisabledNovelDomains(userId: number): Promise<string[]> {
    const [row] = await this.db
      .select({ disabled: webSerialNovelPrefs.disabledDomains })
      .from(webSerialNovelPrefs)
      .where(eq(webSerialNovelPrefs.userId, userId))
      .limit(1);
    return row?.disabled ?? [];
  }

  async setDisabledNovelDomains(userId: number, disabledDomains: string[]): Promise<void> {
    await this.db
      .insert(webSerialNovelPrefs)
      .values({ userId, disabledDomains })
      .onConflictDoUpdate({ target: webSerialNovelPrefs.userId, set: { disabledDomains, updatedAt: new Date() } });
  }

  async upsertVolumeRequest(userId: number, kind: WebSerialKind, matchId: string, volume: string, bookRequestId: number): Promise<void> {
    await this.db
      .insert(webSerialVolumeRequests)
      .values({ userId, kind, matchId, volume, bookRequestId })
      .onConflictDoUpdate({
        target: [webSerialVolumeRequests.userId, webSerialVolumeRequests.kind, webSerialVolumeRequests.matchId, webSerialVolumeRequests.volume],
        set: { bookRequestId },
      });
  }

  async listVolumeRequests(userId: number, kind: WebSerialKind, matchId: string): Promise<WebSerialPublishedRequest[]> {
    return this.db
      .select({ volume: webSerialVolumeRequests.volume, bookRequestId: webSerialVolumeRequests.bookRequestId })
      .from(webSerialVolumeRequests)
      .where(and(eq(webSerialVolumeRequests.userId, userId), eq(webSerialVolumeRequests.kind, kind), eq(webSerialVolumeRequests.matchId, matchId)))
      .orderBy(asc(webSerialVolumeRequests.id))
      .limit(MAX_VOLUME_REQUESTS_PER_SERIES);
  }

  async removeNovelSourceId(sourceId: string): Promise<void> {
    const settings = await this.getSettings();
    if (!settings) return;
    const retained = settings.novelSourceIds.filter((id) => id !== sourceId);
    if (retained.length !== settings.novelSourceIds.length) await this.upsertSettings({ novelSourceIds: retained });
  }

  async addNovelSourceId(sourceId: string): Promise<void> {
    const settings = await this.getSettings();
    const sourceIds = settings?.novelSourceIds ?? [];
    if (!sourceIds.includes(sourceId)) await this.upsertSettings({ novelSourceIds: [...sourceIds, sourceId] });
  }

  async findLibraryFolders(libraryId: number): Promise<WebSerialLibraryFolder[]> {
    return this.db
      .select({ id: libraryFolders.id, path: libraryFolders.path })
      .from(libraryFolders)
      .where(eq(libraryFolders.libraryId, libraryId))
      .orderBy(asc(libraryFolders.id));
  }

  async createJob(values: NewWebSerialJobRow): Promise<WebSerialJobRow> {
    const [row] = await this.db.insert(webSerialJobs).values(values).returning();
    return row!;
  }

  async findJobById(id: number): Promise<WebSerialJobWithLibrary | undefined> {
    const [row] = await this.selectJobs().where(eq(webSerialJobs.id, id)).limit(1);
    return row ? this.toJobRow(row) : undefined;
  }

  /** Active jobs first, then the queue in claim order, then paused, then finished newest first. One bounded query for the page. */
  async listJobs(userId: number | null, limit: number, offset: number): Promise<WebSerialJobWithLibrary[]> {
    const status = webSerialJobs.status;
    const rank = sql`case when ${status} in ('running', 'importing') then 0 when ${status} = 'queued' then 1 when ${status} = 'paused' then 2 else 3 end`;
    const rows = await this.selectJobs()
      .where(userId === null ? undefined : eq(webSerialJobs.userId, userId))
      .orderBy(
        asc(rank),
        sql`case when ${rank} in (1, 2) then ${webSerialJobs.queueOrder} end asc nulls last`,
        sql`case when ${rank} in (0, 1, 2) then ${webSerialJobs.id} end asc nulls last`,
        sql`coalesce(${webSerialJobs.finishedAt}, ${webSerialJobs.updatedAt}) desc`,
        desc(webSerialJobs.id),
      )
      .limit(Math.min(Math.max(limit, 1), MAX_LIST_LIMIT))
      .offset(Math.max(offset, 0));
    return rows.map((row) => this.toJobRow(row));
  }

  private selectJobs() {
    const ahead = alias(webSerialJobs, 'queue_ahead');
    const columns = omitHeavyJobColumns(getTableColumns(webSerialJobs));
    return this.db
      .select({
        job: {
          ...columns,
          engineState: sql<WebSerialJobEngineProjection>`jsonb_build_object('hasCover', ${webSerialJobs.engineState}->'hasCover')`,
          selection: sql<WebSerialSelectionProjection>`case when ${webSerialJobs.selection}->>'mode' = 'list' then jsonb_build_object('mode', 'list', 'sequences', '[]'::jsonb) else ${webSerialJobs.selection} end`,
        },
        libraryName: libraries.name,
        ownerName: users.name,
        queuePosition: sql<number | null>`case when ${webSerialJobs.status} = 'queued' then (
          select count(*)::int from ${webSerialJobs} as ${sql.identifier('queue_ahead')}
          where ${ahead.status} = 'queued'
            and (${ahead.queueOrder} < ${webSerialJobs.queueOrder} or (${ahead.queueOrder} = ${webSerialJobs.queueOrder} and ${ahead.id} <= ${webSerialJobs.id}))
        ) end`,
      })
      .from(webSerialJobs)
      .leftJoin(libraries, eq(libraries.id, webSerialJobs.targetLibraryId))
      .leftJoin(users, eq(users.id, webSerialJobs.userId));
  }

  async findJobUnits(id: number): Promise<EngineUnitSpec[]> {
    const [row] = await this.db
      .select({ units: sql<unknown>`${webSerialJobs.engineState}->'units'` })
      .from(webSerialJobs)
      .where(eq(webSerialJobs.id, id))
      .limit(1);
    return Array.isArray(row?.units) ? (row.units as EngineUnitSpec[]) : [];
  }

  private toJobRow(row: {
    job: Omit<WebSerialJobRow, 'engineState' | 'selection'> & Pick<WebSerialJobWithLibrary, 'engineState' | 'selection'>;
    libraryName: string | null;
    ownerName: string | null;
    queuePosition: number | null;
  }): WebSerialJobWithLibrary {
    return { ...row.job, libraryName: row.libraryName, ownerName: row.ownerName, queuePosition: row.queuePosition };
  }

  /** Every job in scope and how many of them are finished, for paging the queue. */
  async countJobs(userId: number | null): Promise<{ total: number; finishedCount: number }> {
    const [row] = await this.db
      .select({
        total: count(),
        finishedCount: sql<number>`(count(*) filter (where ${inArray(webSerialJobs.status, FINISHED_STATUSES)}))::int`,
      })
      .from(webSerialJobs)
      .where(userId === null ? undefined : eq(webSerialJobs.userId, userId));
    return { total: row?.total ?? 0, finishedCount: row?.finishedCount ?? 0 };
  }

  async countActiveJobs(userId: number | null): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(webSerialJobs)
      .where(and(userId === null ? undefined : eq(webSerialJobs.userId, userId), inArray(webSerialJobs.status, ACTIVE_STATUSES)));
    return row?.value ?? 0;
  }

  /** What the per-user cap counts: active and paused jobs, so pausing never makes room for more. */
  async countCappedJobsForUser(userId: number): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(webSerialJobs)
      .where(and(eq(webSerialJobs.userId, userId), inArray(webSerialJobs.status, [...ACTIVE_STATUSES, 'paused'])));
    return row?.value ?? 0;
  }

  /** Imported items whose book was filed with notice pages in place of chapters the source never delivered. */
  async countGappedImports(jobId: number): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(webSerialJobItems)
      .where(
        and(
          eq(webSerialJobItems.jobId, jobId),
          eq(webSerialJobItems.status, 'imported'),
          sql`${webSerialJobItems.error} like ${`${GAPS_NOTE_PREFIX}%`}`,
        ),
      );
    return row?.value ?? 0;
  }

  /** The ledger keys that point at a book, so a duplicate can tell a shorter copy of the same volume from the book itself. */
  async findLedgerKeysForBook(userId: number, seriesKey: string, bookId: number): Promise<string[]> {
    const rows = await this.db
      .select({ unitKey: webSerialImports.unitKey })
      .from(webSerialImports)
      .where(and(eq(webSerialImports.userId, userId), eq(webSerialImports.seriesKey, seriesKey), eq(webSerialImports.bookId, bookId)))
      .limit(MAX_GROUP_KEYS);
    return rows.map((row) => row.unitKey);
  }

  async findQueuedJobs(limit: number): Promise<Array<Pick<WebSerialJobRow, 'id'>>> {
    return this.db
      .select({ id: webSerialJobs.id })
      .from(webSerialJobs)
      .where(eq(webSerialJobs.status, 'queued'))
      .orderBy(asc(webSerialJobs.queueOrder), asc(webSerialJobs.id))
      .limit(Math.max(limit, 0));
  }

  /** Conditional on still being queued, so two ticks (or a cancel) cannot both win the job. */
  async claimQueuedJob(id: number): Promise<WebSerialJobRow | undefined> {
    const now = new Date();
    const [row] = await this.db
      .update(webSerialJobs)
      .set({ status: 'running', startedAt: sql`coalesce(${webSerialJobs.startedAt}, ${now})`, heartbeatAt: now, updatedAt: now })
      .where(and(eq(webSerialJobs.id, id), eq(webSerialJobs.status, 'queued')))
      .returning();
    return row;
  }

  /**
   * Conditional update: a cancel that landed meanwhile is never overwritten by the runner. With
   * `requireSettledItems` it also refuses while any item is still pending or in flight, so a retry that landed
   * just before the final transition is never stranded in a finished job.
   */
  async transitionJob(
    id: number,
    from: WebSerialJobStatus[],
    values: JobPatch,
    guard: { requireSettledItems?: boolean } = {},
  ): Promise<WebSerialJobId | undefined> {
    const unsettled = guard.requireSettledItems
      ? sql`not exists (select 1 from ${webSerialJobItems} where ${webSerialJobItems.jobId} = ${id} and ${webSerialJobItems.status} in ('pending', 'fetching', 'importing'))`
      : undefined;
    const [row] = await this.db
      .update(webSerialJobs)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(webSerialJobs.id, id), inArray(webSerialJobs.status, from), unsettled))
      .returning({ id: webSerialJobs.id });
    return row;
  }

  async heartbeat(id: number): Promise<void> {
    const now = new Date();
    await this.db.update(webSerialJobs).set({ heartbeatAt: now, updatedAt: now }).where(eq(webSerialJobs.id, id));
  }

  /** Only an active job takes it, so a cancelled job never shows progress again. */
  async setCurrentUnit(id: number, current: WebSerialJobCurrentUnit | null): Promise<void> {
    await this.db
      .update(webSerialJobs)
      .set({ currentUnit: current })
      .where(and(eq(webSerialJobs.id, id), inArray(webSerialJobs.status, ACTIVE_STATUSES)));
  }

  async getJobStatus(id: number): Promise<WebSerialJobStatus | undefined> {
    const [row] = await this.db.select({ status: webSerialJobs.status }).from(webSerialJobs).where(eq(webSerialJobs.id, id)).limit(1);
    return row?.status;
  }

  /** An active or paused job is cancelled and its in-flight items settle as pending; the runner sees the status flip between polls. Ownership is checked by the caller. */
  async cancelJob(id: number): Promise<WebSerialJobId | undefined> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx
        .update(webSerialJobs)
        .set({ status: 'cancelled', message: null, currentUnit: null, finishedAt: now, updatedAt: now })
        .where(and(eq(webSerialJobs.id, id), inArray(webSerialJobs.status, CANCELLABLE_STATUSES)))
        .returning({ id: webSerialJobs.id });
      if (row) await this.releaseInFlight(tx, id);
      return row;
    });
  }

  /** Queued goes straight to paused; a running job is flagged and the runner stops after its current poll. */
  async pauseJob(id: number): Promise<WebSerialJobId | undefined> {
    return this.transitionJob(id, PAUSABLE_STATUSES, { status: 'paused', message: null, currentUnit: null });
  }

  async resumeJob(id: number): Promise<WebSerialJobId | undefined> {
    return this.transitionJob(id, ['paused'], { status: 'queued', queueOrder: QUEUE_ORDER_NOW, heartbeatAt: null });
  }

  /** Puts a job a failed move paused back where it stood in the queue. */
  async restoreAfterMove(id: number, queueOrder: number): Promise<WebSerialJobId | undefined> {
    return this.transitionJob(id, ['paused'], { status: 'queued', queueOrder, heartbeatAt: null });
  }

  async moveJobToTop(id: number): Promise<WebSerialJobId | undefined> {
    const lowest = sql`(select min(${webSerialJobs.queueOrder}) from ${webSerialJobs} where ${webSerialJobs.status} = 'queued')`;
    return this.transitionJob(id, ['queued'], { queueOrder: sql`least(coalesce(${lowest}, ${QUEUE_ORDER_NOW}), ${QUEUE_ORDER_NOW}) - 1` });
  }

  async deleteFinishedJob(id: number): Promise<boolean> {
    const rows = await this.db
      .delete(webSerialJobs)
      .where(and(eq(webSerialJobs.id, id), inArray(webSerialJobs.status, FINISHED_STATUSES)))
      .returning({ id: webSerialJobs.id });
    return rows.length > 0;
  }

  /** Null clears every user's finished jobs (admin scope). Items cascade; imported books stay. Returns the removed ids. */
  async clearFinishedJobs(userId: number | null): Promise<number[]> {
    const rows = await this.db
      .delete(webSerialJobs)
      .where(and(inArray(webSerialJobs.status, FINISHED_STATUSES), userId === null ? undefined : eq(webSerialJobs.userId, userId)))
      .returning({ id: webSerialJobs.id });
    return rows.map((row) => row.id);
  }

  /** Items a stopped run left mid-flight go back to pending with their engine handle dropped. */
  async releaseInFlightItems(jobId: number): Promise<number> {
    return this.releaseInFlight(this.db, jobId);
  }

  /** A run that stopped mid-unit hands the unit back, so the next run never reuses an engine job it cancelled. */
  async releaseItem(itemId: number): Promise<void> {
    await this.db
      .update(webSerialJobItems)
      .set({ status: 'pending', remoteRef: sql`${webSerialJobItems.remoteRef} || ${DROPPED_HANDLE}`, updatedAt: new Date() })
      .where(and(eq(webSerialJobItems.id, itemId), inArray(webSerialJobItems.status, IN_FLIGHT_ITEM_STATUSES)));
  }

  private async releaseInFlight(executor: Pick<Db, 'update'>, jobId: number): Promise<number> {
    const rows = await executor
      .update(webSerialJobItems)
      .set({ status: 'pending', remoteRef: sql`${webSerialJobItems.remoteRef} || ${DROPPED_HANDLE}`, updatedAt: new Date() })
      .where(and(eq(webSerialJobItems.jobId, jobId), inArray(webSerialJobItems.status, IN_FLIGHT_ITEM_STATUSES)))
      .returning({ id: webSerialJobItems.id });
    return rows.length;
  }

  /** Puts a failed or gapped job back in the queue and re-arms its failed items; false when it is in neither state. */
  async requeueForRetry(id: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .update(webSerialJobs)
        .set({
          status: 'queued',
          message: null,
          currentUnit: null,
          finishedAt: null,
          heartbeatAt: null,
          queueOrder: QUEUE_ORDER_NOW,
          updatedAt: new Date(),
        })
        .where(and(eq(webSerialJobs.id, id), inArray(webSerialJobs.status, ['failed', 'completed_with_gaps'])))
        .returning({ id: webSerialJobs.id });
      if (!job) return false;
      await tx
        .update(webSerialJobItems)
        .set({ status: 'pending', error: null, remoteRef: resetRetrySchedule(), updatedAt: new Date() })
        .where(and(eq(webSerialJobItems.jobId, id), eq(webSerialJobItems.status, 'failed')));
      await this.syncCounters(tx, id);
      return true;
    });
  }

  /**
   * Re-arms one failed item. A finished job goes back to the queue (end of line); a running job's loop
   * picks the item up and a paused job keeps it until resume. A cancelled job stays cancelled and keeps its
   * items. False when the item is not a failed item of a job that can take it.
   */
  async retryItem(jobId: number, itemId: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [item] = await tx
        .update(webSerialJobItems)
        .set({ status: 'pending', error: null, remoteRef: resetRetrySchedule(), updatedAt: new Date() })
        .where(
          and(
            eq(webSerialJobItems.id, itemId),
            eq(webSerialJobItems.jobId, jobId),
            eq(webSerialJobItems.status, 'failed'),
            sql`exists (select 1 from ${webSerialJobs} where ${webSerialJobs.id} = ${jobId} and ${webSerialJobs.status} <> 'cancelled')`,
          ),
        )
        .returning({ id: webSerialJobItems.id });
      if (!item) return false;
      await tx
        .update(webSerialJobs)
        .set({
          status: 'queued',
          message: null,
          currentUnit: null,
          finishedAt: null,
          heartbeatAt: null,
          queueOrder: QUEUE_ORDER_NOW,
          updatedAt: new Date(),
        })
        .where(and(eq(webSerialJobs.id, jobId), inArray(webSerialJobs.status, RETRYABLE_JOB_STATUSES)));
      await this.syncCounters(tx, jobId);
      return true;
    });
  }

  /** After a restart: running/importing jobs go back to the queue; their items keep remote handles and resume. */
  async requeueInterruptedJobs(): Promise<WebSerialInterruptedJobs> {
    return this.db.transaction(async (tx) => {
      const paused = await tx.select({ id: webSerialJobs.id }).from(webSerialJobs).where(eq(webSerialJobs.status, 'paused'));
      if (paused.length > 0) {
        await tx
          .update(webSerialJobItems)
          .set({ status: 'pending', remoteRef: sql`${webSerialJobItems.remoteRef} || ${DROPPED_HANDLE}`, updatedAt: new Date() })
          .where(
            and(
              inArray(
                webSerialJobItems.jobId,
                paused.map((job) => job.id),
              ),
              inArray(webSerialJobItems.status, IN_FLIGHT_ITEM_STATUSES),
            ),
          );
      }
      const jobs = await tx
        .update(webSerialJobs)
        .set({ status: 'queued', message: null, currentUnit: null, updatedAt: new Date() })
        .where(inArray(webSerialJobs.status, INTERRUPTED_STATUSES))
        .returning({ id: webSerialJobs.id });
      if (jobs.length > 0) {
        await tx
          .update(webSerialJobItems)
          .set({ status: 'pending', updatedAt: new Date() })
          .where(
            and(
              inArray(
                webSerialJobItems.jobId,
                jobs.map((job) => job.id),
              ),
              inArray(webSerialJobItems.status, ['fetching', 'importing']),
            ),
          );
      }
      return { requeued: jobs.map((job) => job.id) };
    });
  }

  /** Items cascade; the import ledger is kept, so a removed job never forgets its books. */
  async deleteFinishedJobsBefore(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(webSerialJobs)
      .where(
        and(inArray(webSerialJobs.status, FINISHED_STATUSES), lt(sql`coalesce(${webSerialJobs.finishedAt}, ${webSerialJobs.updatedAt})`, cutoff)),
      )
      .returning({ id: webSerialJobs.id });
    return rows.length;
  }

  async insertItems(items: NewWebSerialJobItemRow[]): Promise<number> {
    if (items.length === 0) return 0;
    const rows = await this.db.insert(webSerialJobItems).values(items).onConflictDoNothing().returning({ id: webSerialJobItems.id });
    return rows.length;
  }

  /** Detail view columns only; remote handles stay server-side. Sequences sort numerically ("10" after "9", "10.5" after "10"). */
  async findItemsForDetail(jobId: number): Promise<WebSerialJobItemSummary[]> {
    return this.db
      .select({
        id: webSerialJobItems.id,
        label: webSerialJobItems.label,
        sequence: webSerialJobItems.sequence,
        status: webSerialJobItems.status,
        error: webSerialJobItems.error,
        bookId: webSerialJobItems.bookId,
        updatedAt: webSerialJobItems.updatedAt,
      })
      .from(webSerialJobItems)
      .where(eq(webSerialJobItems.jobId, jobId))
      .orderBy(
        sql`(case when ${webSerialJobItems.sequence} ~ '^[0-9]+(\.[0-9]+)?$' then ${webSerialJobItems.sequence}::numeric end) asc nulls last`,
        asc(webSerialJobItems.sequence),
        asc(webSerialJobItems.id),
      );
  }

  async findMoveItems(jobId: number, limit: number): Promise<WebSerialMoveItem[]> {
    return this.db
      .select({
        id: webSerialJobItems.id,
        sequence: webSerialJobItems.sequence,
        status: webSerialJobItems.status,
        unitKey: webSerialJobItems.unitKey,
        remoteRef: webSerialJobItems.remoteRef,
      })
      .from(webSerialJobItems)
      .where(and(eq(webSerialJobItems.jobId, jobId), inArray(webSerialJobItems.status, MOVABLE_ITEM_STATUSES)))
      .orderBy(
        sql`(case when ${webSerialJobItems.sequence} ~ '^[0-9]+(\.[0-9]+)?$' then ${webSerialJobItems.sequence}::numeric end) asc nulls last`,
        asc(webSerialJobItems.sequence),
        asc(webSerialJobItems.id),
      )
      .limit(Math.max(limit, 0));
  }

  async hasInFlightItems(jobId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: webSerialJobItems.id })
      .from(webSerialJobItems)
      .where(and(eq(webSerialJobItems.jobId, jobId), inArray(webSerialJobItems.status, IN_FLIGHT_ITEM_STATUSES)))
      .limit(1);
    return Boolean(row);
  }

  async moveJob(input: {
    sourceJobId: number;
    sourceExpectedStatus: WebSerialJobStatus;
    movedItemIds: number[];
    missingItemIds: number[];
    sourceMessage: string;
    movedError: string;
    missingError: string;
    targetJob: NewWebSerialJobRow;
  }): Promise<WebSerialJobRow | undefined> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [source] = await tx
        .update(webSerialJobs)
        .set({
          status: 'completed',
          message: input.sourceMessage,
          currentUnit: null,
          finishedAt: now,
          heartbeatAt: null,
          updatedAt: now,
        })
        .where(and(eq(webSerialJobs.id, input.sourceJobId), eq(webSerialJobs.status, input.sourceExpectedStatus)))
        .returning({ id: webSerialJobs.id });
      if (!source) return undefined;

      if (input.movedItemIds.length > 0) {
        await tx
          .update(webSerialJobItems)
          .set({ status: 'skipped', error: input.movedError, remoteRef: resetRetrySchedule(), updatedAt: now })
          .where(
            and(
              eq(webSerialJobItems.jobId, input.sourceJobId),
              inArray(webSerialJobItems.id, input.movedItemIds),
              inArray(webSerialJobItems.status, MOVABLE_ITEM_STATUSES),
            ),
          );
      }
      if (input.missingItemIds.length > 0) {
        await tx
          .update(webSerialJobItems)
          .set({ status: 'failed', error: input.missingError, remoteRef: resetRetrySchedule(), updatedAt: now })
          .where(
            and(
              eq(webSerialJobItems.jobId, input.sourceJobId),
              inArray(webSerialJobItems.id, input.missingItemIds),
              inArray(webSerialJobItems.status, MOVABLE_ITEM_STATUSES),
            ),
          );
      }
      await this.syncCounters(tx, input.sourceJobId);
      const [target] = await tx.insert(webSerialJobs).values(input.targetJob).returning();
      return target;
    });
  }

  /**
   * The next unit to work on: a half-done one first (it holds a remote handle), then pending in id order.
   * Pending units waiting out a retry delay are skipped until their `retryAt` is due.
   */
  async findNextItem(jobId: number, now: Date = new Date()): Promise<WebSerialJobItemRow | undefined> {
    const [row] = await this.db
      .select()
      .from(webSerialJobItems)
      .where(
        and(
          eq(webSerialJobItems.jobId, jobId),
          inArray(webSerialJobItems.status, ['pending', 'fetching', 'importing']),
          sql`(${RETRY_AT} is null or ${RETRY_AT} <= ${now.toISOString()}::timestamptz)`,
        ),
      )
      .orderBy(sql`case when ${webSerialJobItems.status} = 'pending' then 1 else 0 end`, asc(webSerialJobItems.id))
      .limit(1);
    return row;
  }

  /** Pending units that wait out a retry delay: how many, and the one that is due first. */
  async findWaitingRetries(jobId: number): Promise<{ count: number; next: WebSerialJobItemRow } | undefined> {
    const [row] = await this.db
      .select({ item: webSerialJobItems, total: sql<number>`(count(*) over ())::int` })
      .from(webSerialJobItems)
      .where(and(eq(webSerialJobItems.jobId, jobId), eq(webSerialJobItems.status, 'pending'), sql`${RETRY_AT} is not null`))
      .orderBy(asc(RETRY_AT), asc(webSerialJobItems.id))
      .limit(1);
    return row ? { count: row.total, next: row.item } : undefined;
  }

  async findItem(id: number): Promise<WebSerialJobItemRow | undefined> {
    const [row] = await this.db.select().from(webSerialJobItems).where(eq(webSerialJobItems.id, id)).limit(1);
    return row;
  }

  /** Writes only the grouped-unit member marker, so a many-chapter unit does not rewrite its whole description per chapter. */
  async setItemMember(id: number, member: { index: number; handle: Record<string, unknown> } | null): Promise<void> {
    await this.db
      .update(webSerialJobItems)
      .set({ remoteRef: sql`jsonb_set(${webSerialJobItems.remoteRef}, '{member}', ${JSON.stringify(member)}::jsonb)`, updatedAt: new Date() })
      .where(eq(webSerialJobItems.id, id));
  }

  /** How many failed items of the job carry each stored failure reason; items without one count under `unknown`. */
  async countFailureReasons(jobId: number): Promise<Map<string, number>> {
    const reason = sql<string>`coalesce(${webSerialJobItems.remoteRef}->>'failureReason', 'unknown')`;
    const rows = await this.db
      .select({ reason, value: count() })
      .from(webSerialJobItems)
      .where(and(eq(webSerialJobItems.jobId, jobId), eq(webSerialJobItems.status, 'failed')))
      .groupBy(reason);
    return new Map(rows.map((row) => [row.reason, row.value]));
  }

  /** The given job ids whose work folder must stay: unfinished, failed or gapped (a missing job is not returned). */
  async findJobIdsKeepingWorkDirs(ids: readonly number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: webSerialJobs.id })
      .from(webSerialJobs)
      .where(and(inArray(webSerialJobs.id, [...ids]), notInArray(webSerialJobs.status, WORK_DIR_DONE_STATUSES)));
    return rows.map((row) => row.id);
  }

  async updateItem(id: number, values: Partial<NewWebSerialJobItemRow>): Promise<Pick<WebSerialJobItemRow, 'id'> | undefined> {
    const [row] = await this.db
      .update(webSerialJobItems)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(webSerialJobItems.id, id))
      .returning({ id: webSerialJobItems.id });
    return row;
  }

  async countItemsByStatus(jobId: number): Promise<Partial<Record<WebSerialJobItemStatus, number>>> {
    const rows = await this.db
      .select({ status: webSerialJobItems.status, value: count() })
      .from(webSerialJobItems)
      .where(eq(webSerialJobItems.jobId, jobId))
      .groupBy(webSerialJobItems.status);
    return Object.fromEntries(rows.map((row) => [row.status, row.value]));
  }

  /** Records what was imported, independent of the job history: removing a job never forgets its books. */
  async recordImports(rows: NewWebSerialImportRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insert(webSerialImports)
      .values(rows)
      .onConflictDoUpdate({
        target: [webSerialImports.userId, webSerialImports.seriesKey, webSerialImports.unitKey, webSerialImports.packaging],
        set: { bookId: sql`excluded.book_id`, matchKey: sql`coalesce(excluded.match_key, ${webSerialImports.matchKey})` },
      });
  }

  /**
   * Keys of the given units this user already has as a book. Chapters: by key, or by chapter number within the series
   * and, for manga, within the matched series. Manga volumes: by `webSerialMangaVolumeOwned` over this series' volume
   * keys, so only copies of the same volume count. Novel volumes: when owned volumes of this series, or of another source
   * of the same novel on the same engine (matched series or series title), together hold every chapter of the wanted one.
   */
  async findImportedUnitKeys(
    userId: number,
    seriesKey: string,
    units: readonly WebSerialImportCandidate[],
    matchKey?: string | null,
    novelTitles: readonly string[] = [],
  ): Promise<string[]> {
    const own = await this.db
      .selectDistinct({
        unitKey: webSerialImports.unitKey,
        sequence: webSerialImports.sequence,
        packaging: webSerialImports.packaging,
        chapterFrom: webSerialImports.chapterFrom,
        chapterTo: webSerialImports.chapterTo,
      })
      .from(webSerialImports)
      .innerJoin(books, eq(books.id, webSerialImports.bookId))
      .where(and(eq(webSerialImports.userId, userId), eq(webSerialImports.seriesKey, seriesKey)));
    const imported = new Set<string>();
    const ownKeys = new Set(own.map((row) => row.unitKey));

    const chapters = units.filter((unit) => unit.packaging !== 'volume');
    for (const unit of chapters) if (ownKeys.has(unit.key)) imported.add(unit.key);
    const numbered = chapters.filter((unit) => unit.packaging === 'chapter' && !unit.positional && chapterNumber(unit.sequence) !== null);
    const ownChapterNumbers = new Set<number>();
    for (const row of own) {
      const value = row.packaging === 'chapter' ? chapterNumber(row.sequence) : null;
      if (value !== null) ownChapterNumbers.add(value);
    }
    // A newer scanlator upload gives the same chapter a new unit key; the chapter number still identifies it within one series.
    for (const unit of numbered) if (ownChapterNumbers.has(chapterNumber(unit.sequence)!)) imported.add(unit.key);
    if (matchKey && numbered.length > 0 && seriesKey.startsWith('m:')) {
      const matched = await this.db
        .selectDistinct({ sequence: webSerialImports.sequence })
        .from(webSerialImports)
        .innerJoin(books, eq(books.id, webSerialImports.bookId))
        .where(and(eq(webSerialImports.userId, userId), eq(webSerialImports.matchKey, matchKey), eq(webSerialImports.kind, 'manga')));
      const numbers = new Set<number>();
      for (const row of matched) {
        const value = chapterNumber(row.sequence);
        if (value !== null) numbers.add(value);
      }
      for (const unit of numbered) if (numbers.has(chapterNumber(unit.sequence)!)) imported.add(unit.key);
    }

    const volumes = units.filter((unit) => unit.packaging === 'volume');
    if (volumes.length > 0 && seriesKey.startsWith('m:')) {
      const ownVolumeKeys = own.flatMap((row) => (row.packaging === 'volume' ? [row.unitKey] : []));
      for (const unit of volumes) {
        const volume = parseWebSerialVolumeUnitKey(unit.key)?.volume;
        const wanted = unit.range ?? rangeFromUnitKey(seriesKey, unit.key);
        if (volume !== undefined ? webSerialMangaVolumeOwned(ownVolumeKeys, volume, wanted) : ownKeys.has(unit.key)) imported.add(unit.key);
      }
    } else if (volumes.length > 0) {
      const ownVolumes = own.filter((row) => row.packaging === 'volume');
      const ownUnranged = new Set(
        ownVolumes.filter((row) => ledgerRange(seriesKey, row) === null).map((row) => volumeKeyBase(row.unitKey, seriesKey) ?? row.unitKey),
      );
      const ownRanges = ownVolumes.flatMap((row) => ledgerRange(seriesKey, row) ?? []);
      const elsewhere = await this.findNovelVolumeRangesElsewhere(userId, seriesKey, matchKey ?? null, novelTitles);
      const ranges = [...ownRanges, ...elsewhere];
      for (const unit of volumes) {
        const wanted = unit.range ?? rangeFromUnitKey(seriesKey, unit.key);
        const owned =
          wanted === null
            ? ownKeys.has(unit.key)
            : ownUnranged.has(volumeKeyBase(unit.key, seriesKey) ?? unit.key) || webSerialRangesCover(ranges, wanted);
        if (owned) imported.add(unit.key);
      }
    }

    return units.filter((unit) => imported.has(unit.key)).map((unit) => unit.key);
  }

  /**
   * Ranges of the novel volumes this user has from other sources of the same novel on the same engine: by matched series,
   * or by series title compared the way `compactSerialTitle` compares it. Rows from before ranges were stored count only
   * for their own source. Bounded by the user's novel volume rows of the matched series or titles.
   */
  private async findNovelVolumeRangesElsewhere(
    userId: number,
    seriesKey: string,
    matchKey: string | null,
    titles: readonly string[],
  ): Promise<WebSerialChapterRange[]> {
    const compactTitles = [...new Set(titles.map(compactSerialTitle).filter(Boolean))];
    const compactSeriesName = sql`regexp_replace(lower(public.bookorbit_unaccent(${bookMetadata.seriesName})), '[^[:alnum:]]+', '', 'g')`;
    const same = [
      ...(matchKey ? [eq(webSerialImports.matchKey, matchKey)] : []),
      ...(compactTitles.length > 0 ? [inArray(webSerialImports.titleKey, compactTitles)] : []),
      // Rows from before title keys: the filed series name still carries edition tags, so it is narrowed here and compared below.
      ...compactTitles.map((title) => and(sql`${webSerialImports.titleKey} is null`, sql`${compactSeriesName} like ${`%${escapeLike(title)}%`}`)!),
    ];
    if (same.length === 0) return [];
    const rows = await this.db
      .selectDistinct({
        seriesKey: webSerialImports.seriesKey,
        matchKey: webSerialImports.matchKey,
        titleKey: webSerialImports.titleKey,
        seriesName: bookMetadata.seriesName,
        sequence: webSerialImports.sequence,
        chapterFrom: webSerialImports.chapterFrom,
        chapterTo: webSerialImports.chapterTo,
      })
      .from(webSerialImports)
      .innerJoin(books, eq(books.id, webSerialImports.bookId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, webSerialImports.bookId))
      .where(
        and(
          eq(webSerialImports.userId, userId),
          eq(webSerialImports.kind, 'novel'),
          eq(webSerialImports.packaging, 'volume'),
          sql`${webSerialImports.seriesKey} <> ${seriesKey}`,
          sql`${webSerialImports.seriesKey} like ${`${engineOf(seriesKey)}:%`}`,
          or(...same),
        ),
      )
      .limit(MAX_ELSEWHERE_VOLUME_ROWS);
    const wanted = new Set(compactTitles);
    return rows.flatMap((row) => {
      if (row.chapterFrom == null || row.chapterTo == null) return [];
      const sameNovel =
        (matchKey !== null && row.matchKey === matchKey) ||
        (row.titleKey != null ? wanted.has(row.titleKey) : row.seriesName != null && wanted.has(compactSerialTitle(row.seriesName)));
      return sameNovel ? [{ from: row.chapterFrom, to: row.chapterTo }] : [];
    });
  }

  /** Which of the given `mb:<id>` match keys the user already has a book for, from any source. Bounded by the caller's id list. */
  async findImportedMatchKeys(userId: number, matchKeys: readonly string[]): Promise<Set<string>> {
    if (matchKeys.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ matchKey: webSerialImports.matchKey })
      .from(webSerialImports)
      .innerJoin(books, eq(books.id, webSerialImports.bookId))
      .where(and(eq(webSerialImports.userId, userId), inArray(webSerialImports.matchKey, [...matchKeys])));
    return new Set(rows.flatMap((row) => (row.matchKey ? [row.matchKey] : [])));
  }

  /** Keys of the grouped books (volumes, one-book selections, whole-series novels) this user already has for the series. */
  async findImportedGroupKeys(userId: number, seriesKey: string): Promise<string[]> {
    const unitKey = webSerialImports.unitKey;
    const rows = await this.db
      .selectDistinct({ unitKey })
      .from(webSerialImports)
      .innerJoin(books, eq(books.id, webSerialImports.bookId))
      .where(
        and(
          eq(webSerialImports.userId, userId),
          eq(webSerialImports.seriesKey, seriesKey),
          sql`(${unitKey} like 'vol:%' or ${unitKey} like 'sel:%' or ${unitKey} = ${WEB_SERIAL_SERIES_UNIT_KEY})`,
        ),
      )
      .limit(MAX_GROUP_KEYS);
    return rows.map((row) => row.unitKey);
  }

  /** Marks the job's still-pending items for the given unit keys as skipped (already in the library). */
  async skipItems(jobId: number, unitKeys: readonly string[]): Promise<number> {
    if (unitKeys.length === 0) return 0;
    const rows = await this.db
      .update(webSerialJobItems)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(and(eq(webSerialJobItems.jobId, jobId), eq(webSerialJobItems.status, 'pending'), inArray(webSerialJobItems.unitKey, [...unitKeys])))
      .returning({ id: webSerialJobItems.id });
    return rows.length;
  }

  /** Recomputes the job's unit counters from its items, so a retry or resume can never double count. */
  async refreshCounters(jobId: number): Promise<void> {
    await this.syncCounters(this.db, jobId);
  }

  private async syncCounters(executor: Pick<Db, 'update'>, jobId: number): Promise<void> {
    const countWhere = (status: WebSerialJobItemStatus) =>
      sql<number>`(select count(*)::int from ${webSerialJobItems} where ${webSerialJobItems.jobId} = ${jobId} and ${webSerialJobItems.status} = ${status})`;
    await executor
      .update(webSerialJobs)
      .set({
        unitsTotal: sql<number>`(select count(*)::int from ${webSerialJobItems} where ${webSerialJobItems.jobId} = ${jobId})`,
        unitsDone: countWhere('imported'),
        unitsFailed: countWhere('failed'),
        unitsSkipped: countWhere('skipped'),
        updatedAt: new Date(),
      })
      .where(eq(webSerialJobs.id, jobId));
  }
}
