import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { GroupedSeries } from './file-index/file-index-grouping';
import {
  webSerialFileIndexes,
  webSerialFileIndexFiles,
  webSerialFileIndexSeries,
  type NewWebSerialFileIndexRow,
  type WebSerialFileIndexFileRow,
  type WebSerialFileIndexRow,
  type WebSerialFileIndexSeriesRow,
} from './schema/web-serials.schema';

type Db = NodePgDatabase<typeof schema>;

const SERIES_BATCH = 500;
const FILE_BATCH = 2_000;
export const FILE_INDEX_SEARCH_LIMIT = 30;
const SERIES_FILES_LIMIT = 2_000;

export type FileIndexSeriesHit = Pick<
  WebSerialFileIndexSeriesRow,
  'id' | 'indexId' | 'folderPath' | 'title' | 'volumeCount' | 'coverPath' | 'matchId'
> & {
  indexName: string;
};

export interface FileIndexSeriesDetail {
  index: WebSerialFileIndexRow;
  series: WebSerialFileIndexSeriesRow;
}

export type EnabledFileIndex = Pick<WebSerialFileIndexRow, 'id' | 'name' | 'baseUrl'>;

export interface FileIndexWriteResult {
  series: number;
  files: number;
  removedSeries: number;
  removedFiles: number;
}

