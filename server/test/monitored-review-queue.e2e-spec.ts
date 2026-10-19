import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { countWorkClasses, workMatchesClassSelection, type MonitoredWork } from '@bookorbit/types';
import { classSelectionFixtures } from '../../packages/types/src/__fixtures__/class-selection';
import { AppModule } from '../src/app.module';
import { MetadataService } from '../src/modules/metadata/metadata.service';
import { MonitoredStoreService } from '../src/modules/monitored/monitored-store.service';
import { classSelectionMatchSql, bookClassSql } from '../src/modules/monitored/monitored-work-conditions';
import * as schema from '../src/modules/monitored/schema/monitored.schema';
import type { RequestUser } from '../src/common/types/request-user';
import { makeMetadataNoopMock } from './e2e/app-harness';

describe('Monitored review queue (e2e)', { timeout: 60_000 }, () => {
  let app: NestFastifyApplication | undefined;
  let client: Client;
  let store: MonitoredStoreService;
  let userId: number;
  let otherUserId: number;
  let monitorId: string;
  let audioMonitorId: string;
  let otherMonitorId: string;
  const dialect = new PgDialect();

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MetadataService)
      .useValue(makeMetadataNoopMock())
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    store = app.get(MonitoredStoreService);
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const suffix = randomUUID();
    const users = await client.query<{ id: number }>(
      "insert into users (username, name, password_hash) values ($1, 'Review E2E', 'unused'), ($2, 'Review Other', 'unused') returning id",
      [`review-${suffix}`, `review-other-${suffix}`],
    );
    [userId, otherUserId] = users.rows.map((row) => row.id);
    monitorId = randomUUID();
    audioMonitorId = randomUUID();
    otherMonitorId = randomUUID();
    for (const [id, owner, mode] of [
      [monitorId, userId, 'notify'],
      [audioMonitorId, userId, 'off'],
      [otherMonitorId, otherUserId, 'notify'],
    ]) {
      await client.query(
        "insert into monitored_authors (id, owner_user_id, author_name, ebook_mode, audiobook_mode, added_at) values ($1, $2, $4, $3, 'notify', now())",
        [id, owner, mode, `Review E2E ${id}`],
      );
      await client.query('insert into author_catalog_state (monitor_author_id, fetched_at) values ($1, now())', [id]);
    }
  });

  afterAll(async () => {
    if (userId) await client.query('delete from users where id = any($1::int[])', [[userId, otherUserId]]);
    await client?.end();
    await app?.close();
  });

  async function insert(name: string, patch: Partial<MonitoredWork> = {}, author = monitorId) {
    const id = `rq-${name}-${author}`;
    await client.query(
      'insert into author_catalog_works (id, monitor_author_id, title, verdict, flags, kind, ebook_release_date, audio_release_date) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)',
      [
        id,
        author,
        name,
        patch.verdict ?? 'verified',
        JSON.stringify(patch.flags ?? []),
        patch.kind ?? null,
        patch.ebookReleaseDate ?? null,
        patch.audioReleaseDate ?? null,
      ],
    );
    if (patch.userVisibility || patch.userKind || patch.monitorFormats) {
      await client.query(
        'insert into monitored_author_works (work_id, monitor_author_id, user_visibility, user_kind, monitor_ebook, monitor_audiobook) values ($1,$2,$3,$4,$5,$6)',
        [
          id,
          author,
          patch.userVisibility ?? null,
          patch.userKind ?? null,
          patch.monitorFormats?.ebook ?? null,
          patch.monitorFormats?.audiobook ?? null,
        ],
      );
    }
    return id;
  }

  function page(patch: Partial<Parameters<MonitoredStoreService['findReleasePage']>[0]> = {}) {
    return store.findReleasePage({
      viewer: { id: userId, isSuperuser: false } as RequestUser,
      page: 0,
      size: 200,
      sort: 'date',
      order: 'asc',
      filter: 'all',
      earliest: '2026-06-07',
      latest: '2027-09-05',
      today: '2026-09-05',
      soonLatest: '2026-10-05',
      currentYear: '2026',
      ...patch,
    });
  }

  it('matches every shared class fixture in SQL, including absent overlays', async () => {
    for (const [index, fixture] of classSelectionFixtures.entries()) {
      const id = await insert(`parity-${index}`, fixture.work);
      for (const selection of [...fixture.matches, ...fixture.misses]) {
        const statement = dialect.sqlToQuery(sql`select ${classSelectionMatchSql(selection)} as matches, ${bookClassSql()} as book
          from ${schema.authorCatalogWorks} left join ${schema.monitoredAuthorWorks}
          on ${schema.monitoredAuthorWorks.workId} = ${schema.authorCatalogWorks.id}
          where ${schema.authorCatalogWorks.id} = ${id}`);
        const result = await client.query(statement.sql, statement.params);
        expect(result.rows[0].matches, fixture.name).toBe(workMatchesClassSelection(fixture.work, selection));
        expect(result.rows[0].book, fixture.name).toBe(workMatchesClassSelection(fixture.work, { kinds: ['book'], more: [] }));
      }
      await client.query('delete from author_catalog_works where id = $1', [id]);
    }
  });

  it('counts every shared class fixture per display class like countWorkClasses, for the owner only', async () => {
    const suffix = randomUUID();
    const countUsers = await client.query<{ id: number }>(
      "insert into users (username, name, password_hash) values ($1, 'Counts E2E', 'unused'), ($2, 'Counts Other', 'unused') returning id",
      [`counts-${suffix}`, `counts-other-${suffix}`],
    );
    const [ownerId, strangerId] = countUsers.rows.map((row) => row.id);
    try {
      const owned = randomUUID();
      const foreign = randomUUID();
      for (const [id, owner] of [
        [owned, ownerId],
        [foreign, strangerId],
      ]) {
        await client.query(
          "insert into monitored_authors (id, owner_user_id, author_name, ebook_mode, audiobook_mode, added_at) values ($1, $2, $3, 'notify', 'notify', now())",
          [id, owner, `Counts E2E ${id}`],
        );
      }
      for (const [index, fixture] of classSelectionFixtures.entries()) {
        await insert(`count-${index}`, fixture.work, owned);
        await insert(`count-${index}`, fixture.work, foreign);
      }

      const counts = await store.countWorkClasses({ id: ownerId, isSuperuser: false } as RequestUser);

      expect(counts).toEqual(countWorkClasses(classSelectionFixtures.map((fixture) => fixture.work)));

      const suspect = { verdict: 'suspect', flags: ['wrong_contributor'], userVisibility: 'hidden' } as Partial<MonitoredWork>;
      const hiddenMonitor = randomUUID();
      await client.query(
        "insert into monitored_authors (id, owner_user_id, author_name, ebook_mode, audiobook_mode, added_at) values ($1, $2, $3, 'notify', 'notify', now())",
        [hiddenMonitor, ownerId, `Counts Hidden ${hiddenMonitor}`],
      );
      await insert('hidden-suspect', suspect, hiddenMonitor);
      const after = await store.countWorkClasses({ id: ownerId, isSuperuser: false } as RequestUser);
      expect(after.hidden).toBe(counts.hidden + 1);
      expect(after.unconfirmed).toBe(counts.unconfirmed);

      const pausedMonitor = randomUUID();
      await client.query(
        "insert into monitored_authors (id, owner_user_id, author_name, ebook_mode, audiobook_mode, paused, added_at) values ($1, $2, $3, 'notify', 'notify', true, now())",
        [pausedMonitor, ownerId, `Counts Paused ${pausedMonitor}`],
      );
      await insert('paused-hidden', suspect, pausedMonitor);
      expect(await store.countWorkClasses({ id: ownerId, isSuperuser: false } as RequestUser)).toEqual(after);
    } finally {
      await client.query('delete from users where id = any($1::int[])', [[ownerId, strangerId]]);
    }
  });

  it('preserves Book rows and handles old dates, undated formats, scope, filters and stable pages', async () => {
    const book = await insert('book', { ebookReleaseDate: '2026-09-01' });
    await insert('old-book', { ebookReleaseDate: '2012-01-01' });
    await insert('unwatched-book', { ebookReleaseDate: '2026-09-01', monitorFormats: { ebook: false } });
    const old = await insert('old-unconfirmed', { verdict: 'probable', ebookReleaseDate: '2012-01-01' });
    const hidden = await insert('hidden', { userVisibility: 'hidden' });
    const ebookOnly = await insert('ebook-only', { verdict: 'probable', ebookReleaseDate: '2015-01-01' });
    const audioOnly = await insert('audio-only', { userVisibility: 'hidden' }, audioMonitorId);
    await insert('other', { userVisibility: 'hidden' }, otherMonitorId);
    const defaults = await page();
    expect(defaults.items.map((row) => [row.work.id, row.format])).toEqual([[book, 'ebook']]);
    const review = await page({ kinds: [], more: ['unconfirmed'] });
    expect(review.items.map((row) => [row.work.id, row.format, row.releaseDate])).toEqual([
      [old, 'ebook', '2012-01-01'],
      [ebookOnly, 'ebook', '2015-01-01'],
    ]);
    const hiddenPage = await page({ kinds: [], more: ['hidden'] });
    expect(hiddenPage.items.map((row) => [row.work.id, row.format, row.releaseDate])).toEqual([
      [audioOnly, 'audiobook', null],
      [hidden, 'audiobook', null],
      [hidden, 'ebook', null],
    ]);
    expect(hiddenPage.cards).toEqual({ byStatus: 2, byWork: 2 });
    for (const filter of ['recent', 'soon', 'year'] as const) {
      expect((await page({ kinds: [], more: ['hidden'], filter })).total).toBe(0);
    }
    for (const order of ['asc', 'desc'] as const) {
      const query = { kinds: [] as [], more: ['hidden', 'unconfirmed'] as ('hidden' | 'unconfirmed')[], order };
      const all = await page(query);
      expect(all.items.slice(-3).every((row) => row.releaseDate === null)).toBe(true);
      const first = await page({ ...query, size: 3 });
      const second = await page({ ...query, size: 3, page: 1 });
      const key = (row: (typeof all.items)[number]) => `${row.work.id}:${row.format}`;
      expect([...first.items, ...second.items].map(key)).toEqual(all.items.map(key));
      expect(new Set([...first.items, ...second.items].map(key)).size).toBe(all.total);
    }
    expect((await page({ kinds: [], more: ['hidden'], status: ['upcoming'] })).total).toBe(3);
    expect((await page({ kinds: [], more: ['hidden'], status: ['upcoming', 'hidden'] })).total).toBe(3);
    expect((await page({ kinds: [], more: ['hidden'], status: ['hidden'] })).total).toBe(3);
  });
  it('lists an unconfirmed work with only an audio date as one undated row for an ebook-only author', async () => {
    const ebookOnlyAuthor = randomUUID();
    await client.query(
      "insert into monitored_authors (id, owner_user_id, author_name, ebook_mode, audiobook_mode, added_at) values ($1, $2, $3, 'notify', 'off', now())",
      [ebookOnlyAuthor, userId, `Review E2E ${ebookOnlyAuthor}`],
    );
    await client.query('insert into author_catalog_state (monitor_author_id, fetched_at) values ($1, now())', [ebookOnlyAuthor]);
    const id = await insert('ebook-only-author', { verdict: 'probable', audioReleaseDate: '2026-09-01' }, ebookOnlyAuthor);
    const rows = (await page({ q: 'ebook-only-author', kinds: [], more: ['unconfirmed'] })).items;
    expect(rows.map((row) => [row.work.id, row.format, row.releaseDate])).toEqual([[id, 'ebook', null]]);
  });

  it('lists a review work by its probe date when the catalog column is empty', async () => {
    const id = await insert('probe-dated', { userVisibility: 'hidden' });
    await client.query(
      "insert into author_catalog_work_releases (work_id, monitor_author_id, owner_user_id, format, status, release_date, date_precision, next_check_at) values ($1,$2,$3,'ebook','dated','2014-05-06','day',now())",
      [id, monitorId, userId],
    );
    const rows = (await page({ q: 'probe-dated', kinds: [], more: ['hidden'] })).items;
    expect(rows.map((row) => [row.work.id, row.format, row.releaseDate])).toEqual([[id, 'ebook', '2014-05-06']]);
  });

  it('reaches non-Book kinds and placeholders while retaining Book windows and status buckets', async () => {
    const collection = await insert('extras-collection', {
      userKind: 'collection',
      ebookReleaseDate: '2040-01-01',
      audioReleaseDate: '2010-01-01',
      monitorFormats: { ebook: false },
    });
    const placeholder = await insert('extras-placeholder', { flags: ['placeholder'] });
    const hiddenDated = await insert('extras-hidden', { userVisibility: 'hidden', userKind: 'book', ebookReleaseDate: '2011-01-01' });
    await insert('extras-old-book', { ebookReleaseDate: '2012-01-01' });
    const options = {
      q: 'extras-',
      kinds: ['book', 'collection'] as ('book' | 'collection')[],
      more: ['hidden', 'placeholders'] as ('hidden' | 'placeholders')[],
    };
    const all = await page(options);
    expect(all.items.map((row) => [row.work.id, row.format, row.releaseDate])).toEqual([
      [collection, 'audiobook', '2010-01-01'],
      [hiddenDated, 'ebook', '2011-01-01'],
      [collection, 'ebook', '2040-01-01'],
      [placeholder, 'audiobook', null],
      [placeholder, 'ebook', null],
    ]);
    expect(all.cards).toEqual({ byStatus: 4, byWork: 3 });
    expect((await page({ ...options, status: ['not_watched'] })).items.map((row) => [row.work.id, row.format])).toEqual([[collection, 'ebook']]);
    expect((await page({ ...options, status: ['missing'] })).items.map((row) => [row.work.id, row.format])).toEqual([
      [collection, 'audiobook'],
      [hiddenDated, 'ebook'],
    ]);
    expect((await page({ ...options, filter: 'recent' })).items.map((row) => row.releaseDate)).toEqual(['2010-01-01', '2011-01-01']);
  });
});
