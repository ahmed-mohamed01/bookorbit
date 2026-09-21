import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { MONITORED_FORMATS } from '@bookorbit/types';
import type { MonitoredDatePrecision, MonitoredFormat } from '@bookorbit/types';

import { DB } from '../../db';
import * as dbSchema from '../../db/schema';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { nextProbeCheckAt } from './release-probe/probe-decision';
import type { ProbeDecision, ProbeRowSnapshot, ProbeSnapshot, ProbeSuggestion } from './release-probe/release-probe.types';
import { releaseDateRange } from './release-window';
import { activeWorkCondition, releaseRangeOverlapsSql, visibleWorkCondition } from './monitored-work-conditions';
import * as schema from './schema/monitored.schema';

type Db = NodePgDatabase<typeof dbSchema>;
export type ReleaseProbeRow = typeof schema.authorCatalogWorkReleases.$inferSelect;
export type ReleaseTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Everything a probe row needs to be written: the work it belongs to and the monitor that owns it. */
export interface ReleaseProbeWorkRef {
  id: string;
  monitorAuthorId: string;
  ownerUserId: number;
}

export interface ReleaseProbeWork extends ReleaseProbeWorkRef {
  authorName: string;
  title: string;
  ebookReleaseDate: string | null;
  ebookDatePrecision: MonitoredDatePrecision | null;
  audioReleaseDate: string | null;
  audioDatePrecision: MonitoredDatePrecision | null;
  sources: string[];
  ownedFormats: MonitoredFormat[];
  hardcoverSlug: string | null;
  audibleAsin: string | null;
  releases: ReleaseProbeRow[];
}

export type ReleaseProbeOutcome = Partial<
  Record<MonitoredFormat, { decision: ProbeDecision; nextCheckAt: Date; rescheduleOnly?: boolean; suggested?: ProbeSuggestion } | null>
>;

export interface SaveReleaseProbeOutcomeResult {
  ledgerResets: number;
  appliedFormats: MonitoredFormat[];
  skippedFormats: MonitoredFormat[];
}

const FORMATS_PER_WORK = 2;
const FORMATS = MONITORED_FORMATS;
const LEDGER_RESET_TOLERANCE_DAYS = 14;

type OutcomeEntry = [MonitoredFormat, NonNullable<ReleaseProbeOutcome[MonitoredFormat]>];
type LockedProbeRow = ProbeRowSnapshot & { format: MonitoredFormat };

function catalogColumns(format: MonitoredFormat, releaseDate: string | null = null, datePrecision: MonitoredDatePrecision | null = null) {
  return format === 'ebook'
    ? {
        date: schema.authorCatalogWorks.ebookReleaseDate,
        precision: schema.authorCatalogWorks.ebookDatePrecision,
        set: { ebookReleaseDate: releaseDate, ebookDatePrecision: datePrecision },
      }
    : {
        date: schema.authorCatalogWorks.audioReleaseDate,
        precision: schema.authorCatalogWorks.audioDatePrecision,
        set: { audioReleaseDate: releaseDate, audioDatePrecision: datePrecision },
      };
}

export function findChangedProbeFormats(
  snapshot: ProbeSnapshot | undefined,
  outcome: ReleaseProbeOutcome,
  currentRows: ReadonlyArray<LockedProbeRow>,
): MonitoredFormat[] {
  if (!snapshot) return [];
  const current = new Map(currentRows.map((row) => [row.format, row]));
  return FORMATS.filter((format) => {
    if (!(format in outcome)) return false;
    const before = snapshot[format];
    const row = current.get(format) ?? null;
    return (
      (before === null && row !== null) ||
      (before !== null && row === null) ||
      (before !== null &&
        row !== null &&
        (before.status !== row.status ||
          before.releaseDate !== row.releaseDate ||
          before.source !== row.source ||
          before.autoReleaseDate !== row.autoReleaseDate))
    );
  });
}

/**
 * The automatic date the owner knowingly overrides becomes the baseline their suggestion is measured
 * against; a date set over an existing choice keeps whatever baseline the probe last recorded.
 */
function userDateBaseline(kept: AnyPgColumn, replaced: AnyPgColumn): SQL {
  const table = schema.authorCatalogWorkReleases;
  return sql`case
    when ${table.source} = 'user' then ${kept}
    when ${table.status} = 'dated' and ${table.source} is not null and ${table.releaseDate} is not null then ${replaced}
    else null
  end`;
}

