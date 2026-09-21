import { Logger } from '@nestjs/common';
import type { MonitoredFormat } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import * as schema from './schema/monitored.schema';

import {
  findChangedProbeFormats,
  MonitoredReleaseProbeStore,
  reapplyReleaseOverlay,
  type ReleaseProbeOutcome,
  type ReleaseProbeWork,
} from './monitored-release-probe-store.service';

function rendered(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

function boundValues(statement: SQL): unknown[] {
  return new PgDialect().sqlToQuery(statement).params;
}

function work(): ReleaseProbeWork {
  return {
    id: 'work-1',
    monitorAuthorId: 'monitor-1',
    ownerUserId: 7,
    authorName: 'Author',
    title: 'Work',
    ebookReleaseDate: '2027-01-10',
    ebookDatePrecision: 'day',
    audioReleaseDate: '2026-09-10',
    audioDatePrecision: 'day',
    sources: ['hardcover', 'audible'],
    ownedFormats: [],
    hardcoverSlug: 'work',
    audibleAsin: 'B000000001',
    releases: [],
  };
}

describe('MonitoredReleaseProbeStore SQL', () => {
  function selectionDb(rows: Array<{ workId: string }> = []) {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'orderBy']) builder[method] = vi.fn(() => builder);
    builder.limit = vi.fn().mockResolvedValue(rows);
    return { select: vi.fn(() => builder), builder };
  }

  it('enrols each digital format with the window, ownership guard and conflict protection', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 2 });
    const db = { transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({ execute })) };
    const store = new MonitoredReleaseProbeStore(db as never);

    await expect(store.enrol({ id: 'monitor-1', ownerUserId: 7 }, '2026-09-18')).resolves.toBe(4);

    expect(execute).toHaveBeenCalledTimes(4);
    const queries = execute.mock.calls.slice(0, 2).map(([statement]) => rendered(statement as SQL));
    for (const query of queries) {
      expect(query).toContain('insert into "author_catalog_work_releases"');
      expect(query).toContain('left join "monitored_author_works"');
      expect(query).toContain('"author_catalog_works"."owned_formats" @>');
      expect(query).toContain('on conflict (work_id, format) do nothing');
      expect(query).toContain('"author_catalog_works"."release_year" >=');
      expect(query).toContain('"author_catalog_works"."ebook_release_date"');
      expect(query).toContain('"author_catalog_works"."audio_release_date"');
    }
  });

  it('parks the inherited hint on the pending row and clears the fabricated columns in one transaction', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 1 });
    const db = { transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({ execute })) };
    const store = new MonitoredReleaseProbeStore(db as never);

    await store.enrol({ id: 'monitor-1', ownerUserId: 7 }, '2026-09-18');

    expect(db.transaction).toHaveBeenCalledOnce();
    const [ebookInsert, audioInsert, ebookClear, audioClear] = execute.mock.calls.map(([statement]) => rendered(statement as SQL));
    expect(ebookInsert).toContain('release_date, date_precision');
    expect(ebookInsert).toContain(`'pending', "author_catalog_works"."ebook_release_date", "author_catalog_works"."ebook_date_precision"`);
    expect(audioInsert).toContain(
      `case when "author_catalog_works"."audio_date_precision" is distinct from 'day' then "author_catalog_works"."audio_release_date" end`,
    );
    expect(ebookClear).toContain('set ebook_release_date = null');
    expect(ebookClear).toContain("probe.status = 'pending'");
    expect(ebookClear).toContain('not (work.owned_formats @>');
    expect(audioClear).toContain('set audio_release_date = null');
    expect(audioClear).toContain("work.audio_date_precision is distinct from 'day'");
    expect(audioClear).toContain('not (work.owned_formats @>');
  });

  it('removes every probe row through the supplied transaction when the feature is switched off', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 3 });
    const del = vi.fn().mockResolvedValue({ rowCount: 12 });
    const ownDelete = vi.fn();
    const store = new MonitoredReleaseProbeStore({ delete: ownDelete, execute: vi.fn() } as never);

    await expect(store.clearAll({ delete: del, execute } as never)).resolves.toBe(12);

    expect(execute).toHaveBeenCalledTimes(2);
    const [ebook, audiobook] = execute.mock.calls.map(([statement]) => rendered(statement as SQL));
    expect(ebook).toContain("set ebook_release_date = case when probe.source = 'user' then null else probe.release_date end");
    expect(ebook).toContain("probe.source is distinct from 'user' and probe.release_date is not null");
    expect(ebook).toContain('not (work.owned_formats @>');
    expect(audiobook).toContain("set audio_release_date = case when probe.source = 'user' then null else probe.release_date end");
    expect(audiobook).toContain('not (work.owned_formats @>');
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(del.mock.invocationCallOrder[0]!);
    expect(del).toHaveBeenCalledWith(schema.authorCatalogWorkReleases);
    expect(ownDelete).not.toHaveBeenCalled();
  });

  it('opens one transaction for restore and delete when no transaction is supplied', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 1 });
    const del = vi.fn().mockResolvedValue({ rowCount: 2 });
    const tx = { execute, delete: del };
    const transaction = vi.fn((run: (value: typeof tx) => unknown) => run(tx));
    const store = new MonitoredReleaseProbeStore({ transaction } as never);

    await expect(store.clearAll()).resolves.toBe(2);

    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledOnce();
  });

  it('keeps protection rows for hidden and out-of-window works while pruning missing and owned formats', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 0 });
    const store = new MonitoredReleaseProbeStore({ execute } as never);

    await store.prune('monitor-1');

    expect(execute).toHaveBeenCalledOnce();
    const digital = rendered(execute.mock.calls[0]?.[0] as SQL);
    expect(digital).toContain("probe.format in ('ebook', 'audiobook')");
    expect(digital).toContain('jsonb_build_array(probe.format)');
    expect(digital).toContain('probe.monitor_author_id =');
    expect(digital).toContain('not exists');
    expect(digital).toContain('or exists');
    expect(digital).not.toContain('monitored_author_works');
    expect(digital).not.toContain('ebook_release_date');
    expect(digital).not.toContain('probe.status');
    expect(digital).not.toContain('print');
  });

  it('reapplies hints, ebook decisions and null-only audio decisions with set-based updates', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 0 });

    await reapplyReleaseOverlay({ execute } as never, 'monitor-1');

    expect(execute).toHaveBeenCalledTimes(7);
    const statements = execute.mock.calls.map(([statement]) => rendered(statement as SQL));
    expect(statements[0]).toContain("set status = case when probe.status = 'pending' then 'pending' else 'expected' end");
    expect(statements[0]).toContain("probe.format = 'ebook'");
    expect(statements[0]).toContain("probe.status in ('pending', 'expected', 'unlisted')");
    expect(statements[0]).toContain('probe.source is null');
    expect(statements[0]).not.toContain("probe.format = 'audiobook'");
    expect(statements[1]).toContain("set status = case when probe.status = 'pending' then 'pending' else 'expected' end");
    expect(statements[1]).toContain("probe.format = 'audiobook'");
    expect(statements[1]).toContain('probe.source is null');
    expect(statements[1]).toContain("work.audio_date_precision is distinct from 'day'");
    expect(statements[2]).toContain("set status = 'dated'");
    expect(statements[2]).toContain("source = 'audible'");
    expect(statements[2]).toContain("probe.format = 'audiobook'");
    expect(statements[2]).toContain('work.audio_release_date is not null');
    expect(statements[2]).toContain("work.audio_date_precision = 'day'");
    expect(statements[2]).toContain('asin = null');
    expect(statements[2]).toContain('next_check_at = case');
    expect(statements[2]).toContain('work.audio_release_date is distinct from probe.release_date then now()');
    expect(statements[2]).toContain('else probe.next_check_at');
    expect(statements[3]).toContain("probe.format = 'ebook'");
    expect(statements[3]).toContain("probe.status in ('pending', 'dated', 'expected', 'unlisted')");
    expect(statements[3]).toContain('not (work.owned_formats @>');
    expect(statements[4]).toContain('set audio_release_date = null');
    expect(statements[4]).toContain("probe.status in ('pending', 'expected', 'unlisted')");
    expect(statements[4]).toContain("probe.source is distinct from 'user'");
    expect(statements[4]).toContain("work.audio_date_precision is distinct from 'day'");
    expect(statements[4]).toContain('not (work.owned_formats @>');
    expect(statements[6]).toContain('work.audio_release_date is null');
    expect(statements[6]).not.toContain("probe.source <> 'audible'");
    expect(statements[6]).toContain('not (work.owned_formats @>');
  });

  it('leaves a row the owner dated out of every step that would restate it', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 0 });

    await reapplyReleaseOverlay({ execute } as never, 'monitor-1');

    const statements = execute.mock.calls.map(([statement]) => rendered(statement as SQL));
    // Both hint captures are already source-scoped, and the Audible stamp has to name the exception.
    expect(statements[0]).toContain('probe.source is null');
    expect(statements[1]).toContain('probe.source is null');
    expect(statements[2]).toContain("probe.source is distinct from 'user'");
    expect(statements[4]).toContain("probe.source is distinct from 'user'");
  });

  it('writes the audio column from a user row even when the merger just wrote an Audible date', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 0 });

    await reapplyReleaseOverlay({ execute } as never, 'monitor-1');

    const statements = execute.mock.calls.map(([statement]) => rendered(statement as SQL));
    expect(statements[6]).toContain("(work.audio_release_date is null or probe.source = 'user')");
  });

  it('captures the merged Audible date as a suggestion before the owner date is restored over it', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 0 });

    await reapplyReleaseOverlay({ execute } as never, 'monitor-1');

    const statements = execute.mock.calls.map(([statement]) => rendered(statement as SQL));
    const suggestion = statements[5]!;
    expect(suggestion).toContain('update "author_catalog_work_releases" as probe');
    expect(suggestion).toContain('set auto_release_date = work.audio_release_date');
    expect(suggestion).toContain('auto_date_precision = work.audio_date_precision');
    expect(suggestion).toContain("auto_source = 'audible'");
    expect(suggestion).toContain('auto_changed_at = now()');
    expect(suggestion).toContain('work.monitor_author_id =');
    expect(suggestion).toContain("probe.format = 'audiobook'");
    expect(suggestion).toContain("probe.source = 'user'");
    expect(suggestion).toContain("work.audio_date_precision = 'day'");
    expect(suggestion).toContain('work.audio_release_date is distinct from probe.auto_release_date');
    // The restore below it puts the owner's date back into the column this statement just read.
    expect(statements[6]).toContain('set audio_release_date = probe.release_date');
  });

  it('selects due works round-robin across owners after de-duplication and active-work filtering', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const store = new MonitoredReleaseProbeStore({ execute } as never);

    await store.findDueWorks(new Date('2026-09-18T00:00:00.000Z'), 40);

    const query = rendered(execute.mock.calls[0]?.[0] as SQL);
    expect(query).toContain('left join "monitored_author_works"');
    expect(query).toContain('row_number() over (partition by owner_user_id order by next_check_at, work_id)');
    expect(query).toContain('group by "author_catalog_work_releases"."work_id", "monitored_authors"."owner_user_id"');
    expect(query).toContain('order by owner_rank, next_check_at, work_id');
    expect(query).toContain('limit $');
    expect(query).toContain('monitor_state');
    expect(query).toContain('user_visibility');
  });

  it('loads the bounded work ids returned by the round-robin query', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ workId: 'work-2' }, { workId: 'work-1' }] });
    const store = new MonitoredReleaseProbeStore({ execute } as never);
    const loadWorks = vi
      .spyOn(store as unknown as { loadWorks: (workIds: string[]) => Promise<ReleaseProbeWork[]> }, 'loadWorks')
      .mockResolvedValue([]);

    await store.findDueWorks(new Date('2026-09-18T00:00:00.000Z'), 2);

    expect(loadWorks).toHaveBeenCalledWith(['work-2', 'work-1']);
  });

  it('joins live works before selecting pending monitor work', async () => {
    const tracked = selectionDb();
    const store = new MonitoredReleaseProbeStore(tracked as never);

    await store.findPendingWorksForMonitor('monitor-1', 50);

    expect(tracked.builder.groupBy).not.toHaveBeenCalled();
    expect(tracked.builder.limit).toHaveBeenCalledWith(100);
    expect(tracked.builder.innerJoin.mock.calls[0]?.[0]).toBe(schema.authorCatalogWorks);
    expect(tracked.builder.leftJoin.mock.calls[0]?.[0]).toBe(schema.monitoredAuthorWorks);
    const condition = tracked.builder.where.mock.calls[0]?.[0] as SQL;
    expect(rendered(condition)).toContain('monitor_state');
    expect(rendered(condition)).toContain('user_visibility');
  });

  it('updates failure backoff without changing status and stays bounded by work id', async () => {
    const rows = [{ workId: 'work-1', format: 'ebook', attempts: 2 }];
    const selectBuilder: Record<string, ReturnType<typeof vi.fn>> = {};
    selectBuilder.from = vi.fn(() => selectBuilder);
    selectBuilder.where = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockResolvedValue({ rowCount: 1 });
    const set = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => selectBuilder), update: vi.fn(() => ({ set })) };
    const store = new MonitoredReleaseProbeStore(db as never);

    await store.recordFailure(['work-1'], 'TypeError', new Date('2026-09-18T00:00:00.000Z'));

    const values = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values).not.toHaveProperty('status');
    expect(values.lastErrorClass).toBe('TypeError');
    expect(rendered(values.nextCheckAt as SQL)).toContain('case when');
    expect(where).toHaveBeenCalledOnce();
  });
});

