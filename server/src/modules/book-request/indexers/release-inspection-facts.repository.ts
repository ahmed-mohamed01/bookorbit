import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { applySchemaStatements, findMissingTables } from '../../../common/utils/schema-bootstrap.utils';
import { releaseInspectionFacts } from '../schema/release-inspection-facts.schema';
import type { ReleaseInspectionFacts } from './release-inspection-facts';

@Injectable()
export class ReleaseInspectionFactsRepository {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  async findMissingTables(tableNames: readonly string[]): Promise<string[]> {
    return findMissingTables(this.db, tableNames);
  }

  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    return applySchemaStatements(this.db, statements);
  }

  async findByHashes(hashes: string[]): Promise<Map<string, Omit<ReleaseInspectionFacts, 'unitCount'> & { unitCount?: number }>> {
    if (hashes.length === 0) return new Map();
    const rows = await this.db
      .select({
        infoHash: releaseInspectionFacts.infoHash,
        fileCount: releaseInspectionFacts.fileCount,
        unitCount: releaseInspectionFacts.unitCount,
        primaryFileCount: releaseInspectionFacts.primaryFileCount,
        formats: releaseInspectionFacts.formats,
      })
      .from(releaseInspectionFacts)
      .where(inArray(releaseInspectionFacts.infoHash, hashes));
    return new Map(rows.map((row) => [row.infoHash, { ...row, unitCount: row.unitCount ?? undefined }]));
  }

  async upsert(facts: ReleaseInspectionFacts): Promise<void> {
    const { infoHash, ...values } = facts;
    await this.db
      .insert(releaseInspectionFacts)
      .values({ infoHash, ...values })
      .onConflictDoUpdate({ target: releaseInspectionFacts.infoHash, set: { ...values, inspectedAt: new Date() } });
  }
}