/** Row-ordered selection costs one index walk instead of sorting the whole due set, so it over-reads and folds the formats back together here. */
function firstDistinct(workIds: string[], limit: number): string[] {
  const unique = new Set<string>();
  for (const workId of workIds) {
    if (unique.size >= limit) break;
    unique.add(workId);
  }
  return [...unique];
}

function staleLedgerDay(start: string): string {
  const threshold = new Date(`${start}T00:00:00.000Z`);
  threshold.setUTCDate(threshold.getUTCDate() - LEDGER_RESET_TOLERANCE_DAYS);
  return threshold.toISOString().slice(0, 10);
}

function probeWindowCondition(today: string) {
  const earliest = new Date(`${today}T00:00:00.000Z`);
  earliest.setUTCDate(earliest.getUTCDate() - 365);
  const earliestDay = earliest.toISOString().slice(0, 10);
  const currentYear = Number(today.slice(0, 4));
  const ebook = catalogColumns('ebook');
  const audiobook = catalogColumns('audiobook');
  return or(
    releaseRangeOverlapsSql(ebook.date, ebook.precision, earliestDay, '9999-12-31'),
    releaseRangeOverlapsSql(audiobook.date, audiobook.precision, earliestDay, '9999-12-31'),
    and(
      sql`${schema.authorCatalogWorks.ebookReleaseDate} is null`,
      sql`${schema.authorCatalogWorks.audioReleaseDate} is null`,
      sql`${schema.authorCatalogWorks.releaseYear} >= ${currentYear}`,
    ),
  )!;
}

export async function enrolReleaseProbes(tx: ReleaseTransaction, monitorId: string, today: string): Promise<number> {
  const visible = visibleWorkCondition();
  const active = activeWorkCondition(visible);
  const window = probeWindowCondition(today);
  let inserted = 0;
  for (const format of FORMATS) {
    const hintDate =
      format === 'ebook'
        ? sql`${schema.authorCatalogWorks.ebookReleaseDate}`
        : sql`case when ${schema.authorCatalogWorks.audioDatePrecision} is distinct from 'day' then ${schema.authorCatalogWorks.audioReleaseDate} end`;
    const hintPrecision =
      format === 'ebook'
        ? sql`${schema.authorCatalogWorks.ebookDatePrecision}`
        : sql`case when ${schema.authorCatalogWorks.audioDatePrecision} is distinct from 'day' then ${schema.authorCatalogWorks.audioDatePrecision} end`;
    const result = await tx.execute(sql`
      insert into ${schema.authorCatalogWorkReleases}
        (work_id, monitor_author_id, owner_user_id, format, status, release_date, date_precision, next_check_at, attempts)
      select ${schema.authorCatalogWorks.id}, ${schema.authorCatalogWorks.monitorAuthorId}, ${schema.monitoredAuthors.ownerUserId},
        ${format}, 'pending', ${hintDate}, ${hintPrecision}, now(), 0
      from ${schema.authorCatalogWorks}
      inner join ${schema.monitoredAuthors}
        on ${schema.monitoredAuthors.id} = ${schema.authorCatalogWorks.monitorAuthorId}
      left join ${schema.monitoredAuthorWorks}
        on ${schema.monitoredAuthorWorks.workId} = ${schema.authorCatalogWorks.id}
      where ${schema.authorCatalogWorks.monitorAuthorId} = ${monitorId}
        and ${active}
        and ${window}
        and not (${schema.authorCatalogWorks.ownedFormats} @> ${JSON.stringify([format])}::jsonb)
      on conflict (work_id, format) do nothing
    `);
    inserted += result.rowCount ?? 0;
  }
  await tx.execute(sql`
    update ${schema.authorCatalogWorks} as work
    set ebook_release_date = null,
      ebook_date_precision = null
    from ${schema.authorCatalogWorkReleases} as probe
    where probe.work_id = work.id
      and work.monitor_author_id = ${monitorId}
      and probe.format = 'ebook'
      and probe.status = 'pending'
      and not (work.owned_formats @> '["ebook"]'::jsonb)
  `);
  await tx.execute(sql`
    update ${schema.authorCatalogWorks} as work
    set audio_release_date = null,
      audio_date_precision = null
    from ${schema.authorCatalogWorkReleases} as probe
    where probe.work_id = work.id
      and work.monitor_author_id = ${monitorId}
      and probe.format = 'audiobook'
      and probe.status = 'pending'
      and work.audio_date_precision is distinct from 'day'
      and not (work.owned_formats @> '["audiobook"]'::jsonb)
  `);
  return inserted;
}

