import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import {
  MONITORED_FORMATS,
  MONITORED_RELEASE_DATE_SOURCES,
  MONITORED_RELEASE_PROBE_STATUSES,
  MONITORED_WORK_KINDS,
  MONITORED_WORK_STATES,
  MONITORED_WORK_VERDICTS,
  MONITOR_MODES,
} from '@bookorbit/types';

import {
  authorCatalogWorks,
  authorCatalogWorkReleases,
  monitoredAuthors,
  monitoredAuthorWorks,
  monitoredBooks,
  monitoredReleaseEvents,
  monitoredSettings,
} from './monitored.schema';
import { MONITORED_SCHEMA_SQL } from './monitored-schema';

const dialect = new PgDialect();

function checkValues(table: Parameters<typeof getTableConfig>[0], name: string): string[] {
  const check = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  expect(check).toBeDefined();
  const statement = dialect.sqlToQuery(check!.value).sql;
  return [...statement.matchAll(/'([a-z_-]+)'/g)].map((match) => match[1]);
}

describe('monitored CHECK SQL matches shared constants', () => {
  it('keeps monitored settings in a single fixed row', () => {
    expect(checkValues(monitoredSettings, 'monitored_settings_single_row_chk')).toEqual([]);
    expect(MONITORED_SCHEMA_SQL).toContain('CONSTRAINT "monitored_settings_single_row_chk"');
  });

  it('accepts exactly the declared monitor modes for both formats', () => {
    expect(checkValues(monitoredAuthors, 'monitored_authors_ebook_mode_chk').sort()).toEqual([...MONITOR_MODES].sort());
    expect(checkValues(monitoredAuthors, 'monitored_authors_audiobook_mode_chk').sort()).toEqual([...MONITOR_MODES].sort());
  });

  it('accepts exactly the declared work verdicts', () => {
    expect(checkValues(authorCatalogWorks, 'author_catalog_works_verdict_chk').sort()).toEqual([...MONITORED_WORK_VERDICTS].sort());
  });

  it('accepts exactly the declared work kinds', () => {
    expect(checkValues(authorCatalogWorks, 'author_catalog_works_kind_chk').sort()).toEqual([...MONITORED_WORK_KINDS].sort());
  });

  it('accepts exactly the declared work monitor states', () => {
    expect(checkValues(monitoredAuthorWorks, 'monitored_author_works_monitor_state_chk').sort()).toEqual([...MONITORED_WORK_STATES].sort());
  });

  it('accepts exactly the declared formats on a release event', () => {
    expect(checkValues(monitoredReleaseEvents, 'monitored_release_events_format_chk').sort()).toEqual([...MONITORED_FORMATS].sort());
  });

  it('accepts exactly the declared release probe vocabularies', () => {
    expect(checkValues(authorCatalogWorkReleases, 'author_catalog_work_releases_format_chk').sort()).toEqual([...MONITORED_FORMATS].sort());
    expect(checkValues(authorCatalogWorkReleases, 'author_catalog_work_releases_status_chk').sort()).toEqual(
      [...MONITORED_RELEASE_PROBE_STATUSES].sort(),
    );
    expect(checkValues(authorCatalogWorkReleases, 'author_catalog_work_releases_source_chk').sort()).toEqual(
      [...MONITORED_RELEASE_DATE_SOURCES].sort(),
    );
  });
});

describe('monitored_release_events ledger', () => {
  it('keys one row per work and format, which is what makes a release announce exactly once', () => {
    const config = getTableConfig(monitoredReleaseEvents);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0].columns.map((column) => column.name)).toEqual(['work_id', 'format']);
  });

  it('removes the unreachable pending index from both schema copies', () => {
    const names = getTableConfig(monitoredReleaseEvents).indexes.map((candidate) => candidate.config.name);
    expect(names).not.toContain('monitored_release_events_pending_idx');
    expect(MONITORED_SCHEMA_SQL).not.toContain('CREATE INDEX IF NOT EXISTS "monitored_release_events_pending_idx"');
    expect(MONITORED_SCHEMA_SQL).toContain('DROP INDEX IF EXISTS "monitored_release_events_pending_idx";');
  });

  it('retains a nullable title without a catalog-work foreign key', () => {
    const config = getTableConfig(monitoredReleaseEvents);
    expect(config.columns.find((column) => column.name === 'title')?.notNull).toBe(false);
    expect(config.foreignKeys.some((foreignKey) => foreignKey.reference().columns.some((column) => column.name === 'work_id'))).toBe(false);
    expect(MONITORED_SCHEMA_SQL).not.toContain('ADD CONSTRAINT "monitored_release_events_work_id_author_catalog_works_id_fk"');
    expect(MONITORED_SCHEMA_SQL).toContain(
      'ALTER TABLE "monitored_release_events" DROP CONSTRAINT IF EXISTS "monitored_release_events_work_id_author_catalog_works_id_fk";',
    );
  });
});

