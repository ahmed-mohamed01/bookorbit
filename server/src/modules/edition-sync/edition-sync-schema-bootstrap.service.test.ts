import { Logger } from '@nestjs/common';

import { EDITION_SYNC_TABLE_NAMES, EditionSyncSchemaBootstrapService } from './edition-sync-schema-bootstrap.service';
import { EDITION_SYNC_SCHEMA_SQL } from './schema/edition-sync-schema';

function setup(missing: string[] = []) {
  const repo = {
    findMissingTables: vi.fn().mockResolvedValue(missing),
    applySchemaStatements: vi.fn().mockResolvedValue(undefined),
  };
  return { repo, service: new EditionSyncSchemaBootstrapService(repo as never) };
}

describe('EditionSyncSchemaBootstrapService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies every statement of the embedded SQL and stays silent when nothing was missing', async () => {
    const { repo, service } = setup();
    await service.onModuleInit();

    expect(repo.findMissingTables).toHaveBeenCalledWith(EDITION_SYNC_TABLE_NAMES);
    const statements = repo.applySchemaStatements.mock.calls[0]![0] as string[];
    expect(statements).toHaveLength(EDITION_SYNC_SCHEMA_SQL.split('--> statement-breakpoint').filter((s) => s.trim()).length);
    for (const table of EDITION_SYNC_TABLE_NAMES) {
      expect(statements.some((statement) => statement.startsWith(`CREATE TABLE IF NOT EXISTS "${table}"`))).toBe(true);
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('installs the per-book trigger and guarded settings additions', () => {
    expect(EDITION_SYNC_SCHEMA_SQL).toContain('ADD COLUMN IF NOT EXISTS files_changed_at timestamptz');
    expect(EDITION_SYNC_SCHEMA_SQL).toContain("on_files_changed varchar(10) DEFAULT 'next_run' NOT NULL");
    expect(EDITION_SYNC_SCHEMA_SQL).toContain("CHECK (on_files_changed IN ('next_run', 'immediate'))");
    expect(EDITION_SYNC_SCHEMA_SQL).toContain(
      'AFTER INSERT OR UPDATE OF book_id, role, size_bytes, mtime, file_hash, absolute_path OR DELETE ON book_files',
    );
    expect(EDITION_SYNC_SCHEMA_SQL).toContain('IS NOT DISTINCT FROM');
    expect(EDITION_SYNC_SCHEMA_SQL).toContain('WHERE book_id = affected_book_id');
    expect(EDITION_SYNC_SCHEMA_SQL).toContain('RETURN NULL;');
    expect(EDITION_SYNC_SCHEMA_SQL).toContain('CREATE OR REPLACE TRIGGER edition_sync_book_files_changed');
    expect(EDITION_SYNC_SCHEMA_SQL).not.toContain('DROP TRIGGER');
    expect(EDITION_SYNC_SCHEMA_SQL).toContain(
      'content_changed := ROW(OLD.book_id, OLD.role, OLD.size_bytes, OLD.mtime, OLD.file_hash)\n    IS DISTINCT FROM ROW(NEW.book_id, NEW.role, NEW.size_bytes, NEW.mtime, NEW.file_hash)',
    );
    expect(EDITION_SYNC_SCHEMA_SQL.match(/status = 'failed' AND content_changed/g)).toHaveLength(5);
  });

  it('logs the tables it created', async () => {
    const { service } = setup(['edition_sync_runs']);
    await service.onModuleInit();
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[edition_sync\.schema_bootstrap\] \[end\] durationMs=\d+ tablesCreated=1 /));
  });

  it('logs and rethrows a failure', async () => {
    const { repo, service } = setup();
    repo.applySchemaStatements.mockRejectedValue(new Error('permission "denied"'));
    await expect(service.onModuleInit()).rejects.toThrow('permission');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[edition_sync.schema_bootstrap] [fail]'));
  });

  it('keeps every statement idempotent', () => {
    const statements = EDITION_SYNC_SCHEMA_SQL.split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      const guarded =
        statement.startsWith('CREATE TABLE IF NOT EXISTS') ||
        statement.startsWith('CREATE INDEX IF NOT EXISTS') ||
        (statement.startsWith('ALTER TABLE') && statement.includes('ADD COLUMN IF NOT EXISTS')) ||
        statement.startsWith('ALTER TABLE "edition_sync_user_settings" ALTER COLUMN "enabled" SET DEFAULT true;') ||
        statement.startsWith('CREATE OR REPLACE FUNCTION') ||
        statement.startsWith('CREATE OR REPLACE TRIGGER') ||
        (statement.startsWith('DO $$') && statement.includes('IF NOT EXISTS')) ||
        statement.includes('ON CONFLICT');
      expect(guarded, statement.slice(0, 80)).toBe(true);
    }
  });
});

it('adds the default-off server switch and changes only the user column default', () => {
  expect(EDITION_SYNC_SCHEMA_SQL).toContain('ALTER TABLE "edition_sync_settings" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT false NOT NULL');
  expect(EDITION_SYNC_SCHEMA_SQL).toContain('ALTER TABLE "edition_sync_user_settings" ALTER COLUMN "enabled" SET DEFAULT true');
});