describe('findChangedProbeFormats', () => {
  const pending = { status: 'pending' as const, releaseDate: null, source: null, autoReleaseDate: null };
  const currentPending = { format: 'ebook' as const, ...pending };
  const cases: Array<{
    name: string;
    snapshot: Parameters<typeof findChangedProbeFormats>[0];
    outcome: ReleaseProbeOutcome;
    currentRows: Parameters<typeof findChangedProbeFormats>[2];
    expected: MonitoredFormat[];
  }> = [
    { name: 'has no snapshot', snapshot: undefined, outcome: { ebook: null }, currentRows: [], expected: [] },
    {
      name: 'matches the locked row',
      snapshot: { ebook: pending, audiobook: null },
      outcome: { ebook: null },
      currentRows: [currentPending],
      expected: [],
    },
    {
      name: 'lost a snapshotted row',
      snapshot: { ebook: pending, audiobook: null },
      outcome: { ebook: null },
      currentRows: [],
      expected: ['ebook'],
    },
    {
      name: 'gained a row after the snapshot',
      snapshot: { ebook: null, audiobook: null },
      outcome: { ebook: null },
      currentRows: [currentPending],
      expected: ['ebook'],
    },
    {
      name: 'changed a tracked field',
      snapshot: { ebook: pending, audiobook: null },
      outcome: { ebook: null },
      currentRows: [{ ...currentPending, autoReleaseDate: '2027-01-10' }],
      expected: ['ebook'],
    },
    {
      name: 'changed a format absent from the outcome',
      snapshot: { ebook: pending, audiobook: null },
      outcome: { audiobook: null },
      currentRows: [],
      expected: [],
    },
  ];

  it.each(cases)('$name', ({ snapshot, outcome, currentRows, expected }) => {
    expect(findChangedProbeFormats(snapshot, outcome, currentRows)).toEqual(expected);
  });
});

