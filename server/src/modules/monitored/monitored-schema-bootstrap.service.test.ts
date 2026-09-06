import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MonitoredSchemaBootstrapService } from './monitored-schema-bootstrap.service';

const TABLE_NAMES = [
  'monitored_authors',
  'monitored_books',
  'monitored_author_works',
  'author_catalog_works',
  'author_catalog_state',
  'author_catalog_source_works',
  'author_provider_identities',
];

type StoreMock = {
  findMissingTables: ReturnType<typeof vi.fn>;
  applySchemaStatements: ReturnType<typeof vi.fn>;
};

function createService(missing: string[] = []): { service: MonitoredSchemaBootstrapService; store: StoreMock } {
  const store: StoreMock = {
    findMissingTables: vi.fn().mockResolvedValue(missing),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
  };
  return { service: new MonitoredSchemaBootstrapService(store as never), store };
}

describe('MonitoredSchemaBootstrapService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is silent when no tables are missing', async () => {
    const { service, store } = createService();

    await service.onApplicationBootstrap();

    expect(store.findMissingTables).toHaveBeenCalledWith(TABLE_NAMES);
    expect(store.applySchemaStatements).toHaveBeenCalledTimes(1);
    const statements = store.applySchemaStatements.mock.calls[0]![0] as string[];
    expect(statements.filter((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS'))).toHaveLength(7);
    expect(statements.some((statement) => statement.includes('auto_grab'))).toBe(false);
    expect(statements.some((statement) => statement.includes('public.bookorbit_unaccent("title") gin_trgm_ops'))).toBe(true);
    expect(statements.every((statement) => !statement.includes('--> statement-breakpoint'))).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs the number of tables created when all are missing', async () => {
    const { service } = createService(TABLE_NAMES);

    await service.onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = logSpy.mock.calls[0]![0] as string;
    expect(message).toContain('[monitored.schema_bootstrap] [end]');
    expect(message).toContain('durationMs=');
    expect(message).toContain('tablesCreated=7');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a sanitized failure and rethrows it', async () => {
    const { service, store } = createService();
    const failure = new Error('boom "quoted" \\ path');
    store.applySchemaStatements.mockRejectedValue(failure);

    await expect(service.onApplicationBootstrap()).rejects.toThrow(failure);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]![0] as string;
    expect(message).toContain('[monitored.schema_bootstrap] [fail]');
    expect(message).toContain('durationMs=');
    expect(message).toContain('errorClass=Error');
    expect(message).toContain('error="boom \\"quoted\\" \\\\ path"');
  });
});
