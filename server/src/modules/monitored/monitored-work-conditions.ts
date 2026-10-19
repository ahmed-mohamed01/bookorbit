import type { MonitoredClassSelection } from '@bookorbit/types';
import { and, eq, ne, or, sql, type SQL } from 'drizzle-orm';
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
  const overlayKind = schema.monitoredAuthorWorks.userKind;
  return sql<boolean>`coalesce(case
    when ${overlayVisibility} = 'hidden' then false
    when ${overlayKind} is not null then ${overlayKind} = 'book'
    when ${overlayVisibility} = 'visible' then true
    else ${and(eq(schema.authorCatalogWorks.verdict, 'verified'), sql`jsonb_array_length(${schema.authorCatalogWorks.flags}) = 0`)}
  end, false)`;
}

export function activeWorkCondition(visible: ReturnType<typeof visibleWorkCondition>) {
  return and(
    ne(schema.monitoredAuthors.paused, true),
    or(eq(schema.monitoredAuthorWorks.monitorState, 'monitoring'), sql`${schema.monitoredAuthorWorks.monitorState} is null`),
    visible,
  )!;
}

export function bookClassSql(): SQL<boolean> {
  return visibleWorkCondition();
}

function hiddenWorkSql(): SQL<boolean> {
  return sql<boolean>`coalesce(${schema.monitoredAuthorWorks.userVisibility} = 'hidden', false)`;
}

function placeholderWorkSql(visible: SQL<boolean>): SQL<boolean> {
  return sql<boolean>`(not ${visible} and ${schema.authorCatalogWorks.flags} @> '["placeholder"]'::jsonb)`;
}

function workKindSql(visible: SQL<boolean>): SQL {
  return sql`coalesce(${schema.monitoredAuthorWorks.userKind}, case when ${visible} then 'book' else ${schema.authorCatalogWorks.kind} end)`;
}

export function unconfirmedWorkSql(): SQL<boolean> {
  return sql<boolean>`(${schema.monitoredAuthorWorks.userKind} is null
        and ${schema.monitoredAuthorWorks.userVisibility} is distinct from 'hidden'
        and ${schema.monitoredAuthorWorks.userVisibility} is distinct from 'visible'
        and not (${schema.authorCatalogWorks.flags} @> '["placeholder"]'::jsonb)
        and (${schema.authorCatalogWorks.verdict} <> 'verified' or jsonb_array_length(${schema.authorCatalogWorks.flags}) > 0))`;
}

/** 'hidden', 'placeholder', the work's kind, or 'unconfirmed' when it has no kind: the display class of workDisplayClass. */
export function workClassKeySql(): SQL<string> {
  const visible = visibleWorkCondition();
  return sql<string>`case
    when ${hiddenWorkSql()} then 'hidden'
    when ${placeholderWorkSql(visible)} then 'placeholder'
    else coalesce(${workKindSql(visible)}, 'unconfirmed')
  end`;
}

export function classSelectionMatchSql(selection: MonitoredClassSelection): SQL<boolean> {
  const visible = visibleWorkCondition();
  const kind = workKindSql(visible);
  const kinds = selection.kinds.length
    ? sql`coalesce(${kind} in (${sql.join(
        selection.kinds.map((value) => sql`${value}`),
        sql`, `,
      )}), false)`
    : sql`false`;
  const unconfirmed = selection.more.includes('unconfirmed') ? unconfirmedWorkSql() : sql`false`;
  return sql<boolean>`case
    when ${hiddenWorkSql()} then ${selection.more.includes('hidden')}
    when ${placeholderWorkSql(visible)} then ${selection.more.includes('placeholders')}
    else (${kinds} or ${unconfirmed})
  end`;
}
