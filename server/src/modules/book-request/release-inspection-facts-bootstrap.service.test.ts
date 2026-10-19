import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReleaseInspectionFactsBootstrapService } from './release-inspection-facts-bootstrap.service';

type RepoMock = {
  findMissingTables: ReturnType<typeof vi.fn>;
  applySchemaStatements: ReturnType<typeof vi.fn>;
};

function createService(missing: string[] = []): { service: ReleaseInspectionFactsBootstrapService; repo: RepoMock } {
  const repo: RepoMock = {
    findMissingTables: vi.fn().mockResolvedValue(missing),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
  };
  return { service: new ReleaseInspectionFactsBootstrapService(repo as never), repo };
}

describe('ReleaseInspectionFactsBootstrapService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies the facts schema when the table is missing', async () => {
    const { service, repo } = createService(['release_inspection_facts']);

    await service.onModuleInit();

    expect(repo.findMissingTables).toHaveBeenCalledWith(['release_inspection_facts']);
    const statements = repo.applySchemaStatements.mock.calls[0]![0] as string[];
    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/alter table release_inspection_facts add column if not exists unit_count integer/i);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS "release_inspection_facts"');
    expect(statements[0]).toContain('"info_hash" text PRIMARY KEY');
    expect(statements[0]).toContain('"formats" text[] NOT NULL DEFAULT');
    expect(logSpy.mock.calls[0]![0]).toMatch(
      /^\[book_request\.release_facts_bootstrap\] \[end\] durationMs=\d+ tablesAdded=1 - release inspection facts schema applied$/,
    );
  });

  it('does nothing when the schema exists', async () => {
    const { service, repo } = createService();

    await service.onModuleInit();

    expect(repo.applySchemaStatements).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a sanitized failure and rethrows it', async () => {
    const { service, repo } = createService();
    const failure = new Error('boom "quoted" \\ path');
    repo.applySchemaStatements.mockRejectedValue(failure);

    await expect(service.onModuleInit()).rejects.toThrow(failure);

    const message = errorSpy.mock.calls[0]![0] as string;
    expect(message).toContain('[book_request.release_facts_bootstrap] [fail]');
    expect(message).toContain('error="boom \\"quoted\\" \\\\ path"');
  });
});
