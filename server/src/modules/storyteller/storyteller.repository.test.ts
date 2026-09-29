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
  it('claims the pair on conflict only when the existing row is neither building nor queued', async () => {
    const returned = { id: 3, textBookId: 1, audioBookId: 2, status: 'building' };
    const db = mockDb({ insertResults: [[returned]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.startBuild({ textBookId: 1, audioBookId: 2 })).resolves.toEqual(returned);

    const builder = builderFrom(db.insert);
    const conflict = builder.onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.target).toEqual([expect.objectContaining({ name: 'text_book_id' }), expect.objectContaining({ name: 'audio_book_id' })]);
    const setWhere = renderSql(conflict.setWhere);
    expect(setWhere.sql).toBe('"storyteller_read_along_builds"."status" not in ($1, $2)');
    expect(setWhere.params).toEqual(['building', 'queued']);
  });

  it('resets the per-run columns and clears storytellerBookUuid when not supplied, keeping the previous output', async () => {
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
      error: null,
      builtAt: null,
    });
    // The previous read-along stays recognised as this pair's output while the rebuild runs, and
    // after it fails: nothing else records it.
    expect(conflict.set).not.toHaveProperty('outputBookId');
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
    for (const kept of ['storytellerBookUuid', 'transport', 'targetLibraryId', 'targetFolderId', 'requestedBy'])
      expect(setColumns).not.toContain(kept);
    const where = renderSql(builder.where.mock.calls[0]![0]);
    expect(where.sql).toBe(
      '("storyteller_read_along_builds"."id" = $1 and "storyteller_read_along_builds"."status" = $2 and ("storyteller_read_along_builds"."storyteller_book_uuid" is not null or "storyteller_read_along_builds"."output_book_id" is not null))',
    );
    expect(where.params).toEqual([3, 'building']);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('deletes a building row with no Storyteller book and no output', async () => {
    const db = mockDb({ updateResults: [[]], deleteResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.retireCancelledBuild(3)).resolves.toBe('deleted');

    const where = renderSql(builderFrom(db.delete).where.mock.calls[0]![0]);
    expect(where.sql).toBe(
      '("storyteller_read_along_builds"."id" = $1 and "storyteller_read_along_builds"."status" = $2 and "storyteller_read_along_builds"."storyteller_book_uuid" is null and "storyteller_read_along_builds"."output_book_id" is null)',
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

describe('StorytellerRepository.retireQueuedBuild', () => {
  it('puts a queued forced rebuild of a ready read-along back to ready, flipping only the status', async () => {
    const db = mockDb({ updateResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.retireQueuedBuild(3)).resolves.toBe('restored');

    const builder = builderFrom(db.update);
    const set = builder.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(set).toMatchObject({ status: 'ready', queuedAt: null, queuedRequest: null });
    for (const kept of ['targetLibraryId', 'targetFolderId', 'outputBookId', 'builtAt', 'phase', 'storytellerBookUuid'])
      expect(set).not.toHaveProperty(kept);
    const where = renderSql(builder.where.mock.calls[0]![0]);
    expect(where.sql).toContain(`->> 'previousStatus' = 'ready'`);
    expect(where.params).toEqual([3, 'queued']);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('keeps a queued row holding a Storyteller book as cancelled, only while it is still queued', async () => {
    const db = mockDb({ updateResults: [[], [{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.retireQueuedBuild(3)).resolves.toBe('kept');

    expect(renderSql(builderFrom(db.update, 1).where.mock.calls[0]![0]).params).toEqual([3, 'queued']);
  });

  it('deletes a bookless queued row, only while it is still queued', async () => {
    const db = mockDb({ updateResults: [[], []], deleteResults: [[{ id: 3 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.retireQueuedBuild(3)).resolves.toBe('deleted');

    expect(renderSql(builderFrom(db.delete).where.mock.calls[0]![0]).params).toEqual([3, 'queued']);
  });

  it('answers unchanged when a claim made the row building first', async () => {
    const db = mockDb({ updateResults: [[], []], deleteResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.retireQueuedBuild(3)).resolves.toBe('unchanged');
    expect(db.update).toHaveBeenCalledTimes(2);
  });
});

describe('StorytellerRepository queue', () => {
  const queueValues = { textBookId: 1, audioBookId: 2, requestedBy: 42, queuedRequest: { force: false, previousStatus: 'failed' } };

  it('queues only while the row is still in the status the request read, and never over building or queued', async () => {
    const returned = { id: 5, status: 'queued' };
    const db = mockDb({ insertResults: [[returned]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.queueBuild(queueValues, 'failed')).resolves.toEqual(returned);

    const conflict = builderFrom(db.insert).onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.target).toEqual([expect.objectContaining({ name: 'text_book_id' }), expect.objectContaining({ name: 'audio_book_id' })]);
    const setWhere = renderSql(conflict.setWhere);
    expect(setWhere.sql).toBe('("storyteller_read_along_builds"."status" not in ($1, $2) and "storyteller_read_along_builds"."status" = $3)');
    expect(setWhere.params).toEqual(['building', 'queued', 'failed']);
  });

  it('only inserts when the request read no row at all', async () => {
    const db = mockDb({ insertResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.queueBuild(queueValues, null)).resolves.toBeUndefined();

    const conflict = builderFrom(db.insert).onConflictDoUpdate.mock.calls[0]![0];
    expect(renderSql(conflict.setWhere).sql).toBe('false');
  });

  it('writes only the queue columns, leaving everything a ready or failed row holds', async () => {
    const db = mockDb({ insertResults: [[{}]] });
    const repo = new StorytellerRepository(db as never);

    await repo.queueBuild(queueValues, 'ready');

    const builder = builderFrom(db.insert);
    const inserted = builder.values.mock.calls[0]![0];
    expect(inserted).toMatchObject({ textBookId: 1, audioBookId: 2, status: 'queued', requestedBy: 42 });
    expect(inserted.queuedAt).toBeInstanceOf(Date);
    const set = builder.onConflictDoUpdate.mock.calls[0]![0].set as Record<string, unknown>;
    expect(Object.keys(set).sort()).toEqual(['attemptAt', 'queuedAt', 'queuedRequest', 'requestedBy', 'status', 'updatedAt']);
    expect(set).toMatchObject({ status: 'queued', requestedBy: 42, queuedRequest: { force: false, previousStatus: 'failed' } });
    expect(set.attemptAt).toBe(set.queuedAt);
    expect(inserted.attemptAt).toBe(inserted.queuedAt);
  });

  it('answers which of the given builds are still queued or building', async () => {
    const db = mockDb({ selectResults: [[{ id: 8 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findActiveBuildIds([7, 8])).resolves.toEqual([8]);

    expect(renderSql(builderFrom(db.select).where.mock.calls[0]![0]).params).toEqual([7, 8, 'queued', 'building']);
    await expect(repo.findActiveBuildIds([])).resolves.toEqual([]);
    expect(db.select).toHaveBeenCalledOnce();
  });

  it('finds the oldest queued row, oldest first and by id on a tie', async () => {
    const row = { id: 5, status: 'queued' };
    const db = mockDb({ selectResults: [[row]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findOldestQueuedBuild()).resolves.toEqual(row);

    const builder = builderFrom(db.select);
    expect(renderSql(builder.where.mock.calls[0]![0]).params).toEqual(['queued']);
    const order = builder.orderBy.mock.calls[0]!;
    expect(order.map((clause: unknown) => renderSql(clause).sql)).toEqual([
      '"storyteller_read_along_builds"."queued_at" asc',
      '"storyteller_read_along_builds"."id" asc',
    ]);
    expect(builder.limit).toHaveBeenCalledWith(1);
  });

  it('counts the queued rows ahead of one, breaking a tie on the id', async () => {
    const queuedAt = new Date('2026-02-01T00:00:00Z');
    const db = mockDb({ selectResults: [[{ total: 2 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.countQueuedBefore(queuedAt, 9)).resolves.toBe(2);

    const where = renderSql(builderFrom(db.select).where.mock.calls[0]![0]);
    expect(where.sql).toBe(
      '("storyteller_read_along_builds"."status" = $1 and ("storyteller_read_along_builds"."queued_at" < $2 or ("storyteller_read_along_builds"."queued_at" = $3 and "storyteller_read_along_builds"."id" < $4)))',
    );
    expect(where.params).toEqual(['queued', queuedAt.toISOString(), queuedAt.toISOString(), 9]);
  });

  it('claims a queued row by update only while it is still queued, keeping the attempt, its requester and its request', async () => {
    const returned = { id: 5, status: 'building' };
    const db = mockDb({ updateResults: [[returned]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.claimQueuedBuild(5, { storytellerBookUuid: 'resume', targetLibraryId: 3, targetFolderId: 30 })).resolves.toEqual(returned);

    expect(db.insert).not.toHaveBeenCalled();
    const builder = builderFrom(db.update);
    const set = builder.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(set).toMatchObject({
      status: 'building',
      phase: 'prepare',
      storytellerBookUuid: 'resume',
      targetLibraryId: 3,
      targetFolderId: 30,
    });
    expect(set.startedAt).toBeInstanceOf(Date);
    expect(set).not.toHaveProperty('queuedAt');
    expect(set).not.toHaveProperty('requestedBy');
    expect(set).not.toHaveProperty('queuedRequest');
    expect(set).not.toHaveProperty('attemptAt');
    expect(renderSql(builder.where.mock.calls[0]![0]).params).toEqual([5, 'queued']);
  });

  it('starts a new attempt on a direct claim: fresh started_at and attempt_at, no queued_at, the caller as requester', async () => {
    const db = mockDb({ insertResults: [[{}]] });
    const repo = new StorytellerRepository(db as never);

    await repo.startBuild({ textBookId: 1, audioBookId: 2, requestedBy: 42 });

    const builder = builderFrom(db.insert);
    const inserted = builder.values.mock.calls[0]![0];
    expect(inserted).toMatchObject({ requestedBy: 42, queuedAt: null, queuedRequest: null });
    expect(inserted.attemptAt).toBe(inserted.startedAt);
    const conflict = builder.onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.set).toMatchObject({ requestedBy: 42, queuedAt: null, queuedRequest: null });
    expect(conflict.set.startedAt).toBeInstanceOf(Date);
    expect(conflict.set.attemptAt).toBe(conflict.set.startedAt);
  });

  it('records the request on a direct claim, so a restart can re-queue the attempt with it', async () => {
    const db = mockDb({ insertResults: [[{}]] });
    const repo = new StorytellerRepository(db as never);
    const queuedRequest = { force: true, targetLibraryId: 3, cleanUpRemote: false, previousStatus: 'ready' };

    await repo.startBuild({ textBookId: 1, audioBookId: 2, requestedBy: 42, queuedRequest });

    const builder = builderFrom(db.insert);
    expect(builder.values.mock.calls[0]![0].queuedRequest).toEqual(queuedRequest);
    expect(builder.onConflictDoUpdate.mock.calls[0]![0].set.queuedRequest).toEqual(queuedRequest);
  });

  it('fails a queued row only while it is still queued', async () => {
    const db = mockDb({ updateResults: [[], [{ id: 5 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.failQueuedBuild(5, 'gone')).resolves.toBe('failed');

    const builder = builderFrom(db.update, 1);
    expect(builder.set.mock.calls[0]![0]).toMatchObject({ status: 'failed', error: 'gone', queuedAt: null, queuedRequest: null });
    expect(renderSql(builder.where.mock.calls[0]![0]).params).toEqual([5, 'queued']);
  });

  it('never demotes a queued rebuild of a ready read-along: it goes back to ready with no error', async () => {
    const db = mockDb({ updateResults: [[{ id: 5 }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.failQueuedBuild(5, 'no audio')).resolves.toBe('restored');

    expect(db.update).toHaveBeenCalledOnce();
    const set = builderFrom(db.update).set.mock.calls[0]![0] as Record<string, unknown>;
    expect(set.status).toBe('ready');
    expect(set).not.toHaveProperty('error');
  });

  it('answers gone when the row left the queue first', async () => {
    const db = mockDb({ updateResults: [[], []] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.failQueuedBuild(5, 'x')).resolves.toBe('gone');
  });
});

describe('StorytellerRepository.requeueInterruptedBuilds', () => {
  function setup(options: { settled?: unknown[]; failed?: unknown[]; oldestQueued?: Date | null; interrupted?: unknown[]; requeued?: unknown[][] }) {
    const tx = mockDb({
      selectResults: [[{ oldest: options.oldestQueued ?? null }], options.interrupted ?? []],
      updateResults: [options.settled ?? [], options.failed ?? [], ...(options.requeued ?? [])],
    });
    const db = { transaction: vi.fn((run: (inner: typeof tx) => Promise<unknown>) => run(tx)) };
    return { repo: new StorytellerRepository(db as never), tx, db };
  }

  const requeuedSet = (tx: ReturnType<typeof mockDb>, index: number) =>
    builderFrom(tx.update, index + 2).set.mock.calls[0]![0] as Record<string, unknown>;
  const requeuedId = (tx: ReturnType<typeof mockDb>, index: number) => renderSql(builderFrom(tx.update, index + 2).where.mock.calls[0]![0]).params[0];

  it('settles as ready a build stuck in link whose read-along was already imported, however it got stuck', async () => {
    const produced = { id: 27, status: 'ready', phase: 'link', outputBookId: 312 };
    const { repo, tx } = setup({ settled: [produced] });

    await expect(repo.requeueInterruptedBuilds()).resolves.toEqual({ requeued: [], failed: [], settled: [produced] });

    const builder = builderFrom(tx.update, 0);
    const set = builder.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(set).toMatchObject({ status: 'ready', error: null });
    expect(renderSql(set.builtAt).sql).toBe('coalesce("storyteller_read_along_builds"."built_at", now())');
    const where = renderSql(builder.where.mock.calls[0]![0]);
    expect(where.sql).toBe(
      '("storyteller_read_along_builds"."status" in ($1, $2) and "storyteller_read_along_builds"."phase" = $3 and "storyteller_read_along_builds"."output_book_id" is not null)',
    );
    expect(where.params).toEqual(['building', 'failed', 'link']);
  });

  it('fails only the builds interrupted while linking, with the restart message', async () => {
    const linking = { id: 1, status: 'failed', phase: 'link' };
    const { repo, tx } = setup({ failed: [linking] });

    await expect(repo.requeueInterruptedBuilds()).resolves.toEqual({ requeued: [], failed: [linking], settled: [] });

    const builder = builderFrom(tx.update, 1);
    expect(builder.set.mock.calls[0]![0]).toMatchObject({ status: 'failed', error: 'build interrupted by a server restart' });
    const where = renderSql(builder.where.mock.calls[0]![0]);
    expect(where.sql).toBe('("storyteller_read_along_builds"."status" = $1 and "storyteller_read_along_builds"."phase" = $2)');
    expect(where.params).toEqual(['building', 'link']);
  });

  it('re-queues every other interrupted build, keeping its uuid, request and attempt', async () => {
    const waiting = {
      id: 4,
      phase: 'wait',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      queuedRequest: { force: true, targetLibraryId: 3, previousStatus: 'ready' },
    };
    const { repo, tx } = setup({ interrupted: [waiting], requeued: [[{ id: 4, status: 'queued' }]] });

    const result = await repo.requeueInterruptedBuilds();

    expect(result.requeued.map((row) => row.id)).toEqual([4]);
    const select = builderFrom(tx.select, 1);
    expect(renderSql(select.where.mock.calls[0]![0]).params).toEqual(['building']);
    expect(select.orderBy.mock.calls[0]!.map((clause: unknown) => renderSql(clause).sql)).toEqual([
      '"storyteller_read_along_builds"."started_at" asc nulls first',
      '"storyteller_read_along_builds"."id" asc',
    ]);
    const set = requeuedSet(tx, 0);
    expect(set).toMatchObject({
      status: 'queued',
      queuedRequest: { force: true, targetLibraryId: 3, previousStatus: 'interrupted' },
      error: null,
    });
    for (const kept of [
      'storytellerBookUuid',
      'transport',
      'requestedBy',
      'targetLibraryId',
      'targetFolderId',
      'attemptAt',
      'phase',
      'outputBookId',
    ]) {
      expect(set).not.toHaveProperty(kept);
    }
    expect(renderSql(builderFrom(tx.update, 2).where.mock.calls[0]![0]).params).toEqual([4, 'building']);
  });

  // Before the collect records the new read-along, the column names the previous one, which is
  // still this pair's output; a filed read-along is written with the link phase and settled instead.
  it('keeps the previous output of a build interrupted before it filed its read-along', async () => {
    const waiting = { id: 4, phase: 'wait', startedAt: new Date('2026-01-01T00:00:00Z'), outputBookId: 99, queuedRequest: null };
    const { repo, tx } = setup({ interrupted: [waiting], requeued: [[{ id: 4 }]] });

    await repo.requeueInterruptedBuilds();

    expect(requeuedSet(tx, 0)).not.toHaveProperty('outputBookId');
  });

  it('puts builds Storyteller holds ahead of the queued rows, and the rest behind them, each in start order', async () => {
    const oldestQueued = new Date('2026-02-01T00:00:00Z');
    const prepare = { id: 1, phase: 'prepare', startedAt: new Date('2026-01-01T00:00:00Z'), queuedRequest: null };
    const wait = { id: 2, phase: 'wait', startedAt: new Date('2026-01-02T00:00:00Z'), queuedRequest: null };
    const register = { id: 3, phase: 'register', startedAt: new Date('2026-01-03T00:00:00Z'), queuedRequest: null };
    const collect = { id: 4, phase: 'collect', startedAt: new Date('2026-01-04T00:00:00Z'), queuedRequest: null };
    const { repo, tx } = setup({
      oldestQueued,
      interrupted: [prepare, wait, register, collect],
      requeued: [[{ id: 2 }], [{ id: 4 }], [{ id: 1 }], [{ id: 3 }]],
    });

    await repo.requeueInterruptedBuilds();

    expect([0, 1, 2, 3].map((index) => requeuedId(tx, index))).toEqual([2, 4, 1, 3]);
    const times = [0, 1, 2, 3].map((index) => (requeuedSet(tx, index).queuedAt as Date).getTime());
    expect(times[0]).toBeLessThan(times[1]!);
    expect(times[1]).toBeLessThan(oldestQueued.getTime());
    expect(times[2]).toBeGreaterThan(oldestQueued.getTime());
    expect(times[2]).toBeLessThan(times[3]!);
    expect(renderSql(builderFrom(tx.select, 0).where.mock.calls[0]![0]).params).toEqual(['queued']);
  });

  it('answers empty lists when nothing was interrupted', async () => {
    const { repo } = setup({});

    await expect(repo.requeueInterruptedBuilds()).resolves.toEqual({ requeued: [], failed: [], settled: [] });
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

describe('StorytellerRepository.findReplaceableEpubContentFile', () => {
  it('prefers the book primary file, then sort order, among its EPUB content files', async () => {
    const db = mockDb({ selectResults: [[{ id: 40, absolutePath: '/library/Elantris.epub' }]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findReplaceableEpubContentFile(88)).resolves.toEqual({ id: 40, absolutePath: '/library/Elantris.epub' });

    const builder = builderFrom(db.select);
    expect(builder.limit).toHaveBeenCalledWith(1);
    const where = renderSql(builder.where.mock.calls[0]![0]);
    expect(where.params).toEqual([88, 'content', 'epub']);
    expect(builder.orderBy.mock.calls[0]!.map((clause: unknown) => renderSql(clause).sql)).toEqual([
      '("book_files"."id" = "books"."primary_file_id") desc nulls last',
      '"book_files"."sort_order" asc nulls last',
      '"book_files"."id" asc',
    ]);
  });

  it('is null for a book holding no EPUB content file', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findReplaceableEpubContentFile(88)).resolves.toBeNull();
  });
});

describe('StorytellerRepository.findLockedMetadataFields', () => {
  it('reads the locked fields of the book, and none when it has no metadata row', async () => {
    const db = mockDb({ selectResults: [[{ lockedFields: ['title'] }], []] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findLockedMetadataFields(88)).resolves.toEqual(['title']);
    await expect(repo.findLockedMetadataFields(89)).resolves.toEqual([]);
  });
});

describe('StorytellerRepository.findReadAlongMetadata', () => {
  it('takes the text edition metadata and the audio edition narrators, leaving out what is unset', async () => {
    const metadataRow = {
      title: 'Elantris',
      subtitle: null,
      description: 'A city of gods',
      publisher: 'Tor',
      publishedDate: null,
      publishedYear: 2005,
      language: 'en',
      isbn10: null,
      isbn13: '9780765350374',
      seriesName: 'Elantris',
      seriesIndex: '1',
    };
    const db = mockDb({
      selectResults: [[metadataRow], [{ name: 'Brandon Sanderson' }], [{ name: 'Fantasy' }, { name: 'Epic' }], [{ name: 'Jack Garrett' }]],
    });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findReadAlongMetadata(10, 11)).resolves.toEqual({
      title: 'Elantris',
      description: 'A city of gods',
      publisher: 'Tor',
      publishedYear: 2005,
      language: 'en',
      isbn13: '9780765350374',
      seriesName: 'Elantris',
      seriesIndex: '1',
      authors: ['Brandon Sanderson'],
      genres: ['Fantasy', 'Epic'],
      narrators: ['Jack Garrett'],
    });

    expect(renderSql(builderFrom(db.select, 1).where.mock.calls[0]![0]).params).toEqual([10]);
    expect(renderSql(builderFrom(db.select, 2).where.mock.calls[0]![0]).params).toEqual([10]);
    expect(renderSql(builderFrom(db.select, 3).where.mock.calls[0]![0]).params).toEqual([11]);
  });

  it('is null when the text edition has no metadata row', async () => {
    const db = mockDb({ selectResults: [[]] });
    const repo = new StorytellerRepository(db as never);

    await expect(repo.findReadAlongMetadata(10, 11)).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledOnce();
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
