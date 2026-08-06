import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadingAlignmentSchemaBootstrapService } from './reading-alignment-schema-bootstrap.service';
import { READING_ALIGNMENT_SCHEMA_SQL } from './schema/reading-alignment-schema';

type RepoMock = { applySchemaStatements: ReturnType<typeof vi.fn>; failInterruptedBuilds: ReturnType<typeof vi.fn> };

function createService(): { service: ReadingAlignmentSchemaBootstrapService; repo: RepoMock } {
  const repo: RepoMock = { applySchemaStatements: vi.fn().mockResolvedValue(undefined), failInterruptedBuilds: vi.fn().mockResolvedValue(0) };
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

  it('splits the embedded SQL on the statement breakpoint and applies each statement', async () => {
    const { service, repo } = createService();

    await service.onApplicationBootstrap();

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
  });

  it('logs a start and end message on success', async () => {
    const { service } = createService();

    await service.onApplicationBootstrap();

    const messages = logSpy.mock.calls.map((call) => call[0] as string);
    expect(messages.some((message) => message.includes('[reading_alignment.schema_bootstrap] [start]'))).toBe(true);
    expect(messages.some((message) => message.includes('[reading_alignment.schema_bootstrap] [end]') && message.includes('durationMs='))).toBe(true);
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
    expect(message).toContain('durationMs=');
  });
});
