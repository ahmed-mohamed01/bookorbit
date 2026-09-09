import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { MONITORED_WORK_KINDS, MONITORED_WORK_STATES, MONITORED_WORK_VERDICTS, MONITOR_MODES } from '@bookorbit/types';

import { authorCatalogWorks, monitoredAuthors, monitoredAuthorWorks, monitoredBooks } from './monitored.schema';
import { MONITORED_SCHEMA_SQL } from './monitored-schema';

const dialect = new PgDialect();

function checkValues(table: Parameters<typeof getTableConfig>[0], name: string): string[] {
  const check = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  expect(check).toBeDefined();
  const statement = dialect.sqlToQuery(check!.value).sql;
  return [...statement.matchAll(/'([a-z_-]+)'/g)].map((match) => match[1]);
}

describe('monitored CHECK SQL matches shared constants', () => {
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
