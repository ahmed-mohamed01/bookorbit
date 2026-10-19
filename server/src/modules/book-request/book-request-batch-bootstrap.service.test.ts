import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BookRequestBatchBootstrapService } from './book-request-batch-bootstrap.service';

type RepoMock = {
  findMissingColumns: ReturnType<typeof vi.fn>;
  applySchemaStatements: ReturnType<typeof vi.fn>;
};

function createService(missing: string[] = []): { service: BookRequestBatchBootstrapService; repo: RepoMock } {
  const repo: RepoMock = {
    findMissingColumns: vi.fn().mockResolvedValue(missing),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
  };
  return { service: new BookRequestBatchBootstrapService(repo as never), repo };
}

describe('BookRequestBatchBootstrapService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies the batch schema when columns are missing', async () => {
    const { service, repo } = createService(['kind']);

    await service.onModuleInit();

    expect(repo.findMissingColumns).toHaveBeenCalledWith('book_requests', ['kind']);
    const statements = repo.applySchemaStatements.mock.calls[0]![0] as string[];
    expect(statements).toHaveLength(5);
    expect(statements[0]).toContain('ADD COLUMN IF NOT EXISTS "kind" varchar(10) NOT NULL DEFAULT \'single\'');
    expect(statements.join('\n')).toContain('book_requests_kind_chk');
    expect(statements.join('\n')).toContain('CREATE TABLE IF NOT EXISTS "book_request_batch_units"');
    expect(logSpy.mock.calls[0]![0]).toMatch(/^\[book_request\.batch_bootstrap\] \[end\] durationMs=\d+ columnsAdded=1 - batch grab schema applied$/);
  });

  it('does nothing when the schema exists', async () => {
    const { service } = createService();

    await service.onModuleInit();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a sanitized failure and rethrows it', async () => {
    const { service, repo } = createService();
    const failure = new Error('boom "quoted" \\ path');
    repo.applySchemaStatements.mockRejectedValue(failure);

    await expect(service.onModuleInit()).rejects.toThrow(failure);

    const message = errorSpy.mock.calls[0]![0] as string;
    expect(message).toContain('[book_request.batch_bootstrap] [fail]');
    expect(message).toContain('error="boom \\"quoted\\" \\\\ path"');
  });
});
