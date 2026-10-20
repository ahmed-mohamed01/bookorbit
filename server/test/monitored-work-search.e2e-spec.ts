import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { MetadataService } from '../src/modules/metadata/metadata.service';
import { MonitoredStoreService } from '../src/modules/monitored/monitored-store.service';
import type { RequestUser } from '../src/common/types/request-user';
import { makeMetadataNoopMock } from './e2e/app-harness';

describe('Monitored work search (e2e)', { timeout: 60_000 }, () => {
  let app: NestFastifyApplication | undefined;
  let client: Client;
  let store: MonitoredStoreService;
  let userId: number;
  let otherUserId: number;
  let libraryId: number | undefined;
  let monitorId: string;
  let otherMonitorId: string;
  let bookId: number;
  let viewer: RequestUser;

  const BULK_AUTHORS = 205;

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
      "insert into users (username, name, password_hash) values ($1, 'Search E2E', 'unused'), ($2, 'Search Other', 'unused') returning id",
      [`wsearch-${suffix}`, `wsearch-other-${suffix}`],
    );
    [userId, otherUserId] = users.rows.map((row) => row.id);
    // A superuser reads ownership from the matched book alone, so no library grant is needed.
    viewer = { id: userId, isSuperuser: true } as RequestUser;

    monitorId = randomUUID();
    otherMonitorId = randomUUID();
    for (const [id, owner, name] of [
      [monitorId, userId, `Search Author ${suffix}`],
      [otherMonitorId, otherUserId, `Search Other Author ${suffix}`],
    ]) {
      await client.query(
        "insert into monitored_authors (id, owner_user_id, author_name, ebook_mode, audiobook_mode, added_at) values ($1, $2, $3, 'notify', 'notify', now())",
        [id, owner, name],
      );
      await client.query('insert into author_catalog_state (monitor_author_id, fetched_at) values ($1, now())', [id]);
    }

    const library = await client.query<{ id: number }>('insert into libraries (name) values ($1) returning id', [`wsearch-${suffix}`]);
    libraryId = library.rows[0].id;
    const folder = await client.query<{ id: number }>('insert into library_folders (library_id, path) values ($1, $2) returning id', [
      libraryId,
      `/wsearch/${suffix}`,
    ]);
    const book = await client.query<{ id: number }>(
      'insert into books (library_id, library_folder_id, folder_path) values ($1, $2, $3) returning id',
      [libraryId, folder.rows[0].id, `/wsearch/${suffix}/owned`],
    );
    bookId = book.rows[0].id;
  });

  afterAll(async () => {
    if (libraryId) await client.query('delete from libraries where id = $1', [libraryId]);
    if (userId) await client.query('delete from users where id = any($1::int[])', [[userId, otherUserId]]);
    await client?.end();
    await app?.close();
  });

  type WorkSeed = { title: string; series?: string; index?: string; owned?: boolean; hidden?: boolean; author?: string };

  async function seed(works: WorkSeed[]) {
    for (const [position, work] of works.entries()) {
      const author = work.author ?? monitorId;
      const id = `ws-${position}-${author}`;
      await client.query(
        `insert into author_catalog_works (id, monitor_author_id, title, series_name, series_index, verdict, flags, owned_formats, matched_ebook_book_id)
         values ($1, $2, $3, $4, $5, 'verified', '[]'::jsonb, $6::jsonb, $7)`,
        [id, author, work.title, work.series ?? null, work.index ?? null, work.owned ? '["ebook"]' : '[]', work.owned ? bookId : null],
      );
      if (work.hidden) {
        await client.query('insert into monitored_author_works (work_id, monitor_author_id, user_visibility) values ($1, $2, $3)', [
          id,
          author,
          'hidden',
        ]);
      }
    }
  }

  async function clearWorks() {
    await client.query('delete from author_catalog_works where monitor_author_id = any($1::varchar[])', [[monitorId, otherMonitorId]]);
  }

  afterEach(clearWorks);

  async function pageTitles() {
    const page = await store.searchWorks({ viewer, q: 'primal', page: 0, size: 100 });
    return { titles: page.items.map((item) => item.work.title), total: page.total };
  }

  async function catalogTitles() {
    const hits = await store.searchCatalogWorks(viewer, 'primal', 100);
    return hits.map((hit) => hit.work.title);
  }

  it('lists prefix matches before contains matches, ignoring a leading article', async () => {
    await seed([
      { title: 'Zed Primal' },
      { title: 'The Primal Scream' },
      { title: 'Alpha Primal' },
      { title: 'A Primal Zebra' },
      { title: 'Wild Primal Trail', series: 'Wild Tales', index: '1' },
      { title: 'Awakening Primal Beast', series: 'Primal Chronicles', index: '1' },
    ]);

    const { titles } = await pageTitles();

    expect(titles).toEqual(['Awakening Primal Beast', 'The Primal Scream', 'A Primal Zebra', 'Alpha Primal', 'Wild Primal Trail', 'Zed Primal']);
    expect(await catalogTitles()).toEqual(titles);
  });

  it('runs a series in numeric index order with non-numeric and missing indexes after', async () => {
    await seed([
      { title: 'Primal Hunter Null', series: 'The Primal Hunter' },
      { title: 'Primal Hunter 10', series: 'The Primal Hunter', index: '10' },
      { title: 'Primal Hunter Extra', series: 'The Primal Hunter', index: '2-3' },
      { title: 'Primal Hunter 2', series: 'The Primal Hunter', index: '2' },
      { title: 'Primal Hunter 0.5', series: 'The Primal Hunter', index: '0.5' },
    ]);

    const { titles } = await pageTitles();

    expect(titles).toEqual(['Primal Hunter 0.5', 'Primal Hunter 2', 'Primal Hunter 10', 'Primal Hunter Extra', 'Primal Hunter Null']);
  });

  it('interleaves books without a series with series by article-insensitive title', async () => {
    await seed([
      { title: 'The Primal Scream' },
      { title: 'Primal Hunter 2', series: 'The Primal Hunter', index: '2' },
      { title: 'A Primal Chord' },
      { title: 'Primal Hunter 1', series: 'The Primal Hunter', index: '1' },
      { title: 'An Primal Zone' },
    ]);

    const { titles } = await pageTitles();

    expect(titles).toEqual(['A Primal Chord', 'Primal Hunter 1', 'Primal Hunter 2', 'The Primal Scream', 'An Primal Zone']);
  });

  it('includes owned works on the page and leaves them out of the palette', async () => {
    await seed([{ title: 'Primal Owned', owned: true }, { title: 'Primal Wanted' }]);

    const { titles, total } = await pageTitles();

    expect(titles).toEqual(['Primal Owned', 'Primal Wanted']);
    expect(total).toBe(2);
    expect(await catalogTitles()).toEqual(['Primal Wanted']);
  });

  it("never returns hidden works or another user's works", async () => {
    await seed([{ title: 'Primal Visible' }, { title: 'Primal Hidden', hidden: true }, { title: 'Primal Foreign', author: otherMonitorId }]);

    const { titles, total } = await pageTitles();

    expect(titles).toEqual(['Primal Visible']);
    expect(total).toBe(1);
    expect(await catalogTitles()).toEqual(['Primal Visible']);
    const foreign = await store.searchWorks({ viewer: { id: otherUserId, isSuperuser: false } as RequestUser, q: 'primal', page: 0, size: 100 });
    expect(foreign.items.map((item) => item.work.title)).toEqual(['Primal Foreign']);
  });

  it('finds the works of an author matched only by name even when more than 200 authors match', async () => {
    const suffix = randomUUID();
    await client.query(
      `insert into monitored_authors (id, owner_user_id, author_name, ebook_mode, audiobook_mode, added_at)
       select gen_random_uuid(), $1, 'Primal Author ' || lpad(n::text, 3, '0') || ' ' || $2, 'notify', 'notify', now()
       from generate_series(0, $3::int - 1) as n`,
      [userId, suffix, BULK_AUTHORS],
    );
    const authors = await client.query<{ id: string; author_name: string }>(
      "select id, author_name from monitored_authors where owner_user_id = $1 and author_name like 'Primal Author %' order by author_name",
      [userId],
    );
    expect(authors.rows).toHaveLength(BULK_AUTHORS);
    const last = authors.rows[BULK_AUTHORS - 1].id;
    const first = authors.rows[0].id;
    await seed([{ title: 'Quiet Last Work', author: last }, { title: 'Quiet First Work', author: first }, { title: 'Primal Title Hit' }]);

    try {
      const { titles, total } = await pageTitles();
      expect(total).toBe(3);
      expect(titles).toEqual(['Primal Title Hit', 'Quiet First Work', 'Quiet Last Work']);
      expect(await catalogTitles()).toEqual(titles);
    } finally {
      await client.query("delete from monitored_authors where owner_user_id = $1 and author_name like 'Primal Author %'", [userId]);
    }
  });
});
