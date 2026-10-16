import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { GroupedSeries } from './file-index/file-index-grouping';
import {
  webSerialFileIndexes,
  webSerialFileIndexFiles,
  webSerialFileIndexSeries,
  type NewWebSerialFileIndexRow,
  type WebSerialFileIndexRow,
} from './schema/web-serials.schema';

type Db = NodePgDatabase<typeof schema>;

const SERIES_BATCH = 500;
const FILE_BATCH = 2_000;

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
          lastSeenAt: seenAt,
        })),
      )
      .onConflictDoUpdate({
        target: [t.indexId, t.folderPath],
        set: {
          title: sql`excluded.title`,
          titleKey: sql`excluded.title_key`,
          volumeCount: sql`excluded.volume_count`,
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