describe('MonitoredReleaseProbeStore outcomes', () => {
  function outcomeDb(ledgerRows = 0, lockedRows: Array<Record<string, unknown>> = []) {
    const deleteWhere = vi.fn().mockResolvedValue({ rowCount: ledgerRows });
    const deleteFn = vi.fn(() => ({ where: deleteWhere }));
    const onConflictDoUpdate = vi.fn().mockResolvedValue({ rowCount: 1 });
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const updateWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));
    const execute = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: lockedRows });
    const tx = { delete: deleteFn, insert, update, execute };
    const db = { transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)) };
    return { db, deleteFn, deleteWhere, values, set, updateWhere, onConflictDoUpdate, execute };
  }

  function conflictSet(onConflictDoUpdate: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
    return (onConflictDoUpdate.mock.calls[call]?.[0] as { set: Record<string, unknown> }).set;
  }

  it('sets both confirmed overlays and resets older ledger rows', async () => {
    const mocks = outcomeDb(2);
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      ebook: {
        decision: {
          status: 'dated',
          releaseDate: '2027-01-10',
          precision: 'day',
          source: 'apple',
          asin: null,
          overlay: 'set',
        },
        nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
      },
      audiobook: {
        decision: {
          status: 'dated',
          releaseDate: '2027-02-10',
          precision: 'day',
          source: 'audible',
          asin: null,
          overlay: 'set',
        },
        nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
      },
    };

    await expect(store.saveOutcome(work(), outcome, new Date('2026-09-18T00:00:00.000Z'))).resolves.toEqual({
      ledgerResets: 4,
      appliedFormats: ['ebook', 'audiobook'],
      skippedFormats: [],
    });

    expect(mocks.set).toHaveBeenCalledTimes(2);
    expect(mocks.set).toHaveBeenCalledWith({ ebookReleaseDate: '2027-01-10', ebookDatePrecision: 'day' });
    expect(mocks.set).toHaveBeenCalledWith({ audioReleaseDate: '2027-02-10', audioDatePrecision: 'day' });
    expect(mocks.updateWhere.mock.calls.map(([statement]) => rendered(statement as SQL)).every((query) => query.includes('owned_formats'))).toBe(
      true,
    );
    expect(mocks.deleteFn).toHaveBeenCalledTimes(2);
  });

  it('reschedules kept evidence without replacing it or resetting its ledger', async () => {
    const mocks = outcomeDb();
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      audiobook: {
        decision: { status: 'dated', releaseDate: '2027-02-10', precision: 'day', source: 'audible', asin: null, overlay: 'set' },
        nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
        rescheduleOnly: true,
      },
    };

    await store.saveOutcome(work(), outcome, new Date('2026-09-18T00:00:00.000Z'));

    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenNthCalledWith(1, {
      nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
      attempts: 0,
      lastErrorClass: null,
    });
    expect(mocks.set).toHaveBeenNthCalledWith(2, { audioReleaseDate: '2027-02-10', audioDatePrecision: 'day' });
    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });

  it('resets a ledger row announced before a confirmed date that has already passed', async () => {
    const mocks = outcomeDb(1);
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      ebook: {
        decision: { status: 'dated', releaseDate: '2026-09-01', precision: 'day', source: 'amazon', asin: 'B012345678', overlay: 'set' },
        nextCheckAt: new Date('2026-09-19T00:00:00.000Z'),
      },
    };

    await expect(store.saveOutcome(work(), outcome, new Date('2026-09-18T00:00:00.000Z'))).resolves.toEqual({
      ledgerResets: 1,
      appliedFormats: ['ebook'],
      skippedFormats: [],
    });

    expect(boundValues(mocks.deleteWhere.mock.calls[0]?.[0] as SQL)).toContain('2026-08-18');
  });

  it('never resets the ledger for evidence that is not a confirmed date', async () => {
    const mocks = outcomeDb(0);
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      audiobook: {
        decision: { status: 'expected', releaseDate: '2026-09-20', precision: 'day', source: null, asin: null, overlay: 'clear' },
        nextCheckAt: new Date('2026-09-19T00:00:00.000Z'),
      },
    };

    await store.saveOutcome(work(), outcome, new Date('2026-09-18T00:00:00.000Z'));

    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });

  it('clears a digital overlay and deletes a null outcome row', async () => {
    const mocks = outcomeDb();
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      ebook: {
        decision: { status: 'unlisted', releaseDate: null, precision: null, source: 'amazon_search', asin: null, overlay: 'clear' },
        nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
      },
      audiobook: null,
    };

    await store.saveOutcome(work(), outcome, new Date('2026-09-18T00:00:00.000Z'));

    expect(mocks.set).toHaveBeenCalledWith({ ebookReleaseDate: null, ebookDatePrecision: null });
    expect(mocks.deleteFn).toHaveBeenCalledOnce();
  });

  it('overlays an audiobook date the owner chose, which Audible provenance would otherwise skip', async () => {
    const mocks = outcomeDb();
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      audiobook: {
        decision: { status: 'dated', releaseDate: '2027-02-10', precision: 'day', source: 'user', asin: null, overlay: 'set' },
        nextCheckAt: new Date('2026-10-18T00:00:00.000Z'),
      },
    };

    await store.saveOutcome({ id: 'work-1', monitorAuthorId: 'monitor-1', ownerUserId: 7 }, outcome, new Date('2026-09-18T00:00:00.000Z'));

    expect(mocks.values).toHaveBeenCalledWith([expect.objectContaining({ workId: 'work-1', format: 'audiobook', source: 'user', status: 'dated' })]);
    expect(mocks.set).toHaveBeenCalledWith({ audioReleaseDate: '2027-02-10', audioDatePrecision: 'day' });
    expect(mocks.deleteFn).toHaveBeenCalledOnce();
  });

  it('seeds the baseline from the dated row a user date replaces, keeps it over a user row, and clears the stamp', async () => {
    const mocks = outcomeDb();
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      ebook: {
        decision: { status: 'dated', releaseDate: '2027-02-10', precision: 'day', source: 'user', asin: null, overlay: 'set' },
        nextCheckAt: new Date('2026-09-19T00:00:00.000Z'),
      },
    };

    await store.saveOutcome(work(), outcome, new Date('2026-09-18T00:00:00.000Z'));

    const set = conflictSet(mocks.onConflictDoUpdate);
    expect(set.autoChangedAt).toBeNull();
    const baseline = rendered(set.autoReleaseDate as SQL);
    expect(baseline).toContain(`when "author_catalog_work_releases"."source" = 'user' then "author_catalog_work_releases"."auto_release_date"`);
    expect(baseline).toContain(
      `when "author_catalog_work_releases"."status" = 'dated' and "author_catalog_work_releases"."source" is not null and "author_catalog_work_releases"."release_date" is not null then "author_catalog_work_releases"."release_date"`,
    );
    expect(baseline).toContain('else null');
    expect(rendered(set.autoDatePrecision as SQL)).toContain('is not null then "author_catalog_work_releases"."date_precision"');
    expect(rendered(set.autoSource as SQL)).toContain('is not null then "author_catalog_work_releases"."source"');
  });

  it('leaves the automatic columns out of a probe replacement entirely', async () => {
    const mocks = outcomeDb();
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      ebook: {
        decision: { status: 'dated', releaseDate: '2027-01-10', precision: 'day', source: 'apple', asin: null, overlay: 'set' },
        nextCheckAt: new Date('2026-09-19T00:00:00.000Z'),
      },
    };

    await store.saveOutcome(work(), outcome, new Date('2026-09-18T00:00:00.000Z'));

    expect(Object.keys(conflictSet(mocks.onConflictDoUpdate)).filter((key) => key.startsWith('auto'))).toEqual([]);
    expect(mocks.values).toHaveBeenCalledWith([expect.not.objectContaining({ autoReleaseDate: expect.anything() })]);
  });

  it('stamps a suggestion on the owner row only when its date is new', async () => {
    const mocks = outcomeDb();
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const now = new Date('2026-09-18T00:00:00.000Z');
    const outcome: ReleaseProbeOutcome = {
      audiobook: {
        decision: { status: 'dated', releaseDate: '2027-02-10', precision: 'day', source: 'user', asin: null, overlay: 'set' },
        nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
        rescheduleOnly: true,
        suggested: { releaseDate: '2027-03-15', precision: 'day', source: 'amazon' },
      },
    };

    await store.saveOutcome(work(), outcome, now);

    expect(mocks.set).toHaveBeenNthCalledWith(1, {
      nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
      attempts: 0,
      lastErrorClass: null,
      checkedAt: now,
    });
    expect(mocks.set).toHaveBeenNthCalledWith(2, {
      autoReleaseDate: '2027-03-15',
      autoDatePrecision: 'day',
      autoSource: 'amazon',
      autoChangedAt: now,
    });
    const guard = mocks.updateWhere.mock.calls[1]?.[0] as SQL;
    expect(rendered(guard)).toContain('"source" = ');
    expect(rendered(guard)).toContain('"auto_release_date" is distinct from');
    expect(boundValues(guard)).toContain('2027-03-15');
  });

  it('touches nothing automatic when a reschedule carries no suggestion', async () => {
    const mocks = outcomeDb();
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      audiobook: {
        decision: { status: 'dated', releaseDate: '2027-02-10', precision: 'day', source: 'user', asin: null, overlay: 'set' },
        nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
        rescheduleOnly: true,
      },
    };

    await store.saveOutcome(work(), outcome, new Date('2026-09-18T00:00:00.000Z'));

    expect(mocks.set).toHaveBeenCalledTimes(2);
    expect(mocks.set).toHaveBeenNthCalledWith(1, {
      nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
      attempts: 0,
      lastErrorClass: null,
      checkedAt: new Date('2026-09-18T00:00:00.000Z'),
    });
    expect(mocks.set).toHaveBeenNthCalledWith(2, { audioReleaseDate: '2027-02-10', audioDatePrecision: 'day' });
  });

  it('skips every effect for formats whose locked row differs from the probe snapshot', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const mocks = outcomeDb(1, [
      { format: 'ebook', status: 'dated', releaseDate: '2027-05-05', source: 'user', autoReleaseDate: null },
      { format: 'audiobook', status: 'pending', releaseDate: null, source: null, autoReleaseDate: null },
    ]);
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const outcome: ReleaseProbeOutcome = {
      ebook: {
        decision: { status: 'unlisted', releaseDate: null, precision: null, source: 'amazon_search', asin: null, overlay: 'clear' },
        nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
      },
      audiobook: {
        decision: { status: 'dated', releaseDate: '2027-03-04', precision: 'day', source: 'user', asin: null, overlay: 'set' },
        nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
        rescheduleOnly: true,
      },
    };

    await expect(
      store.saveOutcome(work(), outcome, new Date('2026-09-18T00:00:00.000Z'), {
        ebook: null,
        audiobook: { status: 'dated', releaseDate: '2027-03-04', source: 'user', autoReleaseDate: null },
      }),
    ).resolves.toEqual({ ledgerResets: 0, appliedFormats: [], skippedFormats: ['ebook', 'audiobook'] });

    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.deleteFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_probe\.save\] \[end\] workId="work-1" format=ebook durationMs=\d+ skipped=true - row changed during the check$/,
      ),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_probe\.save\] \[end\] workId="work-1" format=audiobook durationMs=\d+ skipped=true - row changed during the check$/,
      ),
    );
    log.mockRestore();
  });

  it('skips a stale write when only the stored automatic suggestion changed', async () => {
    const mocks = outcomeDb(0, [
      {
        format: 'audiobook',
        status: 'dated',
        releaseDate: '2027-03-04',
        source: 'user',
        autoReleaseDate: '2027-07-15',
      },
    ]);
    const store = new MonitoredReleaseProbeStore(mocks.db as never);

    await expect(
      store.saveOutcome(
        work(),
        {
          audiobook: {
            decision: { status: 'dated', releaseDate: '2027-03-04', precision: 'day', source: 'user', asin: null, overlay: 'set' },
            nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
            rescheduleOnly: true,
            suggested: { releaseDate: '2027-06-01', precision: 'day', source: 'audible' },
          },
        },
        new Date('2026-09-18T00:00:00.000Z'),
        {
          ebook: null,
          audiobook: { status: 'dated', releaseDate: '2027-03-04', source: 'user', autoReleaseDate: '2027-06-01' },
        },
      ),
    ).resolves.toEqual({ ledgerResets: 0, appliedFormats: [], skippedFormats: ['audiobook'] });

    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });

  it('locks the work before its release rows and any writes', async () => {
    const mocks = outcomeDb();
    const store = new MonitoredReleaseProbeStore(mocks.db as never);

    await store.saveOutcome(
      work(),
      {
        ebook: {
          decision: { status: 'unlisted', releaseDate: null, precision: null, source: null, asin: null, overlay: 'clear' },
          nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
        },
      },
      new Date('2026-09-18T00:00:00.000Z'),
    );

    expect(rendered(mocks.execute.mock.calls[0]?.[0] as SQL)).toContain('from "author_catalog_works"');
    expect(rendered(mocks.execute.mock.calls[0]?.[0] as SQL)).toContain('for update');
    expect(rendered(mocks.execute.mock.calls[1]?.[0] as SQL)).toContain('from "author_catalog_work_releases"');
    expect(mocks.execute.mock.invocationCallOrder[1]).toBeLessThan(mocks.values.mock.invocationCallOrder[0]!);
  });

  it('does not reset release history when the owner chooses a date in the past', async () => {
    const mocks = outcomeDb(1);
    const store = new MonitoredReleaseProbeStore(mocks.db as never);

    await expect(
      store.saveOutcome(
        work(),
        {
          ebook: {
            decision: { status: 'dated', releaseDate: '2026-09-01', precision: 'day', source: 'user', asin: null, overlay: 'set' },
            nextCheckAt: new Date('2026-09-19T00:00:00.000Z'),
          },
        },
        new Date('2026-09-18T00:00:00.000Z'),
      ),
    ).resolves.toEqual({ ledgerResets: 0, appliedFormats: ['ebook'], skippedFormats: [] });

    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });
});

