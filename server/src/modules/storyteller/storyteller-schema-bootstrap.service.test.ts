import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorytellerSchemaBootstrapService } from './storyteller-schema-bootstrap.service';
import { STORYTELLER_SCHEMA_SQL } from './schema/storyteller-schema';

type RepoMock = {
  findMissingTables: ReturnType<typeof vi.fn>;
  applySchemaStatements: ReturnType<typeof vi.fn>;
  requeueInterruptedBuilds: ReturnType<typeof vi.fn>;
};

function createService(): { service: StorytellerSchemaBootstrapService; repo: RepoMock } {
  const repo: RepoMock = {
    findMissingTables: vi.fn().mockResolvedValue([]),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
    requeueInterruptedBuilds: vi.fn().mockResolvedValue({ requeued: [], failed: [] }),
  };
  const service = new StorytellerSchemaBootstrapService(repo as never);
  return { service, repo };
}

describe('StorytellerSchemaBootstrapService', () => {
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

    expect(repo.findMissingTables).toHaveBeenCalledWith(['storyteller_settings', 'storyteller_read_along_builds']);
    expect(repo.applySchemaStatements).toHaveBeenCalledTimes(1);
    const statements = repo.applySchemaStatements.mock.calls[0]![0] as string[];
    const expectedCount = STORYTELLER_SCHEMA_SQL.split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean).length;
    expect(statements).toHaveLength(expectedCount);
    expect(statements.every((statement) => statement.length > 0 && !statement.includes('--> statement-breakpoint'))).toBe(true);
    expect(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "storyteller_settings"'))).toBe(true);
    expect(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "storyteller_read_along_builds"'))).toBe(true);
    expect(repo.findMissingTables.mock.invocationCallOrder[0]).toBeLessThan(repo.applySchemaStatements.mock.invocationCallOrder[0]!);
    expect(repo.applySchemaStatements.mock.invocationCallOrder[0]).toBeLessThan(repo.requeueInterruptedBuilds.mock.invocationCallOrder[0]!);
  });

  it('is silent when no tables are missing and no build was interrupted', async () => {
    const { service } = createService();

    await service.onApplicationBootstrap();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs the number of tables created when tables were missing', async () => {
    const { service, repo } = createService();
    repo.findMissingTables.mockResolvedValue(['storyteller_settings', 'storyteller_read_along_builds']);

    await service.onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toMatch(
      /^\[storyteller\.schema_bootstrap\] \[end\] durationMs=\d+ tablesCreated=2 interruptedBuildsRequeued=0 interruptedBuildsFailed=0 - schema bootstrap completed$/,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs how many interrupted builds were re-queued and how many failed', async () => {
    const { service, repo } = createService();
    repo.requeueInterruptedBuilds.mockResolvedValue({ requeued: [{ id: 1 }, { id: 2 }], failed: [{ id: 3 }] });

    await service.onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toMatch(
      /^\[storyteller\.schema_bootstrap\] \[end\] durationMs=\d+ tablesCreated=0 interruptedBuildsRequeued=2 interruptedBuildsFailed=1 - schema bootstrap completed$/,
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
    expect(message).toContain('[storyteller.schema_bootstrap] [fail]');
    expect(message).toContain('errorClass=Error');
    expect(message).toContain('error="boom \\"quoted\\""');
    expect(message).toContain('durationMs=');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('settles ready with the interrupted builds once they are re-queued, so the queue starts after them', async () => {
    const { service, repo } = createService();
    const interrupted = { requeued: [{ id: 1 }], failed: [] };
    repo.requeueInterruptedBuilds.mockResolvedValue(interrupted);
    let settled = false;
    void service.ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await service.onApplicationBootstrap();
    await expect(service.ready).resolves.toBe(interrupted);

    expect(settled).toBe(true);
    expect(repo.requeueInterruptedBuilds).toHaveBeenCalledOnce();
  });

  it('rejects ready when the bootstrap fails', async () => {
    const { service, repo } = createService();
    repo.applySchemaStatements.mockRejectedValue(new Error('boom'));

    await expect(service.onApplicationBootstrap()).rejects.toThrow('boom');
    await expect(service.ready).rejects.toThrow('boom');
  });
});
