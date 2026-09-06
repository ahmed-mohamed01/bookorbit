import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { findMissingTables, splitSchemaStatements } from './schema-bootstrap.utils';

describe('schema-bootstrap.utils', () => {
  it('splits statements on the breakpoint and drops blank statements', () => {
    expect(splitSchemaStatements('  select 1;  --> statement-breakpoint\n\n--> statement-breakpoint\n select 2; ')).toEqual([
      'select 1;',
      'select 2;',
    ]);
  });

  it('renders table names as a PostgreSQL array for to_regclass checks', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });

    await findMissingTables({ execute } as never, ['first_table', 'second_table']);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain('unnest(array[');
    expect(query.sql).toContain('to_regclass');
  });
});
