import { randomUUID } from 'crypto';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

import { AppModule } from '../src/app.module';
import { DB } from '../src/db';
import * as dbSchema from '../src/db/schema';
import { MetadataService } from '../src/modules/metadata/metadata.service';
import {
  MonitoredReleaseProbeStore,
  reapplyReleaseOverlay,
  type ReleaseTransaction,
} from '../src/modules/monitored/monitored-release-probe-store.service';
import { MonitoredSettingsService } from '../src/modules/monitored/monitored-settings.service';
import * as schema from '../src/modules/monitored/schema/monitored.schema';
import { makeMetadataNoopMock } from './e2e/app-harness';

type Db = NodePgDatabase<typeof dbSchema>;

const SCENARIO_TIMEOUT_MS = 60_000;

class Rollback extends Error {}

describe('Monitored release probe store (e2e)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
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

  async function seedOwner(tx: ReleaseTransaction, label: string): Promise<{ monitorId: string; ownerUserId: number }> {
    const suffix = randomUUID().replaceAll('-', '');
    const inserted = await tx.execute(sql`
      insert into users (username, name, password_hash)
      values (${`release-probe-${label}-${suffix}`}, ${`Release Probe ${label}`}, 'not-used')
      returning id
    `);
    const ownerUserId = Number((inserted.rows[0] as { id: number }).id);
    // monitored_authors.id is varchar(36): "probe-" and the dash take 7 of them.
    const monitorId = `probe-${label}-${suffix.slice(0, 29 - label.length)}`;
    await tx.insert(schema.monitoredAuthors).values({
      id: monitorId,
      ownerUserId,
      authorName: `Probe ${label}`,
      ebookMode: 'notify',
      audiobookMode: 'notify',
      addedAt: new Date(),
    });
    return { monitorId, ownerUserId };
  }

  it('restores automatic dates, clears owner dates, and deletes rows when disabling the probe', async () => {
    await inRolledBackTransaction(async (tx) => {
      const { monitorId, ownerUserId } = await seedOwner(tx, 'disable');
      const expectedId = `${monitorId}:expected`;
      const datedId = `${monitorId}:dated`;
      const userId = `${monitorId}:user`;
      await tx.insert(schema.authorCatalogWorks).values([
        { id: expectedId, monitorAuthorId: monitorId, title: 'Expected Ebook', verdict: 'verified' },
        { id: datedId, monitorAuthorId: monitorId, title: 'Dated Audio', verdict: 'verified' },
        {
          id: userId,
          monitorAuthorId: monitorId,
          title: 'Owner Ebook',
          verdict: 'verified',
          ebookReleaseDate: '2028-03-03',
          ebookDatePrecision: 'day',
        },
      ]);
      await tx.insert(schema.authorCatalogWorkReleases).values([
        {
          workId: expectedId,
          monitorAuthorId: monitorId,
          ownerUserId,
          format: 'ebook',
          status: 'expected',
          releaseDate: '2028-01',
          datePrecision: 'month',
          source: 'hardcover_edition',
          nextCheckAt: new Date(),
        },
        {
          workId: datedId,
          monitorAuthorId: monitorId,
          ownerUserId,
          format: 'audiobook',
          status: 'dated',
          releaseDate: '2028-02-02',
          datePrecision: 'day',
          source: 'audible',
          nextCheckAt: new Date(),
        },
        {
          workId: userId,
          monitorAuthorId: monitorId,
          ownerUserId,
          format: 'ebook',
          status: 'dated',
          releaseDate: '2028-03-03',
          datePrecision: 'day',
          source: 'user',
          nextCheckAt: new Date(),
        },
      ]);

      const transactionalDb = {
        select: tx.select.bind(tx),
        insert: tx.insert.bind(tx),
        transaction: (run: (inner: ReleaseTransaction) => unknown) => run(tx),
      };
      const settings = new MonitoredSettingsService(
        transactionalDb as never,
        { getValues: vi.fn().mockResolvedValue(new Map<string, string>()) } as never,
        new MonitoredReleaseProbeStore(tx as never),
      );

      await settings.setMonitoredSettings({ refreshCooldownMinutes: 10, releaseProbeEnabled: false });

      const rows = await tx
        .select({
          id: schema.authorCatalogWorks.id,
          ebookDate: schema.authorCatalogWorks.ebookReleaseDate,
          ebookPrecision: schema.authorCatalogWorks.ebookDatePrecision,
          audioDate: schema.authorCatalogWorks.audioReleaseDate,
          audioPrecision: schema.authorCatalogWorks.audioDatePrecision,
        })
        .from(schema.authorCatalogWorks)
        .where(sql`${schema.authorCatalogWorks.id} in (${expectedId}, ${datedId}, ${userId})`);
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(byId[expectedId]).toMatchObject({ ebookDate: '2028-01', ebookPrecision: 'month' });
      expect(byId[datedId]).toMatchObject({ audioDate: '2028-02-02', audioPrecision: 'day' });
      expect(byId[userId]).toMatchObject({ ebookDate: null, ebookPrecision: null });
      const remaining = await tx
        .select({ workId: schema.authorCatalogWorkReleases.workId })
        .from(schema.authorCatalogWorkReleases)
        .where(sql`${schema.authorCatalogWorkReleases.workId} in (${expectedId}, ${datedId}, ${userId})`);
      expect(remaining).toEqual([]);
    });
  });

  it('makes a newly merged Audible date due immediately and leaves an unchanged date scheduled', async () => {
    await inRolledBackTransaction(async (tx) => {
      const { monitorId, ownerUserId } = await seedOwner(tx, 'audible');
      const workId = `${monitorId}:work`;
      await tx.insert(schema.authorCatalogWorks).values({
        id: workId,
        monitorAuthorId: monitorId,
        title: 'Audible Move',
        verdict: 'verified',
        audioReleaseDate: '2028-06-06',
        audioDatePrecision: 'day',
      });
      await tx.insert(schema.authorCatalogWorkReleases).values({
        workId,
        monitorAuthorId: monitorId,
        ownerUserId,
        format: 'audiobook',
        status: 'dated',
        releaseDate: '2028-05-05',
        datePrecision: 'day',
        source: 'audible',
        nextCheckAt: new Date('2030-01-01T00:00:00.000Z'),
      });

      await reapplyReleaseOverlay(tx, monitorId);
      const [moved] = await tx.select().from(schema.authorCatalogWorkReleases).where(eq(schema.authorCatalogWorkReleases.workId, workId));
      expect(moved).toMatchObject({ releaseDate: '2028-06-06', source: 'audible' });
      // Postgres `now()` is the transaction's start, so "due" is the property to pin, not an exact instant.
      expect(moved!.nextCheckAt.getTime()).toBeLessThanOrEqual(Date.now());

      const scheduled = new Date('2031-01-01T00:00:00.000Z');
      await tx.update(schema.authorCatalogWorkReleases).set({ nextCheckAt: scheduled }).where(eq(schema.authorCatalogWorkReleases.workId, workId));
      await reapplyReleaseOverlay(tx, monitorId);
      const [unchanged] = await tx
        .select({ nextCheckAt: schema.authorCatalogWorkReleases.nextCheckAt })
        .from(schema.authorCatalogWorkReleases)
        .where(eq(schema.authorCatalogWorkReleases.workId, workId));
      expect(unchanged!.nextCheckAt).toEqual(scheduled);
    });
  });

  it('finds due works round-robin, once per work, while retaining excluded rows', async () => {
    await inRolledBackTransaction(async (tx) => {
      const ownerA = await seedOwner(tx, 'round-a');
      const ownerB = await seedOwner(tx, 'round-b');
      const activeA = Array.from({ length: 5 }, (_, index) => `${ownerA.monitorId}:a${index + 1}`);
      const activeB = `${ownerB.monitorId}:b1`;
      const hidden = `${ownerA.monitorId}:hidden`;
      const stopped = `${ownerA.monitorId}:stopped`;
      await tx
        .insert(schema.authorCatalogWorks)
        .values([
          ...activeA.map((id) => ({ id, monitorAuthorId: ownerA.monitorId, title: id, verdict: 'verified' as const })),
          { id: activeB, monitorAuthorId: ownerB.monitorId, title: activeB, verdict: 'verified' },
          { id: hidden, monitorAuthorId: ownerA.monitorId, title: hidden, verdict: 'verified' },
          { id: stopped, monitorAuthorId: ownerA.monitorId, title: stopped, verdict: 'verified' },
        ]);
      await tx.insert(schema.monitoredAuthorWorks).values([
        { workId: hidden, monitorAuthorId: ownerA.monitorId, userVisibility: 'hidden' },
        { workId: stopped, monitorAuthorId: ownerA.monitorId, monitorState: 'stopped' },
      ]);
      const base = Date.now() - 60 * 60 * 1000;
      await tx.insert(schema.authorCatalogWorkReleases).values([
        ...activeA.flatMap((workId, index) => [
          {
            workId,
            monitorAuthorId: ownerA.monitorId,
            ownerUserId: ownerA.ownerUserId,
            format: 'ebook' as const,
            status: 'pending' as const,
            nextCheckAt: new Date(base + index * 60_000),
          },
          ...(index === 0
            ? [
                {
                  workId,
                  monitorAuthorId: ownerA.monitorId,
                  ownerUserId: ownerA.ownerUserId,
                  format: 'audiobook' as const,
                  status: 'pending' as const,
                  nextCheckAt: new Date(base + 30_000),
                },
              ]
            : []),
        ]),
        {
          workId: activeB,
          monitorAuthorId: ownerB.monitorId,
          ownerUserId: ownerB.ownerUserId,
          format: 'ebook',
          status: 'pending',
          nextCheckAt: new Date(base + 30_000),
        },
        ...[hidden, stopped].map((workId) => ({
          workId,
          monitorAuthorId: ownerA.monitorId,
          ownerUserId: ownerA.ownerUserId,
          format: 'ebook' as const,
          status: 'pending' as const,
          nextCheckAt: new Date(base),
        })),
      ]);
      const store = new MonitoredReleaseProbeStore(tx as never);

      const works = await store.findDueWorks(new Date(), 20);

      expect(works.map((work) => work.id)).toEqual([activeA[0], activeB, ...activeA.slice(1)]);
      expect(works[0]!.releases).toHaveLength(2);
      expect(new Set(works.map((work) => work.id)).size).toBe(6);
      const excludedRows = await tx
        .select({ workId: schema.authorCatalogWorkReleases.workId })
        .from(schema.authorCatalogWorkReleases)
        .where(sql`${schema.authorCatalogWorkReleases.workId} in (${hidden}, ${stopped})`);
      expect(excludedRows.map((row) => row.workId).sort()).toEqual([hidden, stopped].sort());
    });
  });

  it('skips a stale automatic write after a concurrent owner date commits', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const monitorId = `probe-cas-${suffix.slice(0, 24)}`;
    const workId = `${monitorId}:work`;
    const username = `release-probe-cas-${suffix}`;
    const connectionString = process.env.DATABASE_URL;
    const ownerSession = new Client({ connectionString });
    const probeSession = new Client({ connectionString });
    let ownerUserId: number | undefined;
    let ownerTransactionOpen = false;
    await ownerSession.connect();
    await probeSession.connect();
    try {
      const user = await probeSession.query<{ id: number }>(
        `INSERT INTO users (username, name, password_hash) VALUES ($1, 'Release Probe CAS', 'not-used') RETURNING id`,
        [username],
      );
      ownerUserId = user.rows[0]!.id;
      await probeSession.query(
        `INSERT INTO monitored_authors (id, owner_user_id, author_name, ebook_mode, audiobook_mode, added_at)
         VALUES ($1, $2, 'Release Probe CAS', 'notify', 'notify', now())`,
        [monitorId, ownerUserId],
      );
      await probeSession.query(`INSERT INTO author_catalog_works (id, monitor_author_id, title, verdict) VALUES ($1, $2, 'CAS Work', 'verified')`, [
        workId,
        monitorId,
      ]);
      await probeSession.query(
        `INSERT INTO author_catalog_work_releases
          (work_id, monitor_author_id, owner_user_id, format, status, next_check_at)
         VALUES ($1, $2, $3, 'ebook', 'pending', now())`,
        [workId, monitorId, ownerUserId],
      );

      await ownerSession.query('BEGIN');
      ownerTransactionOpen = true;
      await ownerSession.query(`UPDATE author_catalog_works SET ebook_release_date = '2028-08-08', ebook_date_precision = 'day' WHERE id = $1`, [
        workId,
      ]);
      await ownerSession.query(
        `UPDATE author_catalog_work_releases
         SET status = 'dated', release_date = '2028-08-08', date_precision = 'day', source = 'user'
         WHERE work_id = $1 AND format = 'ebook'`,
        [workId],
      );

      const store = new MonitoredReleaseProbeStore(drizzle(probeSession, { schema: dbSchema }) as never);
      const save = store.saveOutcome(
        { id: workId, monitorAuthorId: monitorId, ownerUserId },
        {
          ebook: {
            decision: { status: 'unlisted', releaseDate: null, precision: null, source: 'amazon_search', asin: null, overlay: 'clear' },
            nextCheckAt: new Date('2026-09-25T00:00:00.000Z'),
          },
        },
        new Date('2026-09-18T00:00:00.000Z'),
        {
          ebook: { status: 'pending', releaseDate: null, source: null, autoReleaseDate: null },
          audiobook: null,
        },
      );
      const state = await Promise.race([
        save.then(() => 'resolved' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ]);
      expect(state).toBe('waiting');
      await ownerSession.query('COMMIT');
      ownerTransactionOpen = false;

      await expect(save).resolves.toEqual({ ledgerResets: 0, appliedFormats: [], skippedFormats: ['ebook'] });
      const row = await probeSession.query<{ source: string | null; releaseDate: string | null; ebookReleaseDate: string | null }>(
        `SELECT probe.source,
          probe.release_date AS "releaseDate",
          work.ebook_release_date AS "ebookReleaseDate"
         FROM author_catalog_work_releases probe
         INNER JOIN author_catalog_works work ON work.id = probe.work_id
         WHERE probe.work_id = $1 AND probe.format = 'ebook'`,
        [workId],
      );
      expect(row.rows[0]).toEqual({ source: 'user', releaseDate: '2028-08-08', ebookReleaseDate: '2028-08-08' });
    } finally {
      if (ownerTransactionOpen) await ownerSession.query('ROLLBACK');
      await probeSession.query('DELETE FROM monitored_authors WHERE id = $1', [monitorId]);
      if (ownerUserId !== undefined) await probeSession.query('DELETE FROM users WHERE id = $1', [ownerUserId]);
      await ownerSession.end();
      await probeSession.end();
    }
  });
});
