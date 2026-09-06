import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type SchemaBootstrapDb = Pick<NodePgDatabase<Record<string, unknown>>, 'execute'>;

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

export function splitSchemaStatements(sqlText: string): string[] {
  return sqlText
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function findMissingTables(db: SchemaBootstrapDb, tableNames: readonly string[]): Promise<string[]> {
  const names = sql.join(
    tableNames.map((name) => sql`${name}`),
    sql`, `,
  );
  const result = await db.execute<{ name: string }>(sql`
    select name
    from unnest(array[${names}]::text[]) as t(name)
    where to_regclass('public.' || name) is null
  `);
  return result.rows.map((row) => row.name);
}

export async function findMissingColumns(db: SchemaBootstrapDb, tableName: string, columnNames: readonly string[]): Promise<string[]> {
  const names = sql.join(
    columnNames.map((name) => sql`${name}`),
    sql`, `,
  );
  const result = await db.execute<{ name: string }>(sql`
    select name
    from unnest(array[${names}]::text[]) as requested(name)
    where not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = ${tableName}
        and column_name = requested.name
    )
  `);
  return result.rows.map((row) => row.name);
}

export async function applySchemaStatements(db: SchemaBootstrapDb, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}
