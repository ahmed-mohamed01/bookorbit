import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditionLinkSchemaBootstrapService } from './edition-link-schema-bootstrap.service';
import { EDITION_LINK_SCHEMA_SQL } from './schema/edition-link-schema';

type RepoMock = {
  findMissingTables: ReturnType<typeof vi.fn>;
  applySchemaStatements: ReturnType<typeof vi.fn>;
};

function createService(): { service: EditionLinkSchemaBootstrapService; repo: RepoMock } {
  const repo: RepoMock = {
    findMissingTables: vi.fn().mockResolvedValue([]),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
  };
  const service = new EditionLinkSchemaBootstrapService(repo as never);
  return { service, repo };
}

describe('EditionLinkSchemaBootstrapService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks tables, splits the embedded SQL, and applies each statement', async () => {
    const { service, repo } = createService();

    await service.onApplicationBootstrap();

    expect(repo.findMissingTables).toHaveBeenCalledWith([
      'book_edition_links',
      'read_along_narration_offsets',
      'book_edition_link_members',
      'edition_link_user_settings',
      'edition_link_match_scans',
      'edition_link_match_results',
      'edition_link_match_dismissals',
    ]);
    expect(repo.applySchemaStatements).toHaveBeenCalledTimes(1);
    const statements = repo.applySchemaStatements.mock.calls[0]![0] as string[];
    const expectedCount = EDITION_LINK_SCHEMA_SQL.split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean).length;
    expect(statements).toHaveLength(expectedCount);
    expect(statements.every((statement) => statement.length > 0 && !statement.includes('--> statement-breakpoint'))).toBe(true);
    expect(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "book_edition_links"'))).toBe(true);
    expect(repo.findMissingTables.mock.invocationCallOrder[0]).toBeLessThan(repo.applySchemaStatements.mock.invocationCallOrder[0]!);
  });

  // A constraint name is unique per relation, not per database. Without the conrelid filter a
  // same-named constraint on any other table satisfies the guard and the FK is never created.
  it('scopes the read-along FK guard to book_edition_links', () => {
    const guard = EDITION_LINK_SCHEMA_SQL.split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .find((statement) => statement.includes('ADD CONSTRAINT "book_edition_links_read_along_book_id_books_id_fk"'))!;

    expect(guard).toContain('pg_constraint');
    expect(guard).toMatch(/conname = 'book_edition_links_read_along_book_id_books_id_fk' AND conrelid = 'book_edition_links'::regclass/);
  });

  it('drops NOT NULL on text_book_id only when the catalog says it is still set', () => {
    const guard = EDITION_LINK_SCHEMA_SQL.split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .find((statement) => statement.includes('ALTER COLUMN "text_book_id" DROP NOT NULL'))!;

    expect(guard).toContain('pg_attribute');
    expect(guard).toContain("attrelid = 'book_edition_links'::regclass AND attname = 'text_book_id'");
    expect(guard).toContain('IF col_notnull THEN');
  });

  it('deletes rows holding only the audiobook after relaxing the column', () => {
    const statements = EDITION_LINK_SCHEMA_SQL.split('--> statement-breakpoint').map((statement) => statement.trim());
    const relax = statements.findIndex((statement) => statement.includes('ALTER COLUMN "text_book_id" DROP NOT NULL'));
    const cleanup = statements.findIndex((statement) => statement.startsWith('DELETE FROM "book_edition_links" link'));

    // A fresh table has no read_along_book_id until its ADD COLUMN runs, so the cleanup must follow it.
    const readAlongColumn = statements.findIndex((statement) => statement.includes('ADD COLUMN IF NOT EXISTS "read_along_book_id"'));

    expect(relax).toBeGreaterThanOrEqual(0);
    expect(readAlongColumn).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(relax);
    expect(cleanup).toBeGreaterThan(readAlongColumn);
  });

  it('keeps a work of two audiobook copies when it cleans up audio-only rows', () => {
    const statements = EDITION_LINK_SCHEMA_SQL.split('--> statement-breakpoint').map((statement) => statement.trim());
    const members = statements.findIndex((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS "book_edition_link_members"'));
    const cleanup = statements.findIndex((statement) => statement.startsWith('DELETE FROM "book_edition_links" link'));

    expect(members).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(members);
    expect(statements[cleanup]).toContain('< 2');
  });

  it('drops NOT NULL on audio_book_id only when the catalog says it is still set', () => {
    const guard = EDITION_LINK_SCHEMA_SQL.split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .find((statement) => statement.includes('ALTER COLUMN "audio_book_id" DROP NOT NULL'))!;

    expect(guard).toContain("attrelid = 'book_edition_links'::regclass AND attname = 'audio_book_id'");
    expect(guard).toContain('IF col_notnull THEN');
  });

  it('backfills one primary member per filled slot, idempotently, after the sync trigger exists', () => {
    const statements = EDITION_LINK_SCHEMA_SQL.split('--> statement-breakpoint').map((statement) => statement.trim());
    const trigger = statements.findIndex((statement) => statement.startsWith('CREATE OR REPLACE TRIGGER "book_edition_links_sync_members"'));
    const backfill = statements.findIndex((statement) => statement.startsWith('INSERT INTO "book_edition_link_members"'));
    const sql = statements[backfill]!;

    expect(trigger).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(trigger);
    expect(sql).toContain(`(link."text_book_id", 'text'), (link."audio_book_id", 'audio'), (link."read_along_book_id", 'readAlong')`);
    expect(sql).toContain('WHERE slot.book_id IS NOT NULL');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });

  it('keeps the slots equal to the primary member of each role through the trigger', () => {
    const statements = EDITION_LINK_SCHEMA_SQL.split('--> statement-breakpoint').map((statement) => statement.trim());
    const sync = statements.find((statement) => statement.includes('FUNCTION "bookorbit_edition_link_sync_members"'))!;
    const claim = statements.find((statement) => statement.includes('FUNCTION "bookorbit_edition_link_claim_primary"'))!;

    for (const role of ['text', 'audio', 'readAlong']) {
      expect(sync).toContain(`'${role}');`);
    }
    expect(sync).toContain('AND "is_primary";');
    expect(claim).toContain('"is_primary" = false');
    expect(claim).toContain("ERRCODE = 'unique_violation'");
  });

  it('is silent when no tables are missing', async () => {
    const { service } = createService();

    await service.onApplicationBootstrap();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs the number of tables created when tables were missing', async () => {
    const { service, repo } = createService();
    repo.findMissingTables.mockResolvedValue(['book_edition_links']);

    await service.onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toMatch(
      /^\[edition_link\.schema_bootstrap\] \[end\] durationMs=\d+ tablesCreated=1 - schema bootstrap created tables$/,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a fail message and rethrows when applying statements fails', async () => {
    const { service, repo } = createService();
    const failure = new Error('boom "quoted"');
    repo.applySchemaStatements.mockRejectedValue(failure);

    await expect(service.onApplicationBootstrap()).rejects.toThrow(failure);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]![0] as string;
    expect(message).toContain('[edition_link.schema_bootstrap] [fail]');
    expect(message).toContain('errorClass=Error');
    expect(message).toContain('error="boom \\"quoted\\""');
    expect(message).toContain('durationMs=');
    expect(logSpy).not.toHaveBeenCalled();
  });
});
