import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { BatchSummary, BookRequestKind } from '@bookorbit/types';

import { applySchemaStatements, findMissingColumns } from '../../../common/utils/schema-bootstrap.utils';
import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { bookDockFiles, bookRequestDownloads, bookRequests } from '../../../db/schema';
import { bookRequestBatchUnits, bookRequestKind, type BatchUnitRow, type NewBatchUnitRow } from '../schema/book-request-batch.schema';

type Db = NodePgDatabase<typeof schema>;

const INSERT_CHUNK_SIZE = 500;

@Injectable()
export class BookRequestBatchRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findMissingColumns(tableName: string, columnNames: readonly string[]): Promise<string[]> {
    return findMissingColumns(this.db, tableName, columnNames);
  }

  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    return applySchemaStatements(this.db, statements);
  }

  async insertUnits(rows: NewBatchUnitRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
        await tx.insert(bookRequestBatchUnits).values(rows.slice(offset, offset + INSERT_CHUNK_SIZE));
      }
    });
  }

  async findUnits(requestId: number): Promise<BatchUnitRow[]> {
    return this.db
      .select()
      .from(bookRequestBatchUnits)
      .where(eq(bookRequestBatchUnits.requestId, requestId))
      .orderBy(asc(bookRequestBatchUnits.unitIndex));
  }

  /**
   * Units of one torrent that an earlier batch already placed in Book Dock. `ownerUserId` null
   * means the viewer sees every batch; otherwise only that user's own.
   */
  async findImportedUnitIndexes(clientKey: string, ownerUserId: number | null): Promise<number[]> {
    const rows = await this.db
      .selectDistinct({ unitIndex: bookRequestBatchUnits.unitIndex })
      .from(bookRequestBatchUnits)
      .innerJoin(bookRequestDownloads, eq(bookRequestDownloads.requestId, bookRequestBatchUnits.requestId))
      .innerJoin(bookRequests, eq(bookRequests.id, bookRequestBatchUnits.requestId))
      .where(
        and(
          eq(bookRequestBatchUnits.status, 'in_dock'),
          sql`lower(${bookRequestDownloads.clientKey}) = ${clientKey.toLowerCase()}`,
          ownerUserId === null ? undefined : eq(bookRequests.userId, ownerUserId),
        ),
      )
      .orderBy(asc(bookRequestBatchUnits.unitIndex));
    return rows.map((row) => row.unitIndex);
  }

  async updateUnit(id: number, data: Partial<NewBatchUnitRow>): Promise<void> {
    await this.db.update(bookRequestBatchUnits).set(data).where(eq(bookRequestBatchUnits.id, id));
  }

  /**
   * Gives failed units another go. A unit whose Book Dock row still exists goes to 'placing' with
   * its id kept, so the import's adoption logic decides rather than placing it a second time.
   * 'placing' and 'in_dock' units are left alone.
   */
  async resetUnitsForRetry(requestId: number): Promise<number> {
    const liveDockRow = sql`exists (select 1 from ${bookDockFiles} where ${bookDockFiles.id} = ${bookRequestBatchUnits.bookDockFileId})`;
    const failed = and(eq(bookRequestBatchUnits.requestId, requestId), eq(bookRequestBatchUnits.status, 'failed'));
    return this.db.transaction(async (tx) => {
      const adopted = await tx
        .update(bookRequestBatchUnits)
        .set({ status: 'placing', errorMessage: null })
        .where(and(failed, liveDockRow))
        .returning({ id: bookRequestBatchUnits.id });
      const reset = await tx
        .update(bookRequestBatchUnits)
        .set({ status: 'waiting', errorMessage: null, bookDockFileId: null })
        .where(failed)
        .returning({ id: bookRequestBatchUnits.id });
      return adopted.length + reset.length;
    });
  }

  async findKinds(requestIds: number[]): Promise<Map<number, BookRequestKind>> {
    const unique = [...new Set(requestIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: bookRequestKind.id, kind: bookRequestKind.kind })
      .from(bookRequestKind)
      .where(inArray(bookRequestKind.id, unique));
    return new Map(rows.map((row) => [row.id, row.kind as BookRequestKind]));
  }

  async setKind(requestId: number, kind: BookRequestKind): Promise<void> {
    await this.db.update(bookRequestKind).set({ kind }).where(eq(bookRequestKind.id, requestId));
  }

  async summaries(requestIds: number[]): Promise<Map<number, BatchSummary>> {
    const unique = [...new Set(requestIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({
        requestId: bookRequestBatchUnits.requestId,
        total: sql<number>`count(*)::int`,
        inDock: sql<number>`(count(*) filter (where ${bookRequestBatchUnits.status} = 'in_dock'))::int`,
        failed: sql<number>`(count(*) filter (where ${bookRequestBatchUnits.status} = 'failed'))::int`,
      })
      .from(bookRequestBatchUnits)
      .where(inArray(bookRequestBatchUnits.requestId, unique))
      .groupBy(bookRequestBatchUnits.requestId);
    return new Map(rows.map((row) => [row.requestId, { total: row.total, inDock: row.inDock, failed: row.failed }]));
  }
}
