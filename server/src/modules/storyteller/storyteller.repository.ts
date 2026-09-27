import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { StorytellerConnectionTestResult } from '@bookorbit/types';
import { AUDIO_FORMAT_LIST, isAudioFormat } from '@bookorbit/types';
import { applySchemaStatements, findMissingTables } from '../../common/utils/schema-bootstrap.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { authors, bookAuthors, bookFiles, bookMetadata, books, libraryFolders } from '../../db/schema';
import { compareAudioPlayOrder } from '../../common/utils/audio-play-order.utils';
import { storytellerReadAlongBuilds, storytellerSettings } from './schema/storyteller.schema';
import type {
  NewStorytellerReadAlongBuild,
  NewStorytellerSettingsRow,
  StorytellerQueuedRequest,
  StorytellerReadAlongBuild,
  StorytellerSettingsRow,
} from './schema/storyteller.schema';

type Db = NodePgDatabase<typeof schema>;

// Match the columns that hold them.
const BOOK_UUID_MAX_LENGTH = 64;
const REMOTE_TASK_MAX_LENGTH = 255;

// Whole code points, never half a surrogate pair - Postgres rejects that as invalid UTF-8.
function clampToLength(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : Array.from(value).slice(0, maxLength).join('');
}

export interface StorytellerSourceEpubFile {
  id: number;
  absolutePath: string;
}

export interface StorytellerAudioFile {
  absolutePath: string;
}

export interface StorytellerLibraryFolder {
  id: number;
  path: string;
}

export interface StorytellerBookFileLocation {
  bookId: number;
  libraryId: number;
}

export interface StorytellerQueueBuildValues {
  textBookId: number;
  audioBookId: number;
  requestedBy: number;
  queuedRequest: StorytellerQueuedRequest;
}

export interface StorytellerBookIdentity {
  title: string | null;
  authorNames: string[];
  isbn10: string | null;
  isbn13: string | null;
  asin: string | null;
}

