import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { BatchSummary, BookRequestKind } from '@bookorbit/types';

import { applySchemaStatements, findMissingColumns } from '../../../common/utils/schema-bootstrap.utils';
import { DB } from '../../../db';
import * as schema from '../../../db/schema';
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

  async updateUnit(id: number, data: Partial<NewBatchUnitRow>): Promise<void> {
    await this.db.update(bookRequestBatchUnits).set(data).where(eq(bookRequestBatchUnits.id, id));
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