describe('MonitoredReleaseProbeStore user dates', () => {
  function clearDb(rowCount: number) {
    const releaseWhere = vi.fn().mockResolvedValue({ rowCount });
    const workWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
    const set = vi
      .fn()
      .mockImplementationOnce(() => ({ where: releaseWhere }))
      .mockImplementationOnce(() => ({ where: workWhere }));
    const update = vi.fn(() => ({ set }));
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      transaction: vi.fn((callback: (tx: { update: typeof update; execute: typeof execute }) => unknown) => callback({ update, execute })),
    };
    return { db, update, set, releaseWhere, workWhere, execute };
  }

  it('returns the row to the probe and empties the column it was overlaying', async () => {
    const mocks = clearDb(1);
    const store = new MonitoredReleaseProbeStore(mocks.db as never);
    const now = new Date('2026-09-18T00:00:00.000Z');

    await expect(store.clearUserReleaseDate('work-1', 'ebook', now)).resolves.toBe(true);

    expect(mocks.set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: 'pending',
        releaseDate: null,
        source: null,
        checkedAt: null,
        nextCheckAt: now,
        attempts: 0,
        autoReleaseDate: null,
        autoDatePrecision: null,
        autoSource: null,
        autoChangedAt: null,
      }),
    );
    expect(mocks.set).toHaveBeenNthCalledWith(2, { ebookReleaseDate: null, ebookDatePrecision: null });
    expect(rendered(mocks.releaseWhere.mock.calls[0]?.[0] as SQL)).toContain('"source" = ');
    expect(rendered(mocks.workWhere.mock.calls[0]?.[0] as SQL)).toContain('owned_formats');
    expect(boundValues(mocks.workWhere.mock.calls[0]?.[0] as SQL)).toContain('["ebook"]');
    expect(rendered(mocks.execute.mock.calls[0]?.[0] as SQL)).toContain('from "author_catalog_works"');
    expect(mocks.execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
  });

  it('leaves a row the probe owns untouched and never clears its column', async () => {
    const mocks = clearDb(0);
    const store = new MonitoredReleaseProbeStore(mocks.db as never);

    await expect(store.clearUserReleaseDate('work-1', 'audiobook', new Date('2026-09-18T00:00:00.000Z'))).resolves.toBe(false);

    expect(mocks.set).toHaveBeenCalledOnce();
  });
});
