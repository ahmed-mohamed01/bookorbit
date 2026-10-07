import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { ReadAlongOffsetsRecord, ReadAlongOffsetsStore } from '../book/read-along-offsets-store';
import { readAlongNarrationOffsets } from './schema/read-along-offsets.schema';

type Db = NodePgDatabase<typeof schema>;

/** Stored narration offsets for a read-along EPUB against the audiobook it is linked to. */
@Injectable()
export class EditionLinkReadAlongOffsetsService implements ReadAlongOffsetsStore {
  constructor(@Inject(DB) private readonly db: Db) {}

  async find(readAlongFileId: number, audioBookId: number): Promise<ReadAlongOffsetsRecord | null> {
    const [row] = await this.db
      .select({
        readAlongFileId: readAlongNarrationOffsets.readAlongFileId,
        audioBookId: readAlongNarrationOffsets.audioBookId,
        narrationSignature: readAlongNarrationOffsets.narrationSignature,
        audioSignature: readAlongNarrationOffsets.audioSignature,
        status: readAlongNarrationOffsets.status,
        source: readAlongNarrationOffsets.source,
        offsets: readAlongNarrationOffsets.offsets,
        mismatch: readAlongNarrationOffsets.mismatch,
      })
      .from(readAlongNarrationOffsets)
      .where(and(eq(readAlongNarrationOffsets.readAlongFileId, readAlongFileId), eq(readAlongNarrationOffsets.audioBookId, audioBookId)))
      .limit(1);
    return row ?? null;
  }

  async save(record: ReadAlongOffsetsRecord): Promise<void> {
    const values = {
      narrationSignature: record.narrationSignature,
      audioSignature: record.audioSignature,
      status: record.status,
      source: record.source,
      offsets: record.offsets,
      mismatch: record.mismatch,
    };
    await this.db
      .insert(readAlongNarrationOffsets)
      .values({ readAlongFileId: record.readAlongFileId, audioBookId: record.audioBookId, ...values })
      .onConflictDoUpdate({
        target: [readAlongNarrationOffsets.readAlongFileId, readAlongNarrationOffsets.audioBookId],
        set: { ...values, updatedAt: sql`now()` },
      });
  }

  async delete(readAlongFileId: number, audioBookId: number): Promise<void> {
    await this.db
      .delete(readAlongNarrationOffsets)
      .where(and(eq(readAlongNarrationOffsets.readAlongFileId, readAlongFileId), eq(readAlongNarrationOffsets.audioBookId, audioBookId)));
  }
}