@Injectable()
export class WebSerialsFileIndexRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  listIndexes(): Promise<WebSerialFileIndexRow[]> {
    return this.db.select().from(webSerialFileIndexes).orderBy(asc(webSerialFileIndexes.name), asc(webSerialFileIndexes.id));
  }

  async findIndex(id: number): Promise<WebSerialFileIndexRow | null> {
    const [row] = await this.db.select().from(webSerialFileIndexes).where(eq(webSerialFileIndexes.id, id));
    return row ?? null;
  }

  async createIndex(row: NewWebSerialFileIndexRow): Promise<WebSerialFileIndexRow> {
    const [created] = await this.db.insert(webSerialFileIndexes).values(row).returning();
    return created!;
  }

  async updateIndex(id: number, patch: Partial<NewWebSerialFileIndexRow>): Promise<WebSerialFileIndexRow | null> {
    const [updated] = await this.db.update(webSerialFileIndexes).set(patch).where(eq(webSerialFileIndexes.id, id)).returning();
    return updated ?? null;
  }

  async deleteIndex(id: number): Promise<boolean> {
    const deleted = await this.db.delete(webSerialFileIndexes).where(eq(webSerialFileIndexes.id, id)).returning({ id: webSerialFileIndexes.id });
    return deleted.length > 0;
  }

  /** Enabled indexes never refreshed, or whose refresh interval has passed since the last attempt. */
  dueIndexIds(now: Date): Promise<Array<{ id: number }>> {
    const t = webSerialFileIndexes;
    return this.db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.enabled, true), sql`(${t.lastRefreshAt} is null or ${t.lastRefreshAt} + make_interval(hours => ${t.refreshHours}) <= ${now})`))
      .orderBy(sql`${t.lastRefreshAt} asc nulls first`, asc(t.id));
  }

  enabledIndexes(): Promise<EnabledFileIndex[]> {
    const t = webSerialFileIndexes;
    return this.db.select({ id: t.id, name: t.name, baseUrl: t.baseUrl }).from(t).where(eq(t.enabled, true)).orderBy(asc(t.name), asc(t.id));
  }

  /** Title prefixes first, then word similarity, within the given (enabled) indexes. */
  searchSeries(titleKey: string, indexIds: readonly number[], limit = FILE_INDEX_SEARCH_LIMIT): Promise<FileIndexSeriesHit[]> {
    if (indexIds.length === 0 || !titleKey) return Promise.resolve([]);
    const s = webSerialFileIndexSeries;
    const prefix = sql<boolean>`${s.titleKey} like ${escapeLike(titleKey)}`;
    return this.db
      .select({ ...this.hitColumns(), prefix })
      .from(s)
      .innerJoin(webSerialFileIndexes, eq(webSerialFileIndexes.id, s.indexId))
      .where(and(inArray(s.indexId, [...indexIds]), eq(webSerialFileIndexes.enabled, true), or(prefix, sql`${titleKey} <% ${s.titleKey}`)))
      .orderBy(desc(prefix), desc(sql`word_similarity(${titleKey}, ${s.titleKey})`), asc(s.title))
      .limit(limit);
  }

  /** Series whose title is exactly one of the keys, or that were matched to the details-database series. */
  findCandidates(titleKeys: readonly string[], matchId: string | null, indexIds: readonly number[], limit: number): Promise<FileIndexSeriesHit[]> {
    if (indexIds.length === 0 || (titleKeys.length === 0 && !matchId)) return Promise.resolve([]);
    const s = webSerialFileIndexSeries;
    const conditions = [...(titleKeys.length > 0 ? [inArray(s.titleKey, [...titleKeys])] : []), ...(matchId ? [eq(s.matchId, matchId)] : [])];
    return this.db
      .select(this.hitColumns())
      .from(s)
      .innerJoin(webSerialFileIndexes, eq(webSerialFileIndexes.id, s.indexId))
      .where(and(inArray(s.indexId, [...indexIds]), eq(webSerialFileIndexes.enabled, true), or(...conditions)))
      .orderBy(desc(s.volumeCount), asc(s.id))
      .limit(limit);
  }

  async findSeries(indexId: number, seriesId: number): Promise<FileIndexSeriesDetail | null> {
    const [row] = await this.db
      .select({ index: webSerialFileIndexes, series: webSerialFileIndexSeries })
      .from(webSerialFileIndexSeries)
      .innerJoin(webSerialFileIndexes, eq(webSerialFileIndexes.id, webSerialFileIndexSeries.indexId))
      .where(and(eq(webSerialFileIndexSeries.id, seriesId), eq(webSerialFileIndexSeries.indexId, indexId)));
    return row ?? null;
  }

  async findSeriesIdByFolder(indexId: number, folderPath: string): Promise<number | null> {
    const s = webSerialFileIndexSeries;
    const [row] = await this.db
      .select({ id: s.id })
      .from(s)
      .where(and(eq(s.indexId, indexId), eq(s.folderPath, folderPath)));
    return row?.id ?? null;
  }

  listSeriesFiles(seriesId: number): Promise<WebSerialFileIndexFileRow[]> {
    const f = webSerialFileIndexFiles;
    return this.db.select().from(f).where(eq(f.seriesId, seriesId)).orderBy(asc(f.volume), asc(f.name)).limit(SERIES_FILES_LIMIT);
  }

  async findFile(seriesId: number, fileId: number): Promise<WebSerialFileIndexFileRow | null> {
    const f = webSerialFileIndexFiles;
    const [row] = await this.db
      .select()
      .from(f)
      .where(and(eq(f.id, fileId), eq(f.seriesId, seriesId)));
    return row ?? null;
  }

  private hitColumns() {
    const s = webSerialFileIndexSeries;
    return {
      id: s.id,
      indexId: s.indexId,
      folderPath: s.folderPath,
      title: s.title,
      volumeCount: s.volumeCount,
      coverPath: s.coverPath,
      matchId: s.matchId,
      indexName: webSerialFileIndexes.name,
    };
  }

  /**
   * Upserts every series and file of a successful read, then removes what the read no longer listed. Rows are stamped
   * with `seenAt`, so a refresh that fails part way leaves the previous listing in place rather than a partial one.
   */
  async writeListing(indexId: number, series: readonly GroupedSeries[], seenAt: Date): Promise<FileIndexWriteResult> {
    let files = 0;
    for (let start = 0; start < series.length; start += SERIES_BATCH) {
      const batch = series.slice(start, start + SERIES_BATCH);
      const ids = await this.upsertSeries(indexId, batch, seenAt);
      const rows = batch.flatMap((entry) => {
        const seriesId = ids.get(entry.folderPath);
        if (seriesId === undefined) return [];
        return entry.files.map((file) => ({ seriesId, path: file.path, name: file.name, size: file.size, volume: file.volume, lastSeenAt: seenAt }));
      });
      for (let offset = 0; offset < rows.length; offset += FILE_BATCH) {
        await this.upsertFiles(rows.slice(offset, offset + FILE_BATCH));
      }
      files += rows.length;
    }

    const seriesIds = this.db
      .select({ id: webSerialFileIndexSeries.id })
      .from(webSerialFileIndexSeries)
      .where(eq(webSerialFileIndexSeries.indexId, indexId));
    const removedFiles = await this.db
      .delete(webSerialFileIndexFiles)
      .where(and(inArray(webSerialFileIndexFiles.seriesId, seriesIds), lt(webSerialFileIndexFiles.lastSeenAt, seenAt)))
      .returning({ id: webSerialFileIndexFiles.id });
    const removedSeries = await this.db
      .delete(webSerialFileIndexSeries)
      .where(and(eq(webSerialFileIndexSeries.indexId, indexId), lt(webSerialFileIndexSeries.lastSeenAt, seenAt)))
      .returning({ id: webSerialFileIndexSeries.id });

    return { series: series.length, files, removedSeries: removedSeries.length, removedFiles: removedFiles.length };
  }

  private async upsertSeries(indexId: number, batch: readonly GroupedSeries[], seenAt: Date): Promise<Map<string, number>> {
    if (batch.length === 0) return new Map();
    const t = webSerialFileIndexSeries;
    const written = await this.db
      .insert(t)
      .values(
        batch.map((entry) => ({
          indexId,
          folderPath: entry.folderPath,
          title: entry.title,
          titleKey: entry.titleKey,
          volumeCount: entry.files.length,
          coverPath: entry.coverPath,
          lastSeenAt: seenAt,
        })),
      )
      .onConflictDoUpdate({
        target: [t.indexId, t.folderPath],
        set: {
          title: sql`excluded.title`,
          titleKey: sql`excluded.title_key`,
          volumeCount: sql`excluded.volume_count`,
          coverPath: sql`excluded.cover_path`,
          // A renamed folder is a different title, so a match made for the old one no longer holds.
          matchId: sql`case when ${t.titleKey} = excluded.title_key then ${t.matchId} end`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      })
      .returning({ id: t.id, folderPath: t.folderPath });
    return new Map(written.map((row) => [row.folderPath, row.id]));
  }

  private async upsertFiles(rows: Array<typeof webSerialFileIndexFiles.$inferInsert>): Promise<void> {
    if (rows.length === 0) return;
    const t = webSerialFileIndexFiles;
    await this.db
      .insert(t)
      .values(rows)
      .onConflictDoUpdate({
        target: [t.seriesId, t.path],
        set: { name: sql`excluded.name`, size: sql`excluded.size`, volume: sql`excluded.volume`, lastSeenAt: sql`excluded.last_seen_at` },
      });
  }
}

function escapeLike(value: string): string {
  return `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
