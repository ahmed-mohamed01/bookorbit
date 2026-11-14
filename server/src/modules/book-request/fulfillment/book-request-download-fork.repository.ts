import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES } from '@bookorbit/types';
import type { BookRequestDownloadStatus } from '@bookorbit/types';

import * as schema from '../../../db/schema';
import { bookRequestDownloads, type BookRequestDownloadRow } from '../../../db/schema';
import { bookRequestDownloadExtension } from '../schema/book-request-download-extension.schema';
import { bookRequestDownloadFileCount } from '../schema/book-request-download-file-count.schema';

type Db = NodePgDatabase<typeof schema>;

/** Fork queries on download attempts, inherited by `BookRequestDownloadRepository` so its callers keep one repository. */
export class BookRequestDownloadForkRepository {
  constructor(protected readonly db: Db) {}

  /** How many files a client wrote when it named only the first (a fork column, see the schema file). */
  async findContentFileCount(id: number): Promise<number | null> {
    const [row] = await this.db
      .select({ contentFileCount: bookRequestDownloadFileCount.contentFileCount })
      .from(bookRequestDownloadFileCount)
      .where(eq(bookRequestDownloadFileCount.id, id))
      .limit(1);
    return row?.contentFileCount ?? null;
  }

  /**
   * Whether a different request still has a live (not failed) attempt on the same torrent on the same
   * client. `statuses` narrows "live" to attempts in one of those statuses.
   */
  async existsOtherForClientKey(
    downloadId: number,
    requestId: number,
    downloadClientId: number,
    clientKey: string,
    statuses?: readonly BookRequestDownloadStatus[],
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: bookRequestDownloads.id })
      .from(bookRequestDownloads)
      .where(
        and(
          eq(bookRequestDownloads.downloadClientId, downloadClientId),
          eq(bookRequestDownloads.clientKey, clientKey),
          sql`${bookRequestDownloads.id} <> ${downloadId}`,
          sql`${bookRequestDownloads.requestId} <> ${requestId}`,
          statuses ? inArray(bookRequestDownloads.status, [...statuses]) : sql`${bookRequestDownloads.status} <> 'failed'`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async findExtension(id: number): Promise<{ filesPendingSince: Date | null; extendsExisting: boolean }> {
    const [row] = await this.db
      .select({ filesPendingSince: bookRequestDownloadExtension.filesPendingSince, extendsExisting: bookRequestDownloadExtension.extendsExisting })
      .from(bookRequestDownloadExtension)
      .where(eq(bookRequestDownloadExtension.id, id))
      .limit(1);
    return { filesPendingSince: row?.filesPendingSince ?? null, extendsExisting: row?.extendsExisting === true };
  }

  async setExtendsExisting(id: number): Promise<void> {
    await this.db.update(bookRequestDownloadExtension).set({ extendsExisting: true }).where(eq(bookRequestDownloadExtension.id, id));
  }

  async setFilesPendingSince(id: number, since: Date | null): Promise<void> {
    // Clearing runs on every poll of every active download; skipping rows already clear keeps the common case write-free.
    const where =
      since === null
        ? and(eq(bookRequestDownloadExtension.id, id), isNotNull(bookRequestDownloadExtension.filesPendingSince))
        : eq(bookRequestDownloadExtension.id, id);
    await this.db.update(bookRequestDownloadExtension).set({ filesPendingSince: since }).where(where);
  }

  async setContentFileCount(id: number, contentFileCount: number): Promise<void> {
    await this.db.update(bookRequestDownloadFileCount).set({ contentFileCount }).where(eq(bookRequestDownloadFileCount.id, id));
  }

  /** An attempt that still holds the client's copy of this torrent: the same set the active-hash unique index covers. */
  async findUnsettledByClientKey(downloadClientId: number, clientKey: string): Promise<BookRequestDownloadRow | undefined> {
    const [row] = await this.db
      .select()
      .from(bookRequestDownloads)
      .where(
        and(
          eq(bookRequestDownloads.downloadClientId, downloadClientId),
          eq(bookRequestDownloads.clientKey, clientKey),
          inArray(bookRequestDownloads.status, [...UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES]),
        ),
      )
      .limit(1);
    return row;
  }
}
