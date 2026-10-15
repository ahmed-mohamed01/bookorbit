import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WEB_SERIALS_SCHEMA_SQL } from './schema/web-serials-schema';
import { WebSerialsSchemaBootstrapService } from './web-serials-schema-bootstrap.service';

function createService() {
  const repo = {
    findMissingTables: vi.fn().mockResolvedValue([]),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
    requeueInterruptedJobs: vi.fn().mockResolvedValue({ requeued: [] }),
  };
  return { service: new WebSerialsSchemaBootstrapService(repo as never), repo };
}

describe('WebSerialsSchemaBootstrapService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies the schema before re-queueing interrupted jobs and settles ready', async () => {
    const { service, repo } = createService();

    await service.onApplicationBootstrap();

    expect(repo.findMissingTables).toHaveBeenCalledWith([
      'web_serial_settings',
      'web_serial_jobs',
      'web_serial_job_items',
      'web_serial_imports',
      'web_serial_novel_prefs',
      'web_serial_novel_index',
      'web_serial_novel_index_sources',
      'web_serial_volume_requests',
    ]);
    const statements = repo.applySchemaStatements.mock.calls[0]![0] as string[];
    expect(statements.length).toBeGreaterThan(3);
    expect(statements.every((s) => s.length > 0 && !s.includes('--> statement-breakpoint'))).toBe(true);
    expect(statements.join('\n')).toContain(WEB_SERIALS_SCHEMA_SQL.split('\n')[0]);
    expect(repo.applySchemaStatements.mock.invocationCallOrder[0]).toBeLessThan(repo.requeueInterruptedJobs.mock.invocationCallOrder[0]!);
    await expect(service.ready).resolves.toEqual({ requeued: [] });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('defaults new installs to LNReader and migrates configured lightnovel-crawler installs', () => {
    expect(WEB_SERIALS_SCHEMA_SQL).toContain('"novel_engine" varchar(10) DEFAULT \'lnreader\' NOT NULL');
    expect(WEB_SERIALS_SCHEMA_SQL).toContain(
      `SET "novel_engine" = CASE WHEN "novel_url" IS NOT NULL THEN 'lncrawl' ELSE 'lnreader' END WHERE "novel_engine" IS NULL`,
    );
    expect(WEB_SERIALS_SCHEMA_SQL.indexOf(`SET "novel_engine" = CASE`)).toBeLessThan(
      WEB_SERIALS_SCHEMA_SQL.indexOf(`ALTER COLUMN "novel_engine" SET NOT NULL`),
    );
  });

  it('logs when tables were created or jobs re-queued', async () => {
    const { service, repo } = createService();
    repo.findMissingTables.mockResolvedValue(['web_serial_jobs']);
    repo.requeueInterruptedJobs.mockResolvedValue({ requeued: [4, 5] });

    await service.onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = logSpy.mock.calls[0]![0] as string;
    expect(message).toContain('[web_serials.schema_bootstrap] [end]');
    expect(message).toContain('tablesCreated=1');
    expect(message).toContain('interruptedJobsRequeued=2');
  });

  it('logs, rejects ready and rethrows when the schema fails to apply', async () => {
    const { service, repo } = createService();
    repo.applySchemaStatements.mockRejectedValue(new Error('boom "quoted"'));

    await expect(service.onApplicationBootstrap()).rejects.toThrow('boom');
    await expect(service.ready).rejects.toThrow('boom');

    const message = errorSpy.mock.calls[0]![0] as string;
    expect(message).toContain('[web_serials.schema_bootstrap] [fail]');
    expect(message).toContain('errorClass=Error');
    expect(message).not.toContain('"quoted"');
  });
});
