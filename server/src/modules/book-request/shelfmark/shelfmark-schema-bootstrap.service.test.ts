import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { BookRequestRepository } from '../book-request.repository';
import { ShelfmarkSchemaBootstrapService } from './shelfmark-schema-bootstrap.service';

async function harness(missing: string[] = [], constraintsExtended = 0, rowsRestored = 0) {
  const repo = {
    findMissingColumns: vi.fn().mockResolvedValue(missing),
    shelfmarkSchemaChanges: vi.fn().mockResolvedValue({ constraintsExtended, rowsRestored }),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
  };
  const module = await Test.createTestingModule({
    providers: [ShelfmarkSchemaBootstrapService, { provide: BookRequestRepository, useValue: repo }],
  }).compile();
  return { service: module.get(ShelfmarkSchemaBootstrapService), repo };
}

describe('Shelfmark schema bootstrap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is silent when the schema and parked rows need no changes', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const { service } = await harness();
    log.mockClear();
    await service.onModuleInit();
    expect(log).not.toHaveBeenCalled();
  });

  it('adds the column before generic constraint extensions and guarded restores', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, repo } = await harness(['content_file_count'], 2, 3);
    await service.onModuleInit();
    const statements = repo.applySchemaStatements.mock.calls[0][0] as string[];
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe('ALTER TABLE "book_request_downloads" ADD COLUMN IF NOT EXISTS "content_file_count" integer;');
    for (const statement of statements.slice(1, 3)) {
      expect(statement).toContain("pg_get_constraintdef(oid) NOT LIKE '%shelfmark%'");
      expect(statement).toContain('CHECK (%s OR %I = %L)');
      expect(statement).toContain('IF definition IS NOT NULL');
    }
    expect(statements[3]).toContain("to_regclass('public.fork_parked_check_rows') IS NOT NULL");
    expect(statements[3]).toContain('p.original_value::boolean');
    expect(statements[3]).toContain('t."enabled" = false');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('columnsAdded=1 constraintsExtended=2 rowsRestored=3'));
  });

  it('logs sanitized failures and rethrows', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, repo } = await harness();
    repo.applySchemaStatements.mockRejectedValue(new Error('bad "value"\nline'));
    await expect(service.onModuleInit()).rejects.toThrow('bad');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('errorClass=Error'));
    expect(log).toHaveBeenCalledWith(expect.not.stringContaining('\n'));
  });
});
