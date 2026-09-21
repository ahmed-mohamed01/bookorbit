import { randomUUID } from 'crypto';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { AppModule } from '../src/app.module';
import { DB } from '../src/db';
import * as dbSchema from '../src/db/schema';
import { MetadataService } from '../src/modules/metadata/metadata.service';
import {
  MonitoredReleaseProbeStore,
  reapplyReleaseOverlay,
  type ReleaseProbeRow,
  type ReleaseTransaction,
} from '../src/modules/monitored/monitored-release-probe-store.service';
import * as schema from '../src/modules/monitored/schema/monitored.schema';
import { makeMetadataNoopMock } from './e2e/app-harness';

type Db = NodePgDatabase<typeof dbSchema>;

const SCENARIO_TIMEOUT_MS = 60_000;
const OWNER_DATE = '2027-03-04';
const ACKNOWLEDGED_AT = new Date('2026-01-02T03:04:05.000Z');

/** Every scenario aborts its own transaction, so the e2e database keeps nothing afterwards. */
class Rollback extends Error {}

interface Fixture {
  monitorId: string;
  ownerUserId: number;
  workId: string;
  otherWorkId: string;
}

describe('Monitored release date suggestions (e2e)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  let app: NestFastifyApplication | undefined;
  let db: Db | undefined;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MetadataService)
      .useValue(makeMetadataNoopMock())
      .compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    db = app.get<Db>(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seed(tx: ReleaseTransaction): Promise<Fixture> {
    const suffix = randomUUID().replaceAll('-', '');
    const monitorId = `suggestion-${suffix.slice(0, 25)}`;
    const inserted = await tx.execute(sql`
      insert into users (username, name, password_hash)
      values (${`release-suggestion-${suffix}`}, 'Release Suggestion E2E', 'not-used')
      returning id
    `);
    const ownerUserId = Number((inserted.rows[0] as { id: number }).id);
    await tx.insert(schema.monitoredAuthors).values({
      id: monitorId,
      ownerUserId,
      authorName: `Release Suggestion ${suffix.slice(0, 8)}`,
      ebookMode: 'notify',
      audiobookMode: 'notify',
      addedAt: new Date(),
    });
    const workId = `${monitorId}:work`;
    const otherWorkId = `${monitorId}:other`;
    for (const id of [workId, otherWorkId]) {
      await tx.insert(schema.authorCatalogWorks).values({ id, monitorAuthorId: monitorId, title: `Work ${id}`, verdict: 'verified' });
    }
    return { monitorId, ownerUserId, workId, otherWorkId };
  }

  async function probeRow(tx: ReleaseTransaction, workId: string, format: 'ebook' | 'audiobook'): Promise<ReleaseProbeRow> {
    const [row] = await tx
      .select()
      .from(schema.authorCatalogWorkReleases)
      .where(and(eq(schema.authorCatalogWorkReleases.workId, workId), eq(schema.authorCatalogWorkReleases.format, format)));
    expect(row).toBeDefined();
    return row!;
  }

  async function mergeAudioDate(tx: ReleaseTransaction, workId: string, date: string | null): Promise<void> {
    await tx
      .update(schema.authorCatalogWorks)
      .set({ audioReleaseDate: date, audioDatePrecision: date === null ? null : 'day' })
      .where(eq(schema.authorCatalogWorks.id, workId));
  }

  /** Aborts the transaction whatever the body did, and lets a failed expectation surface as itself. */
  async function inRolledBackTransaction(body: (tx: ReleaseTransaction) => Promise<void>): Promise<void> {
    const failures: Error[] = [];
    await db!
      .transaction(async (tx) => {
        await body(tx).catch((error: unknown) => {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        });
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    if (failures[0]) throw failures[0];
  }

  it('captures a merged Audible date behind the owner date and re-stamps it only when it moves', async () => {
    await inRolledBackTransaction(async (tx) => {
      const { monitorId, ownerUserId, workId, otherWorkId } = await seed(tx);
      for (const id of [workId, otherWorkId]) {
        await tx.insert(schema.authorCatalogWorkReleases).values({
          workId: id,
          monitorAuthorId: monitorId,
          ownerUserId,
          format: 'audiobook',
          status: 'dated',
          releaseDate: OWNER_DATE,
          datePrecision: 'day',
          source: id === workId ? 'user' : 'audible',
          nextCheckAt: new Date(),
        });
      }

      await mergeAudioDate(tx, workId, '2027-06-01');
      await mergeAudioDate(tx, otherWorkId, '2027-06-01');
      await reapplyReleaseOverlay(tx, monitorId);

      const captured = await probeRow(tx, workId, 'audiobook');
      expect(captured.autoReleaseDate).toBe('2027-06-01');
      expect(captured.autoDatePrecision).toBe('day');
      expect(captured.autoSource).toBe('audible');
      expect(captured.autoChangedAt).not.toBeNull();
      // The owner's own row is never restated, and their date goes back over the merged column.
      expect(captured.status).toBe('dated');
      expect(captured.releaseDate).toBe(OWNER_DATE);
      expect(captured.source).toBe('user');
      const [work] = await tx.select().from(schema.authorCatalogWorks).where(eq(schema.authorCatalogWorks.id, workId));
      expect(work!.audioReleaseDate).toBe(OWNER_DATE);

      // A row the probe owns is restated by the Audible stamp above it and never carries a suggestion.
      const probeOwned = await probeRow(tx, otherWorkId, 'audiobook');
      expect(probeOwned.autoReleaseDate).toBeNull();
      expect(probeOwned.autoChangedAt).toBeNull();

      await tx
        .update(schema.authorCatalogWorkReleases)
        .set({ autoChangedAt: ACKNOWLEDGED_AT })
        .where(eq(schema.authorCatalogWorkReleases.workId, workId));
      await mergeAudioDate(tx, workId, '2027-06-01');
      await reapplyReleaseOverlay(tx, monitorId);
      expect((await probeRow(tx, workId, 'audiobook')).autoChangedAt).toEqual(ACKNOWLEDGED_AT);

      await mergeAudioDate(tx, workId, '2027-07-15');
      await reapplyReleaseOverlay(tx, monitorId);
      const moved = await probeRow(tx, workId, 'audiobook');
      expect(moved.autoReleaseDate).toBe('2027-07-15');
      expect(moved.autoChangedAt).not.toEqual(ACKNOWLEDGED_AT);

      // A coarse merged date is the merger guessing, so it is no evidence anything moved.
      await tx
        .update(schema.authorCatalogWorks)
        .set({ audioReleaseDate: '2027', audioDatePrecision: 'year' })
        .where(eq(schema.authorCatalogWorks.id, workId));
      await reapplyReleaseOverlay(tx, monitorId);
      expect((await probeRow(tx, workId, 'audiobook')).autoReleaseDate).toBe('2027-07-15');
    });
  });

  it('clears coarse audio merger dates for negative decisions and restores a dated row', async () => {
    await inRolledBackTransaction(async (tx) => {
      const { monitorId, ownerUserId, workId, otherWorkId } = await seed(tx);
      const datedWorkId = `${monitorId}:dated`;
      await tx.insert(schema.authorCatalogWorks).values({
        id: datedWorkId,
        monitorAuthorId: monitorId,
        title: 'Dated Work',
        verdict: 'verified',
      });
      await tx
        .update(schema.authorCatalogWorks)
        .set({ audioReleaseDate: '2027', audioDatePrecision: 'year' })
        .where(sql`${schema.authorCatalogWorks.id} in (${workId}, ${otherWorkId})`);
      await tx.insert(schema.authorCatalogWorkReleases).values([
        {
          workId,
          monitorAuthorId: monitorId,
          ownerUserId,
          format: 'audiobook',
          status: 'unlisted',
          releaseDate: null,
          datePrecision: null,
          source: 'amazon_search',
          nextCheckAt: new Date(),
        },
        {
          workId: otherWorkId,
          monitorAuthorId: monitorId,
          ownerUserId,
          format: 'audiobook',
          status: 'expected',
          releaseDate: '2027',
          datePrecision: 'year',
          source: 'hardcover_edition',
          nextCheckAt: new Date(),
        },
        {
          workId: datedWorkId,
          monitorAuthorId: monitorId,
          ownerUserId,
          format: 'audiobook',
          status: 'dated',
          releaseDate: '2027-08-09',
          datePrecision: 'day',
          source: 'amazon',
          nextCheckAt: new Date(),
        },
      ]);

      await reapplyReleaseOverlay(tx, monitorId);

      const rows = await tx
        .select({ id: schema.authorCatalogWorks.id, date: schema.authorCatalogWorks.audioReleaseDate })
        .from(schema.authorCatalogWorks)
        .where(sql`${schema.authorCatalogWorks.id} in (${workId}, ${otherWorkId}, ${datedWorkId})`);
      expect(Object.fromEntries(rows.map((row) => [row.id, row.date]))).toEqual({
        [workId]: null,
        [otherWorkId]: null,
        [datedWorkId]: '2027-08-09',
      });
    });
  });

  it('seeds, keeps and clears the automatic baseline around a date the owner sets', async () => {
    await inRolledBackTransaction(async (tx) => {
      const { monitorId, ownerUserId, workId, otherWorkId } = await seed(tx);
      const store = new MonitoredReleaseProbeStore(tx as never);
      const ref = { id: workId, monitorAuthorId: monitorId, ownerUserId };
      const userDate = (releaseDate: string) => ({
        ebook: {
          decision: {
            status: 'dated' as const,
            releaseDate,
            precision: 'day' as const,
            source: 'user' as const,
            asin: null,
            overlay: 'set' as const,
          },
          nextCheckAt: new Date('2026-09-19T00:00:00.000Z'),
        },
      });

      await tx.insert(schema.authorCatalogWorkReleases).values({
        workId,
        monitorAuthorId: monitorId,
        ownerUserId,
        format: 'ebook',
        status: 'dated',
        releaseDate: '2027-02-01',
        datePrecision: 'day',
        source: 'apple',
        nextCheckAt: new Date(),
      });

      await store.saveOutcome(ref, userDate('2027-05-05'), new Date('2026-09-18T00:00:00.000Z'));
      const seeded = await probeRow(tx, workId, 'ebook');
      expect(seeded.source).toBe('user');
      expect(seeded.releaseDate).toBe('2027-05-05');
      expect(seeded.autoReleaseDate).toBe('2027-02-01');
      expect(seeded.autoDatePrecision).toBe('day');
      expect(seeded.autoSource).toBe('apple');
      expect(seeded.autoChangedAt).toBeNull();

      await tx
        .update(schema.authorCatalogWorkReleases)
        .set({ autoReleaseDate: '2027-09-09', autoSource: 'amazon', autoChangedAt: ACKNOWLEDGED_AT })
        .where(eq(schema.authorCatalogWorkReleases.workId, workId));
      await store.saveOutcome(ref, userDate('2027-05-05'), new Date('2026-09-18T00:00:00.000Z'));
      const acknowledged = await probeRow(tx, workId, 'ebook');
      expect(acknowledged.autoReleaseDate).toBe('2027-09-09');
      expect(acknowledged.autoSource).toBe('amazon');
      expect(acknowledged.autoChangedAt).toBeNull();

      expect(await store.clearUserReleaseDate(workId, 'ebook', new Date('2026-09-20T00:00:00.000Z'))).toBe(true);
      const cleared = await probeRow(tx, workId, 'ebook');
      expect(cleared.status).toBe('pending');
      expect(cleared.autoReleaseDate).toBeNull();
      expect(cleared.autoDatePrecision).toBeNull();
      expect(cleared.autoSource).toBeNull();
      expect(cleared.autoChangedAt).toBeNull();

      // Nothing was being overridden, so there is no baseline to measure a suggestion against.
      await store.saveOutcome(
        { id: otherWorkId, monitorAuthorId: monitorId, ownerUserId },
        userDate('2027-05-05'),
        new Date('2026-09-18T00:00:00.000Z'),
      );
      const fresh = await probeRow(tx, otherWorkId, 'ebook');
      expect(fresh.source).toBe('user');
      expect(fresh.autoReleaseDate).toBeNull();
      expect(fresh.autoSource).toBeNull();
      expect(fresh.autoChangedAt).toBeNull();
    });
  });

  it('stamps a suggestion on the owner row only while its date is new', async () => {
    await inRolledBackTransaction(async (tx) => {
      const { monitorId, ownerUserId, workId, otherWorkId } = await seed(tx);
      const store = new MonitoredReleaseProbeStore(tx as never);
      for (const [id, source] of [
        [workId, 'user'],
        [otherWorkId, 'apple'],
      ] as const) {
        await tx.insert(schema.authorCatalogWorkReleases).values({
          workId: id,
          monitorAuthorId: monitorId,
          ownerUserId,
          format: 'ebook',
          status: 'dated',
          releaseDate: OWNER_DATE,
          datePrecision: 'day',
          source,
          nextCheckAt: new Date(),
        });
      }
      const reschedule = (target: string, releaseDate: string, now: Date) =>
        store.saveOutcome(
          { id: target, monitorAuthorId: monitorId, ownerUserId },
          {
            ebook: {
              decision: {
                status: 'dated' as const,
                releaseDate: OWNER_DATE,
                precision: 'day' as const,
                source: 'user' as const,
                asin: null,
                overlay: 'set' as const,
              },
              nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
              rescheduleOnly: true,
              suggested: { releaseDate, precision: 'day' as const, source: 'amazon' as const },
            },
          },
          now,
        );

      const firstSeenAt = new Date('2026-09-18T00:00:00.000Z');
      await reschedule(workId, '2027-08-08', firstSeenAt);
      const stamped = await probeRow(tx, workId, 'ebook');
      expect(stamped.autoReleaseDate).toBe('2027-08-08');
      expect(stamped.autoSource).toBe('amazon');
      expect(stamped.autoChangedAt).toEqual(firstSeenAt);
      expect(stamped.releaseDate).toBe(OWNER_DATE);

      await reschedule(workId, '2027-08-08', new Date('2026-09-19T00:00:00.000Z'));
      expect((await probeRow(tx, workId, 'ebook')).autoChangedAt).toEqual(firstSeenAt);

      const movedAt = new Date('2026-09-20T00:00:00.000Z');
      await reschedule(workId, '2027-10-10', movedAt);
      const moved = await probeRow(tx, workId, 'ebook');
      expect(moved.autoReleaseDate).toBe('2027-10-10');
      expect(moved.autoChangedAt).toEqual(movedAt);

      await reschedule(otherWorkId, '2027-08-08', firstSeenAt);
      const probeOwned = await probeRow(tx, otherWorkId, 'ebook');
      expect(probeOwned.autoReleaseDate).toBeNull();
      expect(probeOwned.autoChangedAt).toBeNull();
    });
  });

  it('skips stale automatic writes after an owner sets or clears a date', async () => {
    await inRolledBackTransaction(async (tx) => {
      const { monitorId, ownerUserId, workId, otherWorkId } = await seed(tx);
      const store = new MonitoredReleaseProbeStore(tx as never);
      const now = new Date('2026-09-18T00:00:00.000Z');
      const automatic = {
        ebook: {
          decision: {
            status: 'unlisted' as const,
            releaseDate: null,
            precision: null,
            source: 'amazon_search' as const,
            asin: null,
            overlay: 'clear' as const,
          },
          nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
        },
      };

      await store.saveOutcome(
        { id: workId, monitorAuthorId: monitorId, ownerUserId },
        {
          ebook: {
            decision: {
              status: 'dated',
              releaseDate: '2027-05-05',
              precision: 'day',
              source: 'user',
              asin: null,
              overlay: 'set',
            },
            nextCheckAt: new Date('2026-09-19T00:00:00.000Z'),
          },
        },
        now,
      );
      await store.saveOutcome({ id: workId, monitorAuthorId: monitorId, ownerUserId }, automatic, now, { ebook: null, audiobook: null });
      expect(await probeRow(tx, workId, 'ebook')).toMatchObject({ source: 'user', releaseDate: '2027-05-05' });
      const [ownerSetWork] = await tx.select().from(schema.authorCatalogWorks).where(eq(schema.authorCatalogWorks.id, workId));
      expect(ownerSetWork!.ebookReleaseDate).toBe('2027-05-05');

      await store.saveOutcome(
        { id: otherWorkId, monitorAuthorId: monitorId, ownerUserId },
        {
          ebook: {
            decision: {
              status: 'dated',
              releaseDate: '2027-06-06',
              precision: 'day',
              source: 'user',
              asin: null,
              overlay: 'set',
            },
            nextCheckAt: new Date('2026-09-19T00:00:00.000Z'),
          },
        },
        now,
      );
      expect(await store.clearUserReleaseDate(otherWorkId, 'ebook', now)).toBe(true);
      await store.saveOutcome(
        { id: otherWorkId, monitorAuthorId: monitorId, ownerUserId },
        {
          ebook: {
            decision: {
              status: 'dated',
              releaseDate: '2027-06-06',
              precision: 'day',
              source: 'user',
              asin: null,
              overlay: 'set',
            },
            nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
            rescheduleOnly: true,
          },
        },
        now,
        {
          ebook: { status: 'dated', releaseDate: '2027-06-06', source: 'user', autoReleaseDate: null },
          audiobook: null,
        },
      );
      expect(await probeRow(tx, otherWorkId, 'ebook')).toMatchObject({ status: 'pending', source: null, releaseDate: null });
      const [ownerClearedWork] = await tx.select().from(schema.authorCatalogWorks).where(eq(schema.authorCatalogWorks.id, otherWorkId));
      expect(ownerClearedWork!.ebookReleaseDate).toBeNull();
    });
  });
});
