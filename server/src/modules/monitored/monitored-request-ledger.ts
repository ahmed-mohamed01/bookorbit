import { sql, type SQL } from 'drizzle-orm';
import type { MonitoredFormat } from '@bookorbit/types';

import type { ReleaseTransaction } from './monitored-release-probe-store.service';
import * as schema from './schema/monitored.schema';

const REQUEST_COLUMNS: Record<MonitoredFormat, string> = { ebook: 'ebook_request_id', audiobook: 'audiobook_request_id' };

/** The provider ids of a catalog work as `source:id`, the keys that survive a change of work id. */
export function workProviderKeysSql(workId: SQL): SQL {
  return sql`array(
    select identity.source || ':' || identity.provider_work_id
    from ${schema.authorCatalogSourceWorks} as identity
    where identity.work_id = ${workId}
    order by 1
  )`;
}

// Hashed so a long title cannot push the key past what a btree index entry can hold.
export function workIdentityKeysSql(work: SQL): SQL {
  return sql`array_append(${workProviderKeysSql(sql`${work}.id`)}, 'title:' || md5(lower(public.bookorbit_unaccent(${work}.title))))`;
}

/**
 * Copies every request id the monitor's works hold into the ledger, under each identity key of the
 * work that holds it. Runs before a catalog save deletes the works it no longer sees.
 */
export async function recordRequestLedger(tx: ReleaseTransaction, monitorId: string): Promise<void> {
  await tx.execute(sql`
    insert into ${schema.monitoredRequestLedger} (monitor_author_id, format, identity_key, request_id)
    select distinct on (recorded.format, recorded.identity_key) ${monitorId}, recorded.format, recorded.identity_key, recorded.request_id
    from (
      select request.format, request.request_id, unnest(${workIdentityKeysSql(sql`work`)}) as identity_key
      from ${schema.authorCatalogWorks} as work
      inner join ${schema.monitoredAuthorWorks} as overlay on overlay.work_id = work.id
      cross join lateral (values ('ebook', overlay.ebook_request_id), ('audiobook', overlay.audiobook_request_id)) as request(format, request_id)
      where work.monitor_author_id = ${monitorId}
        and request.request_id is not null
    ) as recorded
    order by recorded.format, recorded.identity_key, recorded.request_id desc
    on conflict (monitor_author_id, format, identity_key) do update set request_id = excluded.request_id
  `);
}

/**
 * Hands a recorded request id back to every work of the monitor that has none for that format but
 * shares an identity key with the work that filed it. Never replaces an id a work already holds.
 */
export async function restoreRequestLedger(tx: ReleaseTransaction, monitorId: string): Promise<void> {
  for (const format of Object.keys(REQUEST_COLUMNS) as MonitoredFormat[]) {
    const column = sql.identifier(REQUEST_COLUMNS[format]);
    await tx.execute(sql`
      insert into ${schema.monitoredAuthorWorks} (work_id, monitor_author_id, ${column})
      select work.id, work.monitor_author_id, recorded.request_id
      from ${schema.authorCatalogWorks} as work
      left join ${schema.monitoredAuthorWorks} as overlay on overlay.work_id = work.id
      cross join lateral (
        select ledger.request_id
        from ${schema.monitoredRequestLedger} as ledger
        where ledger.monitor_author_id = work.monitor_author_id
          and ledger.format = ${format}
          and ledger.identity_key = any(${workIdentityKeysSql(sql`work`)})
        order by ledger.request_id desc
        limit 1
      ) as recorded
      where work.monitor_author_id = ${monitorId}
        and overlay.${column} is null
      on conflict (work_id) do update set ${column} = excluded.${column}
      where ${schema.monitoredAuthorWorks}.${column} is null
    `);
  }
}
