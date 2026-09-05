import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { MONITORED_WORK_STATES, MONITORED_WORK_VERDICTS, MONITOR_MODES } from '@bookorbit/types';

import { authorCatalogWorks, monitoredAuthors, monitoredAuthorWorks, monitoredBooks } from './monitored';

const dialect = new PgDialect();

function checkValues(table: Parameters<typeof getTableConfig>[0], name: string): string[] {
  const check = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  expect(check).toBeDefined();
  const statement = dialect.sqlToQuery(check!.value).sql;
  return [...statement.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
}

describe('monitored CHECK SQL matches shared constants', () => {
  it('accepts exactly the declared monitor modes for both formats', () => {
    expect(checkValues(monitoredAuthors, 'monitored_authors_ebook_mode_chk').sort()).toEqual([...MONITOR_MODES].sort());
    expect(checkValues(monitoredAuthors, 'monitored_authors_audiobook_mode_chk').sort()).toEqual([...MONITOR_MODES].sort());
  });

  it('accepts exactly the declared work verdicts', () => {
    expect(checkValues(authorCatalogWorks, 'author_catalog_works_verdict_chk').sort()).toEqual([...MONITORED_WORK_VERDICTS].sort());
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
