import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BookRequestAutoGrabBootstrapService } from './book-request-auto-grab-bootstrap.service';

type RepoMock = {
  findMissingColumns: ReturnType<typeof vi.fn>;
  applySchemaStatements: ReturnType<typeof vi.fn>;
};

function createService(missing: string[] = []): { service: BookRequestAutoGrabBootstrapService; repo: RepoMock } {
  const repo: RepoMock = {
    findMissingColumns: vi.fn().mockResolvedValue(missing),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
  };
  return { service: new BookRequestAutoGrabBootstrapService(repo as never), repo };
}

describe('BookRequestAutoGrabBootstrapService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is silent when the column is present', async () => {
    const { service, repo } = createService();

    await service.onModuleInit();

    expect(repo.findMissingColumns).toHaveBeenCalledWith('book_requests', ['auto_grab']);
    expect(repo.applySchemaStatements).toHaveBeenCalledWith(['ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "auto_grab" boolean;']);
    expect(repo.findMissingColumns.mock.invocationCallOrder[0]).toBeLessThan(repo.applySchemaStatements.mock.invocationCallOrder[0]!);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs columnsAdded=1 when the column was missing', async () => {
    const { service } = createService(['auto_grab']);

    await service.onModuleInit();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toMatch(
      /^\[book_request\.auto_grab_bootstrap\] \[end\] durationMs=\d+ columnsAdded=1 - auto_grab column added$/,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a sanitized failure and rethrows it', async () => {
    const { service, repo } = createService();
    const failure = new Error('boom "quoted" \\ path');
    repo.applySchemaStatements.mockRejectedValue(failure);

    await expect(service.onModuleInit()).rejects.toThrow(failure);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]![0] as string;
    expect(message).toContain('[book_request.auto_grab_bootstrap] [fail]');
    expect(message).toContain('durationMs=');
    expect(message).toContain('errorClass=Error');
    expect(message).toContain('error="boom \\"quoted\\" \\\\ path"');
  });
});