export async function reapplyReleaseOverlay(tx: ReleaseTransaction, monitorId: string): Promise<void> {
  await tx.execute(sql`
    update ${schema.authorCatalogWorkReleases} as probe
    set status = case when probe.status = 'pending' then 'pending' else 'expected' end,
      release_date = work.ebook_release_date,
      date_precision = work.ebook_date_precision
    from ${schema.authorCatalogWorks} as work
    where work.id = probe.work_id
      and work.monitor_author_id = ${monitorId}
      and probe.format = 'ebook'
      and probe.source is null
      and probe.status in ('pending', 'expected', 'unlisted')
      and work.ebook_release_date is not null
  `);
  // A cluster-consensus year in the audio column is the merger guessing, not an Audible listing, so
  // it is captured as a hint exactly like the ebook column instead of being stamped as evidence.
  await tx.execute(sql`
    update ${schema.authorCatalogWorkReleases} as probe
    set status = case when probe.status = 'pending' then 'pending' else 'expected' end,
      release_date = work.audio_release_date,
      date_precision = work.audio_date_precision
    from ${schema.authorCatalogWorks} as work
    where work.id = probe.work_id
      and work.monitor_author_id = ${monitorId}
      and probe.format = 'audiobook'
      and probe.source is null
      and probe.status in ('pending', 'expected', 'unlisted')
      and work.audio_release_date is not null
      and work.audio_date_precision is distinct from 'day'
  `);
  await tx.execute(sql`
    update ${schema.authorCatalogWorkReleases} as probe
    set status = 'dated',
      source = 'audible',
      release_date = work.audio_release_date,
      date_precision = work.audio_date_precision,
      asin = null,
      next_check_at = case
        when work.audio_release_date is distinct from probe.release_date then now()
        else probe.next_check_at
      end
    from ${schema.authorCatalogWorks} as work
    where work.id = probe.work_id
      and work.monitor_author_id = ${monitorId}
      and probe.format = 'audiobook'
      and probe.source is distinct from 'user'
      and work.audio_release_date is not null
      and work.audio_date_precision = 'day'
  `);
  await tx.execute(sql`
    update ${schema.authorCatalogWorks} as work
    set ebook_release_date = case when probe.status = 'dated' then probe.release_date else null end,
      ebook_date_precision = case when probe.status = 'dated' then probe.date_precision else null end
    from ${schema.authorCatalogWorkReleases} as probe
    where probe.work_id = work.id
      and work.monitor_author_id = ${monitorId}
      and probe.format = 'ebook'
      and probe.status in ('pending', 'dated', 'expected', 'unlisted')
      and not (work.owned_formats @> '["ebook"]'::jsonb)
  `);
  await tx.execute(sql`
    update ${schema.authorCatalogWorks} as work
    set audio_release_date = null,
      audio_date_precision = null
    from ${schema.authorCatalogWorkReleases} as probe
    where probe.work_id = work.id
      and work.monitor_author_id = ${monitorId}
      and probe.format = 'audiobook'
      and probe.source is distinct from 'user'
      and probe.status in ('pending', 'expected', 'unlisted')
      and work.audio_date_precision is distinct from 'day'
      and not (work.owned_formats @> '["audiobook"]'::jsonb)
  `);
  // Audible reaches a monitored work through the catalog merger, not through the probe sweep, so a
  // date the owner overrode has to capture its suggestion here, while the merged column is still in
  // front of the restore below.
  await tx.execute(sql`
    update ${schema.authorCatalogWorkReleases} as probe
    set auto_release_date = work.audio_release_date,
      auto_date_precision = work.audio_date_precision,
      auto_source = 'audible',
      auto_changed_at = now()
    from ${schema.authorCatalogWorks} as work
    where work.id = probe.work_id
      and work.monitor_author_id = ${monitorId}
      and probe.format = 'audiobook'
      and probe.source = 'user'
      and work.audio_release_date is not null
      and work.audio_date_precision = 'day'
      and work.audio_release_date is distinct from probe.auto_release_date
  `);
  // The owner's date always outranks the merger; other confirmed dates only restore a column the
  // merger left empty.
  await tx.execute(sql`
    update ${schema.authorCatalogWorks} as work
    set audio_release_date = probe.release_date,
      audio_date_precision = probe.date_precision
    from ${schema.authorCatalogWorkReleases} as probe
    where probe.work_id = work.id
      and work.monitor_author_id = ${monitorId}
      and (work.audio_release_date is null or probe.source = 'user')
      and probe.format = 'audiobook'
      and probe.status = 'dated'
      and not (work.owned_formats @> '["audiobook"]'::jsonb)
  `);
}

