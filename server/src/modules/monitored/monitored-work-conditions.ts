import { and, eq, ne, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import * as schema from './schema/monitored.schema';

export function releaseRangeOverlapsSql(date: AnyPgColumn, precision: AnyPgColumn, earliest: string, latest: string) {
  // A stored precision of NULL is not day precision: release-window.ts reads the precision off the
  // value's shape, so the SQL prefilter has to infer it the same way. Treating a null-precision
  // '2026' as 2026-01-01 dropped the row from every window the JS path still matched.
  const effective = sql`case when ${precision} is not null then ${precision} when length(${date}) = 4 then 'year' when length(${date}) = 7 then 'month' else 'day' end`;
  const rangeStart = sql<string>`case ${effective} when 'year' then ${date} || '-01-01' when 'month' then ${date} || '-01' else ${date} end`;
  const rangeEnd = sql<string>`case ${effective} when 'year' then ${date} || '-12-31' when 'month' then ${date} || '-31' else ${date} end`;
  return sql<boolean>`${rangeStart} <= ${latest} and ${rangeEnd} >= ${earliest}`;
}

export function visibleWorkCondition() {
  const overlayVisibility = schema.monitoredAuthorWorks.userVisibility;
  return sql<boolean>`coalesce(${or(
    sql`${overlayVisibility} = 'visible'`,
    and(
      sql`${overlayVisibility} is null`,
      eq(schema.authorCatalogWorks.verdict, 'verified'),
      sql`jsonb_array_length(${schema.authorCatalogWorks.flags}) = 0`,
    ),
  )}, false)`;
}

export function activeWorkCondition(visible: ReturnType<typeof visibleWorkCondition>) {
  return and(
    ne(schema.monitoredAuthors.paused, true),
    or(eq(schema.monitoredAuthorWorks.monitorState, 'monitoring'), sql`${schema.monitoredAuthorWorks.monitorState} is null`),
    visible,
  )!;
}
