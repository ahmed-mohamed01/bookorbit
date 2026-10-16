import { randomUUID } from 'crypto';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { AppModule } from '../src/app.module';
import { DB } from '../src/db';
import * as dbSchema from '../src/db/schema';
import { MetadataService } from '../src/modules/metadata/metadata.service';
import { recordChoiceLedger, restoreChoiceLedger } from '../src/modules/monitored/monitored-choice-ledger';
import type { ReleaseTransaction } from '../src/modules/monitored/monitored-release-probe-store.service';
import * as schema from '../src/modules/monitored/schema/monitored.schema';
import { makeMetadataNoopMock } from './e2e/app-harness';

type Db = NodePgDatabase<typeof dbSchema>;

class Rollback extends Error {}

describe('Monitored choice ledger (e2e)', { timeout: 60_000 }, () => {
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

  async function seedMonitor(tx: ReleaseTransaction, label: string): Promise<string> {
    const suffix = randomUUID().replaceAll('-', '');
    const inserted = await tx.execute(sql`
      insert into users (username, name, password_hash)
      values (${`choice-ledger-${label}-${suffix}`}, ${`Choice Ledger ${label}`}, 'not-used')
      returning id
    `);
    const ownerUserId = Number((inserted.rows[0] as { id: number }).id);
    const monitorId = `choice-${label}-${suffix.slice(0, 28 - label.length)}`;
    await tx.insert(schema.monitoredAuthors).values({
      id: monitorId,
      ownerUserId,
      authorName: `Choice ${label}`,
      ebookMode: 'notify',
      audiobookMode: 'notify',
      addedAt: new Date(),
    });
    return monitorId;
  }

  async function addWork(tx: ReleaseTransaction, monitorId: string, key: string, title: string, providerWorkId = key): Promise<string> {
    const id = `${monitorId}:hardcover:${key}`;
    await tx.insert(schema.authorCatalogWorks).values({ id, monitorAuthorId: monitorId, title, verdict: 'verified' });
    await tx.insert(schema.authorCatalogSourceWorks).values({ workId: id, source: 'hardcover', providerWorkId });
    return id;
  }

  async function workIds(tx: ReleaseTransaction, monitorId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: schema.authorCatalogWorks.id })
      .from(schema.authorCatalogWorks)
      .where(eq(schema.authorCatalogWorks.monitorAuthorId, monitorId));
    return rows.map((row) => row.id);
  }

  async function choicesOf(tx: ReleaseTransaction, workId: string) {
    const [row] = await tx
      .select({
        userKind: schema.monitoredAuthorWorks.userKind,
        userVisibility: schema.monitoredAuthorWorks.userVisibility,
        monitorAudiobook: schema.monitoredAuthorWorks.monitorAudiobook,
      })
      .from(schema.monitoredAuthorWorks)
      .where(eq(schema.monitoredAuthorWorks.workId, workId));
    return row ?? null;
  }

  async function mark(tx: ReleaseTransaction, monitorId: string, workId: string, values: Partial<typeof schema.monitoredAuthorWorks.$inferInsert>) {
    await tx
      .insert(schema.monitoredAuthorWorks)
      .values({ workId, monitorAuthorId: monitorId, ...values })
      .onConflictDoUpdate({ target: schema.monitoredAuthorWorks.workId, set: values });
  }

  /** A refresh that files the same book under a new id: the provider id stays, the work id changes. */
  async function refile(tx: ReleaseTransaction, monitorId: string, fromId: string, providerWorkId: string, title: string): Promise<string> {
    await tx.delete(schema.authorCatalogWorks).where(eq(schema.authorCatalogWorks.id, fromId));
    return addWork(tx, monitorId, `${providerWorkId}-refiled`, title, providerWorkId);
  }

  it('hands the owner choices to the work a refresh files the same book under', async () => {
    await inRolledBackTransaction(async (tx) => {
      const monitorId = await seedMonitor(tx, 'refile');
      const original = await addWork(tx, monitorId, 'book-one', 'Book One');
      await mark(tx, monitorId, original, { userKind: 'split_part', monitorAudiobook: false });

      const before = await workIds(tx, monitorId);
      await recordChoiceLedger(tx, monitorId);
      const refiled = await refile(tx, monitorId, original, 'book-one', 'Book One');
      await restoreChoiceLedger(tx, monitorId, before);

      expect(await choicesOf(tx, refiled)).toEqual({ userKind: 'split_part', userVisibility: null, monitorAudiobook: false });
    });
  });

  it('leaves a same-titled edition that was already there alone', async () => {
    await inRolledBackTransaction(async (tx) => {
      const monitorId = await seedMonitor(tx, 'sibling');
      const marked = await addWork(tx, monitorId, 'aaa-edition', 'Shared Title');
      const sibling = await addWork(tx, monitorId, 'zzz-edition', 'Shared Title');
      await mark(tx, monitorId, marked, { userKind: 'duplicate', userVisibility: 'hidden' });

      const before = await workIds(tx, monitorId);
      await recordChoiceLedger(tx, monitorId);
      await restoreChoiceLedger(tx, monitorId, before);

      expect(await choicesOf(tx, sibling)).toBeNull();
    });
  });

  it('does not bring back a choice the owner cleared', async () => {
    await inRolledBackTransaction(async (tx) => {
      const monitorId = await seedMonitor(tx, 'cleared');
      const original = await addWork(tx, monitorId, 'book-two', 'Book Two');
      await mark(tx, monitorId, original, { userKind: 'collection' });
      await recordChoiceLedger(tx, monitorId);
      await mark(tx, monitorId, original, { userKind: null });

      const before = await workIds(tx, monitorId);
      await recordChoiceLedger(tx, monitorId);
      const refiled = await refile(tx, monitorId, original, 'book-two', 'Book Two');
      await restoreChoiceLedger(tx, monitorId, before);

      expect(await choicesOf(tx, refiled)).toBeNull();
    });
  });

  it('gives a work its choices back when it returns after one refresh away', async () => {
    await inRolledBackTransaction(async (tx) => {
      const monitorId = await seedMonitor(tx, 'returns');
      const original = await addWork(tx, monitorId, 'book-three', 'Book Three');
      await mark(tx, monitorId, original, { userVisibility: 'visible' });
      await recordChoiceLedger(tx, monitorId);
      await tx.delete(schema.authorCatalogWorks).where(eq(schema.authorCatalogWorks.id, original));

      const before = await workIds(tx, monitorId);
      await recordChoiceLedger(tx, monitorId);
      const returned = await addWork(tx, monitorId, 'book-three', 'Book Three');
      await restoreChoiceLedger(tx, monitorId, before);

      expect(returned).toBe(original);
      expect(await choicesOf(tx, returned)).toEqual({ userKind: null, userVisibility: 'visible', monitorAudiobook: null });
    });
  });
});