describe('author_catalog_work_releases probe state', () => {
  it('keys one row per work and format without a catalog-work foreign key', () => {
    const config = getTableConfig(authorCatalogWorkReleases);
    expect(config.primaryKeys[0].columns.map((column) => column.name)).toEqual(['work_id', 'format']);
    expect(config.foreignKeys.some((foreignKey) => foreignKey.reference().columns.some((column) => column.name === 'work_id'))).toBe(false);
    expect(MONITORED_SCHEMA_SQL).not.toContain('author_catalog_work_releases_work_id_author_catalog_works_id_fk');
  });

  it('indexes the scheduler and monitor lookup columns', () => {
    expect(getTableConfig(authorCatalogWorkReleases).indexes.map((candidate) => candidate.config.name)).toEqual(
      expect.arrayContaining(['author_catalog_work_releases_next_check_at_work_id_idx', 'author_catalog_work_releases_monitor_author_id_idx']),
    );
  });

  it('carries the due-sweep index on both schema copies', () => {
    const index = getTableConfig(authorCatalogWorkReleases).indexes.find(
      (candidate) => candidate.config.name === 'author_catalog_work_releases_next_check_at_work_id_idx',
    );
    expect(index).toBeDefined();
    expect(index!.config.columns.map((column) => ('name' in column ? column.name : ''))).toEqual(['next_check_at', 'work_id']);
    expect(MONITORED_SCHEMA_SQL).toContain(
      'CREATE INDEX IF NOT EXISTS "author_catalog_work_releases_next_check_at_work_id_idx" ON "author_catalog_work_releases" USING btree ("next_check_at","work_id");',
    );
  });

  it('drops the redundant scheduler-prefix index after creating the covering index', () => {
    const names = getTableConfig(authorCatalogWorkReleases).indexes.map((candidate) => candidate.config.name);
    const coveringIndexAt = MONITORED_SCHEMA_SQL.indexOf('CREATE INDEX IF NOT EXISTS "author_catalog_work_releases_next_check_at_work_id_idx"');
    const dropAt = MONITORED_SCHEMA_SQL.indexOf('DROP INDEX IF EXISTS "author_catalog_work_releases_next_check_at_idx";');

    expect(names).not.toContain('author_catalog_work_releases_next_check_at_idx');
    expect(MONITORED_SCHEMA_SQL).not.toContain('CREATE INDEX IF NOT EXISTS "author_catalog_work_releases_next_check_at_idx"');
    expect(dropAt).toBeGreaterThan(coveringIndexAt);
  });

  it('tracks release date history in both schema copies', () => {
    const config = getTableConfig(authorCatalogWorkReleases);
    const names = [
      'last_release_date',
      'last_date_precision',
      'last_date_source',
      'previous_release_date',
      'previous_date_precision',
      'date_changed_at',
    ];
    const createStart = MONITORED_SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS "author_catalog_work_releases"');
    const createEnd = MONITORED_SCHEMA_SQL.indexOf('--> statement-breakpoint', createStart);
    const createTable = MONITORED_SCHEMA_SQL.slice(createStart, createEnd);

    for (const name of names) {
      expect(config.columns.find((column) => column.name === name)?.notNull).toBe(false);
      expect(createTable).toContain(`"${name}"`);
    }
  });

  it('adds and backfills release date history once on an existing table', () => {
    const guardAt = MONITORED_SCHEMA_SQL.indexOf("AND column_name = 'last_date_source'");
    const blockStart = MONITORED_SCHEMA_SQL.lastIndexOf('DO $$ BEGIN', guardAt);
    const blockEnd = MONITORED_SCHEMA_SQL.indexOf('END $$;', guardAt);
    const block = MONITORED_SCHEMA_SQL.slice(blockStart, blockEnd + 'END $$;'.length);

    expect(block).toContain("AND table_name = 'author_catalog_work_releases'");
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "last_release_date" varchar(10)');
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "last_date_precision" varchar(5)');
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "last_date_source" varchar(20)');
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "previous_release_date" varchar(10)');
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "previous_date_precision" varchar(5)');
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "date_changed_at" timestamp with time zone');
    expect(block).toContain('SET "last_release_date" = "release_date"');
    expect(block).toContain('"last_date_precision" = "date_precision"');
    expect(block).toContain('"last_date_source" = "source"');
    expect(block).toContain('"date_changed_at" = COALESCE("date_changed_at", now())');
    expect(block).toContain('AND "source" IS DISTINCT FROM \'user\'');
  });

  it('installs one trigger-owned history function after the upgrade block', () => {
    const guardAt = MONITORED_SCHEMA_SQL.indexOf("AND column_name = 'last_date_source'");
    const functionStart = MONITORED_SCHEMA_SQL.indexOf('CREATE OR REPLACE FUNCTION "author_catalog_work_releases_track_date"');
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionStart).toBeGreaterThan(guardAt);
    expect(MONITORED_SCHEMA_SQL.slice(functionStart, MONITORED_SCHEMA_SQL.indexOf('$$;', functionStart))).toContain('statement_timestamp()');
  });

  it('carries the automatic-date columns in both schema copies', () => {
    const config = getTableConfig(authorCatalogWorkReleases);
    const names = ['auto_release_date', 'auto_date_precision', 'auto_source', 'auto_changed_at'];
    const createStart = MONITORED_SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS "author_catalog_work_releases"');
    const createEnd = MONITORED_SCHEMA_SQL.indexOf('--> statement-breakpoint', createStart);
    const createTable = MONITORED_SCHEMA_SQL.slice(createStart, createEnd);

    for (const name of names) {
      expect(config.columns.find((column) => column.name === name)?.notNull).toBe(false);
      expect(createTable).toContain(`"${name}"`);
    }
  });

  it('adds the automatic-date columns to an existing table without backfilling them', () => {
    const guardAt = MONITORED_SCHEMA_SQL.indexOf("AND column_name = 'auto_changed_at'");
    const blockStart = MONITORED_SCHEMA_SQL.lastIndexOf('DO $$ BEGIN', guardAt);
    const blockEnd = MONITORED_SCHEMA_SQL.indexOf('END $$;', guardAt);
    const block = MONITORED_SCHEMA_SQL.slice(blockStart, blockEnd + 'END $$;'.length);

    expect(block).toContain("AND table_name = 'author_catalog_work_releases'");
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "auto_release_date" varchar(10)');
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "auto_date_precision" varchar(5)');
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "auto_source" varchar(20)');
    expect(block).toContain('ADD COLUMN IF NOT EXISTS "auto_changed_at" timestamp with time zone');
    expect(block).not.toContain('UPDATE "author_catalog_work_releases"');
  });

  it('keeps the automatic-date columns out of the trigger-owned history block', () => {
    const historyGuardAt = MONITORED_SCHEMA_SQL.indexOf("AND column_name = 'last_date_source'");
    const historyBlock = MONITORED_SCHEMA_SQL.slice(
      MONITORED_SCHEMA_SQL.lastIndexOf('DO $$ BEGIN', historyGuardAt),
      MONITORED_SCHEMA_SQL.indexOf('END $$;', historyGuardAt),
    );
    const trackerFunction = MONITORED_SCHEMA_SQL.slice(
      MONITORED_SCHEMA_SQL.indexOf('CREATE OR REPLACE FUNCTION "author_catalog_work_releases_track_date"'),
      MONITORED_SCHEMA_SQL.indexOf('$$;', MONITORED_SCHEMA_SQL.indexOf('CREATE OR REPLACE FUNCTION "author_catalog_work_releases_track_date"')),
    );

    expect(historyBlock).not.toContain('auto_');
    expect(trackerFunction).not.toContain('auto_');
  });

  it('creates the date tracker trigger only when it is absent', () => {
    const triggerAt = MONITORED_SCHEMA_SQL.indexOf("WHERE tgname = 'author_catalog_work_releases_track_date_trg'");
    const blockStart = MONITORED_SCHEMA_SQL.lastIndexOf('DO $$ BEGIN', triggerAt);
    const blockEnd = MONITORED_SCHEMA_SQL.indexOf('END $$;', triggerAt);
    const block = MONITORED_SCHEMA_SQL.slice(blockStart, blockEnd + 'END $$;'.length);

    expect(triggerAt).toBeGreaterThanOrEqual(0);
    expect(block).toMatch(/SELECT 1 FROM pg_trigger[\s\S]+tgrelid = 'author_catalog_work_releases'::regclass[\s\S]+NOT tgisinternal/);
    expect(block).toContain('CREATE TRIGGER "author_catalog_work_releases_track_date_trg"');
  });
});

