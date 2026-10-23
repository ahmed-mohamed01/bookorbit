import { sql, type SQL } from 'drizzle-orm';

import type { ReleaseTransaction } from './monitored-release-probe-store.service';
import { workIdentityKeysSql } from './monitored-request-ledger';
import * as schema from './schema/monitored.schema';

function hasChoiceSql(overlay: SQL): SQL {
  return sql`(${overlay}.monitor_state <> 'monitoring' or ${overlay}.monitor_ebook is not null or ${overlay}.monitor_audiobook is not null
    or ${overlay}.auto_download_ebook is not null or ${overlay}.auto_download_audiobook is not null
    or ${overlay}.user_visibility is not null or ${overlay}.user_kind is not null)`;
}

/**
 * Copies the owner's choices on the monitor's works into the ledger, under each identity key of the
 * work, with the work that holds them. Runs before a catalog save deletes the works it no longer sees.
 *
 * Only works holding a choice are written. The keys of present works holding none are then dropped,
 * unless a present work with a choice shares them, so a choice the owner cleared is not handed back
 * later. Keys of works that are gone stay, which is what lets a returning work get its choices back.
 */
export async function recordChoiceLedger(tx: ReleaseTransaction, monitorId: string): Promise<void> {
  await tx.execute(sql`
    insert into ${schema.monitoredChoiceLedger}
      (monitor_author_id, identity_key, work_id, monitor_state, monitor_ebook, monitor_audiobook, auto_download_ebook, auto_download_audiobook, user_visibility, user_kind)
    select distinct on (recorded.identity_key)
      ${monitorId}, recorded.identity_key, recorded.work_id, recorded.monitor_state, recorded.monitor_ebook,
      recorded.monitor_audiobook, recorded.auto_download_ebook, recorded.auto_download_audiobook, recorded.user_visibility, recorded.user_kind
    from (
      select
        work.id as work_id,
        nullif(overlay.monitor_state, 'monitoring') as monitor_state,
        overlay.monitor_ebook,
        overlay.monitor_audiobook,
        overlay.auto_download_ebook,
        overlay.auto_download_audiobook,
        overlay.user_visibility,
        overlay.user_kind,
        unnest(${workIdentityKeysSql(sql`work`)}) as identity_key
      from ${schema.authorCatalogWorks} as work
      inner join ${schema.monitoredAuthorWorks} as overlay on overlay.work_id = work.id
      where work.monitor_author_id = ${monitorId}
        and ${hasChoiceSql(sql`overlay`)}
    ) as recorded
    order by recorded.identity_key, recorded.work_id
    on conflict (monitor_author_id, identity_key) do update set
      work_id = excluded.work_id,
      monitor_state = excluded.monitor_state,
      monitor_ebook = excluded.monitor_ebook,
      monitor_audiobook = excluded.monitor_audiobook,
      auto_download_ebook = excluded.auto_download_ebook,
      auto_download_audiobook = excluded.auto_download_audiobook,
      user_visibility = excluded.user_visibility,
      user_kind = excluded.user_kind
  `);
  await tx.execute(sql`
    delete from ${schema.monitoredChoiceLedger} as ledger
    where ledger.monitor_author_id = ${monitorId}
      and ledger.identity_key in (
        select unnest(${workIdentityKeysSql(sql`work`)})
        from ${schema.authorCatalogWorks} as work
        left join ${schema.monitoredAuthorWorks} as overlay on overlay.work_id = work.id
        where work.monitor_author_id = ${monitorId}
          and (overlay.work_id is null or not ${hasChoiceSql(sql`overlay`)})
      )
      and ledger.identity_key not in (
        select unnest(${workIdentityKeysSql(sql`work`)})
        from ${schema.authorCatalogWorks} as work
        inner join ${schema.monitoredAuthorWorks} as overlay on overlay.work_id = work.id
        where work.monitor_author_id = ${monitorId}
          and ${hasChoiceSql(sql`overlay`)}
      )
  `);
}

/**
 * Hands recorded choices back to the works this save added, when they share an identity key with a
 * work that is gone, or are that work come back. A work that was already there keeps what it holds:
 * a same-titled edition must not take on the other edition's choices. Never replaces a choice.
 */
export async function restoreChoiceLedger(tx: ReleaseTransaction, monitorId: string, previousWorkIds: readonly string[]): Promise<void> {
  const overlay = schema.monitoredAuthorWorks;
  const previous = sql`array(select jsonb_array_elements_text(${JSON.stringify(previousWorkIds)}::jsonb))`;
  await tx.execute(sql`
    insert into ${overlay} (work_id, monitor_author_id, monitor_state, monitor_ebook, monitor_audiobook, auto_download_ebook, auto_download_audiobook, user_visibility, user_kind)
    select work.id, work.monitor_author_id, coalesce(recorded.monitor_state, 'monitoring'), recorded.monitor_ebook,
      recorded.monitor_audiobook, recorded.auto_download_ebook, recorded.auto_download_audiobook, recorded.user_visibility, recorded.user_kind
    from ${schema.authorCatalogWorks} as work
    left join ${overlay} as current on current.work_id = work.id
    cross join lateral (
      select ledger.monitor_state, ledger.monitor_ebook, ledger.monitor_audiobook, ledger.auto_download_ebook, ledger.auto_download_audiobook, ledger.user_visibility, ledger.user_kind
      from ${schema.monitoredChoiceLedger} as ledger
      where ledger.monitor_author_id = work.monitor_author_id
        and ledger.identity_key = any(${workIdentityKeysSql(sql`work`)})
        and (
          ledger.work_id = work.id
          or not exists (select 1 from ${schema.authorCatalogWorks} as recorder where recorder.id = ledger.work_id)
        )
      order by ledger.identity_key
      limit 1
    ) as recorded
    where work.monitor_author_id = ${monitorId}
      and not (work.id = any(${previous}))
      and (current.work_id is null or not ${hasChoiceSql(sql`current`)})
    on conflict (work_id) do update set
      monitor_state = excluded.monitor_state,
      monitor_ebook = excluded.monitor_ebook,
      monitor_audiobook = excluded.monitor_audiobook,
      auto_download_ebook = excluded.auto_download_ebook,
      auto_download_audiobook = excluded.auto_download_audiobook,
      user_visibility = excluded.user_visibility,
      user_kind = excluded.user_kind
    where not ${hasChoiceSql(sql`${overlay}`)}
  `);
}