@Injectable()
export class StorytellerRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findMissingTables(tableNames: readonly string[]): Promise<string[]> {
    return findMissingTables(this.db, tableNames);
  }

  // DB access lives here so the bootstrap service never injects the Drizzle instance directly.
  async applySchemaStatements(statements: readonly string[]): Promise<void> {
    return applySchemaStatements(this.db, statements);
  }

  async getSettings(): Promise<StorytellerSettingsRow | undefined> {
    const [row] = await this.db.select().from(storytellerSettings).where(eq(storytellerSettings.id, 1)).limit(1);
    return row;
  }

  async upsertSettings(values: Partial<NewStorytellerSettingsRow>): Promise<StorytellerSettingsRow> {
    const [row] = await this.db
      .insert(storytellerSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({
        target: storytellerSettings.id,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /**
   * Upserts so a test run before any settings were saved still persists a result row.
   *
   * `testedServerUrl` is the host the result describes. The round trip takes seconds, so a save can
   * re-point this single row while it is in flight; `setWhere` drops the stale result in the same
   * statement that would have written it, rather than showing a green check for a server nobody
   * tested and gating builds on it.
   */
  async recordCheck(result: StorytellerConnectionTestResult, testedServerUrl: string | null): Promise<void> {
    const checkedAt = new Date();
    await this.db
      .insert(storytellerSettings)
      .values({ id: 1, lastCheckResult: result, lastCheckedAt: checkedAt })
      .onConflictDoUpdate({
        target: storytellerSettings.id,
        set: { lastCheckResult: result, lastCheckedAt: checkedAt, updatedAt: checkedAt },
        setWhere: testedServerUrl === null ? isNull(storytellerSettings.serverUrl) : eq(storytellerSettings.serverUrl, testedServerUrl),
      });
  }

  async findBuildByPair(textBookId: number, audioBookId: number): Promise<StorytellerReadAlongBuild | undefined> {
    const [row] = await this.db
      .select()
      .from(storytellerReadAlongBuilds)
      .where(and(eq(storytellerReadAlongBuilds.textBookId, textBookId), eq(storytellerReadAlongBuilds.audioBookId, audioBookId)))
      .limit(1);
    return row;
  }

  async findBuildByOutputBook(bookId: number): Promise<StorytellerReadAlongBuild | undefined> {
    const [row] = await this.db.select().from(storytellerReadAlongBuilds).where(eq(storytellerReadAlongBuilds.outputBookId, bookId)).limit(1);
    return row;
  }

  /**
   * Claims the pair for a fresh attempt. The conditional `setWhere` settles a race: the loser's
   * INSERT hits the conflict, its UPDATE fails to match, and the zero RETURNING rows surface as
   * `undefined` rather than clobbering the build in flight.
   *
   * Every per-run column is reset for the winner unless the caller supplies a value for this call
   * (`useExistingUuid` flows straight into storytellerBookUuid to skip registration). `targetLibraryId`
   * and `targetFolderId` are outside that list and keep whatever the previous attempt wrote only when
   * the caller omits them; `requestBuild` always passes both, so a claim that changes the library
   * never keeps a folder from another one.
   *
   * A queued row is refused as well: it belongs to the queue runner, which claims it through
   * `claimQueuedBuild`. A direct claim starts a new attempt, so it clears `queued_at`.
   */
  async startBuild(
    rawValues: Pick<NewStorytellerReadAlongBuild, 'textBookId' | 'audioBookId'> & Partial<NewStorytellerReadAlongBuild>,
  ): Promise<StorytellerReadAlongBuild | undefined> {
    this.assertStorableBookUuid(rawValues.storytellerBookUuid);
    const values = this.withBoundedColumns(rawValues);
    const now = new Date();
    const insertValues: NewStorytellerReadAlongBuild = {
      ...values,
      status: 'building',
      phase: 'prepare',
      error: null,
      startedAt: now,
      builtAt: null,
      queuedAt: null,
      queuedRequest: null,
    };

    const [row] = await this.db
      .insert(storytellerReadAlongBuilds)
      .values(insertValues)
      .onConflictDoUpdate({
        target: [storytellerReadAlongBuilds.textBookId, storytellerReadAlongBuilds.audioBookId],
        set: { ...this.claimSet(values, now), queuedAt: null },
        setWhere: notInArray(storytellerReadAlongBuilds.status, ['building', 'queued']),
      })
      .returning();
    return row;
  }

  /**
   * The queue runner's claim: an update of that one row while it is still queued, never an insert, so
   * a row a cancel deleted between the runner's read and this write is not brought back. `queued_at`
   * and `requested_by` stay: they name the attempt and its requester until the build ends.
   */
  async claimQueuedBuild(id: number, rawValues: Partial<NewStorytellerReadAlongBuild>): Promise<StorytellerReadAlongBuild | undefined> {
    this.assertStorableBookUuid(rawValues.storytellerBookUuid);
    const [row] = await this.db
      .update(storytellerReadAlongBuilds)
      .set(this.claimSet(this.withBoundedColumns(rawValues), new Date()))
      .where(and(eq(storytellerReadAlongBuilds.id, id), eq(storytellerReadAlongBuilds.status, 'queued')))
      .returning();
    return row;
  }

  private claimSet(values: Partial<NewStorytellerReadAlongBuild>, now: Date): Partial<NewStorytellerReadAlongBuild> {
    return {
      ...values,
      status: 'building',
      phase: 'prepare',
      storytellerBookUuid: values.storytellerBookUuid ?? null,
      remoteTask: values.remoteTask ?? null,
      remoteProgress: values.remoteProgress ?? null,
      transport: values.transport ?? null,
      outputBookId: values.outputBookId ?? null,
      error: null,
      startedAt: now,
      builtAt: null,
      queuedRequest: null,
      updatedAt: now,
    };
  }

  /**
   * Records a build that waits for the slot. Only the queue columns are written: everything a ready or
   * failed row holds (destination, output, uuid, transport, dates) stays untouched until the claim, so
   * a cancelled or refused queued rebuild leaves the row as it was. The request keeps the destination.
   *
   * A compare-and-set on the status the caller read: it matches nothing once the row has moved (a
   * build finished, another request queued or claimed it), and the caller reads again.
   */
  async queueBuild(values: StorytellerQueueBuildValues, expectedStatus: string | null): Promise<StorytellerReadAlongBuild | undefined> {
    const now = new Date();
    const queueColumns = {
      status: 'queued',
      requestedBy: values.requestedBy,
      queuedAt: now,
      queuedRequest: values.queuedRequest,
    } satisfies Partial<NewStorytellerReadAlongBuild>;
    const [row] = await this.db
      .insert(storytellerReadAlongBuilds)
      .values({ textBookId: values.textBookId, audioBookId: values.audioBookId, ...queueColumns })
      .onConflictDoUpdate({
        target: [storytellerReadAlongBuilds.textBookId, storytellerReadAlongBuilds.audioBookId],
        set: { ...queueColumns, updatedAt: now },
        setWhere:
          expectedStatus === null
            ? sql`false`
            : and(notInArray(storytellerReadAlongBuilds.status, ['building', 'queued']), eq(storytellerReadAlongBuilds.status, expectedStatus)),
      })
      .returning();
    return row;
  }

  async findOldestQueuedBuild(): Promise<StorytellerReadAlongBuild | undefined> {
    const [row] = await this.db
      .select()
      .from(storytellerReadAlongBuilds)
      .where(eq(storytellerReadAlongBuilds.status, 'queued'))
      .orderBy(asc(storytellerReadAlongBuilds.queuedAt), asc(storytellerReadAlongBuilds.id))
      .limit(1);
    return row;
  }

  /** Queued rows ahead of this one; the id breaks a tie between two rows queued in the same instant. */
  async countQueuedBefore(queuedAt: Date, id: number): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(storytellerReadAlongBuilds)
      .where(
        and(
          eq(storytellerReadAlongBuilds.status, 'queued'),
          or(
            lt(storytellerReadAlongBuilds.queuedAt, queuedAt),
            and(eq(storytellerReadAlongBuilds.queuedAt, queuedAt), lt(storytellerReadAlongBuilds.id, id)),
          ),
        ),
      );
    return row?.total ?? 0;
  }

  async countQueuedBuilds(): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(storytellerReadAlongBuilds).where(eq(storytellerReadAlongBuilds.status, 'queued'));
    return row?.total ?? 0;
  }

  async updateBuild(id: number, values: Partial<NewStorytellerReadAlongBuild>): Promise<StorytellerReadAlongBuild | undefined> {
    this.assertStorableBookUuid(values.storytellerBookUuid);
    const [row] = await this.db
      .update(storytellerReadAlongBuilds)
      .set({ ...this.withBoundedColumns(values), updatedAt: new Date() })
      .where(eq(storytellerReadAlongBuilds.id, id))
      .returning();
    return row;
  }

  /**
   * Cuts the provider-authored string to the column that holds it. `remote_task` is written on every
   * wait poll, where a Postgres 22001 lands inside the poll loop's own catch, counts as transport
   * trouble and aborts the build twenty polls later blaming a healthy Storyteller. It is read back
   * only to be shown - unlike the book id, which names the remote book and so is refused outright
   * rather than clipped (assertStorableBookUuid).
   */
  private withBoundedColumns<T extends Partial<NewStorytellerReadAlongBuild>>(values: T): T {
    const bounded = { ...values };
    if (typeof bounded.remoteTask === 'string') bounded.remoteTask = clampToLength(bounded.remoteTask, REMOTE_TASK_MAX_LENGTH);
    return bounded;
  }

  /**
   * The normalizer accepts any non-empty string, while the column holds 64 characters and the build
   * logs interpolate the value unquoted on one line. Refused here because the alternative is a
   * Postgres 22001 raised after a multi-gigabyte upload and persisted as the build's error.
   */
  private assertStorableBookUuid(uuid: string | null | undefined): void {
    if (uuid == null) return;
    if (uuid.length > BOOK_UUID_MAX_LENGTH || /\s/.test(uuid)) {
      throw new BadGatewayException('Storyteller returned a book id that cannot be stored');
    }
  }

  /**
   * Retires a cancelled build's row. A row holding a Storyteller book is kept as `cancelled` so the next
   * Generate resumes that book; one without is deleted. Decided on the row as it is now, not as the
   * caller last read it: the build may record its book between that read and this write. The final
   * update catches a book recorded between the first two statements.
   */
  async retireCancelledBuild(id: number): Promise<'kept' | 'deleted' | 'unchanged'> {
    if (await this.markBuildCancelled(id, 'building')) return 'kept';
    if (await this.deleteBookless(id, 'building')) return 'deleted';
    return (await this.markBuildCancelled(id, 'building')) ? 'kept' : 'unchanged';
  }

  /**
   * Retires a cancelled queued row, every statement requiring it to be queued still: a runner claim
   * that lands first makes all three match nothing, and the caller then treats the row as building.
   * A queued forced rebuild of a ready read-along goes back to ready, which is all it ever changed.
   */
  async retireQueuedBuild(id: number): Promise<'kept' | 'deleted' | 'restored' | 'unchanged'> {
    if (await this.restoreQueuedReadyBuild(id)) return 'restored';
    if (await this.markBuildCancelled(id, 'queued')) return 'kept';
    if (await this.deleteBookless(id, 'queued')) return 'deleted';
    return 'unchanged';
  }

  private async deleteBookless(id: number, status: 'building' | 'queued'): Promise<boolean> {
    const deleted = await this.db
      .delete(storytellerReadAlongBuilds)
      .where(
        and(
          eq(storytellerReadAlongBuilds.id, id),
          eq(storytellerReadAlongBuilds.status, status),
          isNull(storytellerReadAlongBuilds.storytellerBookUuid),
        ),
      )
      .returning({ id: storytellerReadAlongBuilds.id });
    return deleted.length > 0;
  }

  private async restoreQueuedReadyBuild(id: number): Promise<boolean> {
    const rows = await this.db
      .update(storytellerReadAlongBuilds)
      .set({ status: 'ready', queuedAt: null, queuedRequest: null, updatedAt: new Date() })
      .where(
        and(
          eq(storytellerReadAlongBuilds.id, id),
          eq(storytellerReadAlongBuilds.status, 'queued'),
          sql`${storytellerReadAlongBuilds.queuedRequest} ->> 'previousStatus' = 'ready'`,
        ),
      )
      .returning({ id: storytellerReadAlongBuilds.id });
    return rows.length > 0;
  }

  private async markBuildCancelled(id: number, status: 'building' | 'queued'): Promise<boolean> {
    const rows = await this.db
      .update(storytellerReadAlongBuilds)
      .set({
        status: 'cancelled',
        phase: null,
        remoteTask: null,
        remoteProgress: null,
        error: null,
        queuedAt: null,
        queuedRequest: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(storytellerReadAlongBuilds.id, id),
          eq(storytellerReadAlongBuilds.status, status),
          isNotNull(storytellerReadAlongBuilds.storytellerBookUuid),
        ),
      )
      .returning({ id: storytellerReadAlongBuilds.id });
    return rows.length > 0;
  }

  /**
   * Retires a queued row the runner cannot start, only while it is still queued (a cancel may have
   * won). A queued rebuild of a ready read-along is never demoted: the row goes back to ready and the
   * reason reaches the requester through the notification and the log only.
   */
  async failQueuedBuild(id: number, error: string): Promise<'failed' | 'restored' | 'gone'> {
    if (await this.restoreQueuedReadyBuild(id)) return 'restored';
    const rows = await this.db
      .update(storytellerReadAlongBuilds)
      .set({ status: 'failed', phase: null, error, queuedAt: null, queuedRequest: null, updatedAt: new Date() })
      .where(and(eq(storytellerReadAlongBuilds.id, id), eq(storytellerReadAlongBuilds.status, 'queued')))
      .returning({ id: storytellerReadAlongBuilds.id });
    return rows.length > 0 ? 'failed' : 'gone';
  }

  // A build runs in-process, so one still marked 'building' at boot was interrupted: reset it to
  // 'failed' or the client polls a state that will never advance.
  async failInterruptedBuilds(): Promise<number> {
    const rows = await this.db
      .update(storytellerReadAlongBuilds)
      .set({ status: 'failed', error: 'build interrupted by a server restart', updatedAt: new Date() })
      .where(eq(storytellerReadAlongBuilds.status, 'building'))
      .returning({ id: storytellerReadAlongBuilds.id });
    return rows.length;
  }

  // Prefers a non-overlay EPUB: Storyteller aligns from scratch, so a file that already carries a
  // media overlay wastes the alignment and orphans its own narration in the result.
  async findSourceEpubFile(textBookId: number): Promise<StorytellerSourceEpubFile | undefined> {
    const [row] = await this.db
      .select({
        id: bookFiles.id,
        absolutePath: bookFiles.absolutePath,
      })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, textBookId), eq(bookFiles.role, 'content'), eq(bookFiles.format, 'epub')))
      .orderBy(asc(bookFiles.mediaOverlayAvailable), sql`${bookFiles.sortOrder} asc nulls last`, asc(bookFiles.id))
      .limit(1);
    return row;
  }

  // The reading-alignment module's manifest ordering, reused as-is: absolute audio positions must
  // agree with the player's file order, or Storyteller aligns against the wrong track order.
  async findAudioFiles(audioBookId: number): Promise<StorytellerAudioFile[]> {
    const rows = await this.db
      .select({
        id: bookFiles.id,
        format: bookFiles.format,
        absolutePath: bookFiles.absolutePath,
        sortOrder: bookFiles.sortOrder,
      })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, audioBookId), eq(bookFiles.role, 'content')))
      .orderBy(asc(bookFiles.sortOrder));

    return rows
      .filter((row) => row.format != null && isAudioFormat(row.format))
      .sort(compareAudioPlayOrder)
      .map((row) => ({ absolutePath: row.absolutePath }));
  }

  /**
   * The block reasons only ask yes/no, and the status route is polled every few seconds per open
   * popover: listing and sorting every track of a 300-file audiobook costs 300 rows for one boolean.
   * The format filter is the set `isAudioFormat` matches, applied in SQL.
   */
  async hasAudioContentFile(audioBookId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ exists: sql<number>`1` })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, audioBookId), eq(bookFiles.role, 'content'), inArray(bookFiles.format, [...AUDIO_FORMAT_LIST])))
      .limit(1);
    return row !== undefined;
  }

  /** Null when the scanner never recorded a size, rather than a false zero. */
  async sumContentBytes(bookId: number): Promise<number | null> {
    const [row] = await this.db
      .select({ total: sql<string | null>`sum(${bookFiles.sizeBytes})` })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, bookId), eq(bookFiles.role, 'content')));
    const total = row?.total == null ? null : Number(row.total);
    return total === null || Number.isNaN(total) ? null : total;
  }

  // Ordered by id: callers fall back to the first folder when none is configured, and heap order
  // would let two builds of the same pair land in different folders.
  async findLibraryFolders(libraryId: number): Promise<StorytellerLibraryFolder[]> {
    return this.db
      .select({ id: libraryFolders.id, path: libraryFolders.path })
      .from(libraryFolders)
      .where(eq(libraryFolders.libraryId, libraryId))
      .orderBy(asc(libraryFolders.id));
  }

  /**
   * Whether a book holds any content file other than the one path given. The read-along a build
   * produces is exactly one file, so a book that owns anything else was not produced by that build.
   */
  async hasContentFileOtherThan(bookId: number, absolutePath: string): Promise<boolean> {
    const [row] = await this.db
      .select({ one: sql<number>`1` })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, bookId), eq(bookFiles.role, 'content'), ne(bookFiles.absolutePath, absolutePath)))
      .limit(1);
    return row !== undefined;
  }

  // `absolute_path` is globally unique while book-library folders may overlap (see
  // `library-folder-roles.utils`), so the owning library comes back with the ids: whichever library
  // indexed the path first owns the row, and it need not be the one a build targeted.
  async findBookFileByAbsolutePath(absolutePath: string): Promise<StorytellerBookFileLocation | undefined> {
    const [row] = await this.db
      .select({ bookId: bookFiles.bookId, fileId: bookFiles.id, libraryId: books.libraryId })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .where(eq(bookFiles.absolutePath, absolutePath))
      .limit(1);
    return row;
  }

  // Existing-book matching against Storyteller: ISBN/ASIN first, title+author as the fallback tier.
  async findBookTitleAndAuthors(bookId: number): Promise<StorytellerBookIdentity | null> {
    const [row] = await this.db
      .select({
        title: bookMetadata.title,
        isbn10: bookMetadata.isbn10,
        isbn13: bookMetadata.isbn13,
        asin: bookMetadata.audibleId,
        authorNames: sql<string[]>`coalesce(
          array_agg(${authors.name} ORDER BY ${bookAuthors.displayOrder}, ${authors.id})
            FILTER (WHERE ${authors.id} IS NOT NULL),
          ARRAY[]::varchar[]
        )`,
      })
      .from(books)
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .leftJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
      .leftJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(books.id, bookId))
      .groupBy(bookMetadata.title, bookMetadata.isbn10, bookMetadata.isbn13, bookMetadata.audibleId)
      .limit(1);
    if (!row) return null;
    return { title: row.title, authorNames: row.authorNames, isbn10: row.isbn10, isbn13: row.isbn13, asin: row.asin };
  }
}