describe('release watcher indexes', () => {
  it('does not duplicate the leading monitor index with unused date columns', () => {
    const names = getTableConfig(authorCatalogWorks).indexes.map((candidate) => candidate.config.name);
    expect(names).not.toContain('author_catalog_works_monitor_ebook_release_idx');
    expect(names).not.toContain('author_catalog_works_monitor_audio_release_idx');
    expect(MONITORED_SCHEMA_SQL).not.toContain('CREATE INDEX IF NOT EXISTS "author_catalog_works_monitor_ebook_release_idx"');
    expect(MONITORED_SCHEMA_SQL).not.toContain('CREATE INDEX IF NOT EXISTS "author_catalog_works_monitor_audio_release_idx"');
    expect(MONITORED_SCHEMA_SQL).toContain('DROP INDEX IF EXISTS "author_catalog_works_monitor_ebook_release_idx";');
    expect(MONITORED_SCHEMA_SQL).toContain('DROP INDEX IF EXISTS "author_catalog_works_monitor_audio_release_idx";');
  });
});

describe('monitored_authors duplicate guard', () => {
  it('carries a case-insensitive unique index per owner', () => {
    const index = getTableConfig(monitoredAuthors).indexes.find((candidate) => candidate.config.name === 'monitored_authors_owner_lower_name_uidx');
    expect(index).toBeDefined();
    expect(index!.config.unique).toBe(true);
    const columns = index!.config.columns.map((column) => ('name' in column ? column.name : dialect.sqlToQuery(column as never).sql));
    expect(columns[0]).toBe('owner_user_id');
    expect(columns[1]).toMatch(/lower\(/i);
  });
});

describe('monitored_books duplicate guard', () => {
  it('carries a unique index per owner, monitor and work', () => {
    const index = getTableConfig(monitoredBooks).indexes.find((candidate) => candidate.config.name === 'monitored_books_owner_monitor_work_uidx');
    expect(index).toBeDefined();
    expect(index!.config.unique).toBe(true);
    expect(index!.config.columns.map((column) => ('name' in column ? column.name : ''))).toEqual(['owner_user_id', 'monitor_author_id', 'work_id']);
  });

  it('indexes the owner column the list scopes every read by', () => {
    const names = getTableConfig(monitoredBooks).indexes.map((candidate) => candidate.config.name);
    expect(names).toContain('monitored_books_owner_user_id_idx');
  });
});

describe('monitored search indexes', () => {
  it('indexes every accent-insensitive search predicate with a trigram expression index', () => {
    const cases: [Parameters<typeof getTableConfig>[0], string, string][] = [
      [monitoredAuthors, 'monitored_authors_name_unaccent_trgm_idx', 'author_name'],
      [authorCatalogWorks, 'author_catalog_works_title_unaccent_trgm_idx', 'title'],
    ];
    for (const [table, name, column] of cases) {
      const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
      expect(index).toBeDefined();
      expect(index!.config.method).toBe('gin');
      const expression = dialect.sqlToQuery(index!.config.columns[0] as never).sql;
      expect(expression).toContain('bookorbit_unaccent');
      expect(expression).toContain(column);
      expect(expression).toContain('gin_trgm_ops');
    }
  });
});

// The bootstrap SQL is a second, hand-maintained copy of the table. A column that exists only in the
// Drizzle definition typechecks perfectly and then fails at runtime on the first insert.
describe('bootstrap SQL carries the columns the table declares', () => {
  it('creates the kind column on a fresh database and adds it to an existing one', () => {
    expect(MONITORED_SCHEMA_SQL).toContain('"kind" varchar(20)');
    expect(MONITORED_SCHEMA_SQL).toContain('ALTER TABLE "author_catalog_works" ADD COLUMN IF NOT EXISTS "kind" varchar(20);');
  });

  it('creates the release ledger and scheduler stamps on a fresh database and adds them to an existing one', () => {
    expect(MONITORED_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS "monitored_release_events"');
    expect(MONITORED_SCHEMA_SQL).toContain('"title" varchar(1000)');
    expect(MONITORED_SCHEMA_SQL).toContain('CONSTRAINT "monitored_release_events_work_id_format_pk" PRIMARY KEY("work_id","format")');
    expect(MONITORED_SCHEMA_SQL).toContain(
      'ALTER TABLE "monitored_authors" ADD COLUMN IF NOT EXISTS "last_release_check_at" timestamp with time zone;',
    );
    expect(MONITORED_SCHEMA_SQL).toContain(
      'ALTER TABLE "monitored_authors" ADD COLUMN IF NOT EXISTS "last_sync_attempted_at" timestamp with time zone;',
    );
    expect(MONITORED_SCHEMA_SQL).toContain('ALTER TABLE "monitored_release_events" ADD COLUMN IF NOT EXISTS "title" varchar(1000);');
    const authorColumns = getTableConfig(monitoredAuthors).columns.map((column) => column.name);
    expect(authorColumns).toContain('last_release_check_at');
    expect(authorColumns).toContain('last_sync_attempted_at');
  });

  it('creates the release probe table and settings flag on fresh and existing databases', () => {
    expect(MONITORED_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS "author_catalog_work_releases"');
    expect(MONITORED_SCHEMA_SQL).toContain('"release_probe_enabled" boolean DEFAULT true NOT NULL');
    expect(MONITORED_SCHEMA_SQL).toContain(
      'ALTER TABLE "monitored_settings" ADD COLUMN IF NOT EXISTS "release_probe_enabled" boolean NOT NULL DEFAULT true;',
    );
    expect(getTableConfig(monitoredSettings).columns.map((column) => column.name)).toContain('release_probe_enabled');
  });

  it('constrains release probe vocabularies to the shared constants on the bootstrap path', () => {
    const cases = [
      ['format', MONITORED_FORMATS],
      ['status', MONITORED_RELEASE_PROBE_STATUSES],
      ['source', MONITORED_RELEASE_DATE_SOURCES],
    ] as const;

    for (const [column, values] of cases) {
      const constraint = MONITORED_SCHEMA_SQL.match(new RegExp(`"author_catalog_work_releases"\\."${column}"[^\\n]+`));
      expect(constraint).not.toBeNull();
      expect([...constraint![0].matchAll(/'([a-z_-]+)'/g)].map((match) => match[1]).sort()).toEqual([...values].sort());
    }
  });

  it('constrains a release event format to the shared vocabulary', () => {
    const constraint = MONITORED_SCHEMA_SQL.match(/"monitored_release_events"\."format" in \([^)]+\)/);
    expect(constraint).not.toBeNull();
    expect([...constraint![0].matchAll(/'([a-z_-]+)'/g)].map((match) => match[1]).sort()).toEqual([...MONITORED_FORMATS].sort());
  });

  it('leaves no is_shared column on either a fresh or an existing database', () => {
    expect(MONITORED_SCHEMA_SQL).not.toContain('"is_shared" boolean');
    expect(MONITORED_SCHEMA_SQL).toContain(
      "WHERE table_schema = 'public'\n\t\t\tAND table_name = 'monitored_authors'\n\t\t\tAND column_name = 'is_shared'\n\t) THEN\n\t\tALTER TABLE \"monitored_authors\" DROP COLUMN IF EXISTS \"is_shared\";",
    );
    expect(MONITORED_SCHEMA_SQL).toContain(
      "WHERE table_schema = 'public'\n\t\t\tAND table_name = 'monitored_books'\n\t\t\tAND column_name = 'is_shared'\n\t) THEN\n\t\tALTER TABLE \"monitored_books\" DROP COLUMN IF EXISTS \"is_shared\";",
    );
  });

  it('drops legacy sharing columns only after their tables exist', () => {
    const authorCreateIndex = MONITORED_SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS "monitored_authors"');
    const authorDropIndex = MONITORED_SCHEMA_SQL.indexOf('ALTER TABLE "monitored_authors" DROP COLUMN IF EXISTS "is_shared";');
    const bookCreateIndex = MONITORED_SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS "monitored_books"');
    const bookDropIndex = MONITORED_SCHEMA_SQL.indexOf('ALTER TABLE "monitored_books" DROP COLUMN IF EXISTS "is_shared";');

    expect(authorCreateIndex).toBeGreaterThanOrEqual(0);
    expect(authorDropIndex).toBeGreaterThanOrEqual(0);
    expect(bookCreateIndex).toBeGreaterThanOrEqual(0);
    expect(bookDropIndex).toBeGreaterThanOrEqual(0);
    expect(authorDropIndex).toBeGreaterThan(authorCreateIndex);
    expect(bookDropIndex).toBeGreaterThan(bookCreateIndex);
  });

  it('constrains kind to the shared vocabulary on both paths', () => {
    const constraints = [...MONITORED_SCHEMA_SQL.matchAll(/"author_catalog_works"\."kind" is null or[^)]+\)/g)].map((match) => match[0]);

    expect(constraints).toHaveLength(2);
    for (const constraint of constraints) {
      expect([...constraint.matchAll(/'([a-z_-]+)'/g)].map((match) => match[1]).sort()).toEqual([...MONITORED_WORK_KINDS].sort());
    }
  });
});
