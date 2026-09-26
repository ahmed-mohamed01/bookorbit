import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
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
   * is outside that list and keeps whatever the previous attempt wrote when the caller omits it.
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
    };
    const updateSet: Partial<NewStorytellerReadAlongBuild> = {
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
      updatedAt: now,
    };

    const [row] = await this.db
      .insert(storytellerReadAlongBuilds)
      .values(insertValues)
      .onConflictDoUpdate({
        target: [storytellerReadAlongBuilds.textBookId, storytellerReadAlongBuilds.audioBookId],
        set: updateSet,
        setWhere: ne(storytellerReadAlongBuilds.status, 'building'),
      })
      .returning();
    return row;
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
