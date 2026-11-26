import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { knowledgeIndex, knowledgeCards, knowledgeKindReviews, knowledgeSettings } from './schema/book-knowledge.schema';
@Injectable()
export class BookKnowledgeRepository {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}
  async bootstrap(statements: string[]) {
    for (const statement of statements) await this.db.execute(sql.raw(statement));
  }
  /** A book's files with the inputs upstream's story guide ranking reads, so BK picks the file the card picks. */
  knowledgeFileCandidates(bookId: number) {
    const { bookFiles, books, libraries } = schema;
    return this.db
      .select({
        id: bookFiles.id,
        bookId: bookFiles.bookId,
        format: bookFiles.format,
        role: bookFiles.role,
        absolutePath: bookFiles.absolutePath,
        fileHash: bookFiles.fileHash,
        sizeBytes: bookFiles.sizeBytes,
        mediaOverlayAvailable: bookFiles.mediaOverlayAvailable,
        primaryFileId: books.primaryFileId,
        formatPriority: libraries.formatPriority,
      })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .innerJoin(libraries, eq(libraries.id, books.libraryId))
      .where(eq(bookFiles.bookId, bookId))
      .orderBy(asc(bookFiles.sortOrder), asc(bookFiles.id));
  }
  async state(bookId: number) {
    return (await this.db.select().from(knowledgeIndex).where(eq(knowledgeIndex.bookId, bookId)))[0];
  }
  async queue(bookId: number, fingerprint: string, textVersion: number, termsVersion: number) {
    await this.db
      .insert(knowledgeIndex)
      .values({ bookId, fingerprint, textVersion, termsVersion, status: 'queued' })
      .onConflictDoUpdate({
        target: knowledgeIndex.bookId,
        set: { fingerprint, textVersion, termsVersion, status: 'queued', progress: 0, error: null, updatedAt: new Date() },
        setWhere: ne(knowledgeIndex.status, 'running'),
      });
  }
  async update(bookId: number, values: Partial<typeof knowledgeIndex.$inferInsert>) {
    await this.db
      .update(knowledgeIndex)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(knowledgeIndex.bookId, bookId));
  }
  async resume() {
    await this.db.update(knowledgeIndex).set({ status: 'queued' }).where(eq(knowledgeIndex.status, 'running'));
  }
  async next() {
    return (
      await this.db
        .select()
        .from(knowledgeIndex)
        .where(eq(knowledgeIndex.status, 'queued'))
        .orderBy(knowledgeIndex.updatedAt, knowledgeIndex.bookId)
        .limit(1)
    )[0];
  }
  async settings() {
    return (await this.db.select().from(knowledgeSettings).where(eq(knowledgeSettings.id, 1)))[0]!;
  }
  async saveSettings(values: Partial<typeof knowledgeSettings.$inferInsert>) {
    await this.db
      .update(knowledgeSettings)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(knowledgeSettings.id, 1));
  }
  async cached(
    identity: Pick<
      typeof knowledgeCards.$inferInsert,
      'bookId' | 'fingerprint' | 'termKey' | 'cutoffOrdinal' | 'model' | 'promptVersion' | 'evidenceHash'
    >,
  ) {
    return (
      await this.db
        .select()
        .from(knowledgeCards)
        .where(
          and(
            eq(knowledgeCards.bookId, identity.bookId),
            eq(knowledgeCards.fingerprint, identity.fingerprint),
            eq(knowledgeCards.termKey, identity.termKey),
            eq(knowledgeCards.cutoffOrdinal, identity.cutoffOrdinal),
            eq(knowledgeCards.model, identity.model),
            eq(knowledgeCards.promptVersion, identity.promptVersion),
            eq(knowledgeCards.evidenceHash, identity.evidenceHash),
          ),
        )
        .limit(1)
    )[0];
  }
  async cache(value: typeof knowledgeCards.$inferInsert) {
    await this.db.insert(knowledgeCards).values(value).onConflictDoNothing();
  }
  async kindReviews(bookId: number, fingerprint: string, requestHashes: string[]) {
    if (!requestHashes.length) return [];
    return this.db
      .select({ requestHash: knowledgeKindReviews.requestHash, answers: knowledgeKindReviews.answers })
      .from(knowledgeKindReviews)
      .where(
        and(
          eq(knowledgeKindReviews.bookId, bookId),
          eq(knowledgeKindReviews.fingerprint, fingerprint),
          inArray(knowledgeKindReviews.requestHash, requestHashes),
        ),
      );
  }
  async saveKindReview(value: typeof knowledgeKindReviews.$inferInsert) {
    await this.db.insert(knowledgeKindReviews).values(value).onConflictDoNothing();
  }
  async enqueueCleanup(bookId: number) {
    await this.db.execute(sql`INSERT INTO book_knowledge_cleanup(book_id) VALUES(${bookId}) ON CONFLICT DO NOTHING`);
  }
  async cleanupIds(): Promise<number[]> {
    const result = await this.db.execute<{ book_id: number }>(sql`SELECT book_id FROM book_knowledge_cleanup ORDER BY book_id LIMIT 20`);
    return result.rows.map((row) => row.book_id);
  }
  async cleanupDone(bookId: number) {
    await this.db.execute(sql`DELETE FROM book_knowledge_cleanup WHERE book_id=${bookId}`);
  }
}