@Injectable()
export class MonitoredReleaseProbeStore {
  private readonly logger = new Logger(MonitoredReleaseProbeStore.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Enrolment itself has to be conservative: the date columns a work arrives with are inherited from
   * a book-level date that says nothing about this format, so the hint is moved into the pending row
   * and the columns are cleared in the same transaction. A Hardcover pass that then fails, or a
   * monitor with more pending works than one refresh pass probes, can no longer leave a fabricated
   * date in front of the release watcher and auto-request.
   */
  async enrol(monitor: { id: string; ownerUserId: number }, today: string): Promise<number> {
    return this.db.transaction((tx) => enrolReleaseProbes(tx, monitor.id, today));
  }

  async clearAll(db?: Pick<Db, 'execute' | 'delete'>): Promise<number> {
    if (!db) return this.db.transaction((tx) => this.clearAll(tx));
    await db.execute(sql`
      update ${schema.authorCatalogWorks} as work
      set ebook_release_date = case when probe.source = 'user' then null else probe.release_date end,
        ebook_date_precision = case when probe.source = 'user' then null else probe.date_precision end
      from ${schema.authorCatalogWorkReleases} as probe
      where probe.work_id = work.id
        and probe.format = 'ebook'
        and (probe.source = 'user' or (probe.source is distinct from 'user' and probe.release_date is not null))
        and not (work.owned_formats @> '["ebook"]'::jsonb)
    `);
    await db.execute(sql`
      update ${schema.authorCatalogWorks} as work
      set audio_release_date = case when probe.source = 'user' then null else probe.release_date end,
        audio_date_precision = case when probe.source = 'user' then null else probe.date_precision end
      from ${schema.authorCatalogWorkReleases} as probe
      where probe.work_id = work.id
        and probe.format = 'audiobook'
        and (probe.source = 'user' or (probe.source is distinct from 'user' and probe.release_date is not null))
        and not (work.owned_formats @> '["audiobook"]'::jsonb)
    `);
    const result = await db.delete(schema.authorCatalogWorkReleases);
    return result.rowCount ?? 0;
  }

  async prune(monitorId: string): Promise<void> {
    await this.db.execute(sql`
      delete from ${schema.authorCatalogWorkReleases} as probe
      where probe.monitor_author_id = ${monitorId}
        and probe.format in ('ebook', 'audiobook')
        and (
          not exists (
            select 1 from ${schema.authorCatalogWorks} as work
            where work.id = probe.work_id
              and work.monitor_author_id = ${monitorId}
          )
          or exists (
            select 1 from ${schema.authorCatalogWorks} as work
            where work.id = probe.work_id
              and work.monitor_author_id = ${monitorId}
              and work.owned_formats @> jsonb_build_array(probe.format)
          )
        )
    `);
  }

  async findDueWorks(now: Date, limit: number): Promise<ReleaseProbeWork[]> {
    const active = activeWorkCondition(visibleWorkCondition());
    const refs = await this.db.execute(sql`
      with due_works as (
        select ${schema.authorCatalogWorkReleases.workId} as work_id,
          ${schema.monitoredAuthors.ownerUserId} as owner_user_id,
          min(${schema.authorCatalogWorkReleases.nextCheckAt}) as next_check_at
        from ${schema.authorCatalogWorkReleases}
        inner join ${schema.authorCatalogWorks}
          on ${schema.authorCatalogWorks.id} = ${schema.authorCatalogWorkReleases.workId}
        inner join ${schema.monitoredAuthors}
          on ${schema.monitoredAuthors.id} = ${schema.authorCatalogWorkReleases.monitorAuthorId}
        left join ${schema.monitoredAuthorWorks}
          on ${schema.monitoredAuthorWorks.workId} = ${schema.authorCatalogWorks.id}
        where ${schema.authorCatalogWorkReleases.format} in ('ebook', 'audiobook')
          and ${schema.authorCatalogWorkReleases.nextCheckAt} <= ${now}
          and ${active}
        group by ${schema.authorCatalogWorkReleases.workId}, ${schema.monitoredAuthors.ownerUserId}
      ), ranked as (
        select work_id,
          next_check_at,
          row_number() over (partition by owner_user_id order by next_check_at, work_id) as owner_rank
        from due_works
      )
      select work_id as "workId"
      from ranked
      order by owner_rank, next_check_at, work_id
      limit ${limit}
    `);
    return this.loadWorks((refs.rows as Array<{ workId: string }>).map((row) => row.workId));
  }

  async findPendingWorksForMonitor(monitorId: string, limit: number): Promise<ReleaseProbeWork[]> {
    const active = activeWorkCondition(visibleWorkCondition());
    const refs = await this.db
      .select({ workId: schema.authorCatalogWorkReleases.workId })
      .from(schema.authorCatalogWorkReleases)
      .innerJoin(schema.authorCatalogWorks, eq(schema.authorCatalogWorks.id, schema.authorCatalogWorkReleases.workId))
      .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorkReleases.monitorAuthorId))
      .leftJoin(schema.monitoredAuthorWorks, eq(schema.monitoredAuthorWorks.workId, schema.authorCatalogWorks.id))
      .where(
        and(
          eq(schema.authorCatalogWorkReleases.monitorAuthorId, monitorId),
          inArray(schema.authorCatalogWorkReleases.format, FORMATS),
          eq(schema.authorCatalogWorkReleases.status, 'pending'),
          active,
        ),
      )
      .orderBy(asc(schema.authorCatalogWorkReleases.nextCheckAt), asc(schema.authorCatalogWorkReleases.workId))
      .limit(limit * FORMATS_PER_WORK);
    return this.loadWorks(
      firstDistinct(
        refs.map((row) => row.workId),
        limit,
      ),
    );
  }

  async saveOutcome(
    work: ReleaseProbeWorkRef,
    outcome: ReleaseProbeOutcome,
    now: Date,
    snapshot?: ProbeSnapshot,
  ): Promise<SaveReleaseProbeOutcomeResult> {
    const startedAt = Date.now();
    return this.db.transaction(async (tx) => {
      const currentRows = await this.lockOutcomeRows(tx, work.id);
      const changed = new Set(findChangedProbeFormats(snapshot, outcome, currentRows));
      this.logChangedFormats(work.id, changed, startedAt);
      const effectiveOutcome = Object.fromEntries(
        (Object.entries(outcome) as Array<[MonitoredFormat, ReleaseProbeOutcome[MonitoredFormat]]>).filter(([format]) => !changed.has(format)),
      ) as ReleaseProbeOutcome;
      await this.writeOutcomeRows(tx, work, effectiveOutcome, now);
      await this.overlayCatalogColumns(tx, work.id, effectiveOutcome);
      const ledgerResets = await this.resetReleaseLedger(tx, work.id, effectiveOutcome, now);
      return {
        ledgerResets,
        appliedFormats: FORMATS.filter((format) => format in effectiveOutcome),
        skippedFormats: FORMATS.filter((format) => changed.has(format)),
      };
    });
  }

  private async lockOutcomeRows(tx: ReleaseTransaction, workId: string): Promise<LockedProbeRow[]> {
    await tx.execute(
      sql`select ${schema.authorCatalogWorks.id} from ${schema.authorCatalogWorks} where ${schema.authorCatalogWorks.id} = ${workId} for update`,
    );
    const lockedRows = await tx.execute(sql`
      select ${schema.authorCatalogWorkReleases.format} as format,
        ${schema.authorCatalogWorkReleases.status} as status,
        ${schema.authorCatalogWorkReleases.releaseDate} as "releaseDate",
        ${schema.authorCatalogWorkReleases.source} as source,
        ${schema.authorCatalogWorkReleases.autoReleaseDate} as "autoReleaseDate"
      from ${schema.authorCatalogWorkReleases}
      where ${schema.authorCatalogWorkReleases.workId} = ${workId}
        and ${schema.authorCatalogWorkReleases.format} in ('ebook', 'audiobook')
      for update
    `);
    return lockedRows.rows as unknown as LockedProbeRow[];
  }

  private logChangedFormats(workId: string, changed: ReadonlySet<MonitoredFormat>, startedAt: number): void {
    for (const format of changed) {
      this.logger.log(
        `[monitored.release_probe.save] [end] workId="${sanitizeLogValue(workId)}" format=${format} durationMs=${Date.now() - startedAt} skipped=true - row changed during the check`,
      );
    }
  }

  private async writeOutcomeRows(tx: ReleaseTransaction, work: ReleaseProbeWorkRef, outcome: ReleaseProbeOutcome, now: Date): Promise<void> {
    const entries = (Object.entries(outcome) as Array<[MonitoredFormat, ReleaseProbeOutcome[MonitoredFormat]]>).filter(
      (entry): entry is OutcomeEntry => entry[1] !== null,
    );
    const removed = (Object.entries(outcome) as Array<[MonitoredFormat, ReleaseProbeOutcome[MonitoredFormat]]>)
      .filter(([, value]) => value === null)
      .map(([format]) => format);
    if (removed.length) {
      await tx
        .delete(schema.authorCatalogWorkReleases)
        .where(and(eq(schema.authorCatalogWorkReleases.workId, work.id), inArray(schema.authorCatalogWorkReleases.format, removed)));
    }
    if (!entries.length) return;
    // Only a date the owner set arrives here as a `user` decision that replaces a row: every
    // stored user row is restated, and so travels the reschedule path instead.
    const replacements = entries.filter(([, value]) => !value.rescheduleOnly && value.decision.source !== 'user');
    const userDates = entries.filter(([, value]) => !value.rescheduleOnly && value.decision.source === 'user');
    const reschedules = entries.filter(([, value]) => value.rescheduleOnly);
    await this.rescheduleOutcomeRows(tx, work.id, reschedules, now);
    await this.upsertOutcomeRows(tx, work, replacements, now, false);
    await this.upsertOutcomeRows(tx, work, userDates, now, true);
  }

  private async rescheduleOutcomeRows(tx: ReleaseTransaction, workId: string, entries: OutcomeEntry[], now: Date): Promise<void> {
    for (const [format, value] of entries) {
      await tx
        .update(schema.authorCatalogWorkReleases)
        .set({
          nextCheckAt: value.nextCheckAt,
          attempts: 0,
          lastErrorClass: null,
          ...(value.decision.source === 'user' ? { checkedAt: now } : {}),
        })
        .where(and(eq(schema.authorCatalogWorkReleases.workId, workId), eq(schema.authorCatalogWorkReleases.format, format)));
      if (value.suggested) await this.saveSuggestion(tx, workId, format, value.suggested, now);
    }
  }

  private async upsertOutcomeRows(
    tx: ReleaseTransaction,
    work: ReleaseProbeWorkRef,
    entries: OutcomeEntry[],
    now: Date,
    userDates: boolean,
  ): Promise<void> {
    if (!entries.length) return;
    const replacedColumns = {
      status: sql`excluded.status`,
      releaseDate: sql`excluded.release_date`,
      datePrecision: sql`excluded.date_precision`,
      source: sql`excluded.source`,
      asin: sql`excluded.asin`,
      checkedAt: sql`excluded.checked_at`,
      nextCheckAt: sql`excluded.next_check_at`,
      attempts: 0,
      lastErrorClass: null,
    };
    await tx
      .insert(schema.authorCatalogWorkReleases)
      .values(
        entries.map(([format, value]) => ({
          workId: work.id,
          monitorAuthorId: work.monitorAuthorId,
          ownerUserId: work.ownerUserId,
          format,
          status: value.decision.status,
          releaseDate: value.decision.releaseDate,
          datePrecision: value.decision.precision,
          source: value.decision.source,
          asin: value.decision.asin,
          checkedAt: now,
          nextCheckAt: value.nextCheckAt,
          attempts: 0,
          lastErrorClass: null,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.authorCatalogWorkReleases.workId, schema.authorCatalogWorkReleases.format],
        set: userDates
          ? {
              ...replacedColumns,
              autoReleaseDate: userDateBaseline(schema.authorCatalogWorkReleases.autoReleaseDate, schema.authorCatalogWorkReleases.releaseDate),
              autoDatePrecision: userDateBaseline(schema.authorCatalogWorkReleases.autoDatePrecision, schema.authorCatalogWorkReleases.datePrecision),
              autoSource: userDateBaseline(schema.authorCatalogWorkReleases.autoSource, schema.authorCatalogWorkReleases.source),
              // Choosing a date, even the same one again, is the owner acknowledging whatever the
              // automatic check had found.
              autoChangedAt: null,
            }
          : replacedColumns,
      });
  }

  private async overlayCatalogColumns(tx: ReleaseTransaction, workId: string, outcome: ReleaseProbeOutcome): Promise<void> {
    for (const format of FORMATS) {
      const value = outcome[format];
      if (!value || value.decision.overlay === 'none') continue;
      const releaseDate = value.decision.overlay === 'set' ? value.decision.releaseDate : null;
      const datePrecision = value.decision.overlay === 'set' ? value.decision.precision : null;
      await tx
        .update(schema.authorCatalogWorks)
        .set(catalogColumns(format, releaseDate, datePrecision).set)
        .where(
          and(eq(schema.authorCatalogWorks.id, workId), sql`not (${schema.authorCatalogWorks.ownedFormats} @> ${JSON.stringify([format])}::jsonb)`),
        );
    }
  }

  private async resetReleaseLedger(tx: ReleaseTransaction, workId: string, outcome: ReleaseProbeOutcome, now: Date): Promise<number> {
    let ledgerResets = 0;
    for (const format of FORMATS) {
      const value = outcome[format];
      if (value?.rescheduleOnly) continue;
      const decision = value?.decision;
      if (decision?.status !== 'dated' || !decision.releaseDate) continue;
      const range = releaseDateRange(decision.releaseDate, decision.precision);
      if (!range) continue;
      if (decision.source === 'user' && range.start <= now.toISOString().slice(0, 10)) continue;
      // A format announced off a fabricated date has to be announceable again once the real date
      // is confirmed, including when that confirmation lands on or after release day. The
      // tolerance keeps a small correction of a true announcement from notifying twice.
      const result = await tx
        .delete(schema.monitoredReleaseEvents)
        .where(
          and(
            eq(schema.monitoredReleaseEvents.workId, workId),
            eq(schema.monitoredReleaseEvents.format, format),
            sql`${schema.monitoredReleaseEvents.releaseDate} < ${staleLedgerDay(range.start)}`,
          ),
        );
      ledgerResets += result.rowCount ?? 0;
    }
    return ledgerResets;
  }

  /**
   * A suggestion is only news while it is new: re-seeing the same automatic date leaves the stamp
   * where it is, so an alert the owner has not acted on keeps the moment the probe first saw it.
   */
  private async saveSuggestion(
    tx: ReleaseTransaction,
    workId: string,
    format: MonitoredFormat,
    suggested: ProbeSuggestion,
    now: Date,
  ): Promise<void> {
    await tx
      .update(schema.authorCatalogWorkReleases)
      .set({
        autoReleaseDate: suggested.releaseDate,
        autoDatePrecision: suggested.precision,
        autoSource: suggested.source,
        autoChangedAt: now,
      })
      .where(
        and(
          eq(schema.authorCatalogWorkReleases.workId, workId),
          eq(schema.authorCatalogWorkReleases.format, format),
          eq(schema.authorCatalogWorkReleases.source, 'user'),
          sql`${schema.authorCatalogWorkReleases.autoReleaseDate} is distinct from ${suggested.releaseDate}`,
        ),
      );
  }

  async recordFailure(workIds: string[], errorClass: string, now: Date): Promise<void> {
    if (!workIds.length) return;
    const rows = await this.db
      .select({
        workId: schema.authorCatalogWorkReleases.workId,
        format: schema.authorCatalogWorkReleases.format,
        attempts: schema.authorCatalogWorkReleases.attempts,
      })
      .from(schema.authorCatalogWorkReleases)
      .where(and(inArray(schema.authorCatalogWorkReleases.workId, workIds), inArray(schema.authorCatalogWorkReleases.format, FORMATS)));
    if (!rows.length) return;
    const nextCases = rows.map(
      (row) =>
        sql`when ${schema.authorCatalogWorkReleases.workId} = ${row.workId} and ${schema.authorCatalogWorkReleases.format} = ${row.format} then ${nextProbeCheckAt(
          now,
          {
            status: 'pending',
            releaseDate: null,
            precision: null,
            source: null,
            siblingDates: [],
            failed: true,
            attempts: row.attempts + 1,
          },
        )}`,
    );
    await this.db
      .update(schema.authorCatalogWorkReleases)
      .set({
        attempts: sql`${schema.authorCatalogWorkReleases.attempts} + 1`,
        lastErrorClass: errorClass,
        nextCheckAt: sql`case ${sql.join(nextCases, sql` `)} else ${schema.authorCatalogWorkReleases.nextCheckAt} end`,
      })
      .where(and(inArray(schema.authorCatalogWorkReleases.workId, workIds), inArray(schema.authorCatalogWorkReleases.format, FORMATS)));
  }

  /** One work with whatever probe rows it already has, for an on-demand refresh of that work alone. */
  async findWork(workId: string): Promise<ReleaseProbeWork | null> {
    const [work] = await this.loadWorks([workId]);
    return work ?? null;
  }

  /**
   * Hands one format back to the probe: the row becomes pending and due now, and the column it was
   * overlaying is emptied. Only a row the owner set is theirs to clear, so the source is part of the
   * predicate rather than a read before the write.
   */
  async clearUserReleaseDate(workId: string, format: MonitoredFormat, now: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${schema.authorCatalogWorks.id} from ${schema.authorCatalogWorks} where ${schema.authorCatalogWorks.id} = ${workId} for update`,
      );
      const result = await tx
        .update(schema.authorCatalogWorkReleases)
        .set({
          status: 'pending',
          releaseDate: null,
          datePrecision: null,
          source: null,
          asin: null,
          autoReleaseDate: null,
          autoDatePrecision: null,
          autoSource: null,
          autoChangedAt: null,
          checkedAt: null,
          nextCheckAt: now,
          attempts: 0,
          lastErrorClass: null,
        })
        .where(
          and(
            eq(schema.authorCatalogWorkReleases.workId, workId),
            eq(schema.authorCatalogWorkReleases.format, format),
            eq(schema.authorCatalogWorkReleases.source, 'user'),
          ),
        );
      if (!result.rowCount) return false;
      await tx
        .update(schema.authorCatalogWorks)
        .set(catalogColumns(format).set)
        .where(
          and(eq(schema.authorCatalogWorks.id, workId), sql`not (${schema.authorCatalogWorks.ownedFormats} @> ${JSON.stringify([format])}::jsonb)`),
        );
      return true;
    });
  }

  async findForWorks(workIds: string[]): Promise<ReleaseProbeRow[]> {
    if (!workIds.length) return [];
    return this.db.select().from(schema.authorCatalogWorkReleases).where(inArray(schema.authorCatalogWorkReleases.workId, workIds));
  }

  // A paused monitor is excluded by whichever query chose these ids; an id asked for by name, as an
  // on-demand refresh does, is the owner overriding that pause for one work.
  private async loadWorks(workIds: string[]): Promise<ReleaseProbeWork[]> {
    if (!workIds.length) return [];
    const hardcoverSource = alias(schema.authorCatalogSourceWorks, 'hardcover_source');
    const audibleSource = alias(schema.authorCatalogSourceWorks, 'audible_source');
    const [works, releases] = await Promise.all([
      this.db
        .select({
          id: schema.authorCatalogWorks.id,
          monitorAuthorId: schema.authorCatalogWorks.monitorAuthorId,
          ownerUserId: schema.monitoredAuthors.ownerUserId,
          authorName: schema.monitoredAuthors.authorName,
          title: schema.authorCatalogWorks.title,
          ebookReleaseDate: schema.authorCatalogWorks.ebookReleaseDate,
          ebookDatePrecision: schema.authorCatalogWorks.ebookDatePrecision,
          audioReleaseDate: schema.authorCatalogWorks.audioReleaseDate,
          audioDatePrecision: schema.authorCatalogWorks.audioDatePrecision,
          sources: schema.authorCatalogWorks.sources,
          ownedFormats: schema.authorCatalogWorks.ownedFormats,
          hardcoverSlug: hardcoverSource.providerWorkId,
          audibleAsin: audibleSource.providerWorkId,
        })
        .from(schema.authorCatalogWorks)
        .innerJoin(schema.monitoredAuthors, eq(schema.monitoredAuthors.id, schema.authorCatalogWorks.monitorAuthorId))
        .leftJoin(hardcoverSource, and(eq(hardcoverSource.workId, schema.authorCatalogWorks.id), eq(hardcoverSource.source, 'hardcover')))
        .leftJoin(audibleSource, and(eq(audibleSource.workId, schema.authorCatalogWorks.id), eq(audibleSource.source, 'audible')))
        .where(inArray(schema.authorCatalogWorks.id, workIds)),
      this.findForWorks(workIds),
    ]);
    const rowsByWork = new Map<string, ReleaseProbeRow[]>();
    for (const row of releases) rowsByWork.set(row.workId, [...(rowsByWork.get(row.workId) ?? []), row]);
    const workById = new Map(works.map((work) => [work.id, work]));
    return workIds.flatMap((workId) => {
      const work = workById.get(workId);
      return work ? [{ ...work, releases: rowsByWork.get(work.id) ?? [] }] : [];
    });
  }
}
