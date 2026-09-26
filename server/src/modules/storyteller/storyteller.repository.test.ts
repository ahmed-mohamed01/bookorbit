import { BadGatewayException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { StorytellerConnectionTestResult } from '@bookorbit/types';
import { StorytellerRepository } from './storyteller.repository';

const dialect = new PgDialect();

function renderSql(value: unknown) {
  return dialect.sqlToQuery(value as SQL);
}

function queryBuilder<T>(result: T) {
  const builder: Record<string, ReturnType<typeof vi.fn>> & { then?: Promise<T>['then'] } = {};
  for (const method of [
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'values',
    'returning',
    'set',
    'leftJoin',
    'innerJoin',
    'groupBy',
    'onConflictDoUpdate',
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mockDb(options: { selectResults?: unknown[]; insertResults?: unknown[]; updateResults?: unknown[]; deleteResults?: unknown[] } = {}) {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  const deleteResults = [...(options.deleteResults ?? [])];

  return {
    select: vi.fn(() => queryBuilder(selectResults.shift() ?? [])),
    insert: vi.fn(() => queryBuilder(insertResults.shift() ?? [])),
    update: vi.fn(() => queryBuilder(updateResults.shift() ?? [])),
    delete: vi.fn(() => queryBuilder(deleteResults.shift() ?? [])),
  };
}

/** The builder instance returned by the db's Nth call to `select`/`insert`/`update`, so a test can
 * inspect exactly what predicate/order/conflict clause the repository built. */
function builderFrom(dbMethod: ReturnType<typeof vi.fn>, callIndex = 0) {
  return dbMethod.mock.results[callIndex]!.value as ReturnType<typeof queryBuilder>;
}

describe('StorytellerRepository.getSettings / upsertSettings', () => {
  it('returns undefined when no settings row exists', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.getSettings()).resolves.toBeUndefined();
  });

  it('returns the singleton settings row', async () => {
    const row = { id: 1, serverUrl: 'https://storyteller.example.com' };
    const db = mockDb({ selectResults: [[row]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.getSettings()).resolves.toEqual(row);
  });

  // The settings are one row keyed to id 1, so the write has to carry that id and resolve a conflict
  // on it. Without either half the second save raises 23505, or writes a second row nothing reads.
  it('upserts the singleton row with id=1', async () => {
    const returned = { id: 1, serverUrl: 'https://storyteller.example.com' };
    const db = mockDb({ insertResults: [[returned]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.upsertSettings({ serverUrl: 'https://storyteller.example.com' })).resolves.toEqual(returned);

    const builder = builderFrom(db.insert);
    expect(builder.values.mock.calls[0]![0]).toMatchObject({ id: 1, serverUrl: 'https://storyteller.example.com' });
    const conflict = builder.onConflictDoUpdate.mock.calls[0]![0] as { target: unknown; set: Record<string, unknown> };
    expect(conflict.target).toBeDefined();
    expect(conflict.set).toMatchObject({ serverUrl: 'https://storyteller.example.com' });
  });
});

describe('StorytellerRepository.recordCheck', () => {
  const result: StorytellerConnectionTestResult = {
    ok: true,
    checkedAt: new Date().toISOString(),
    serverVersion: '1.0.0',
    capabilities: ['readaloud-process'],
    readaloudLocationType: 'CUSTOM_FOLDER',
    readaloudLocation: '/read-along',
    importMode: 'reference',
    aligner: 'whisper',
    sharedPathsReady: true,
    effectiveTransport: 'shared-paths',
    problems: [],
    error: null,
  };

  it('upserts the last check result onto the singleton row', async () => {
    const db = mockDb({ insertResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await repo.recordCheck(result, 'https://storyteller.example.com');

    // Onto the same singleton row: without the conflict clause every check after the first one
    // raises 23505 against id 1 and no result is ever recorded.
    const builder = builderFrom(db.insert);
    expect(builder.values.mock.calls[0]![0]).toMatchObject({ id: 1, lastCheckResult: result });
    const conflict = builder.onConflictDoUpdate.mock.calls[0]![0] as { set: Record<string, unknown> };
    expect(conflict.set).toMatchObject({ lastCheckResult: result });
  });

  // A connection test takes seconds, and a save during it re-points this row at another host. The
  // update carries the host that was tested, so a row that has moved on keeps its own state instead
  // of showing a green check for a server nobody tested.
  it('updates only while the stored host is still the one that was tested', async () => {
    const db = mockDb({ insertResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await repo.recordCheck(result, 'https://storyteller.example.com');

    const conflict = builderFrom(db.insert).onConflictDoUpdate.mock.calls[0]![0] as { setWhere: unknown };
    const setWhere = renderSql(conflict.setWhere);
    expect(setWhere.sql).toContain('"server_url" = $1');
    expect(setWhere.params).toEqual(['https://storyteller.example.com']);
  });

  // A test against an unconfigured connection is recorded too, and its host is null - which `=` would
  // never match, dropping every such result.
  it('matches a row with no stored host when the tested connection had none either', async () => {
    const db = mockDb({ insertResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await repo.recordCheck(result, null);

    const conflict = builderFrom(db.insert).onConflictDoUpdate.mock.calls[0]![0] as { setWhere: unknown };
    const setWhere = renderSql(conflict.setWhere);
    expect(setWhere.sql).toContain('"server_url" is null');
    expect(setWhere.params).toEqual([]);
  });
});

describe('StorytellerRepository build lookups', () => {
  it('findBuildByPair filters on both book ids', async () => {
    const build = { id: 5, textBookId: 1, audioBookId: 2 };
    const db = mockDb({ selectResults: [[build]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findBuildByPair(1, 2)).resolves.toEqual(build);

    const where = builderFrom(db.select).where.mock.calls[0]![0];
    const rendered = renderSql(where);
    expect(rendered.sql).toContain('"text_book_id" = $1');
    expect(rendered.sql).toContain('"audio_book_id" = $2');
    expect(rendered.params).toEqual([1, 2]);
  });

  it('findBuildByOutputBook returns undefined when nothing matches', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findBuildByOutputBook(99)).resolves.toBeUndefined();
  });
});

describe('StorytellerRepository.startBuild', () => {
  it('claims the pair on conflict only when the existing row is not already building', async () => {
    const returned = { id: 3, textBookId: 1, audioBookId: 2, status: 'building' };
    const db = mockDb({ insertResults: [[returned]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.startBuild({ textBookId: 1, audioBookId: 2 })).resolves.toEqual(returned);

    const builder = builderFrom(db.insert);
    const conflict = builder.onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.target).toEqual([expect.objectContaining({ name: 'text_book_id' }), expect.objectContaining({ name: 'audio_book_id' })]);
    const setWhere = renderSql(conflict.setWhere);
    expect(setWhere.sql).toBe('"storyteller_read_along_builds"."status" <> $1');
    expect(setWhere.params).toEqual(['building']);
  });

  it('resets the per-run columns and clears storytellerBookUuid when not supplied', async () => {
    const db = mockDb({ insertResults: [[{}]] });
    const repo = new StorytellerRepository(db as never);

    await repo.startBuild({ textBookId: 1, audioBookId: 2, error: 'stale error from a previous attempt' });

    const builder = builderFrom(db.insert);
    const conflict = builder.onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.set).toMatchObject({
      status: 'building',
      phase: 'prepare',
      storytellerBookUuid: null,
      remoteTask: null,
      remoteProgress: null,
      transport: null,
      outputBookId: null,
      error: null,
      builtAt: null,
    });
    expect(conflict.set.startedAt).toBeInstanceOf(Date);
  });

  it('keeps a caller-supplied storytellerBookUuid and outputBookId instead of resetting them', async () => {
    const db = mockDb({ insertResults: [[{}]] });
    const repo = new StorytellerRepository(db as never);

    await repo.startBuild({ textBookId: 1, audioBookId: 2, storytellerBookUuid: 'existing-uuid', outputBookId: 55 });

    const builder = builderFrom(db.insert);
    const conflict = builder.onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.set.storytellerBookUuid).toBe('existing-uuid');
    expect(conflict.set.outputBookId).toBe(55);
  });

  it('keeps the destination columns on conflict only when the caller omits them', async () => {
    const db = mockDb({ insertResults: [[{}]] });
    const repo = new StorytellerRepository(db as never);

    await repo.startBuild({ textBookId: 1, audioBookId: 2 });

    const builder = builderFrom(db.insert);
    const conflict = builder.onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.set).not.toHaveProperty('targetLibraryId');
    expect(conflict.set).not.toHaveProperty('targetFolderId');
  });

  it('overwrites the folder with an explicit null so a claim for another library drops the old folder', async () => {
    const db = mockDb({ insertResults: [[{}]] });
    const repo = new StorytellerRepository(db as never);

    await repo.startBuild({ textBookId: 1, audioBookId: 2, targetLibraryId: 4, targetFolderId: null });

    const conflict = builderFrom(db.insert).onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.set).toMatchObject({ targetLibraryId: 4, targetFolderId: null });
  });

  it('writes a caller-supplied destination library and folder', async () => {
    const db = mockDb({ insertResults: [[{}]] });
    const repo = new StorytellerRepository(db as never);

    await repo.startBuild({ textBookId: 1, audioBookId: 2, targetLibraryId: 3, targetFolderId: 30 });

    const builder = builderFrom(db.insert);
    expect(builder.values.mock.calls[0]![0]).toMatchObject({ targetLibraryId: 3, targetFolderId: 30 });
    const conflict = builder.onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.set).toMatchObject({ targetLibraryId: 3, targetFolderId: 30 });
  });

  it('returns undefined when the row was skipped because another build already holds the pair', async () => {
    const db = mockDb({ insertResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.startBuild({ textBookId: 1, audioBookId: 2 })).resolves.toBeUndefined();
  });
});

describe('StorytellerRepository.updateBuild', () => {
  it('updates a build by id', async () => {
    const returned = { id: 3, status: 'ready' };
    const db = mockDb({ updateResults: [[returned]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.updateBuild(3, { status: 'ready' })).resolves.toEqual(returned);
  });

  it('returns undefined when no row matches the id', async () => {
    const db = mockDb({ updateResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.updateBuild(999, { status: 'ready' })).resolves.toBeUndefined();
  });
});

describe('StorytellerRepository provider-authored column bounds', () => {
  it('clips a Storyteller task name to remote_task on updateBuild', async () => {
    const db = mockDb({ updateResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    // The overflow would raise a Postgres 22001 inside the build's own wait-loop catch, which counts
    // it as transport trouble and blames Storyteller twenty polls later.
    await repo.updateBuild(3, { remoteTask: 'A'.repeat(400) });

    const set = builderFrom(db.update).set.mock.calls[0]![0] as { remoteTask: string };
    expect(set.remoteTask).toHaveLength(255);
  });

  // Whole code points: half a surrogate pair is invalid UTF-8 to Postgres.
  it('never splits a code point when it clips', async () => {
    const db = mockDb({ updateResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await repo.updateBuild(3, { remoteTask: '𝕊'.repeat(400) });

    const set = builderFrom(db.update).set.mock.calls[0]![0] as { remoteTask: string };
    expect([...set.remoteTask]).toHaveLength(255);
  });

  it('clips remote_task on startBuild too', async () => {
    const db = mockDb({ insertResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await repo.startBuild({ textBookId: 1, audioBookId: 2, remoteTask: 'A'.repeat(400) });

    const values = builderFrom(db.insert).values.mock.calls[0]![0] as { remoteTask: string };
    expect(values.remoteTask).toHaveLength(255);
  });
});

describe('StorytellerRepository.retireCancelledBuild', () => {
  it('keeps a building row that holds a Storyteller book as cancelled, clearing only the run state', async () => {
    const db = mockDb({ updateResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.retireCancelledBuild(3)).resolves.toBe('kept');

    const builder = builderFrom(db.update);
    expect(builder.set.mock.calls[0]![0]).toMatchObject({ status: 'cancelled', phase: null, remoteTask: null, remoteProgress: null, error: null });
    const setColumns = Object.keys(builder.set.mock.calls[0]![0] as object);
    for (const kept of ['storytellerBookUuid', 'transport', 'targetLibraryId', 'targetFolderId']) expect(setColumns).not.toContain(kept);
    const where = renderSql(builder.where.mock.calls[0]![0]);
    expect(where.sql).toBe(
      '("storyteller_read_along_builds"."id" = $1 and "storyteller_read_along_builds"."status" = $2 and "storyteller_read_along_builds"."storyteller_book_uuid" is not null)',
    );
    expect(where.params).toEqual([3, 'building']);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('deletes a building row with no Storyteller book', async () => {
    const db = mockDb({ updateResults: [[]], deleteResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.retireCancelledBuild(3)).resolves.toBe('deleted');

    const where = renderSql(builderFrom(db.delete).where.mock.calls[0]![0]);
    expect(where.sql).toBe(
      '("storyteller_read_along_builds"."id" = $1 and "storyteller_read_along_builds"."status" = $2 and "storyteller_read_along_builds"."storyteller_book_uuid" is null)',
    );
    expect(where.params).toEqual([3, 'building']);
  });

  it('keeps the row when the build recorded its book between the update and the delete', async () => {
    const db = mockDb({ updateResults: [[], [{ id: 3 }]], deleteResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.retireCancelledBuild(3)).resolves.toBe('kept');
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it('leaves a row that is no longer building alone', async () => {
    const db = mockDb({ updateResults: [[], []], deleteResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.retireCancelledBuild(3)).resolves.toBe('unchanged');
  });
});

describe('StorytellerRepository.failInterruptedBuilds', () => {
  it('returns the count of rows reset from building to failed', async () => {
    const db = mockDb({ updateResults: [[{ id: 1 }, { id: 2 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.failInterruptedBuilds()).resolves.toBe(2);
  });

  it('returns 0 when nothing was interrupted', async () => {
    const db = mockDb({ updateResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.failInterruptedBuilds()).resolves.toBe(0);
  });
});

describe('StorytellerRepository.findSourceEpubFile', () => {
  it('returns the first row from the ordered query (non-overlay epub preferred by the SQL order)', async () => {
    const row = { id: 9, absolutePath: '/books/book.epub', sizeBytes: 1024, mediaOverlayAvailable: false };
    const db = mockDb({ selectResults: [[row]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findSourceEpubFile(42)).resolves.toEqual(row);
  });

  it('returns undefined when the book has no epub content file', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findSourceEpubFile(42)).resolves.toBeUndefined();
  });

  it('filters to content-role epub files and orders non-overlay first, then sort_order (nulls last), then id', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await repo.findSourceEpubFile(42);

    const builder = builderFrom(db.select);
    const where = renderSql(builder.where.mock.calls[0]![0]);
    expect(where.sql).toContain('"book_id" = $1');
    expect(where.sql).toContain(`"role" = $2`);
    expect(where.sql).toContain(`"format" = $3`);
    expect(where.params).toEqual([42, 'content', 'epub']);

    const orderByArgs = builder.orderBy.mock.calls[0]!;
    expect(orderByArgs).toHaveLength(3);
    expect(renderSql(orderByArgs[0]).sql).toBe('"book_files"."media_overlay_available" asc');
    expect(renderSql(orderByArgs[1]).sql).toContain('"sort_order" asc nulls last');
    expect(renderSql(orderByArgs[2]).sql).toBe('"book_files"."id" asc');
  });
});

describe('StorytellerRepository.findAudioFiles', () => {
  it('drops non-audio files and returns the rest in manifest play order', async () => {
    const db = mockDb({
      selectResults: [
        [
          { id: 3, absolutePath: '/books/track-10.mp3', sortOrder: null, format: 'mp3', durationSeconds: 30 },
          { id: 1, absolutePath: '/books/book.epub', sortOrder: null, format: 'epub', durationSeconds: null },
          { id: 2, absolutePath: '/books/track-2.mp3', sortOrder: null, format: 'mp3', durationSeconds: 20 },
        ],
      ],
    });
    const repo = new StorytellerRepository(db as never);

    // Natural order by basename, so track-2 precedes track-10; the epub is filtered out by format.
    await expect(repo.findAudioFiles(42)).resolves.toEqual([{ absolutePath: '/books/track-2.mp3' }, { absolutePath: '/books/track-10.mp3' }]);
  });
});

describe('StorytellerRepository.hasAudioContentFile', () => {
  it('answers true from a single row', async () => {
    const db = mockDb({ selectResults: [[{ exists: 1 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.hasAudioContentFile(42)).resolves.toBe(true);
  });

  it('answers false when the book has no audio content file', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.hasAudioContentFile(42)).resolves.toBe(false);
  });

  // The caller only needs a yes/no, so the audio filter is a predicate the index can serve and the
  // row cap is one - not every track of a 300-file audiobook filtered in JS.
  it('filters to content-role audio formats in SQL and stops at one row', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await repo.hasAudioContentFile(42);

    const builder = builderFrom(db.select);
    const where = renderSql(builder.where.mock.calls[0]![0]);
    expect(where.sql).toContain('"book_id" = $1');
    expect(where.sql).toContain('"role" = $2');
    expect(where.sql).toContain('"format" in');
    expect(where.params.slice(0, 2)).toEqual([42, 'content']);
    expect(where.params).toEqual(expect.arrayContaining(['mp3', 'm4b', 'flac']));
    expect(builder.limit).toHaveBeenCalledWith(1);
  });
});

// The column is varchar(64) and the provider is free to answer any non-empty string, so an id that
// does not fit is refused before Postgres answers 22001 - after the upload, with a message that
// would then be stored as the build's error and shown to the user.
describe('StorytellerRepository storyteller book uuid bounds', () => {
  const overLong = 'a'.repeat(65);

  it('refuses an over-long uuid on updateBuild without issuing the statement', async () => {
    const db = mockDb({ updateResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.updateBuild(3, { storytellerBookUuid: overLong })).rejects.toBeInstanceOf(BadGatewayException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses an over-long uuid on startBuild without issuing the statement', async () => {
    const db = mockDb({ insertResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.startBuild({ textBookId: 1, audioBookId: 2, storytellerBookUuid: overLong })).rejects.toBeInstanceOf(BadGatewayException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  // The value is interpolated unquoted into single-line build logs.
  it('refuses a uuid carrying whitespace', async () => {
    const db = mockDb({ updateResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.updateBuild(3, { storytellerBookUuid: 'uuid with\na newline' })).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('stores a uuid that fits and clears one that is null', async () => {
    const db = mockDb({ updateResults: [[{ id: 3 }], [{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.updateBuild(3, { storytellerBookUuid: 'bf5a5d5f-fc17-484e-8de0-3486251f92f7' })).resolves.toEqual({ id: 3 });
    await expect(repo.updateBuild(3, { storytellerBookUuid: null })).resolves.toEqual({ id: 3 });
  });
});

describe('StorytellerRepository.findLibraryFolders', () => {
  it('returns the folders of a library', async () => {
    const folders = [
      { id: 1, path: '/books/read-along' },
      { id: 2, path: '/books/read-along-2' },
    ];
    const db = mockDb({ selectResults: [folders] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findLibraryFolders(7)).resolves.toEqual(folders);

    const where = renderSql(builderFrom(db.select).where.mock.calls[0]![0]);
    expect(where.sql).toContain('"library_id" = $1');
    expect(where.params).toEqual([7]);
  });

  it('orders by id so the fallback "first folder" is the same folder on every build', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await repo.findLibraryFolders(7);

    const orderBy = builderFrom(db.select).orderBy.mock.calls[0]!;
    expect(orderBy).toHaveLength(1);
    expect(renderSql(orderBy[0]).sql).toMatch(/"library_folders"\."id" asc/);
  });

  it('returns an empty array when the library has no folders', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findLibraryFolders(999)).resolves.toEqual([]);
  });
});

describe('StorytellerRepository.findBookFileByAbsolutePath', () => {
  // The owning library comes back with the row because a path can be indexed by a library other than
  // the one the build wrote to: `book_files.absolute_path` is globally unique and overlapping book
  // library folders are allowed, so whichever library indexed the path first owns the row.
  it('returns the owning library alongside the book and file id', async () => {
    const db = mockDb({ selectResults: [[{ bookId: 5, libraryId: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findBookFileByAbsolutePath('/books/read-along/book.epub')).resolves.toEqual({ bookId: 5, libraryId: 3 });

    const builder = builderFrom(db.select);
    expect(builder.innerJoin).toHaveBeenCalledTimes(1);
    expect(Object.keys(db.select.mock.calls[0]![0] as Record<string, unknown>)).toContain('libraryId');
  });

  it('returns undefined when no file has that path', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findBookFileByAbsolutePath('/nope.epub')).resolves.toBeUndefined();
  });
});

describe('StorytellerRepository.hasContentFileOtherThan', () => {
  it('asks for one row and filters to content files at another path', async () => {
    const db = mockDb({ selectResults: [[{ one: 1 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.hasContentFileOtherThan(7, '/library/read-along.epub')).resolves.toBe(true);

    const builder = builderFrom(db.select);
    expect(builder.limit).toHaveBeenCalledWith(1);
    const where = renderSql(builder.where.mock.calls[0]![0]);
    expect(where.sql).toContain('"book_id" = $1');
    expect(where.sql).toContain('"role" = $2');
    expect(where.sql).toContain('"absolute_path" <> $3');
    expect(where.params).toEqual([7, 'content', '/library/read-along.epub']);
  });

  it('is false for a book whose only content file is that path', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.hasContentFileOtherThan(7, '/library/read-along.epub')).resolves.toBe(false);
  });
});

describe('StorytellerRepository.findBookTitleAndAuthors', () => {
  it('returns title, authors and identifiers', async () => {
    const row = { title: 'Dune', isbn10: null, isbn13: '9780441172719', asin: 'B00B7NPRY8', authorNames: ['Frank Herbert'] };
    const db = mockDb({ selectResults: [[row]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findBookTitleAndAuthors(1)).resolves.toEqual({
      title: 'Dune',
      authorNames: ['Frank Herbert'],
      isbn10: null,
      isbn13: '9780441172719',
      asin: 'B00B7NPRY8',
    });
  });

  it('returns null when the book does not exist', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findBookTitleAndAuthors(999)).resolves.toBeNull();
  });
});
