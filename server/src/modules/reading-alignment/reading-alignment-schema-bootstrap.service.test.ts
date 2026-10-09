import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadingAlignmentSchemaBootstrapService } from './reading-alignment-schema-bootstrap.service';
import { READING_ALIGNMENT_SCHEMA_SQL } from './schema/reading-alignment-schema';

type RepoMock = {
  findMissingTables: ReturnType<typeof vi.fn>;
  findMissingColumns: ReturnType<typeof vi.fn>;
  applySchemaStatements: ReturnType<typeof vi.fn>;
  failInterruptedBuilds: ReturnType<typeof vi.fn>;
};

function createService(): { service: ReadingAlignmentSchemaBootstrapService; repo: RepoMock } {
  const repo: RepoMock = {
    findMissingTables: vi.fn().mockResolvedValue([]),
    findMissingColumns: vi.fn().mockResolvedValue([]),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
    failInterruptedBuilds: vi.fn().mockResolvedValue(0),
  };
  const service = new ReadingAlignmentSchemaBootstrapService(repo as never);
  return { service, repo };
}

describe('ReadingAlignmentSchemaBootstrapService', () => {
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

    expect(repo.findMissingTables).toHaveBeenCalledWith(['audiobook_alignment', 'audiobook_alignment_anchor']);
    expect(repo.findMissingColumns).toHaveBeenCalledWith('reading_progress', ['alignment_projected_at']);
    expect(repo.applySchemaStatements).toHaveBeenCalledTimes(1);
    const statements = repo.applySchemaStatements.mock.calls[0]![0] as string[];
    const expectedCount = READING_ALIGNMENT_SCHEMA_SQL.split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean).length;
    expect(statements).toHaveLength(expectedCount);
    expect(statements.every((statement) => statement.length > 0 && !statement.includes('--> statement-breakpoint'))).toBe(true);
    expect(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "audiobook_alignment"'))).toBe(true);
    expect(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "audiobook_alignment_anchor"'))).toBe(true);
    expect(statements[0]).toContain('"text_book_id" integer NOT NULL');
    expect(statements[0]).toContain('"audio_book_id" integer NOT NULL');
    expect(statements[0]).toContain('UNIQUE("text_book_id","audio_book_id")');
    expect(statements[0]).not.toContain('"book_id" integer NOT NULL');
    expect(repo.findMissingTables.mock.invocationCallOrder[0]).toBeLessThan(repo.applySchemaStatements.mock.invocationCallOrder[0]!);
    expect(repo.findMissingColumns.mock.invocationCallOrder[0]).toBeLessThan(repo.applySchemaStatements.mock.invocationCallOrder[0]!);
    expect(
      statements.some((statement) =>
        statement.includes('ALTER TABLE "reading_progress" ADD COLUMN IF NOT EXISTS "alignment_projected_at" timestamp with time zone'),
      ),
    ).toBe(true);
    expect(repo.applySchemaStatements.mock.invocationCallOrder[0]).toBeLessThan(repo.failInterruptedBuilds.mock.invocationCallOrder[0]!);
  });

  it('is silent when no tables are missing and no interrupted builds were reset', async () => {
    const { service } = createService();

    await service.onApplicationBootstrap();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs the number of tables created when tables were missing', async () => {
    const { service, repo } = createService();
    repo.findMissingTables.mockResolvedValue(['audiobook_alignment', 'audiobook_alignment_anchor']);

    await service.onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toMatch(
      /^\[reading_alignment\.schema_bootstrap\] \[end\] durationMs=\d+ tablesCreated=2 columnsAdded=0 interruptedBuildsReset=0 - schema bootstrap completed$/,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs the number of columns added when the projection column was missing', async () => {
    const { service, repo } = createService();
    repo.findMissingColumns.mockResolvedValue(['alignment_projected_at']);

    await service.onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toMatch(
      /^\[reading_alignment\.schema_bootstrap\] \[end\] durationMs=\d+ tablesCreated=0 columnsAdded=1 interruptedBuildsReset=0 - schema bootstrap completed$/,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs when interrupted builds were reset', async () => {
    const { service, repo } = createService();
    repo.failInterruptedBuilds.mockResolvedValue(3);

    await service.onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toMatch(
      /^\[reading_alignment\.schema_bootstrap\] \[end\] durationMs=\d+ tablesCreated=0 columnsAdded=0 interruptedBuildsReset=3 - schema bootstrap completed$/,
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
    expect(message).toContain('[reading_alignment.schema_bootstrap] [fail]');
    expect(message).toContain('errorClass=Error');
    expect(message).toContain('error="boom \\"quoted\\""');
    expect(message).toContain('durationMs=');
    expect(logSpy).not.toHaveBeenCalled();
  });
});
