import { randomUUID } from 'crypto';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';

import { AppModule } from '../src/app.module';
import { MetadataService } from '../src/modules/metadata/metadata.service';
import { makeMetadataNoopMock } from './e2e/app-harness';

interface HistoryRow {
  lastReleaseDate: string | null;
  lastDatePrecision: string | null;
  lastDateSource: string | null;
  previousReleaseDate: string | null;
  previousDatePrecision: string | null;
  dateChangedAt: Date | null;
}

type ExpectedHistory = Omit<HistoryRow, 'dateChangedAt'> & { dateChangedAt: string | null };

const SCENARIO_TIMEOUT_MS = 60_000;

describe('Monitored release history trigger (e2e)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  let app: NestFastifyApplication | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MetadataService)
      .useValue(makeMetadataNoopMock())
      .compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();

    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  it('records first sightings, refinements, and real moves while protecting trigger-owned history', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const monitorId = `history-${suffix.slice(0, 28)}`;
    const primaryWorkId = `${monitorId}:primary`;
    const refinementWorkId = `${monitorId}:refinement`;
    let ownerUserId = 0;

    async function upsert(workId: string, releaseDate: string | null, precision: string | null, source: string | null, status = 'dated') {
      await client!.query(
        `INSERT INTO author_catalog_work_releases
          (work_id, monitor_author_id, owner_user_id, format, status, release_date, date_precision, source, next_check_at)
        VALUES ($1, $2, $3, 'ebook', $4, $5, $6, $7, now())
        ON CONFLICT (work_id, format) DO UPDATE SET
          status = excluded.status,
          release_date = excluded.release_date,
          date_precision = excluded.date_precision,
          source = excluded.source`,
        [workId, monitorId, ownerUserId, status, releaseDate, precision, source],
      );
    }

    async function history(workId: string): Promise<HistoryRow> {
      const result = await client!.query<HistoryRow>(
        `SELECT
          last_release_date AS "lastReleaseDate",
          last_date_precision AS "lastDatePrecision",
          last_date_source AS "lastDateSource",
          previous_release_date AS "previousReleaseDate",
          previous_date_precision AS "previousDatePrecision",
          date_changed_at AS "dateChangedAt"
        FROM author_catalog_work_releases
        WHERE work_id = $1 AND format = 'ebook'`,
        [workId],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!;
    }

    async function expectHistory(workId: string, expected: ExpectedHistory): Promise<HistoryRow> {
      const row = await history(workId);
      expect({ ...row, dateChangedAt: row.dateChangedAt?.toISOString() ?? null }).toEqual(expected);
      return row;
    }

    await client!.query('BEGIN');
    try {
      const user = await client!.query<{ id: number }>(
        `INSERT INTO users (username, name, password_hash)
         VALUES ($1, 'Release History E2E', 'not-used')
         RETURNING id`,
        [`release-history-${suffix}`],
      );
      ownerUserId = user.rows[0]!.id;
      await client!.query(
        `INSERT INTO monitored_authors
          (id, owner_user_id, author_name, ebook_mode, audiobook_mode, added_at)
         VALUES ($1, $2, 'Release History E2E', 'notify', 'notify', now())`,
        [monitorId, ownerUserId],
      );

      await upsert(primaryWorkId, '2027-03-01', 'day', null);
      const inherited = await history(primaryWorkId);
      expect(inherited.dateChangedAt).not.toBeNull();
      await expectHistory(primaryWorkId, {
        lastReleaseDate: '2027-03-01',
        lastDatePrecision: 'day',
        lastDateSource: null,
        previousReleaseDate: null,
        previousDatePrecision: null,
        dateChangedAt: inherited.dateChangedAt!.toISOString(),
      });

      await client!.query('SELECT pg_sleep(0.002)');
      await upsert(primaryWorkId, '2027-04-15', 'day', 'apple');
      const firstListed = await history(primaryWorkId);
      expect(firstListed.dateChangedAt!.getTime()).toBeGreaterThan(inherited.dateChangedAt!.getTime());
      await expectHistory(primaryWorkId, {
        lastReleaseDate: '2027-04-15',
        lastDatePrecision: 'day',
        lastDateSource: 'apple',
        previousReleaseDate: null,
        previousDatePrecision: null,
        dateChangedAt: firstListed.dateChangedAt!.toISOString(),
      });

      await client!.query('SELECT pg_sleep(0.002)');
      await upsert(primaryWorkId, '2027-05-20', 'day', 'apple');
      const moved = await history(primaryWorkId);
      expect(moved.dateChangedAt!.getTime()).toBeGreaterThan(firstListed.dateChangedAt!.getTime());
      const movedHistory: ExpectedHistory = {
        lastReleaseDate: '2027-05-20',
        lastDatePrecision: 'day',
        lastDateSource: 'apple',
        previousReleaseDate: '2027-04-15',
        previousDatePrecision: 'day',
        dateChangedAt: moved.dateChangedAt!.toISOString(),
      };
      await expectHistory(primaryWorkId, movedHistory);

      await upsert(primaryWorkId, null, null, 'apple', 'unlisted');
      await expectHistory(primaryWorkId, movedHistory);

      await upsert(primaryWorkId, '2027-05-20', 'day', 'apple');
      await expectHistory(primaryWorkId, movedHistory);

      await upsert(refinementWorkId, '2027', 'year', 'apple');
      const coarse = await history(refinementWorkId);
      expect(coarse.dateChangedAt).not.toBeNull();
      await expectHistory(refinementWorkId, {
        lastReleaseDate: '2027',
        lastDatePrecision: 'year',
        lastDateSource: 'apple',
        previousReleaseDate: null,
        previousDatePrecision: null,
        dateChangedAt: coarse.dateChangedAt!.toISOString(),
      });

      await client!.query('SELECT pg_sleep(0.002)');
      await upsert(refinementWorkId, '2027-02-11', 'day', 'apple');
      const refinedHistory: ExpectedHistory = {
        lastReleaseDate: '2027-02-11',
        lastDatePrecision: 'day',
        lastDateSource: 'apple',
        previousReleaseDate: null,
        previousDatePrecision: null,
        dateChangedAt: coarse.dateChangedAt!.toISOString(),
      };
      await expectHistory(refinementWorkId, refinedHistory);

      await upsert(refinementWorkId, '2027-08-09', 'day', 'user');
      await expectHistory(refinementWorkId, refinedHistory);

      await client!.query(
        `UPDATE author_catalog_work_releases
         SET previous_release_date = '1900-01-01',
           last_release_date = '1901-01-01',
           date_changed_at = '1902-01-01T00:00:00Z'
         WHERE work_id = $1 AND format = 'ebook'`,
        [refinementWorkId],
      );
      await expectHistory(refinementWorkId, refinedHistory);

      await client!.query('SELECT pg_sleep(0.002)');
      await client!.query(
        `UPDATE author_catalog_work_releases AS probe
         SET status = 'dated',
           release_date = updates.release_date,
           date_precision = 'day',
           source = 'apple'
         FROM (VALUES ($1::varchar, '2027-06-01'::varchar), ($2::varchar, '2027-03-03'::varchar)) AS updates(work_id, release_date)
         WHERE probe.work_id = updates.work_id AND probe.format = 'ebook'`,
        [primaryWorkId, refinementWorkId],
      );
      const primarySetBased = await history(primaryWorkId);
      const refinementSetBased = await history(refinementWorkId);
      expect(primarySetBased.dateChangedAt!.getTime()).toBeGreaterThan(moved.dateChangedAt!.getTime());
      expect(refinementSetBased.dateChangedAt!.getTime()).toBeGreaterThan(coarse.dateChangedAt!.getTime());
      await expectHistory(primaryWorkId, {
        lastReleaseDate: '2027-06-01',
        lastDatePrecision: 'day',
        lastDateSource: 'apple',
        previousReleaseDate: '2027-05-20',
        previousDatePrecision: 'day',
        dateChangedAt: primarySetBased.dateChangedAt!.toISOString(),
      });
      await expectHistory(refinementWorkId, {
        lastReleaseDate: '2027-03-03',
        lastDatePrecision: 'day',
        lastDateSource: 'apple',
        previousReleaseDate: '2027-02-11',
        previousDatePrecision: 'day',
        dateChangedAt: refinementSetBased.dateChangedAt!.toISOString(),
      });
    } finally {
      await client!.query('ROLLBACK');
    }
  });
});
