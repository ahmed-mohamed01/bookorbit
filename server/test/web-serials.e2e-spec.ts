import { rm } from 'fs/promises';

import { asc, eq, sql } from 'drizzle-orm';
import { vi } from 'vitest';
import { NotificationType, Permission, planWebSerialMangaVolumes } from '@bookorbit/types';
import type {
  MoveWebSerialJobResult,
  WebSerialCapabilities,
  WebSerialClearFinishedResult,
  WebSerialDiscoverResult,
  WebSerialJob,
  WebSerialJobDetail,
  WebSerialJobList,
  WebSerialMangaExtensionPage,
  WebSerialMoveCandidates,
  WebSerialNovelIndexStatus,
  WebSerialNovelProviders,
  WebSerialSearchResult,
  WebSerialSeriesDetail,
  WebSerialSeriesLookup,
  WebSerialSettings,
  WebSerialSourceOptions,
  WebSerialSuggestResult,
} from '@bookorbit/types';

import {
  webSerialImports,
  webSerialJobItems,
  webSerialJobs,
  webSerialNovelIndex,
  webSerialNovelIndexSources,
  webSerialNovelPrefs,
} from '../src/modules/web-serials/schema/web-serials.schema';
import { WebSerialsNovelIndexFillerService } from '../src/modules/web-serials/web-serials-novel-index-filler.service';
import { WebSerialsNovelIndexRepository } from '../src/modules/web-serials/web-serials-novel-index.repository';
import * as schema from '../src/db/schema';
import { WebSerialsSettingsService } from '../src/modules/web-serials/web-serials-settings.service';
import {
  api,
  closeWebSerialsContext,
  configureEngines,
  countBooks,
  createJob,
  createLibrary,
  createWebSerialsContext,
  ensureUser,
  getJob,
  itemRows,
  jobStatus,
  listBooks,
  readCbzComicInfo,
  readCbzPages,
  resetWebSerialsState,
  restartApp,
  waitFor,
  waitForJob,
  webSerialNotifications,
  zipEntryNames,
  type WebSerialsContext,
  type WebSerialsLibrary,
} from './e2e/web-serials/web-serials-harness';
import {
  generateMangaChapters,
  generateNovelVolumes,
  type FakeManga,
  type FakeMangaChapter,
  type FakeNovel,
  type Gate,
} from './e2e/web-serials/fake-serial-engines';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SOURCE_A = { id: '1001', name: 'Alpha Scans', lang: 'en' };
const SOURCE_B = { id: '1002', name: 'Beta Reader', lang: 'en' };

describe('Web Serials (e2e)', () => {
  let ctx!: WebSerialsContext;
  let library!: WebSerialsLibrary;
  const suwayomi = () => ctx.fakes.suwayomi;
  const lncrawl = () => ctx.fakes.lncrawl;

  beforeAll(async () => {
    ctx = await createWebSerialsContext();
  });

  afterAll(async () => {
    if (ctx) await closeWebSerialsContext(ctx);
  });

  beforeEach(async () => {
    await resetWebSerialsState(ctx);
    library = await createLibrary(ctx);
  });

  // ---------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------

  function seedManga(
    input: { title: string; chapters?: number | FakeMangaChapter[]; sourceId?: string; chaptersPerVolume?: number } & Record<string, unknown>,
  ): FakeManga {
    if (!suwayomi().sources.some((source) => source.id === (input.sourceId ?? SOURCE_A.id))) {
      suwayomi().addSource(input.sourceId === SOURCE_B.id ? SOURCE_B : SOURCE_A);
    }
    const { chapters, chaptersPerVolume, ...rest } = input;
    const list = Array.isArray(chapters) ? chapters : generateMangaChapters({ count: chapters ?? 3, chaptersPerVolume });
    return suwayomi().addManga({ author: 'Author A', artist: 'Artist B', ...rest, chapters: list });
  }

  function seedNovel(volumes = 3, chaptersPerVolume = 10, title = 'The Long Road'): FakeNovel {
    return lncrawl().addNovel({ title, authors: 'Writer One, Writer Two', volumes: generateNovelVolumes(volumes, chaptersPerVolume) });
  }

  async function configure(
    options: { manga?: boolean; novel?: boolean; maxConcurrentJobs?: number; mangaSourceIds?: string[]; novelDomains?: string[] } = {},
  ) {
    await configureEngines(ctx, { library, ...options });
  }

  function mangaJobBody(manga: FakeManga, extra: Record<string, unknown> = {}) {
    return { seriesKey: `m:${manga.id}`, packaging: 'chapter', selection: { mode: 'all' }, libraryId: library.libraryId, ...extra };
  }

  function novelJobBody(novel: FakeNovel, extra: Record<string, unknown> = {}) {
    return { seriesKey: `n:${novel.id}`, packaging: 'volume', selection: { mode: 'all' }, libraryId: library.libraryId, ...extra };
  }

  async function runToEnd(token: string, body: Record<string, unknown>): Promise<WebSerialJob> {
    const job = await createJob(ctx, token, body);
    return waitForJob(ctx, job.id);
  }

  async function until(check: () => Promise<boolean> | boolean, description: string, timeoutMs = 20_000) {
    await waitFor(
      async () => {
        await ctx.runner.tick();
        return check();
      },
      description,
      timeoutMs,
    );
  }

  async function gateReached(gate: Gate) {
    await until(() => gate.touched, 'the runner never reached the held unit');
  }

  async function itemStatuses(jobId: number): Promise<Record<string, string>> {
    return Object.fromEntries((await itemRows(ctx, jobId)).map((item) => [item.sequence, item.status]));
  }

  async function jobFromList(token: string, id: number, scope = 'mine'): Promise<WebSerialJob | undefined> {
    const response = await api(ctx, 'GET', `/web-serials/jobs?scope=${scope}&limit=100`, token);
    expect(response.statusCode).toBe(200);
    return (response.json() as WebSerialJobList).items.find((job) => job.id === id);
  }

  function matchSeries(overrides: Partial<Parameters<typeof ctx.fakes.mangabaka.addSeries>[0]> & { id: number; title: string }) {
    return ctx.fakes.mangabaka.addSeries({
      authors: ['Canonical Writer'],
      artists: ['Canonical Artist'],
      genres: ['slice_of_life', 'adventure'],
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------------------
  // admin settings and connection tests
  // ---------------------------------------------------------------------------------------

  describe('admin settings', () => {
    it('saves both connections, never returns a password, and records a connection test', async () => {
      seedManga({ title: 'Settings Series' });
      seedNovel();
      await configure({ maxConcurrentJobs: 3 });

      const settings = (await api(ctx, 'GET', '/web-serials/admin/settings', ctx.admin.token)).json() as WebSerialSettings;
      expect(settings.manga).toMatchObject({
        url: suwayomi().url,
        username: 'suwayomi',
        passwordConfigured: true,
        targetLibraryId: library.libraryId,
      });
      expect(settings.novel).toMatchObject({ url: lncrawl().url, username: 'crawler@example.com', passwordConfigured: true });
      expect(settings.maxConcurrentJobs).toBe(3);
      expect(JSON.stringify(settings)).not.toContain('suwayomi-secret');
      expect(JSON.stringify(settings)).not.toContain('crawler-secret');

      const manga = await api(ctx, 'POST', '/web-serials/admin/test', ctx.admin.token, { kind: 'manga' });
      expect(manga.statusCode).toBe(200);
      expect(manga.json()).toMatchObject({ ok: true, version: suwayomi().version, searchableSources: 1, error: null });
      const novel = await api(ctx, 'POST', '/web-serials/admin/test', ctx.admin.token, { kind: 'novel' });
      expect(novel.json()).toMatchObject({ ok: true, version: lncrawl().version, searchableSources: 1 });

      const after = (await api(ctx, 'GET', '/web-serials/admin/settings', ctx.admin.token)).json() as WebSerialSettings;
      expect(after.manga.lastCheck?.ok).toBe(true);
      expect(after.novel.lastCheck?.ok).toBe(true);
    });

    it('reports bad credentials and an unreachable address as a failed check, not an error', async () => {
      seedManga({ title: 'Settings Series' });
      await configure({ novel: false });
      suwayomi().credentials = { username: 'someone-else', password: 'different' };

      const rejected = await api(ctx, 'POST', '/web-serials/admin/test', ctx.admin.token, { kind: 'manga' });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({ ok: false, searchableSources: 0 });
      expect((rejected.json() as { error: string }).error).toMatch(/credentials/i);

      const draft = await api(ctx, 'POST', '/web-serials/admin/test', ctx.admin.token, { kind: 'manga', url: 'http://127.0.0.1:1', password: 'x' });
      expect(draft.json()).toMatchObject({ ok: false });
      const stored = (await api(ctx, 'GET', '/web-serials/admin/settings', ctx.admin.token)).json() as WebSerialSettings;
      expect(stored.manga.url).toBe(suwayomi().url);
    });

    it('refuses a draft test of a new address without its password, and a link-local address', async () => {
      await configure({ novel: false });
      const missingPassword = await api(ctx, 'POST', '/web-serials/admin/test', ctx.admin.token, { kind: 'manga', url: 'http://127.0.0.1:2' });
      expect(missingPassword.json()).toMatchObject({ ok: false, error: expect.stringContaining('password') });

      const linkLocal = await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { manga: { url: 'http://169.254.169.254/' } });
      expect(linkLocal.statusCode).toBeGreaterThanOrEqual(400);
      expect(linkLocal.statusCode).toBeLessThan(500);
    });

    it('validates the payload at the boundary', async () => {
      expect((await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { maxConcurrentJobs: 9 })).statusCode).toBe(400);
      expect((await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { manga: { url: 'ftp://nope' } })).statusCode).toBe(400);
      expect((await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { surprise: true })).statusCode).toBe(400);
      expect((await api(ctx, 'POST', '/web-serials/admin/test', ctx.admin.token, { kind: 'comics' })).statusCode).toBe(400);
    });

    it('lists manga sources and novel domains for the pickers, and tests the lookup provider', async () => {
      suwayomi().addSource({ id: '1002', name: 'Zeta', lang: 'ja' });
      suwayomi().addSource({ id: '1001', name: 'Alpha', lang: 'en' });
      lncrawl().addNovel({ title: 'A', domain: 'zz.example', volumes: generateNovelVolumes(1, 1) });
      lncrawl().addNovel({ title: 'B', domain: 'aa.example', volumes: generateNovelVolumes(1, 1) });
      await configure();

      const manga = await api(ctx, 'GET', '/web-serials/admin/manga-sources', ctx.admin.token);
      expect((manga.json() as Array<{ id: string; lang: string }>).map((source) => `${source.lang}:${source.id}`)).toEqual(['en:1001', 'ja:1002']);
      const novel = await api(ctx, 'GET', '/web-serials/admin/novel-sources', ctx.admin.token);
      expect((novel.json() as Array<{ domain: string }>).map((source) => source.domain)).toEqual(['aa.example', 'zz.example']);

      const lookup = await api(ctx, 'POST', '/web-serials/admin/lookup/test', ctx.admin.token);
      expect(lookup.json()).toMatchObject({ ok: true, error: null });
      ctx.fakes.mangabaka.failOp('search', { mode: 'status', status: 503, times: 1 });
      const failing = await api(ctx, 'POST', '/web-serials/admin/lookup/test', ctx.admin.token);
      expect(failing.json()).toMatchObject({ ok: false });
    });
  });

  // ---------------------------------------------------------------------------------------
  // capabilities
  // ---------------------------------------------------------------------------------------

  describe('capabilities', () => {
    it('reports what is available and whether the caller can add to the default library', async () => {
      seedManga({ title: 'Cap Series' });
      seedNovel();
      await configure();

      const mine = (await api(ctx, 'GET', '/web-serials/capabilities', ctx.user.token)).json() as WebSerialCapabilities;
      expect(mine.manga).toEqual({ available: true, searchable: true, defaultLibraryId: library.libraryId, targetFolderId: library.folderId });
      expect(mine.novel).toEqual({
        available: true,
        searchable: true,
        acceptsLinks: true,
        defaultLibraryId: library.libraryId,
        targetFolderId: library.folderId,
      });

      const noAccess = (await api(ctx, 'GET', '/web-serials/capabilities', ctx.other.token)).json() as WebSerialCapabilities;
      expect(noAccess.manga.available).toBe(true);
      expect(noAccess.manga.defaultLibraryId).toBeNull();
      expect(noAccess.novel.defaultLibraryId).toBeNull();
      expect(noAccess.manga.targetFolderId).toBeNull();
    });

    it('marks an unconfigured engine unavailable and an engine with no domains unsearchable', async () => {
      seedNovel();
      await configure({ manga: false });
      await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { manga: { url: '' }, novel: { searchDomains: [] } });
      const caps = (await api(ctx, 'GET', '/web-serials/capabilities', ctx.user.token)).json() as WebSerialCapabilities;
      expect(caps.manga.available).toBe(false);
      expect(caps.novel).toMatchObject({ available: true, searchable: false, acceptsLinks: true });
    });
  });

  // ---------------------------------------------------------------------------------------
  // search, resolve, detail, lookup
  // ---------------------------------------------------------------------------------------

  describe('search and series', () => {
    it('searches manga across the chosen sources only, reports failing sources, and caches the result', async () => {
      suwayomi().addSource(SOURCE_A);
      suwayomi().addSource(SOURCE_B);
      suwayomi().addSource({ id: '1003', name: 'Gamma', lang: 'en' });
      const a = seedManga({ title: 'Quest Hero', sourceId: SOURCE_A.id });
      seedManga({ title: 'Quest Hero', sourceId: SOURCE_B.id });
      seedManga({ title: 'Quest Hero', sourceId: '1003' });
      await configure({ mangaSourceIds: [SOURCE_A.id, SOURCE_B.id, '1003'], novel: false });
      suwayomi().failSource(SOURCE_B.id);

      const response = await api(ctx, 'GET', '/web-serials/search?q=quest&kind=manga', ctx.user.token);
      expect(response.statusCode).toBe(200);
      const result = response.json() as WebSerialSearchResult;
      expect(result.hits.map((hit) => hit.sourceName).sort()).toEqual(['Alpha Scans', 'Gamma']);
      expect(result.failedSources).toEqual(['Beta Reader']);
      const hit = result.hits.find((entry) => entry.sourceName === 'Alpha Scans')!;
      expect(hit).toMatchObject({ seriesKey: `m:${a.id}`, kind: 'manga', title: 'Quest Hero', author: 'Author A', url: null });
      expect(hit.coverUrl).toBe(`/api/v1/web-serials/series/m:${a.id}/cover`);
      expect(JSON.stringify(result)).not.toContain('127.0.0.1');
      expect(suwayomi().count('graphql:BookOrbitSearch')).toBe(3);

      suwayomi().clearPlans();
      await configure({ mangaSourceIds: [SOURCE_A.id], novel: false });
      const narrowed = (await api(ctx, 'GET', '/web-serials/search?q=quest&kind=manga', ctx.user.token)).json() as WebSerialSearchResult;
      expect(narrowed.hits.map((entry) => entry.sourceName)).toEqual(['Alpha Scans']);

      const before = suwayomi().count('graphql:BookOrbitSearch');
      await api(ctx, 'GET', '/web-serials/search?q=quest&kind=manga', ctx.user.token);
      expect(suwayomi().count('graphql:BookOrbitSearch')).toBe(before);
    });

    it('ranks hits matching a MangaBaka title first and makes one MangaBaka search per query', async () => {
      seedManga({ title: 'Ember' });
      seedManga({ title: 'Ember Legends' });
      matchSeries({ id: 4242, title: 'Ember Legends' });
      await configure({ novel: false });

      const first = (await api(ctx, 'GET', '/web-serials/search?q=ember&kind=manga', ctx.user.token)).json() as WebSerialSearchResult;
      expect(first.hits.map((entry) => entry.title)).toEqual(['Ember Legends', 'Ember']);
      await api(ctx, 'GET', '/web-serials/search?q=ember&kind=manga', ctx.user.token);
      expect(ctx.fakes.mangabaka.count('search')).toBe(1);
    });

    it('searches novels by domain and returns link-only hits, and both kinds at once', async () => {
      seedManga({ title: 'Wanderer Manga' });
      lncrawl().addNovel({ title: 'Wanderer Novel', domain: 'one.example', volumes: generateNovelVolumes(2, 5) });
      lncrawl().addNovel({ title: 'Wanderer Other', domain: 'two.example', volumes: generateNovelVolumes(2, 5) });
      await configure({ novelDomains: ['one.example', 'two.example'] });

      const novels = (await api(ctx, 'GET', '/web-serials/search?q=wanderer&kind=novel', ctx.user.token)).json() as WebSerialSearchResult;
      expect(novels.hits).toHaveLength(2);
      expect(novels.hits[0]).toMatchObject({ kind: 'novel', seriesKey: null, coverUrl: null });
      expect(novels.hits[0]!.url).toMatch(/^https:\/\/(one|two)\.example\//);

      const all = (await api(ctx, 'GET', '/web-serials/search?q=wanderer', ctx.user.token)).json() as WebSerialSearchResult;
      expect(all.hits.map((hit) => hit.kind).sort()).toEqual(['manga', 'novel', 'novel']);
      expect(lncrawl().count('login')).toBeLessThanOrEqual(2);
    });

    it('reports a novel site that failed to answer while the others still return results', async () => {
      lncrawl().addNovel({ title: 'Partial Novel', domain: 'good.example', volumes: generateNovelVolumes(1, 2) });
      lncrawl().addNovel({ title: 'Partial Novel', domain: 'bad.example', volumes: generateNovelVolumes(1, 2) });
      await configure({ manga: false, novelDomains: ['good.example', 'bad.example'] });
      lncrawl().failJobs({ type: 'search-sources', domain: 'bad.example', times: Infinity, error: 'site down' });

      const result = (await api(ctx, 'GET', '/web-serials/search?q=partial&kind=novel', ctx.user.token)).json() as WebSerialSearchResult;
      expect(result.hits.map((hit) => hit.sourceName)).toEqual(['good.example']);
      expect(result.failedSources).toEqual(['bad.example']);
    });

    describe('light novel providers', () => {
      const providers = async (token = ctx.user.token) =>
        (await api(ctx, 'GET', '/web-serials/novel-providers', token)).json() as WebSerialNovelProviders;
      const disable = (domains: string[], token = ctx.user.token) =>
        api(ctx, 'PUT', '/web-serials/novel-providers', token, { disabledDomains: domains });

      beforeEach(async () => {
        lncrawl().addNovel({ title: 'Wanderer One', domain: 'one.example', volumes: generateNovelVolumes(1, 2) });
        lncrawl().addNovel({ title: 'Wanderer Two', domain: 'two.example', volumes: generateNovelVolumes(1, 2) });
        lncrawl().addNovel({ title: 'Wanderer Three', domain: 'three.example', volumes: generateNovelVolumes(1, 2) });
        await configure({ manga: false, novelDomains: ['one.example', 'two.example'] });
      });

      it('lists the admin domains with the caller on/off and every site the crawler supports by link', async () => {
        const initial = await providers();
        expect(initial.search).toEqual([
          { domain: 'one.example', name: 'one.example', enabled: true },
          { domain: 'two.example', name: 'two.example', enabled: true },
        ]);
        expect(initial.linkSites.map((site) => site.domain).sort()).toEqual(['one.example', 'three.example', 'two.example']);
        expect(initial).toMatchObject({ linkSitesTotal: 3, unavailable: false });
      });

      it('keeps a preference per user, drops unknown domains, and never lets a user enable what the admin did not', async () => {
        const saved = await disable(['two.example', 'three.example', 'nope.example']);
        expect(saved.statusCode).toBe(200);
        expect((saved.json() as WebSerialNovelProviders).search.map((entry) => [entry.domain, entry.enabled])).toEqual([
          ['one.example', true],
          ['two.example', false],
        ]);

        expect((await providers()).search.map((entry) => entry.enabled)).toEqual([true, false]);
        expect((await providers(ctx.other.token)).search.map((entry) => entry.enabled)).toEqual([true, true]);
        expect(await ctx.db.select().from(webSerialNovelPrefs)).toEqual([
          expect.objectContaining({ userId: ctx.user.userId, disabledDomains: ['two.example'] }),
        ]);

        expect((await disable([])).statusCode).toBe(200);
        expect((await providers()).search.every((entry) => entry.enabled)).toBe(true);
      });

      it('searches only the sites the caller left on, and says so when every site is off', async () => {
        await disable(['two.example']);
        const some = (await api(ctx, 'GET', '/web-serials/search?q=wanderer&kind=novel', ctx.user.token)).json() as WebSerialSearchResult;
        expect(some.hits.map((hit) => hit.sourceName)).toEqual(['one.example']);
        const other = (await api(ctx, 'GET', '/web-serials/search?q=wanderer&kind=novel', ctx.other.token)).json() as WebSerialSearchResult;
        expect(other.hits.map((hit) => hit.sourceName).sort()).toEqual(['one.example', 'two.example']);

        await disable(['one.example', 'two.example']);
        const none = (await api(ctx, 'GET', '/web-serials/search?q=wanderer&kind=novel', ctx.user.token)).json() as WebSerialSearchResult;
        expect(none).toMatchObject({ hits: [], failedSources: ['WEB_SERIAL_NOVEL_SOURCES_ALL_DISABLED'] });
      });

      it('answers from settings with an unavailable flag when the crawler cannot list its sites', async () => {
        lncrawl().failOp('sources', { mode: 'status', status: 503, times: Infinity });
        ctx.app.get(WebSerialsSettingsService).bumpCatalogVersion();
        const result = await providers();
        expect(result).toMatchObject({ linkSites: [], linkSitesTotal: 0, unavailable: true });
        expect(result.search).toHaveLength(2);
      });

      it('validates the payload and requires the Web Serials permission', async () => {
        expect((await api(ctx, 'PUT', '/web-serials/novel-providers', ctx.user.token, { disabledDomains: 'one.example' })).statusCode).toBe(400);
        expect((await api(ctx, 'PUT', '/web-serials/novel-providers', ctx.user.token, { disabledDomains: [], extra: 1 })).statusCode).toBe(400);
        expect((await api(ctx, 'GET', '/web-serials/novel-providers', ctx.outsider.token)).statusCode).toBe(403);
        expect((await disable([], ctx.outsider.token)).statusCode).toBe(403);
      });
    });

    it('rejects a query that is too short', async () => {
      await configure();
      expect((await api(ctx, 'GET', '/web-serials/search?q=a', ctx.user.token)).statusCode).toBe(400);
    });

    it('resolves a novel link to its series, and refuses a link it cannot open', async () => {
      const novel = seedNovel(2, 4, 'Linked Novel');
      await configure();

      const response = await api(ctx, 'POST', '/web-serials/resolve', ctx.user.token, { url: novel.url });
      expect(response.statusCode).toBe(200);
      const detail = response.json() as WebSerialSeriesDetail;
      expect(detail).toMatchObject({ seriesKey: `n:${novel.id}`, kind: 'novel', title: 'Linked Novel', defaultPackaging: 'volume' });
      expect(detail.packagingOptions).toEqual(['volume', 'series']);

      const unknown = await api(ctx, 'POST', '/web-serials/resolve', ctx.user.token, { url: 'https://unknown.example/book/1' });
      expect(unknown.statusCode).toBe(400);
      expect((await api(ctx, 'POST', '/web-serials/resolve', ctx.user.token, { url: 'not a url' })).statusCode).toBe(400);
    });

    it('returns series detail with chapters oldest first, parsed volumes, plain text synopsis and a same-origin cover', async () => {
      const manga = seedManga({
        title: 'Detail Series',
        description: '<p>Hello <b>world</b></p>',
        genre: ['Action', 'Drama'],
        chapters: generateMangaChapters({ count: 6, chaptersPerVolume: 3, startDate: Date.UTC(2023, 4, 1) }).reverse(),
      });
      await configure({ novel: false });

      const response = await api(ctx, 'GET', `/web-serials/series/m:${manga.id}`, ctx.user.token);
      expect(response.statusCode).toBe(200);
      const detail = response.json() as WebSerialSeriesDetail;
      expect(detail).toMatchObject({
        kind: 'manga',
        title: 'Detail Series',
        author: 'Author A',
        sourceName: 'Alpha Scans',
        chapterCount: 6,
        tags: ['Action', 'Drama'],
        defaultPackaging: 'chapter',
        importedUnitKeys: [],
        coverUrl: `/api/v1/web-serials/series/m:${manga.id}/cover`,
      });
      expect(detail.packagingOptions).toEqual(['chapter', 'volume', 'series']);
      expect(detail.synopsis).toContain('Hello');
      expect(detail.synopsis).not.toContain('<');
      expect(detail.units.map((unit) => unit.sequence)).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(detail.units.map((unit) => unit.volume)).toEqual(['1', '1', '1', '2', '2', '2']);
      expect(detail.units[0]!.publishedAt).toBe('2023-05-01T00:00:00.000Z');
      expect(detail.units[5]!.publishedAt).toBe('2023-05-06T00:00:00.000Z');
    });

    it('lists misnumbered extras where the source posted them, outside the volume plan', async () => {
      const base = generateMangaChapters({ count: 12, chaptersPerVolume: 5 });
      const extra = (id: number, number: number, name: string, sourceOrder: number) => ({
        id,
        name,
        chapterNumber: number,
        uploadDate: Date.UTC(2024, 6, 1),
        sourceOrder,
        scanlator: null,
        pages: 3,
      });
      const manga = seedManga({
        title: 'Extras Series',
        chapters: [...base, extra(9001, 1.1, 'Vol.69 Ch.1.1', 0), extra(9002, 2.3, 'Vol.98 Ch.2.3', -1)],
      });
      await configure({ novel: false });

      const detail = (await api(ctx, 'GET', `/web-serials/series/m:${manga.id}`, ctx.user.token)).json() as WebSerialSeriesDetail;
      expect(detail.units.map((unit) => unit.sequence)).toEqual([...Array.from({ length: 12 }, (_, index) => String(index + 1)), '12.001', '12.002']);
      expect(detail.units.slice(-2).map((unit) => [unit.label, unit.volume])).toEqual([
        ['Vol.69 Ch.1.1', null],
        ['Vol.98 Ch.2.3', null],
      ]);

      const planUnits = detail.units.map((unit) => ({ key: unit.key, sequence: unit.sequence, volume: unit.volume ?? null }));
      const keys = planUnits.map((unit) => unit.key);
      expect(new Set(keys.filter(Boolean)).size).toBe(detail.units.length);
      const plan = planWebSerialMangaVolumes(planUnits, { mode: 'range', fromSequence: '1', toSequence: '10' });
      expect(plan.entries).toEqual([
        { type: 'volume', volume: '1', keys: keys.slice(0, 5) },
        { type: 'volume', volume: '2', keys: keys.slice(5, 10) },
      ]);
      expect(plan.snappedRange).toBeNull();
      expect(planWebSerialMangaVolumes(planUnits, { mode: 'all' }).entries.slice(-2)).toEqual([
        { type: 'chapter', key: keys[12], volume: null },
        { type: 'chapter', key: keys[13], volume: null },
      ]);
    });

    it('refuses a manga series from a source the admin did not select', async () => {
      const allowed = seedManga({ title: 'Allowed Series', sourceId: SOURCE_A.id });
      const other = seedManga({ title: 'Other Series', sourceId: SOURCE_B.id });
      await configure({ novel: false, mangaSourceIds: [SOURCE_A.id] });

      expect((await api(ctx, 'GET', `/web-serials/series/m:${allowed.id}`, ctx.user.token)).statusCode).toBe(200);
      expect((await api(ctx, 'GET', `/web-serials/series/m:${other.id}`, ctx.user.token)).statusCode).toBe(404);
    });

    it('serves the cover through the app and rejects a series that does not exist', async () => {
      const manga = seedManga({ title: 'Cover Series' });
      await configure({ novel: false });
      const cover = await api(ctx, 'GET', `/web-serials/series/m:${manga.id}/cover`, ctx.user.token);
      expect(cover.statusCode).toBe(200);
      expect(cover.headers['content-type']).toContain('image/png');
      expect(cover.rawPayload.subarray(1, 4).toString('ascii')).toBe('PNG');

      const missing = await api(ctx, 'GET', '/web-serials/series/m:99999', ctx.user.token);
      expect(missing.statusCode).toBeGreaterThanOrEqual(400);
      for (const path of [
        '/web-serials/series/not-a-key',
        '/web-serials/series/x:1/lookup',
        '/web-serials/series/m:a%20b/sources',
        '/web-serials/series/m:/cover',
      ]) {
        const invalid = await api(ctx, 'GET', path, ctx.user.token);
        expect(invalid.statusCode).toBe(400);
        expect(JSON.stringify(invalid.json())).toContain('seriesKey');
      }
    });

    it('looks a series up: matched with MangaDex volumes, no match, disabled, and unavailable behind a breaker', async () => {
      const manga = seedManga({ title: 'Lookup Hero', chapters: 6, author: 'Writer X' });
      await configure({ novel: false });
      matchSeries({ id: 501, title: 'Lookup Hero', status: 'completed', year: 2019, anilistId: 777, authors: ['Writer X'], artists: ['Artist Y'] });
      ctx.fakes.mangadex.addEntry({ id: 'dex-1', title: 'Lookup Hero', anilistId: 777, volumes: { '1': [1, 2, 3], '2': [4, 5] } });

      const matched = (await api(ctx, 'GET', `/web-serials/series/m:${manga.id}/lookup`, ctx.user.token)).json() as WebSerialSeriesLookup;
      expect(matched.state).toBe('matched');
      expect(matched.match).toMatchObject({
        provider: 'mangabaka',
        id: '501',
        title: 'Lookup Hero',
        year: 2019,
        status: 'completed',
        authors: ['Writer X'],
        artists: ['Artist Y'],
        genres: ['Slice Of Life', 'Adventure'],
      });
      const ids = manga.chapters.map((chapter) => String(chapter.id));
      expect(matched.chapterVolumes).toEqual({ [ids[0]!]: '1', [ids[1]!]: '1', [ids[2]!]: '1', [ids[3]!]: '2', [ids[4]!]: '2' });

      const requests = ctx.fakes.mangabaka.count(/./);
      await api(ctx, 'GET', `/web-serials/series/m:${manga.id}/lookup`, ctx.user.token);
      expect(ctx.fakes.mangabaka.count(/./)).toBe(requests);

      const detail = (await api(ctx, 'GET', `/web-serials/series/m:${manga.id}`, ctx.user.token)).json() as WebSerialSeriesDetail;
      expect(detail.importedUnitKeys).toEqual([]);

      const other = seedManga({ title: 'Nobody Knows This One' });
      const none = (await api(ctx, 'GET', `/web-serials/series/m:${other.id}/lookup`, ctx.user.token)).json() as WebSerialSeriesLookup;
      expect(none).toMatchObject({ state: 'no_match', match: null, chapterVolumes: null });

      await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { lookup: { enabled: false } });
      const third = seedManga({ title: 'Lookup Disabled' });
      expect(((await api(ctx, 'GET', `/web-serials/series/m:${third.id}/lookup`, ctx.user.token)).json() as WebSerialSeriesLookup).state).toBe(
        'disabled',
      );
      await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { lookup: { enabled: true } });
    });

    it('answers unavailable (never an error) when the lookup provider is down, and stops calling it once the breaker opens', async () => {
      const series = [1, 2, 3, 4, 5].map((n) => seedManga({ title: `Breaker ${n}` }));
      await configure({ novel: false });
      ctx.fakes.mangabaka.failOp('search', { mode: 'status', status: 503, times: Infinity });

      for (const manga of series.slice(0, 3)) {
        const response = await api(ctx, 'GET', `/web-serials/series/m:${manga.id}/lookup`, ctx.user.token);
        expect(response.statusCode).toBe(200);
        expect((response.json() as WebSerialSeriesLookup).state).toBe('unavailable');
      }
      expect(ctx.fakes.mangabaka.count('search')).toBe(3);

      const afterBreaker = (await api(ctx, 'GET', `/web-serials/series/m:${series[3]!.id}/lookup`, ctx.user.token)).json() as WebSerialSeriesLookup;
      expect(afterBreaker).toMatchObject({ state: 'unavailable', match: null });
      expect(afterBreaker.message).toBeTruthy();
      expect(ctx.fakes.mangabaka.count('search')).toBe(3);

      const settings = (await api(ctx, 'GET', '/web-serials/admin/settings', ctx.admin.token)).json() as WebSerialSettings;
      expect(settings.lookup.lastCheck).toMatchObject({ ok: false });
    });

    it('offers the same series from other sources, flagging the most complete one; novels only offer the current source', async () => {
      const first = seedManga({ title: 'Many Sources', chapters: 5, sourceId: SOURCE_A.id });
      const second = seedManga({ title: 'Many Sources', chapters: 9, sourceId: SOURCE_B.id });
      seedManga({ title: 'Different Title Entirely', chapters: 20, sourceId: SOURCE_B.id });
      const novel = seedNovel();
      await configure();

      const options = (await api(ctx, 'GET', `/web-serials/series/m:${first.id}/sources`, ctx.user.token)).json() as WebSerialSourceOptions;
      expect(options.options.map((option) => ({ key: option.seriesKey, confidence: option.confidence, best: option.mostComplete }))).toEqual([
        { key: `m:${first.id}`, confidence: 'current', best: false },
        { key: `m:${second.id}`, confidence: 'title_match', best: true },
      ]);
      expect(options.options[1]!.latestAt).toBeTruthy();

      const novelOptions = (await api(ctx, 'GET', `/web-serials/series/n:${novel.id}/sources`, ctx.user.token)).json() as WebSerialSourceOptions;
      expect(novelOptions.options).toHaveLength(1);
      expect(novelOptions.options[0]).toMatchObject({ confidence: 'current', mostComplete: true });
    });
  });

  // ---------------------------------------------------------------------------------------
  // metadata-first search
  // ---------------------------------------------------------------------------------------

  describe('metadata-first search', () => {
    const discover = async (q: string, kind = 'manga', token = ctx.user.token) =>
      (await api(ctx, 'GET', `/web-serials/discover?q=${encodeURIComponent(q)}&kind=${kind}`, token)).json() as WebSerialDiscoverResult;
    const sourcesOf = async (kind: string, matchId: number, token = ctx.user.token) =>
      (await api(ctx, 'GET', `/web-serials/discover/${kind}/${matchId}/sources`, token)).json() as WebSerialSourceOptions;

    it('searches the series database only, one result per series, with no engine call', async () => {
      suwayomi().addSource(SOURCE_A);
      seedManga({ title: 'Metadata Hero' });
      matchSeries({ id: 900, title: 'Metadata Hero', year: 2021, secondaryTitles: ['Hero of Metadata'], description: '<p>A <b>long</b> story.</p>' });
      matchSeries({ id: 901, title: 'Metadata Hero Gaiden', year: 2022 });
      await configure({ novel: false });

      const result = await discover('metadata hero');

      expect(result.fallback).toBeNull();
      expect(result.results.map((entry) => entry.matchId)).toEqual(['900', '901']);
      expect(result.results[0]).toMatchObject({
        kind: 'manga',
        title: 'Metadata Hero',
        year: 2021,
        authors: ['Canonical Writer'],
        artists: ['Canonical Artist'],
        genres: ['Slice Of Life', 'Adventure'],
        synopsis: 'A long story.',
        inLibrary: false,
        url: 'https://mangabaka.org/900',
      });
      expect(JSON.stringify(result)).not.toContain('Hero of Metadata');
      expect(suwayomi().count(/./)).toBe(0);
      expect(ctx.fakes.mangabaka.count('search')).toBe(1);
    });

    it('opens a result: finds it on the enabled sources, most complete first, then downloads it end to end', async () => {
      suwayomi().addSource(SOURCE_A);
      suwayomi().addSource(SOURCE_B);
      suwayomi().addSource({ id: '1003', name: 'Gamma', lang: 'en' });
      const alpha = seedManga({ title: 'Metadata Hero', sourceId: SOURCE_A.id, chapters: 4 });
      const big = seedManga({ title: 'Metadata Hero', sourceId: SOURCE_B.id, chapters: 9 });
      seedManga({ title: 'Metadata Hero', sourceId: '1003', chapters: 2 });
      seedManga({ title: 'Metadata Hero Reborn', sourceId: SOURCE_A.id, chapters: 50 });
      matchSeries({ id: 900, title: 'Metadata Hero', anilistId: 555 });
      await configure({ mangaSourceIds: [SOURCE_A.id, SOURCE_B.id], novel: false });

      const found = await discover('metadata hero');
      expect(found.results.map((entry) => entry.matchId)).toEqual(['900']);
      expect(suwayomi().count('graphql:BookOrbitSearch')).toBe(0);

      const sources = await sourcesOf('manga', 900);
      expect(sources.failedSources).toEqual([]);
      expect(sources.options.map((option) => [option.sourceName, option.chapterCount, option.mostComplete])).toEqual([
        ['Beta Reader', 9, true],
        ['Alpha Scans', 4, false],
      ]);
      expect(sources.options.every((option) => option.confidence !== 'current')).toBe(true);
      expect(JSON.stringify(sources)).not.toContain('Gamma');

      const detail = (
        await api(ctx, 'GET', `/web-serials/series/${sources.options[0]!.seriesKey}?matchId=900`, ctx.user.token)
      ).json() as WebSerialSeriesDetail;
      expect(detail.seriesKey).toBe(`m:${big.id}`);
      const lookup = (
        await api(ctx, 'GET', `/web-serials/series/${sources.options[0]!.seriesKey}/lookup?matchId=900`, ctx.user.token)
      ).json() as WebSerialSeriesLookup;
      expect(lookup).toMatchObject({ state: 'matched', match: { id: '900', title: 'Metadata Hero' } });

      const job = await runToEnd(ctx.user.token, mangaJobBody(big, { metadata: { matchId: '900' } }));
      expect(job).toMatchObject({ status: 'completed', unitsDone: 9 });

      const again = await discover('metadata hero');
      expect(again.results[0]).toMatchObject({ matchId: '900', inLibrary: true });
      const other = await discover('metadata hero', 'manga', ctx.other.token);
      expect(other.results[0]).toMatchObject({ matchId: '900', inLibrary: false });
      const crossSource = (await api(ctx, 'GET', `/web-serials/series/m:${alpha.id}?matchId=900`, ctx.user.token)).json() as WebSerialSeriesDetail;
      expect(crossSource.importedUnitKeys.length).toBe(4);
    });

    it('reports that no source has the series, and keeps the failed sources', async () => {
      suwayomi().addSource(SOURCE_A);
      suwayomi().addSource(SOURCE_B);
      seedManga({ title: 'Something Else', sourceId: SOURCE_A.id });
      matchSeries({ id: 910, title: 'Unlisted Hero' });
      await configure({ mangaSourceIds: [SOURCE_A.id, SOURCE_B.id], novel: false });
      suwayomi().failSource(SOURCE_B.id);

      const sources = await sourcesOf('manga', 910);

      expect(sources.options).toEqual([]);
      expect(sources.failedSources).toEqual(['Beta Reader']);
    });

    it('finds a novel on the user’s enabled sites by the official title and skips the sites the user switched off', async () => {
      lncrawl().addNovel({ title: 'Novel Hero', domain: 'one.example', volumes: generateNovelVolumes(2, 5) });
      lncrawl().addNovel({ title: 'Novel Hero', domain: 'two.example', volumes: generateNovelVolumes(3, 5) });
      matchSeries({ id: 920, title: 'Novel Hero', type: 'novel' });
      await configure({ manga: false, novelDomains: ['one.example', 'two.example'] });

      const entries = await discover('novel hero', 'novel');
      expect(entries.results.map((entry) => [entry.matchId, entry.kind])).toEqual([['920', 'novel']]);
      const both = await sourcesOf('novel', 920);
      expect(both.options.map((option) => [option.sourceName, option.mostComplete])).toEqual([
        ['two.example', true],
        ['one.example', false],
      ]);

      await api(ctx, 'PUT', '/web-serials/novel-providers', ctx.user.token, { disabledDomains: ['two.example'] });
      const filtered = await sourcesOf('novel', 920);
      expect(filtered.options.map((option) => option.sourceName)).toEqual(['one.example']);
      const others = await sourcesOf('novel', 920, ctx.other.token);
      expect(others.options.map((option) => option.sourceName)).toEqual(['two.example', 'one.example']);
    });

    it('sends nothing to the sources when the series database is switched off, and falls back with the reason', async () => {
      seedManga({ title: 'Metadata Hero' });
      matchSeries({ id: 900, title: 'Metadata Hero' });
      await configure({ novel: false });
      await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { lookup: { enabled: false } });

      expect(await discover('metadata hero')).toEqual({ results: [], fallback: 'disabled' });
      expect(ctx.fakes.mangabaka.count(/./)).toBe(0);
      const sources = (await api(ctx, 'GET', '/web-serials/search?q=metadata&kind=manga', ctx.user.token)).json() as WebSerialSearchResult;
      expect(sources.hits.map((entry) => entry.title)).toEqual(['Metadata Hero']);
      await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { lookup: { enabled: true } });
    });

    it('falls back when MangaBaka is down, stops calling it once the breaker opens, and still searches the sources', async () => {
      seedManga({ title: 'Metadata Hero' });
      matchSeries({ id: 900, title: 'Metadata Hero' });
      await configure({ novel: false });
      ctx.fakes.mangabaka.failOp('search', { mode: 'status', status: 503, times: Infinity });

      for (let index = 0; index < 3; index++) {
        expect(await discover(`metadata hero ${index}`)).toEqual({ results: [], fallback: 'unavailable' });
      }
      const calls = ctx.fakes.mangabaka.count('search');
      expect(await discover('metadata hero again')).toEqual({ results: [], fallback: 'unavailable' });
      expect(ctx.fakes.mangabaka.count('search')).toBe(calls);

      const sourceSearch = (await api(ctx, 'GET', '/web-serials/search?q=metadata&kind=manga', ctx.user.token)).json() as WebSerialSearchResult;
      expect(sourceSearch.hits.map((entry) => entry.title)).toEqual(['Metadata Hero']);
    });

    it('falls back when MangaBaka is slow and when it has nothing for the query', async () => {
      seedManga({ title: 'Metadata Hero' });
      matchSeries({ id: 900, title: 'Metadata Hero' });
      await configure({ novel: false });

      expect(await discover('zzzz nothing')).toEqual({ results: [], fallback: 'empty' });

      ctx.fakes.mangabaka.opLatencyMs.set('search', 4_000);
      expect(await discover('metadata hero')).toEqual({ results: [], fallback: 'unavailable' });
    });

    it('offers no cover when the database’s is not https and refuses malformed identifiers', async () => {
      seedManga({ title: 'Covered Hero' });
      matchSeries({ id: 930, title: 'Covered Hero', coverUrl: 'http://127.0.0.1:1/cover.jpg' });
      await configure({ novel: false });

      const entry = (await discover('covered hero')).results[0]!;
      expect(entry.coverUrl).toBeNull();
      expect((await api(ctx, 'GET', '/web-serials/discover/manga/930/cover', ctx.user.token)).statusCode).toBe(404);
      expect((await api(ctx, 'GET', '/web-serials/discover/manga/abc/cover', ctx.user.token)).statusCode).toBe(400);
      const badKind = await api(ctx, 'GET', '/web-serials/discover/comic/930/sources', ctx.user.token);
      expect(badKind.statusCode).toBe(400);
      expect(JSON.stringify(badKind.json())).toContain('kind');
      const badId = await api(ctx, 'GET', '/web-serials/discover/novel/12x/sources', ctx.user.token);
      expect(badId.statusCode).toBe(400);
      expect(JSON.stringify(badId.json())).toContain('matchId');
      expect((await api(ctx, 'GET', '/web-serials/discover?q=a', ctx.user.token)).statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------------------
  // manga downloads
  // ---------------------------------------------------------------------------------------

  describe('manga downloads', () => {
    it('files one book per chapter with series name, index, authors, and the source file untouched', async () => {
      const manga = seedManga({ title: 'Chapter Series', chapters: 5, genre: ['Action'] });
      await configure({ novel: false });

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(done).toMatchObject({ status: 'completed', unitsTotal: 5, unitsDone: 5, unitsFailed: 0, unitsSkipped: 0, message: null, current: null });

      const books = await listBooks(ctx, library.libraryId);
      expect(books.map((book) => book.title)).toEqual([
        'Chapter Series Ch. 1',
        'Chapter Series Ch. 2',
        'Chapter Series Ch. 3',
        'Chapter Series Ch. 4',
        'Chapter Series Ch. 5',
      ]);
      expect(books.map((book) => book.seriesIndex)).toEqual(['1', '2', '3', '4', '5']);
      for (const [index, book] of books.entries()) {
        expect(book.seriesName).toBe('Chapter Series');
        expect(book.authors).toEqual(['Author A']);
        expect(book.pencillers).toEqual(['Artist B']);
        expect(book.files).toHaveLength(1);
        expect(book.files[0]!.format).toBe('cbz');
        expect(book.files[0]!.path.startsWith(library.path)).toBe(true);
        const pages = await readCbzPages(book.files[0]!.path);
        expect(pages.labels).toEqual([1, 2, 3].map((page) => `c${manga.chapters[index]!.id}p${page}`));
      }

      const detail = await getJob(ctx, ctx.user.token, done.id);
      expect(detail.items.map((item) => [item.sequence, item.status])).toEqual(['1', '2', '3', '4', '5'].map((sequence) => [sequence, 'imported']));
      expect(detail.items.every((item) => item.bookId !== null)).toBe(true);
    });

    it('removes Suwayomi’s own copy of every imported chapter, batching a volume into one call', async () => {
      const manga = seedManga({ title: 'Cleanup Series', chapters: 6, chaptersPerVolume: 3 });
      await configure({ novel: false });

      const perChapter = await runToEnd(ctx.user.token, mangaJobBody(manga, { selection: { mode: 'list', sequences: ['1', '2'] } }));
      expect(perChapter).toMatchObject({ status: 'completed', unitsDone: 2 });
      expect(suwayomi().deleteCalls).toEqual([[manga.chapters[0]!.id], [manga.chapters[1]!.id]]);
      expect(suwayomi().count('graphql:BookOrbitDeleteDownloaded')).toBe(2);

      suwayomi().resetStats();
      const volumes = await runToEnd(ctx.user.token, mangaJobBody(manga, { packaging: 'volume' }));
      expect(volumes).toMatchObject({ status: 'completed', unitsDone: 2 });
      expect(suwayomi().deleteCalls).toEqual([
        manga.chapters.slice(0, 3).map((chapter) => chapter.id),
        manga.chapters.slice(3).map((chapter) => chapter.id),
      ]);
    });

    it('also removes the copy of a chapter it skipped as already in the library', async () => {
      const manga = seedManga({ title: 'Duplicate Cleanup', chapters: 2 });
      await configure({ novel: false });
      await runToEnd(ctx.user.token, mangaJobBody(manga));
      suwayomi().resetStats();

      const forced = await runToEnd(ctx.user.token, mangaJobBody(manga, { skipImported: false, selection: { mode: 'list', sequences: ['1'] } }));
      expect(forced).toMatchObject({ status: 'completed', unitsSkipped: 1 });
      expect(suwayomi().deleteCalls).toEqual([[manga.chapters[0]!.id]]);
    });

    it('keeps the copy of a chapter that failed, and never fails an import when the cleanup fails', async () => {
      const manga = seedManga({ title: 'Cleanup Failures', chapters: 2 });
      await configure({ novel: false });
      suwayomi().failDownload(manga.chapters[0]!.id, { kind: 'http', status: 404, times: Infinity });
      suwayomi().failOp('graphql:BookOrbitDeleteDownloaded', { mode: 'graphql-error', times: Infinity });

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(done).toMatchObject({ status: 'completed_with_gaps', unitsDone: 1, unitsFailed: 1 });
      expect(suwayomi().count('graphql:BookOrbitDeleteDownloaded')).toBe(1);
      expect(suwayomi().deleteCalls).toEqual([]);
      expect(await countBooks(ctx, library.libraryId)).toBe(1);
    });

    it('handles a range, an explicit list, and fractional chapter numbers', async () => {
      const chapters = [...generateMangaChapters({ count: 6 }), ...generateMangaChapters({ count: 1, firstChapterNumber: 3.5 })];
      const manga = seedManga({ title: 'Selection Series', chapters });
      await configure({ novel: false });

      const range = await runToEnd(ctx.user.token, mangaJobBody(manga, { selection: { mode: 'range', fromSequence: '2', toSequence: '4' } }));
      expect(range).toMatchObject({ unitsTotal: 4, unitsDone: 4 });
      expect((await listBooks(ctx, library.libraryId)).map((book) => book.seriesIndex).sort()).toEqual(['2', '3', '3.5', '4']);

      const list = await runToEnd(ctx.user.token, mangaJobBody(manga, { selection: { mode: 'list', sequences: ['6', '1'] } }));
      expect(list).toMatchObject({ unitsTotal: 2, unitsDone: 2 });
      expect(await countBooks(ctx, library.libraryId)).toBe(6);

      const empty = await api(
        ctx,
        'POST',
        '/web-serials/jobs',
        ctx.user.token,
        mangaJobBody(manga, { selection: { mode: 'list', sequences: ['99'] } }),
      );
      expect(empty.statusCode).toBe(400);
      const backwards = await api(
        ctx,
        'POST',
        '/web-serials/jobs',
        ctx.user.token,
        mangaJobBody(manga, { selection: { mode: 'range', fromSequence: '5', toSequence: '2' } }),
      );
      expect(backwards.statusCode).toBe(400);
    });

    it('stays polite to the engine: one enqueue, one download and a few polls per chapter, one request at a time', async () => {
      const manga = seedManga({ title: 'Polite Series', chapters: 12 });
      await configure({ novel: false });
      suwayomi().resetStats();

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(done.status).toBe('completed');
      expect(suwayomi().count('graphql:BookOrbitDownload')).toBe(12);
      expect(suwayomi().count('download')).toBe(12);
      expect(suwayomi().maxPerChapter(suwayomi().enqueues)).toBe(1);
      expect(suwayomi().maxPerChapter(suwayomi().downloads)).toBe(1);
      expect(suwayomi().maxPerChapter(suwayomi().polls)).toBeLessThanOrEqual(2);
      expect(suwayomi().count('graphql:BookOrbitSeries')).toBeLessThanOrEqual(2);
      expect(suwayomi().peakInFlight).toBeLessThanOrEqual(2);
    });

    it('merges chapters into one CBZ per volume in reading order, with ComicInfo and the volume as series index', async () => {
      const manga = seedManga({ title: 'Volume Series', chapters: 7, chaptersPerVolume: 3, genre: ['Fantasy'] });
      await configure({ novel: false });

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga, { packaging: 'volume', metadata: { artists: ['Pencil Artist'] } }));
      expect(done).toMatchObject({ status: 'completed', unitsTotal: 3, unitsDone: 3, packaging: 'volume' });

      const books = await listBooks(ctx, library.libraryId);
      expect(books.map((book) => [book.title, book.seriesName, book.seriesIndex])).toEqual([
        ['Volume Series, Volume 1', 'Volume Series', '1'],
        ['Volume Series, Volume 2', 'Volume Series', '2'],
        ['Volume Series, Volume 3 (Chapters 7-7)', 'Volume Series', '3'],
      ]);
      expect(books[0]!.pencillers).toEqual(['Pencil Artist']);

      const volumes = [manga.chapters.slice(0, 3), manga.chapters.slice(3, 6), manga.chapters.slice(6)];
      for (const [index, book] of books.entries()) {
        const pages = await readCbzPages(book.files[0]!.path);
        expect(pages.labels).toEqual(volumes[index]!.flatMap((chapter) => [1, 2, 3].map((page) => `c${chapter.id}p${page}`)));
        expect(pages.names[0]).toBe('0001-0001.png');
        expect(pages.names.at(-1)).toBe(`${String(volumes[index]!.length).padStart(4, '0')}-0003.png`);
        const info = (await readCbzComicInfo(book.files[0]!.path))!;
        expect(info).toContain('<Series>Volume Series</Series>');
        expect(info).toContain(`<Volume>${index + 1}</Volume>`);
        expect(info).toContain(`<Number>${index + 1}</Number>`);
        expect(info).toContain('<Writer>Author A</Writer>');
        expect(info).toContain('<Penciller>Pencil Artist</Penciller>');
        expect(info).toContain('<Genre>Fantasy</Genre>');
      }
      expect(suwayomi().count('download')).toBe(7);

      manga.chapters.unshift({ ...manga.chapters.at(-1)!, id: 990_001, name: 'Vol.3 Ch.8', chapterNumber: 8, sourceOrder: 0 });
      ctx.app.get(WebSerialsSettingsService).bumpCatalogVersion();
      const grown = await runToEnd(ctx.user.token, mangaJobBody(manga, { packaging: 'volume' }));
      expect(grown).toMatchObject({ status: 'completed', unitsTotal: 3, unitsDone: 1, unitsSkipped: 2 });
      expect((await listBooks(ctx, library.libraryId)).map((book) => book.title)).toContain('Volume Series, Volume 3 (Chapters 7-8)');
    });

    it('groups chapters by volume from the volume database when the source names carry none, and keeps leftovers as chapters', async () => {
      const manga = seedManga({ title: 'Dex Series', chapters: 6 });
      matchSeries({ id: 601, title: 'Dex Series', anilistId: 888, authors: ['Author A'] });
      ctx.fakes.mangadex.addEntry({ id: 'dex-601', title: 'Dex Series', anilistId: 888, volumes: { '1': [1, 2, 3], '2': [4, 5] } });
      await configure({ novel: false });

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga, { packaging: 'volume', metadata: { matchId: '601' } }));
      expect(done).toMatchObject({ status: 'completed', unitsTotal: 3, unitsDone: 3 });
      const books = await listBooks(ctx, library.libraryId);
      expect(books.map((book) => book.title)).toEqual(['Dex Series, Volume 1', 'Dex Series, Volume 2', 'Dex Series Ch. 6']);
      expect((await readCbzPages(books[0]!.files[0]!.path)).labels).toHaveLength(9);
      expect((await readCbzPages(books[1]!.files[0]!.path)).labels).toHaveLength(6);
      expect((await readCbzPages(books[2]!.files[0]!.path)).labels).toEqual([1, 2, 3].map((page) => `c${manga.chapters[5]!.id}p${page}`));
    });

    describe('per-volume packaging with chapters outside volumes', () => {
      function chaptersOf(spec: Array<[number, number | null]>): FakeMangaChapter[] {
        return generateMangaChapters({ count: spec.length }).map((chapter, index) => {
          const [number, volume] = spec[index]!;
          return {
            ...chapter,
            chapterNumber: number,
            name: volume ? `Vol.${volume} Ch.${number}` : `Chapter ${number}`,
            sourceOrder: spec.length - index,
          };
        });
      }

      it('files whole volumes as volume books and every chapter outside a volume, in between or trailing, as its own book', async () => {
        const manga = seedManga({
          title: 'Mixed Volumes',
          chapters: chaptersOf([
            [1, 1],
            [2, 1],
            [3, 1],
            [3.1, null],
            [4, 2],
            [5, 2],
            [6, null],
            [7, null],
          ]),
        });
        await configure({ novel: false });

        const done = await runToEnd(ctx.user.token, mangaJobBody(manga, { packaging: 'volume' }));
        expect(done).toMatchObject({ status: 'completed', unitsTotal: 5, unitsDone: 5 });
        const books = await listBooks(ctx, library.libraryId);
        expect(books.map((book) => book.title)).toEqual([
          'Mixed Volumes, Volume 1',
          'Mixed Volumes Ch. 3.1',
          'Mixed Volumes, Volume 2',
          'Mixed Volumes Ch. 6',
          'Mixed Volumes Ch. 7',
        ]);
        expect((await readCbzPages(books[0]!.files[0]!.path)).labels).toHaveLength(9);
        expect((await readCbzPages(books[2]!.files[0]!.path)).labels).toHaveLength(6);

        const detail = (await api(ctx, 'GET', `/web-serials/series/m:${manga.id}`, ctx.user.token)).json() as WebSerialSeriesDetail;
        expect(detail.importedGroupKeys.sort()).toEqual(['vol:1', 'vol:2']);
      });

      it('widens a range that starts in the middle of a volume to the whole volume', async () => {
        const manga = seedManga({
          title: 'Snapped Range',
          chapters: chaptersOf([
            [1, 1],
            [2, 1],
            [3, 1],
            [4, 2],
            [5, 2],
            [6, 2],
            [7, null],
            [8, null],
          ]),
        });
        await configure({ novel: false });

        const done = await runToEnd(
          ctx.user.token,
          mangaJobBody(manga, { packaging: 'volume', selection: { mode: 'range', fromSequence: '5', toSequence: '8' } }),
        );
        expect(done).toMatchObject({ status: 'completed', unitsTotal: 3, unitsDone: 3 });
        const books = await listBooks(ctx, library.libraryId);
        expect(books.map((book) => book.title)).toEqual(['Snapped Range, Volume 2', 'Snapped Range Ch. 7', 'Snapped Range Ch. 8']);
        expect((await readCbzPages(books[0]!.files[0]!.path)).labels).toHaveLength(9);
      });

      it('files the chapters of a volume that is only partly chosen as chapter books and never records the volume as owned', async () => {
        const manga = seedManga({
          title: 'Partial Volume',
          chapters: chaptersOf([
            [1, 1],
            [2, 1],
            [3, 1],
            [4, 2],
            [5, 2],
          ]),
        });
        await configure({ novel: false });

        const done = await runToEnd(
          ctx.user.token,
          mangaJobBody(manga, { packaging: 'volume', selection: { mode: 'list', sequences: ['1', '2', '4', '5'] } }),
        );
        expect(done).toMatchObject({ status: 'completed', unitsTotal: 3, unitsDone: 3 });
        const books = await listBooks(ctx, library.libraryId);
        expect(books.map((book) => book.title)).toEqual(['Partial Volume Ch. 1', 'Partial Volume Ch. 2', 'Partial Volume, Volume 2 (Chapters 4-5)']);

        const detail = (await api(ctx, 'GET', `/web-serials/series/m:${manga.id}`, ctx.user.token)).json() as WebSerialSeriesDetail;
        expect(detail.importedGroupKeys).toEqual(['vol:2:4-5']);
      });
    });

    it('refuses volume packaging when no volume is known anywhere', async () => {
      const manga = seedManga({ title: 'No Volumes Here', chapters: 4 });
      await configure({ novel: false });
      const response = await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, mangaJobBody(manga, { packaging: 'volume' }));
      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).toContain('Volume information');
    });

    it('builds one book for a chosen range of chapters', async () => {
      const manga = seedManga({ title: 'Omnibus Series', chapters: 8 });
      await configure({ novel: false });

      const done = await runToEnd(
        ctx.user.token,
        mangaJobBody(manga, { packaging: 'series', selection: { mode: 'range', fromSequence: '3', toSequence: '6' } }),
      );
      expect(done).toMatchObject({ status: 'completed', unitsTotal: 1, unitsDone: 1 });
      const books = await listBooks(ctx, library.libraryId);
      expect(books).toHaveLength(1);
      expect(books[0]!.title).toBe('Omnibus Series, Chapters 3-6');
      const pages = await readCbzPages(books[0]!.files[0]!.path);
      expect(pages.labels).toEqual(manga.chapters.slice(2, 6).flatMap((chapter) => [1, 2, 3].map((page) => `c${chapter.id}p${page}`)));
      expect(await readCbzComicInfo(books[0]!.files[0]!.path)).toContain('<Number>3-6</Number>');
      expect(suwayomi().count('download')).toBe(4);
    });

    it('names a whole-series book after the series', async () => {
      const manga = seedManga({ title: 'Whole Series', chapters: 3 });
      await configure({ novel: false });
      await runToEnd(ctx.user.token, mangaJobBody(manga, { packaging: 'series' }));
      const books = await listBooks(ctx, library.libraryId);
      expect(books.map((book) => book.title)).toEqual(['Whole Series']);
    });

    it('applies the matched series title, authors and artists chosen in the preview', async () => {
      const manga = seedManga({ title: 'Source Title Differs', chapters: 2 });
      matchSeries({ id: 701, title: 'Canonical Title', authors: ['Match Writer'], artists: ['Match Artist'] });
      await configure({ novel: false });

      await runToEnd(ctx.user.token, mangaJobBody(manga, { metadata: { matchId: '701' } }));
      const matched = await listBooks(ctx, library.libraryId);
      expect(matched.map((book) => book.title)).toEqual(['Canonical Title Ch. 1', 'Canonical Title Ch. 2']);
      expect(matched[0]!.seriesName).toBe('Canonical Title');
      expect(matched[0]!.authors).toEqual(['Match Writer']);
      expect(matched[0]!.pencillers).toEqual(['Match Artist']);

      const second = seedManga({ title: 'Override Me', chapters: 1 });
      const overridden = await runToEnd(
        ctx.user.token,
        mangaJobBody(second, { metadata: { authors: ['Chosen Author'], artists: ['Chosen Artist'] } }),
      );
      expect(overridden.author).toBe('Chosen Author');
      const all = await listBooks(ctx, library.libraryId);
      const book = all.find((entry) => entry.seriesName === 'Override Me')!;
      expect(book.authors).toEqual(['Chosen Author']);
      expect(book.pencillers).toEqual(['Chosen Artist']);
    });
  });

  // ---------------------------------------------------------------------------------------
  // novel downloads
  // ---------------------------------------------------------------------------------------

  describe('novel downloads', () => {
    it('files one EPUB per volume with authors, series name and index', async () => {
      const novel = seedNovel(3, 12, 'Epic Saga');
      await configure({ manga: false });

      const done = await runToEnd(ctx.user.token, novelJobBody(novel));
      expect(done).toMatchObject({ status: 'completed', unitsTotal: 3, unitsDone: 3, packaging: 'volume' });
      const books = await listBooks(ctx, library.libraryId);
      expect(books.map((book) => [book.title, book.seriesName, book.seriesIndex])).toEqual([
        ['Epic Saga, Volume 1', 'Epic Saga', '1'],
        ['Epic Saga, Volume 2', 'Epic Saga', '2'],
        ['Epic Saga, Volume 3 (Chapters 25-36)', 'Epic Saga', '3'],
      ]);
      for (const book of books) {
        expect(book.authors).toEqual(['Writer One', 'Writer Two']);
        expect(book.files[0]!.format).toBe('epub');
        expect(await zipEntryNames(book.files[0]!.path)).toEqual(expect.arrayContaining(['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf']));
      }
      const created = lncrawl().jobsCreated.map((entry) => entry.type);
      expect(created.filter((type) => type === 'fetch-volumes')).toHaveLength(3);
      expect(created.filter((type) => type === 'make-artifacts')).toHaveLength(3);
      expect(lncrawl().count('login')).toBeLessThanOrEqual(2);
    });

    it('files a grown last volume as a book of its own and keeps an unchanged one owned', async () => {
      const novel = seedNovel(2, 5, 'Growing Saga');
      await configure({ manga: false });

      expect(await runToEnd(ctx.user.token, novelJobBody(novel))).toMatchObject({ status: 'completed', unitsDone: 2 });
      novel.volumes[1]!.chapterCount = 8;
      ctx.app.get(WebSerialsSettingsService).bumpCatalogVersion();
      const detail = (await api(ctx, 'GET', `/web-serials/series/n:${novel.id}`, ctx.user.token)).json() as WebSerialSeriesDetail;
      const grownKey = `${novel.volumes[1]!.id}:6-13`;
      expect(detail.units.map((unit) => unit.key)).toEqual([novel.volumes[0]!.id, grownKey]);
      expect(detail.importedUnitKeys).toEqual([novel.volumes[0]!.id]);

      expect(await runToEnd(ctx.user.token, novelJobBody(novel))).toMatchObject({ status: 'completed', unitsDone: 1, unitsSkipped: 1 });
      expect((await listBooks(ctx, library.libraryId)).map((book) => book.title)).toEqual([
        'Growing Saga, Volume 1',
        'Growing Saga, Volume 2 (Chapters 6-10)',
        'Growing Saga, Volume 2 (Chapters 6-13)',
      ]);
      expect(await runToEnd(ctx.user.token, novelJobBody(novel))).toMatchObject({ unitsDone: 0, unitsSkipped: 2 });
    });

    it('files the whole series as one EPUB built from every volume', async () => {
      const novel = seedNovel(4, 5, 'One Big Book');
      await configure({ manga: false });

      const done = await runToEnd(ctx.user.token, novelJobBody(novel, { packaging: 'series' }));
      expect(done).toMatchObject({ status: 'completed', unitsTotal: 1, unitsDone: 1 });
      const books = await listBooks(ctx, library.libraryId);
      expect(books).toHaveLength(1);
      expect(books[0]!.title).toBe('One Big Book');
      expect(books[0]!.files[0]!.format).toBe('epub');
      const fetches = lncrawl().jobsCreated.filter((entry) => entry.type === 'fetch-volumes');
      expect(fetches).toHaveLength(1);
      expect(fetches[0]!.params['volumes']).toEqual(novel.volumes.map((volume) => volume.id));
      const builds = lncrawl().jobsCreated.filter((entry) => entry.type === 'make-artifacts');
      expect(builds).toHaveLength(1);
      expect(builds[0]!.params['volume']).toBeUndefined();
    });

    it('downloads a range of volumes and shows live progress while the crawler works', async () => {
      const novel = seedNovel(4, 20, 'Slow Crawl');
      lncrawl().jobPolls.set('fetch-volumes', 4);
      lncrawl().jobPolls.set('make-artifacts', 2);
      lncrawl().opLatencyMs.set('job:get', 60);
      await configure({ manga: false });

      const job = await createJob(ctx, ctx.user.token, novelJobBody(novel, { selection: { mode: 'range', fromSequence: '2', toSequence: '3' } }));
      let sawProgress = false;
      await until(async () => {
        const current = (await jobFromList(ctx.user.token, job.id))?.current;
        if (current?.stage === 'fetching' && current.chaptersTotal === 20) sawProgress = true;
        return (await jobStatus(ctx, job.id)) === 'completed';
      }, 'the slow crawl did not finish');
      expect(sawProgress).toBe(true);
      expect((await listBooks(ctx, library.libraryId)).map((book) => book.seriesIndex)).toEqual(['2', '3']);
    });

    it('refuses packaging a novel cannot have, and a range for a whole-series book', async () => {
      const novel = seedNovel();
      await configure({ manga: false });
      expect((await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, novelJobBody(novel, { packaging: 'chapter' }))).statusCode).toBe(400);
      const range = await api(
        ctx,
        'POST',
        '/web-serials/jobs',
        ctx.user.token,
        novelJobBody(novel, { packaging: 'series', selection: { mode: 'range', fromSequence: '1', toSequence: '2' } }),
      );
      expect(range.statusCode).toBe(400);
    });

    it('logs in again when the crawler drops its token', async () => {
      const novel = seedNovel(2, 3);
      await configure({ manga: false });
      const first = await runToEnd(ctx.user.token, novelJobBody(novel, { selection: { mode: 'list', sequences: ['1'] } }));
      expect(first.status).toBe('completed');
      const loginsBefore = lncrawl().count('login');
      lncrawl().invalidateTokens();
      const second = await runToEnd(ctx.user.token, novelJobBody(novel, { selection: { mode: 'list', sequences: ['2'] } }));
      expect(second.status).toBe('completed');
      expect(lncrawl().count('login')).toBeGreaterThan(loginsBefore);
      expect(lncrawl().count('login')).toBeLessThanOrEqual(loginsBefore + 2);
    });
  });

  // ---------------------------------------------------------------------------------------
  // job creation rules
  // ---------------------------------------------------------------------------------------

  describe('job creation', () => {
    it('rejects a library the user cannot reach, one that does not take the format, a foreign folder and an unknown series', async () => {
      const manga = seedManga({ title: 'Rules Series', chapters: 2 });
      await configure({ novel: false });

      const forbidden = await api(ctx, 'POST', '/web-serials/jobs', ctx.other.token, mangaJobBody(manga));
      expect(forbidden.statusCode).toBe(403);

      const epubOnly = await createLibrary(ctx, { allowedFormats: ['epub'] });
      const wrongFormat = await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, mangaJobBody(manga, { libraryId: epubOnly.libraryId }));
      expect(wrongFormat.statusCode).toBe(400);

      const foreignFolder = await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, mangaJobBody(manga, { folderId: epubOnly.folderId }));
      expect(foreignFolder.statusCode).toBe(400);

      const unknown = await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, mangaJobBody({ id: 424242 } as FakeManga));
      expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
      expect(await countBooks(ctx, library.libraryId)).toBe(0);
    });

    it('rejects unknown fields and malformed selections', async () => {
      const manga = seedManga({ title: 'Validation Series', chapters: 2 });
      await configure({ novel: false });
      expect((await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, mangaJobBody(manga, { extra: 1 }))).statusCode).toBe(400);
      expect(
        (
          await api(
            ctx,
            'POST',
            '/web-serials/jobs',
            ctx.user.token,
            mangaJobBody(manga, { selection: { mode: 'range', fromSequence: 'x', toSequence: '2' } }),
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, mangaJobBody(manga, { selection: { mode: 'list', sequences: [] } }))).statusCode,
      ).toBe(400);
      expect((await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, mangaJobBody(manga, { packaging: 'omnibus' }))).statusCode).toBe(400);
    });

    it('caps the downloads one user can have in progress', async () => {
      const manga = seedManga({ title: 'Cap Series', chapters: 1 });
      await configure({ novel: false });
      expect((await api(ctx, 'POST', '/web-serials/queue/pause', ctx.admin.token)).statusCode).toBe(200);
      for (let index = 0; index < 25; index += 1) await createJob(ctx, ctx.user.token, mangaJobBody(manga));
      const over = await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, mangaJobBody(manga));
      expect(over.statusCode).toBe(400);
      const list = (await api(ctx, 'GET', '/web-serials/jobs?limit=100', ctx.user.token)).json() as WebSerialJobList;
      expect(list).toMatchObject({ activeCount: 25, queuePaused: true });
      expect(list.items.map((job) => job.queuePosition)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
      expect(suwayomi().count('download')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------
  // the import ledger
  // ---------------------------------------------------------------------------------------

  describe('already in the library', () => {
    it('skips what the user already has, reports it in the preview, and survives clearing finished jobs', async () => {
      const manga = seedManga({ title: 'Ledger Series', chapters: 5 });
      await configure({ novel: false });
      const first = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(first).toMatchObject({ status: 'completed', unitsDone: 5 });

      const detail = (await api(ctx, 'GET', `/web-serials/series/m:${manga.id}`, ctx.user.token)).json() as WebSerialSeriesDetail;
      expect(detail.importedUnitKeys.sort()).toEqual(manga.chapters.map((chapter) => String(chapter.id)).sort());
      const others = (await api(ctx, 'GET', `/web-serials/series/m:${manga.id}`, ctx.other.token)).json() as WebSerialSeriesDetail;
      expect(others.importedUnitKeys).toEqual([]);

      const downloads = suwayomi().count('download');
      const again = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(again).toMatchObject({ status: 'completed', unitsTotal: 5, unitsDone: 0, unitsSkipped: 5 });
      expect(suwayomi().count('download')).toBe(downloads);

      const cleared = (await api(ctx, 'POST', '/web-serials/jobs/clear-finished', ctx.user.token)).json() as WebSerialClearFinishedResult;
      expect(cleared.removed).toBe(2);
      expect(await ctx.db.$count(webSerialJobs)).toBe(0);
      expect(await ctx.db.$count(webSerialImports)).toBe(5);

      const afterClear = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(afterClear).toMatchObject({ unitsDone: 0, unitsSkipped: 5 });
      expect(await countBooks(ctx, library.libraryId)).toBe(5);

      const forced = await runToEnd(ctx.user.token, mangaJobBody(manga, { skipImported: false, selection: { mode: 'list', sequences: ['1'] } }));
      expect(forced).toMatchObject({ status: 'completed', unitsDone: 0, unitsFailed: 0, unitsSkipped: 1 });
      expect(await countBooks(ctx, library.libraryId)).toBe(5);
    });

    it('downloads a chapter again once its book has been removed from the library', async () => {
      const manga = seedManga({ title: 'Removed Book Series', chapters: 3 });
      await configure({ novel: false });
      await runToEnd(ctx.user.token, mangaJobBody(manga));
      const [victim] = await listBooks(ctx, library.libraryId);
      await ctx.db.delete(schema.books).where(eq(schema.books.id, victim!.id));
      await rm(victim!.files[0]!.path);

      const detail = (await api(ctx, 'GET', `/web-serials/series/m:${manga.id}`, ctx.user.token)).json() as WebSerialSeriesDetail;
      expect(detail.importedUnitKeys).toHaveLength(2);
      const again = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(again).toMatchObject({ unitsDone: 1, unitsSkipped: 2 });
      expect(await countBooks(ctx, library.libraryId)).toBe(3);
    });

    it('recognises chapters already imported from another source of the same matched series', async () => {
      const first = seedManga({ title: 'Twin Series', chapters: generateMangaChapters({ count: 5 }), sourceId: SOURCE_A.id });
      const second = seedManga({ title: 'Twin Series', chapters: generateMangaChapters({ count: 6, firstChapterNumber: 3 }), sourceId: SOURCE_B.id });
      matchSeries({ id: 801, title: 'Twin Series', authors: ['Author A'] });
      await configure({ novel: false });

      const one = await runToEnd(ctx.user.token, mangaJobBody(first, { metadata: { matchId: '801' } }));
      expect(one).toMatchObject({ unitsDone: 5 });

      await api(ctx, 'GET', `/web-serials/series/m:${second.id}/lookup`, ctx.user.token);
      const preview = (await api(ctx, 'GET', `/web-serials/series/m:${second.id}`, ctx.user.token)).json() as WebSerialSeriesDetail;
      const known = second.chapters.filter((chapter) => chapter.chapterNumber <= 5).map((chapter) => String(chapter.id));
      expect(preview.importedUnitKeys.sort()).toEqual(known.sort());

      const two = await runToEnd(ctx.user.token, mangaJobBody(second, { metadata: { matchId: '801' } }));
      expect(two).toMatchObject({ unitsTotal: 6, unitsDone: 3, unitsSkipped: 3 });
      expect(await countBooks(ctx, library.libraryId)).toBe(8);
      expect(suwayomi().downloads.size).toBe(8);
    });

    it('does not treat another source as a duplicate when the series was not matched', async () => {
      const first = seedManga({ title: 'Unmatched Twin', chapters: generateMangaChapters({ count: 2 }), sourceId: SOURCE_A.id });
      const second = seedManga({ title: 'Unmatched Twin', chapters: generateMangaChapters({ count: 2 }), sourceId: SOURCE_B.id });
      await configure({ novel: false });
      await runToEnd(ctx.user.token, mangaJobBody(first));
      const two = await runToEnd(ctx.user.token, mangaJobBody(second));
      expect(two).toMatchObject({ status: 'completed', unitsDone: 0, unitsFailed: 0, unitsSkipped: 2 });
      expect(await countBooks(ctx, library.libraryId)).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------------------
  // failures and deferred retries
  // ---------------------------------------------------------------------------------------

  describe('failures', () => {
    it('defers a chapter whose source is down, carries on with the others, then retries it once the delay has passed', async () => {
      const manga = seedManga({ title: 'Flaky Series', chapters: 4 });
      await configure({ novel: false });
      suwayomi().failDownload(manga.chapters[1]!.id, { kind: 'http', status: 522, times: 1 });
      ctx.clock.frozen = true;

      const job = await createJob(ctx, ctx.user.token, mangaJobBody(manga));
      await until(
        async () => (await jobFromList(ctx.user.token, job.id))?.message?.startsWith('Waiting to retry 1 chapter') === true,
        'the job never reported waiting',
      );

      expect(await itemStatuses(job.id)).toEqual({ '1': 'imported', '2': 'pending', '3': 'imported', '4': 'imported' });
      const [flaky] = (await itemRows(ctx, job.id)).filter((item) => item.sequence === '2');
      expect(flaky!.remoteRef).toMatchObject({ attempts: 1, retryReason: 'source_unavailable' });
      expect(Date.parse((flaky!.remoteRef as { retryAt: string }).retryAt)).toBeGreaterThan(ctx.clock.date().getTime());
      expect(await countBooks(ctx, library.libraryId)).toBe(3);
      expect(suwayomi().downloads.get(manga.chapters[1]!.id)).toBe(1);

      ctx.clock.frozen = false;
      const done = await waitForJob(ctx, job.id);
      expect(done).toMatchObject({ status: 'completed', unitsDone: 4, unitsFailed: 0, message: null });
      expect(suwayomi().downloads.get(manga.chapters[1]!.id)).toBe(2);
      expect(suwayomi().enqueues.get(manga.chapters[1]!.id)).toBe(2);
      const books = await listBooks(ctx, library.libraryId);
      expect(books.at(-1)!.seriesIndex).toBe('2');
      expect(ctx.clock.offsetMs).toBeGreaterThanOrEqual(2 * 60_000 - 5000);
    });

    it('gives up after the retry budget and finishes with gaps, naming the source', async () => {
      const manga = seedManga({ title: 'Broken Series', chapters: 3 });
      await configure({ novel: false });
      suwayomi().failDownload(manga.chapters[1]!.id, { kind: 'http', status: 503, times: Infinity });

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(done).toMatchObject({ status: 'completed_with_gaps', unitsDone: 2, unitsFailed: 1 });
      expect(done.message).toBe("1 chapter could not be downloaded: Alpha Scans isn't responding right now. Try again later.");
      expect(suwayomi().downloads.get(manga.chapters[1]!.id)).toBe(3);
      expect(ctx.clock.offsetMs).toBeGreaterThanOrEqual(12 * 60_000 - 5000);

      const detail = await getJob(ctx, ctx.user.token, done.id);
      const failed = detail.items.find((item) => item.status === 'failed')!;
      expect(failed.error).toBe("Chapter 2: Alpha Scans isn't responding right now.");
      expect(failed.bookId).toBeNull();
    });

    it('fails a chapter at once, without retrying, when the source no longer has it', async () => {
      const manga = seedManga({ title: 'Permanent 404', chapters: 3 });
      await configure({ novel: false });
      suwayomi().failDownload(manga.chapters[0]!.id, { kind: 'http', status: 404, times: Infinity });

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(done).toMatchObject({ status: 'completed_with_gaps', unitsDone: 2, unitsFailed: 1 });
      expect(suwayomi().downloads.get(manga.chapters[0]!.id)).toBe(1);
      expect(done.message).toBe('1 chapter could not be downloaded: Alpha Scans no longer has this chapter.');
      expect(ctx.clock.offsetMs).toBeLessThan(60_000);
    });

    it('stops the whole job once, without retrying, when the engine rejects the saved credentials mid-job', async () => {
      const manga = seedManga({ title: 'Permanent 403', chapters: 3 });
      await configure({ novel: false });
      suwayomi().failDownload(manga.chapters[0]!.id, { kind: 'http', status: 403, times: Infinity });

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(done).toMatchObject({
        status: 'failed',
        unitsDone: 0,
        unitsFailed: 0,
        message: 'The download service rejected its credentials. Ask an admin to check the connection settings.',
      });
      expect(suwayomi().downloads.get(manga.chapters[0]!.id)).toBe(1);
      expect(suwayomi().downloads.get(manga.chapters[1]!.id) ?? 0).toBe(0);
    });

    it('gives up on a novel volume whose crawler job disappears, after a bounded number of polls', async () => {
      const novel = seedNovel(2, 4, 'Vanishing Job');
      await configure({ manga: false });
      lncrawl().failJobs({ type: 'fetch-volumes', volumeSerial: 1, times: 1, gone: true });

      const done = await runToEnd(ctx.user.token, novelJobBody(novel));
      expect(['completed', 'completed_with_gaps']).toContain(done.status);
      const polls = lncrawl().count('job:get');
      expect(polls).toBeLessThanOrEqual(10 + 8);
      expect(done.unitsDone + done.unitsFailed).toBe(2);
    });

    it('does not retry a novel volume when the website refuses the crawler', async () => {
      const novel = seedNovel(2, 4, 'Blocked Novel');
      await configure({ manga: false });
      lncrawl().failJobs({ type: 'fetch-volumes', volumeSerial: 2, times: Infinity, error: 'HTTP error 403 Forbidden' });

      const done = await runToEnd(ctx.user.token, novelJobBody(novel));
      expect(done).toMatchObject({ status: 'completed_with_gaps', unitsDone: 1, unitsFailed: 1 });
      expect(done.message).toBe(`1 volume could not be downloaded: ${novel.domain} refused the request (it may be blocking automated downloads).`);
      expect(lncrawl().jobsCreated.filter((entry) => entry.type === 'fetch-volumes')).toHaveLength(2);
      expect(ctx.clock.offsetMs).toBeLessThan(60_000);
    });

    it('treats an engine that failed its last check as unavailable to users until a test succeeds again', async () => {
      seedManga({ title: 'Health Series' });
      await configure({ novel: false });
      suwayomi().credentials = { username: 'rotated', password: 'rotated' };
      await api(ctx, 'POST', '/web-serials/admin/test', ctx.admin.token, { kind: 'manga' });
      const down = (await api(ctx, 'GET', '/web-serials/capabilities', ctx.user.token)).json() as WebSerialCapabilities;
      expect(down.manga).toMatchObject({ available: false, searchable: false });

      suwayomi().credentials = { username: 'suwayomi', password: 'suwayomi-secret' };
      await api(ctx, 'POST', '/web-serials/admin/test', ctx.admin.token, { kind: 'manga' });
      const up = (await api(ctx, 'GET', '/web-serials/capabilities', ctx.user.token)).json() as WebSerialCapabilities;
      expect(up.manga.available).toBe(true);
    });

    it('retries a chapter the engine reports as errored, and one that vanishes from its queue', async () => {
      const manga = seedManga({ title: 'Queue Trouble', chapters: 3 });
      await configure({ novel: false });
      suwayomi().failPoll(manga.chapters[0]!.id, { kind: 'queue-error', times: 1 });
      suwayomi().failPoll(manga.chapters[1]!.id, { kind: 'vanish', times: 2 });

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(done).toMatchObject({ status: 'completed', unitsDone: 3, unitsFailed: 0 });
      expect(suwayomi().enqueues.get(manga.chapters[0]!.id)).toBe(2);
      expect(suwayomi().enqueues.get(manga.chapters[1]!.id)).toBe(3);
      expect(suwayomi().downloads.get(manga.chapters[1]!.id)).toBe(1);
    });

    it('rides out engine hiccups while polling without failing the chapter', async () => {
      const manga = seedManga({ title: 'Hiccup Series', chapters: 2 });
      await configure({ novel: false });
      suwayomi().failPoll(manga.chapters[0]!.id, { kind: 'reset', times: 3 });
      suwayomi().failPoll(manga.chapters[1]!.id, { kind: 'slow', polls: 5 });
      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(done).toMatchObject({ status: 'completed', unitsDone: 2 });
      expect(suwayomi().polls.get(manga.chapters[1]!.id)).toBeLessThanOrEqual(8);
    });

    it('defers a chapter when the engine connection drops during the file transfer', async () => {
      const manga = seedManga({ title: 'Dropped Transfer', chapters: 2 });
      await configure({ novel: false });
      suwayomi().failDownload(manga.chapters[0]!.id, { kind: 'reset', times: 1 });
      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(done).toMatchObject({ status: 'completed', unitsDone: 2 });
      expect(suwayomi().downloads.get(manga.chapters[0]!.id)).toBe(2);
    });

    it('fails the whole job and notifies when nothing can be fetched, then retries it from the queue page', async () => {
      const manga = seedManga({ title: 'Dead Series', chapters: 2 });
      await configure({ novel: false });
      for (const chapter of manga.chapters) suwayomi().failDownload(chapter.id, { kind: 'http', status: 404, times: Infinity });

      const failed = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(failed).toMatchObject({ status: 'failed', unitsDone: 0, unitsFailed: 2 });
      const notices = await webSerialNotifications(ctx, ctx.user.userId);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ type: NotificationType.WebSerialFailed, title: 'Dead Series could not be downloaded', read: false });

      suwayomi().clearPlans();
      const retried = await api(ctx, 'POST', `/web-serials/jobs/${failed.id}/retry`, ctx.user.token);
      expect(retried.statusCode).toBe(200);
      expect((retried.json() as WebSerialJob).status).toBe('queued');
      const done = await waitForJob(ctx, failed.id);
      expect(done).toMatchObject({ status: 'completed', unitsDone: 2, unitsFailed: 0 });
      expect(await countBooks(ctx, library.libraryId)).toBe(2);
      expect(suwayomi().downloads.get(manga.chapters[0]!.id)).toBe(2);

      const notAgain = await api(ctx, 'POST', `/web-serials/jobs/${failed.id}/retry`, ctx.user.token);
      expect(notAgain.statusCode).toBe(409);
    });

    it('retries a single failed item of a finished job', async () => {
      const manga = seedManga({ title: 'One Bad Chapter', chapters: 4 });
      await configure({ novel: false });
      suwayomi().failDownload(manga.chapters[2]!.id, { kind: 'http', status: 404, times: Infinity });
      const gaps = await runToEnd(ctx.user.token, mangaJobBody(manga));
      expect(gaps.status).toBe('completed_with_gaps');
      const bad = (await itemRows(ctx, gaps.id)).find((item) => item.status === 'failed')!;

      suwayomi().clearPlans();
      const response = await api(ctx, 'POST', `/web-serials/jobs/${gaps.id}/items/${bad.id}/retry`, ctx.user.token);
      expect(response.statusCode).toBe(200);
      expect((response.json() as WebSerialJobDetail).job.status).toBe('queued');
      const done = await waitForJob(ctx, gaps.id);
      expect(done).toMatchObject({ status: 'completed', unitsDone: 4, unitsFailed: 0 });
      expect(suwayomi().downloads.get(manga.chapters[0]!.id)).toBe(1);

      const ok = (await itemRows(ctx, gaps.id))[0]!;
      expect((await api(ctx, 'POST', `/web-serials/jobs/${gaps.id}/items/${ok.id}/retry`, ctx.user.token)).statusCode).toBe(409);
    });

    it('defers a volume whose merge member fails and resumes it without refetching the chapters already saved', async () => {
      const manga = seedManga({ title: 'Merge Retry', chapters: 6, chaptersPerVolume: 3 });
      await configure({ novel: false });
      suwayomi().failDownload(manga.chapters[4]!.id, { kind: 'http', status: 502, times: 1 });

      const done = await runToEnd(ctx.user.token, mangaJobBody(manga, { packaging: 'volume' }));
      expect(done).toMatchObject({ status: 'completed', unitsDone: 2 });
      for (const chapter of manga.chapters) {
        expect(suwayomi().downloads.get(chapter.id)).toBe(chapter.id === manga.chapters[4]!.id ? 2 : 1);
      }
      const books = await listBooks(ctx, library.libraryId);
      expect((await readCbzPages(books[1]!.files[0]!.path)).labels).toHaveLength(9);
    });

    it('retries a novel volume the crawler failed to fetch, and fails one it can never build', async () => {
      const novel = seedNovel(3, 8, 'Crawl Trouble');
      await configure({ manga: false });
      lncrawl().failJobs({ type: 'fetch-volumes', volumeSerial: 1, times: 1, error: null, failed: 2 });
      lncrawl().failJobs({ type: 'make-artifacts', volumeSerial: 3, times: Infinity, error: 'builder crashed' });

      const done = await runToEnd(ctx.user.token, novelJobBody(novel));
      expect(done).toMatchObject({ status: 'completed_with_gaps', unitsDone: 2, unitsFailed: 1 });
      expect((await listBooks(ctx, library.libraryId)).map((book) => book.seriesIndex)).toEqual(['2', '1']);
      const fetches = lncrawl().jobsCreated.filter((entry) => entry.type === 'fetch-volumes');
      expect(fetches).toHaveLength(4);
      const detail = await getJob(ctx, ctx.user.token, done.id);
      expect(detail.items.find((item) => item.status === 'failed')!.error).toContain('Volume 3');
      const notices = await webSerialNotifications(ctx, ctx.user.userId);
      expect(notices[0]).toMatchObject({ type: NotificationType.WebSerialCompletedWithGaps });
    });
  });

  // ---------------------------------------------------------------------------------------
  // queue controls
  // ---------------------------------------------------------------------------------------

  describe('queue controls', () => {
    it('pauses a running job, releases its in-flight chapter, and resumes without refetching finished ones', async () => {
      const manga = seedManga({ title: 'Pause Series', chapters: 4 });
      await configure({ novel: false });
      const gate = suwayomi().hold(manga.chapters[1]!.id);

      const job = await createJob(ctx, ctx.user.token, mangaJobBody(manga));
      await gateReached(gate);
      const paused = await api(ctx, 'POST', `/web-serials/jobs/${job.id}/pause`, ctx.user.token);
      expect(paused.statusCode).toBe(200);
      await until(async () => (await itemStatuses(job.id))['2'] === 'pending', 'the in-flight chapter was not released');
      expect(await jobStatus(ctx, job.id)).toBe('paused');
      expect(await itemStatuses(job.id)).toEqual({ '1': 'imported', '2': 'pending', '3': 'pending', '4': 'pending' });
      expect((await jobFromList(ctx.user.token, job.id))?.current).toBeNull();
      expect(suwayomi().count('graphql:BookOrbitDequeue')).toBeGreaterThanOrEqual(1);

      const stillPaused = await api(ctx, 'POST', `/web-serials/jobs/${job.id}/pause`, ctx.user.token);
      expect(stillPaused.statusCode).toBe(409);
      expect(stillPaused.json()).toMatchObject({ errorCode: 'WEB_SERIAL_JOB_PAUSE_NOT_ALLOWED' });
      gate.release();
      const resumed = await api(ctx, 'POST', `/web-serials/jobs/${job.id}/resume`, ctx.user.token);
      expect(resumed.statusCode).toBe(200);
      const done = await waitForJob(ctx, job.id);
      expect(done).toMatchObject({ status: 'completed', unitsDone: 4 });
      expect(suwayomi().downloads.get(manga.chapters[0]!.id)).toBe(1);
      expect(suwayomi().enqueues.get(manga.chapters[0]!.id)).toBe(1);
      expect((await api(ctx, 'POST', `/web-serials/jobs/${job.id}/resume`, ctx.user.token)).statusCode).toBe(409);
    });

    it('moves a waiting job to the front of the queue', async () => {
      const manga = seedManga({ title: 'Order Series', chapters: 2 });
      await configure({ novel: false, maxConcurrentJobs: 1 });
      const gate = suwayomi().hold(manga.chapters[0]!.id);

      const first = await createJob(ctx, ctx.user.token, mangaJobBody(manga, { selection: { mode: 'list', sequences: ['1'] } }));
      await gateReached(gate);
      const second = await createJob(
        ctx,
        ctx.user.token,
        mangaJobBody(manga, { selection: { mode: 'list', sequences: ['2'] }, skipImported: false }),
      );
      const third = await createJob(
        ctx,
        ctx.user.token,
        mangaJobBody(manga, { selection: { mode: 'range', fromSequence: '1', toSequence: '2' }, skipImported: false }),
      );
      expect((await jobFromList(ctx.user.token, second.id))?.queuePosition).toBe(1);
      expect((await jobFromList(ctx.user.token, third.id))?.queuePosition).toBe(2);

      const moved = await api(ctx, 'POST', `/web-serials/jobs/${third.id}/move-to-top`, ctx.user.token);
      expect(moved.statusCode).toBe(200);
      expect((moved.json() as WebSerialJob).queuePosition).toBe(1);
      expect((await jobFromList(ctx.user.token, second.id))?.queuePosition).toBe(2);
      expect((await api(ctx, 'POST', `/web-serials/jobs/${first.id}/move-to-top`, ctx.user.token)).statusCode).toBe(409);

      gate.release();
      await waitForJob(ctx, third.id);
      await waitForJob(ctx, second.id);
      const startedThird = (await jobFromList(ctx.user.token, third.id))!.startedAt!;
      const startedSecond = (await jobFromList(ctx.user.token, second.id))!.startedAt!;
      expect(Date.parse(startedThird)).toBeLessThanOrEqual(Date.parse(startedSecond));
    });

    it('cancels a running job and a waiting job, and only removes finished ones', async () => {
      const manga = seedManga({ title: 'Cancel Series', chapters: 3 });
      await configure({ novel: false, maxConcurrentJobs: 1 });
      const gate = suwayomi().hold(manga.chapters[1]!.id);

      const running = await createJob(ctx, ctx.user.token, mangaJobBody(manga));
      await gateReached(gate);
      const waiting = await createJob(ctx, ctx.user.token, mangaJobBody(manga, { skipImported: false }));

      expect((await api(ctx, 'DELETE', `/web-serials/jobs/${running.id}`, ctx.user.token)).statusCode).toBe(409);
      const cancelledWaiting = await api(ctx, 'POST', `/web-serials/jobs/${waiting.id}/cancel`, ctx.user.token);
      expect((cancelledWaiting.json() as WebSerialJob).status).toBe('cancelled');
      const cancelled = await api(ctx, 'POST', `/web-serials/jobs/${running.id}/cancel`, ctx.user.token);
      expect((cancelled.json() as WebSerialJob).status).toBe('cancelled');
      await until(() => suwayomi().count('graphql:BookOrbitDequeue') >= 1, 'the engine was never told to drop the chapter');
      gate.release();
      await waitFor(
        () => !(ctx.runner as unknown as { active: Map<number, unknown> }).active.has(running.id),
        'the runner kept working on a cancelled job',
      );
      expect(await countBooks(ctx, library.libraryId)).toBe(1);
      expect(await jobStatus(ctx, running.id)).toBe('cancelled');
      expect(suwayomi().downloads.get(manga.chapters[2]!.id)).toBeUndefined();

      expect((await api(ctx, 'DELETE', `/web-serials/jobs/${running.id}`, ctx.user.token)).statusCode).toBe(204);
      expect(await ctx.db.$count(webSerialJobs)).toBe(1);
      expect(await ctx.db.$count(webSerialImports)).toBe(1);
    });

    it('lets an admin pause and resume the whole queue, and nobody else', async () => {
      const manga = seedManga({ title: 'Admin Pause', chapters: 2 });
      await configure({ novel: false });

      expect((await api(ctx, 'POST', '/web-serials/queue/pause', ctx.user.token)).statusCode).toBe(403);
      const paused = await api(ctx, 'POST', '/web-serials/queue/pause', ctx.admin.token);
      expect(paused.json()).toEqual({ queuePaused: true });

      const job = await createJob(ctx, ctx.user.token, mangaJobBody(manga));
      for (let index = 0; index < 4; index += 1) await ctx.runner.tick();
      expect(await jobStatus(ctx, job.id)).toBe('queued');
      expect(suwayomi().count('graphql:BookOrbitDownload')).toBe(0);
      const list = (await api(ctx, 'GET', '/web-serials/jobs', ctx.user.token)).json() as WebSerialJobList;
      expect(list.queuePaused).toBe(true);

      expect((await api(ctx, 'POST', '/web-serials/queue/resume', ctx.user.token)).statusCode).toBe(403);
      expect((await api(ctx, 'POST', '/web-serials/queue/resume', ctx.admin.token)).json()).toEqual({ queuePaused: false });
      const done = await waitForJob(ctx, job.id);
      expect(done.status).toBe('completed');
    });

    it('runs no more jobs at once than the admin allows', async () => {
      const manga = seedManga({ title: 'Concurrency Series', chapters: 2 });
      await configure({ novel: false, maxConcurrentJobs: 2 });
      const gates = manga.chapters.map((chapter) => suwayomi().hold(chapter.id));

      const jobs = await Promise.all(
        [1, 2, 3].map((index) =>
          createJob(
            ctx,
            ctx.user.token,
            mangaJobBody(manga, { selection: { mode: 'list', sequences: [String(index === 3 ? 1 : index)] }, skipImported: false }),
          ),
        ),
      );
      await until(async () => {
        const statuses = await Promise.all(jobs.map((job) => jobStatus(ctx, job.id)));
        return statuses.filter((status) => status === 'running').length === 2;
      }, 'two jobs never ran together');
      for (let index = 0; index < 3; index += 1) await ctx.runner.tick();
      const statuses = await Promise.all(jobs.map((job) => jobStatus(ctx, job.id)));
      expect(statuses.filter((status) => status === 'running' || status === 'importing')).toHaveLength(2);
      expect(statuses.filter((status) => status === 'queued')).toHaveLength(1);
      for (const gate of gates) gate.release();
      for (const job of jobs) await waitForJob(ctx, job.id);
    });
  });

  // ---------------------------------------------------------------------------------------
  // moving to another source
  // ---------------------------------------------------------------------------------------

  describe('move to another source', () => {
    it('carries a job’s failed and waiting chapters over to a source that has them', async () => {
      const first = seedManga({ title: 'Move Series', chapters: generateMangaChapters({ count: 6 }), sourceId: SOURCE_A.id });
      const second = seedManga({ title: 'Move Series', chapters: generateMangaChapters({ count: 8 }), sourceId: SOURCE_B.id });
      await configure({ novel: false });
      suwayomi().failDownload(first.chapters[3]!.id, { kind: 'http', status: 404, times: Infinity });
      suwayomi().failDownload(first.chapters[4]!.id, { kind: 'http', status: 404, times: Infinity });

      const done = await runToEnd(ctx.user.token, mangaJobBody(first));
      expect(done).toMatchObject({ status: 'completed_with_gaps', unitsDone: 4, unitsFailed: 2 });

      const candidates = (await api(ctx, 'GET', `/web-serials/jobs/${done.id}/move-candidates`, ctx.user.token)).json() as WebSerialMoveCandidates;
      expect(candidates.remainingTotal).toBe(2);
      expect(candidates.candidates).toHaveLength(1);
      expect(candidates.candidates[0]).toMatchObject({
        seriesKey: `m:${second.id}`,
        sourceName: 'Beta Reader',
        confidence: 'title_match',
        remainingAvailable: 2,
        remainingTotal: 2,
      });

      const moved = await api(ctx, 'POST', `/web-serials/jobs/${done.id}/move`, ctx.user.token, { seriesKey: `m:${second.id}` });
      expect(moved.statusCode).toBe(200);
      const result = moved.json() as MoveWebSerialJobResult;
      expect(result.from).toMatchObject({ status: 'completed', message: 'Remaining chapters moved to Beta Reader.' });
      expect(result.to).toMatchObject({ seriesKey: `m:${second.id}`, sourceName: 'Beta Reader', unitsTotal: 0 });

      const finished = await waitForJob(ctx, result.to.id);
      expect(finished).toMatchObject({ status: 'completed', unitsTotal: 2, unitsDone: 2 });
      expect(await countBooks(ctx, library.libraryId)).toBe(6);
      expect((await listBooks(ctx, library.libraryId)).map((book) => book.seriesIndex).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
      const movedItems = await itemStatuses(done.id);
      expect(movedItems).toMatchObject({ '4': 'skipped', '5': 'skipped' });
      expect(suwayomi().downloads.get(second.chapters[0]!.id)).toBeUndefined();
    });

    it('moves a volume job: the unfinished volume is rebuilt from its chapters on the other source', async () => {
      const first = seedManga({ title: 'Volume Move', chapters: 9, chaptersPerVolume: 3, sourceId: SOURCE_A.id });
      const second = seedManga({ title: 'Volume Move', chapters: 9, chaptersPerVolume: 3, sourceId: SOURCE_B.id });
      await configure({ novel: false });
      for (const chapter of first.chapters.slice(3, 6)) suwayomi().failDownload(chapter.id, { kind: 'http', status: 404, times: Infinity });

      const done = await runToEnd(ctx.user.token, mangaJobBody(first, { packaging: 'volume' }));
      expect(done).toMatchObject({ status: 'completed_with_gaps', unitsTotal: 3, unitsDone: 2, unitsFailed: 1 });

      const candidates = (await api(ctx, 'GET', `/web-serials/jobs/${done.id}/move-candidates`, ctx.user.token)).json() as WebSerialMoveCandidates;
      expect(candidates.remainingTotal).toBe(3);
      expect(candidates.candidates[0]).toMatchObject({ seriesKey: `m:${second.id}`, remainingAvailable: 3, remainingTotal: 3 });

      const moved = await api(ctx, 'POST', `/web-serials/jobs/${done.id}/move`, ctx.user.token, { seriesKey: `m:${second.id}` });
      expect(moved.statusCode).toBe(200);
      const result = moved.json() as MoveWebSerialJobResult;
      expect(result.to).toMatchObject({ packaging: 'volume', sourceName: 'Beta Reader' });

      const finished = await waitForJob(ctx, result.to.id);
      expect(finished).toMatchObject({ status: 'completed', unitsTotal: 1, unitsDone: 1 });
      const books = await listBooks(ctx, library.libraryId);
      expect(books.map((book) => book.seriesIndex).sort()).toEqual(['1', '2', '3']);
      const rebuilt = books.find((book) => book.seriesIndex === '2')!;
      const pages = await readCbzPages(rebuilt.files[0]!.path);
      expect(pages.labels).toEqual(second.chapters.slice(3, 6).flatMap((chapter) => [1, 2, 3].map((page) => `c${chapter.id}p${page}`)));
      expect(await itemStatuses(done.id)).toMatchObject({ '2': 'skipped' });
    });

    it('moves a job that is running: it stops, and nothing downloaded is fetched twice', async () => {
      const first = seedManga({ title: 'Mid Move', chapters: generateMangaChapters({ count: 5 }), sourceId: SOURCE_A.id });
      const second = seedManga({ title: 'Mid Move', chapters: generateMangaChapters({ count: 5 }), sourceId: SOURCE_B.id });
      await configure({ novel: false });
      const gate = suwayomi().hold(first.chapters[2]!.id);

      const job = await createJob(ctx, ctx.user.token, mangaJobBody(first));
      await gateReached(gate);
      const mover = api(ctx, 'POST', `/web-serials/jobs/${job.id}/move`, ctx.user.token, { seriesKey: `m:${second.id}` });
      const response = await mover;
      expect(response.statusCode).toBe(200);
      const result = response.json() as MoveWebSerialJobResult;
      expect(result.from.status).toBe('completed');
      const done = await waitForJob(ctx, result.to.id);
      expect(done).toMatchObject({ status: 'completed', unitsDone: 3 });
      expect(await countBooks(ctx, library.libraryId)).toBe(5);
      expect(suwayomi().downloads.get(second.chapters[0]!.id)).toBeUndefined();
      expect(suwayomi().downloads.get(second.chapters[1]!.id)).toBeUndefined();
    });

    it('rejects moves it cannot make', async () => {
      const first = seedManga({ title: 'No Move', chapters: 2, sourceId: SOURCE_A.id });
      const same = seedManga({ title: 'No Move', chapters: 2, sourceId: SOURCE_A.id });
      const novel = seedNovel(1, 2);
      await configure();

      const done = await runToEnd(ctx.user.token, mangaJobBody(first));
      expect((await api(ctx, 'GET', `/web-serials/jobs/${done.id}/move-candidates`, ctx.user.token)).statusCode).toBe(409);
      expect((await api(ctx, 'POST', `/web-serials/jobs/${done.id}/move`, ctx.user.token, { seriesKey: `m:${same.id}` })).statusCode).toBe(400);
      expect((await api(ctx, 'POST', `/web-serials/jobs/${done.id}/move`, ctx.user.token, { seriesKey: `n:${novel.id}` })).statusCode).toBe(400);

      const novelJob = await runToEnd(ctx.user.token, novelJobBody(novel));
      expect((await api(ctx, 'GET', `/web-serials/jobs/${novelJob.id}/move-candidates`, ctx.user.token)).statusCode).toBe(400);
      expect((await api(ctx, 'GET', `/web-serials/jobs/${done.id}/move-candidates`, ctx.other.token)).statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------------------
  // restart
  // ---------------------------------------------------------------------------------------

  describe('restart', () => {
    it('resumes a job after the app restarts: finished chapters stay, the in-flight handle is reused, scheduled retries and attempts survive', async () => {
      const manga = seedManga({ title: 'Restart Series', chapters: 6 });
      await configure({ novel: false });
      suwayomi().failDownload(manga.chapters[1]!.id, { kind: 'http', status: 503, times: 1 });
      const gate = suwayomi().hold(manga.chapters[3]!.id);
      ctx.clock.frozen = true;

      const job = await createJob(ctx, ctx.user.token, mangaJobBody(manga));
      await gateReached(gate);
      expect(await itemStatuses(job.id)).toMatchObject({ '1': 'imported', '2': 'pending', '3': 'imported', '4': 'fetching' });
      const beforeRestart = (await itemRows(ctx, job.id)).find((item) => item.sequence === '4')!;
      expect(beforeRestart.remoteRef).toMatchObject({ handle: { chapterId: expect.anything() } });

      await restartApp(ctx);
      const afterBoot = await jobStatus(ctx, job.id);
      expect(['queued', 'running']).toContain(afterBoot);
      const retryItem = (await itemRows(ctx, job.id)).find((item) => item.sequence === '2')!;
      expect(retryItem.remoteRef).toMatchObject({ attempts: 1, retryReason: 'source_unavailable' });
      expect(retryItem.remoteRef).toHaveProperty('retryAt');

      gate.release();
      ctx.clock.frozen = false;
      const done = await waitForJob(ctx, job.id, undefined, 40_000);
      expect(done).toMatchObject({ status: 'completed', unitsDone: 6, unitsFailed: 0 });
      expect(await countBooks(ctx, library.libraryId)).toBe(6);
      for (const [index, chapter] of manga.chapters.entries()) {
        expect(suwayomi().downloads.get(chapter.id)).toBe(index === 1 ? 2 : 1);
        expect(suwayomi().enqueues.get(chapter.id)).toBe(index === 1 ? 2 : 1);
      }
      const books = await listBooks(ctx, library.libraryId);
      expect(new Set(books.map((book) => book.seriesIndex)).size).toBe(6);
    });

    it('keeps a paused job paused across a restart and a queued job queued', async () => {
      const manga = seedManga({ title: 'Quiet Restart', chapters: 2 });
      await configure({ novel: false });
      await api(ctx, 'POST', '/web-serials/queue/pause', ctx.admin.token);
      const queued = await createJob(ctx, ctx.user.token, mangaJobBody(manga));
      const paused = await createJob(ctx, ctx.user.token, mangaJobBody(manga, { skipImported: false }));
      await api(ctx, 'POST', `/web-serials/jobs/${paused.id}/pause`, ctx.user.token);

      await restartApp(ctx);
      expect(await jobStatus(ctx, queued.id)).toBe('queued');
      expect(await jobStatus(ctx, paused.id)).toBe('paused');
      expect(((await api(ctx, 'GET', '/web-serials/jobs', ctx.user.token)).json() as WebSerialJobList).queuePaused).toBe(true);
      await api(ctx, 'POST', '/web-serials/queue/resume', ctx.admin.token);
      expect((await waitForJob(ctx, queued.id)).status).toBe('completed');
      expect(await jobStatus(ctx, paused.id)).toBe('paused');
    });

    it('picks a merged volume back up from the chapters already saved on disk', async () => {
      const manga = seedManga({ title: 'Restart Volume', chapters: 4, chaptersPerVolume: 4 });
      await configure({ novel: false });
      const gate = suwayomi().hold(manga.chapters[2]!.id);
      const job = await createJob(ctx, ctx.user.token, mangaJobBody(manga, { packaging: 'volume' }));
      await gateReached(gate);
      expect(suwayomi().downloads.size).toBe(2);

      await restartApp(ctx);
      gate.release();
      const done = await waitForJob(ctx, job.id, undefined, 40_000);
      expect(done).toMatchObject({ status: 'completed', unitsDone: 1 });
      for (const chapter of manga.chapters) expect(suwayomi().downloads.get(chapter.id)).toBe(1);
      const [book] = await listBooks(ctx, library.libraryId);
      expect((await readCbzPages(book!.files[0]!.path)).labels).toHaveLength(12);
    });
  });

  // ---------------------------------------------------------------------------------------
  // notifications
  // ---------------------------------------------------------------------------------------

  describe('notifications', () => {
    it('tells the owner when a download completes, linking to the queue page', async () => {
      const manga = seedManga({ title: 'Notify Series', chapters: 3 });
      await configure({ novel: false });
      const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
      const listed = await jobFromList(ctx.user.token, done.id);

      const notices = await webSerialNotifications(ctx, ctx.user.userId);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        type: NotificationType.WebSerialCompleted,
        title: 'Notify Series is in your library',
        message: `3 chapters added to ${listed!.libraryName}.`,
        actionUrl: '/web-serials/queue',
        read: false,
        groupKey: `web-serial-job:${done.id}`,
      });
      expect(await webSerialNotifications(ctx, ctx.admin.userId)).toHaveLength(0);
      expect(await webSerialNotifications(ctx, ctx.other.userId)).toHaveLength(0);
    });

    it('notifies about a gap with the reason and does not notify for a cancelled job', async () => {
      const gappy = seedManga({ title: 'Gappy Series', chapters: 2 });
      await configure({ novel: false });
      suwayomi().failDownload(gappy.chapters[0]!.id, { kind: 'http', status: 404, times: Infinity });
      await runToEnd(ctx.user.token, mangaJobBody(gappy));
      const notices = await webSerialNotifications(ctx, ctx.user.userId);
      expect(notices.map((notice) => notice.type)).toEqual([NotificationType.WebSerialCompletedWithGaps]);
      expect(notices[0]!.message).toContain('could not be downloaded');

      await api(ctx, 'POST', '/web-serials/queue/pause', ctx.admin.token);
      const queued = await createJob(ctx, ctx.user.token, mangaJobBody(gappy, { skipImported: false }));
      await api(ctx, 'POST', `/web-serials/jobs/${queued.id}/cancel`, ctx.user.token);
      expect(await webSerialNotifications(ctx, ctx.user.userId)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------
  // permissions
  // ---------------------------------------------------------------------------------------

  describe('permissions', () => {
    it('keeps every user route behind the Web Serials permission', async () => {
      const manga = seedManga({ title: 'Locked Series', chapters: 1 });
      await configure({ novel: false });
      const routes: Array<['GET' | 'POST' | 'DELETE', string, unknown?]> = [
        ['GET', '/web-serials/capabilities'],
        ['GET', '/web-serials/search?q=locked'],
        ['POST', '/web-serials/resolve', { url: 'https://example.com/x' }],
        ['GET', `/web-serials/series/m:${manga.id}`],
        ['GET', `/web-serials/series/m:${manga.id}/lookup`],
        ['GET', `/web-serials/series/m:${manga.id}/sources`],
        ['GET', `/web-serials/series/m:${manga.id}/cover`],
        ['GET', '/web-serials/discover?q=locked'],
        ['GET', '/web-serials/discover/manga/1/sources'],
        ['GET', '/web-serials/discover/manga/1/cover'],
        ['POST', '/web-serials/jobs', mangaJobBody(manga)],
        ['GET', '/web-serials/jobs'],
        ['GET', '/web-serials/jobs/1'],
        ['POST', '/web-serials/jobs/1/cancel'],
        ['POST', '/web-serials/jobs/clear-finished'],
        ['POST', '/web-serials/queue/pause'],
      ];
      for (const [method, url, payload] of routes) {
        const response = await api(ctx, method, url, ctx.outsider.token, payload);
        expect([method, url, response.statusCode]).toEqual([method, url, 403]);
      }
      const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/web-serials/capabilities' });
      expect(anonymous.statusCode).toBe(401);
    });

    it('keeps the admin routes for admins', async () => {
      await configure({ novel: false });
      const routes: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?]> = [
        ['GET', '/web-serials/admin/settings'],
        ['PUT', '/web-serials/admin/settings', { maxConcurrentJobs: 2 }],
        ['POST', '/web-serials/admin/test', { kind: 'manga' }],
        ['POST', '/web-serials/admin/lookup/test'],
        ['GET', '/web-serials/admin/novel-sources'],
        ['GET', '/web-serials/admin/manga-sources'],
        ['GET', '/web-serials/admin/manga-extensions'],
        ['POST', '/web-serials/admin/manga-extensions/refresh'],
        ['POST', '/web-serials/admin/manga-extensions/some.pkg/install'],
        ['POST', '/web-serials/admin/manga-extensions/some.pkg/uninstall'],
        ['POST', '/web-serials/admin/manga-extensions/some.pkg/update'],
        ['GET', '/web-serials/admin/manga-extensions/some.pkg/icon'],
        ['GET', '/web-serials/admin/manga-repos'],
        ['POST', '/web-serials/admin/manga-repos', { url: 'https://example.com/index.min.json' }],
        ['DELETE', '/web-serials/admin/manga-repos?url=https%3A%2F%2Fexample.com%2Findex.min.json'],
      ];
      for (const [method, url, payload] of routes) {
        for (const who of [ctx.user, ctx.other, ctx.outsider]) {
          const response = await api(ctx, method, url, who.token, payload);
          expect([who.username, method, url, response.statusCode]).toEqual([who.username, method, url, 403]);
        }
      }
    });

    it('lets a user see and control only their own downloads, and an admin see everyone’s', async () => {
      const manga = seedManga({ title: 'Private Series', chapters: 2 });
      await configure({ novel: false });
      await api(ctx, 'POST', '/web-serials/queue/pause', ctx.admin.token);
      const mine = await createJob(ctx, ctx.user.token, mangaJobBody(manga));

      for (const [method, path] of [
        ['GET', `/web-serials/jobs/${mine.id}`],
        ['POST', `/web-serials/jobs/${mine.id}/cancel`],
        ['POST', `/web-serials/jobs/${mine.id}/pause`],
        ['POST', `/web-serials/jobs/${mine.id}/resume`],
        ['POST', `/web-serials/jobs/${mine.id}/retry`],
        ['POST', `/web-serials/jobs/${mine.id}/move-to-top`],
        ['POST', `/web-serials/jobs/${mine.id}/items/1/retry`],
        ['GET', `/web-serials/jobs/${mine.id}/move-candidates`],
        ['DELETE', `/web-serials/jobs/${mine.id}`],
      ] as const) {
        const response = await api(ctx, method, path, ctx.other.token);
        expect([method, path, response.statusCode]).toEqual([method, path, 403]);
      }
      expect((await api(ctx, 'POST', `/web-serials/jobs/${mine.id}/move`, ctx.other.token, { seriesKey: 'm:1' })).statusCode).toBe(403);
      const missing = await api(ctx, 'GET', '/web-serials/jobs/999999', ctx.user.token);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ errorCode: 'WEB_SERIAL_JOB_NOT_FOUND', message: 'Download not found' });

      expect(((await api(ctx, 'GET', '/web-serials/jobs', ctx.other.token)).json() as WebSerialJobList).items).toHaveLength(0);
      expect(((await api(ctx, 'GET', '/web-serials/jobs', ctx.admin.token)).json() as WebSerialJobList).items).toHaveLength(0);
      expect((await api(ctx, 'GET', '/web-serials/jobs?scope=all', ctx.user.token)).statusCode).toBe(403);
      expect((await api(ctx, 'GET', '/web-serials/jobs?scope=all', ctx.other.token)).statusCode).toBe(403);
      expect((await api(ctx, 'POST', '/web-serials/jobs/clear-finished?scope=all', ctx.user.token)).statusCode).toBe(403);

      const all = (await api(ctx, 'GET', '/web-serials/jobs?scope=all', ctx.admin.token)).json() as WebSerialJobList;
      expect(all.items).toHaveLength(1);
      expect(all.items[0]!.owner).toEqual({ id: ctx.user.userId, name: ctx.user.username });
      const ownersView = (await api(ctx, 'GET', '/web-serials/jobs', ctx.user.token)).json() as WebSerialJobList;
      expect(ownersView.items[0]!.owner).toBeNull();

      const adminDetail = (await api(ctx, 'GET', `/web-serials/jobs/${mine.id}`, ctx.admin.token)).json() as WebSerialJobDetail;
      expect(adminDetail.job.owner?.id).toBe(ctx.user.userId);
      const cancelled = await api(ctx, 'POST', `/web-serials/jobs/${mine.id}/cancel`, ctx.admin.token);
      expect((cancelled.json() as WebSerialJob).status).toBe('cancelled');
    });

    it('limits clear-finished to the caller unless an admin asks for everyone', async () => {
      const manga = seedManga({ title: 'Clear Series', chapters: 1 });
      await configure({ novel: false });
      const second = await createLibrary(ctx);
      await ctx.db.insert(schema.userLibraryAccess).values({ userId: ctx.other.userId, libraryId: second.libraryId, accessLevel: 'editor' });
      await api(ctx, 'POST', '/web-serials/queue/pause', ctx.admin.token);
      const a = await createJob(ctx, ctx.user.token, mangaJobBody(manga));
      const b = await createJob(ctx, ctx.other.token, mangaJobBody(manga, { libraryId: second.libraryId }));
      await api(ctx, 'POST', `/web-serials/jobs/${a.id}/cancel`, ctx.user.token);
      await api(ctx, 'POST', `/web-serials/jobs/${b.id}/cancel`, ctx.other.token);

      const mineOnly = (await api(ctx, 'POST', '/web-serials/jobs/clear-finished', ctx.user.token)).json() as WebSerialClearFinishedResult;
      expect(mineOnly.removed).toBe(1);
      expect(await ctx.db.$count(webSerialJobs, eq(webSerialJobs.id, b.id))).toBe(1);
      const everyone = (await api(ctx, 'POST', '/web-serials/jobs/clear-finished?scope=all', ctx.admin.token)).json() as WebSerialClearFinishedResult;
      expect(everyone.removed).toBe(1);
      expect(await ctx.db.$count(webSerialJobs)).toBe(0);
    });

    it('treats a non-superuser with the app-settings permission as an admin', async () => {
      const manager = await ensureUser(ctx.db, ctx.app, 'web-serials-e2e-manager', {
        permissions: [Permission.WebSerialAccess, Permission.ManageAppSettings],
      });
      const manga = seedManga({ title: 'Manager Series', chapters: 1 });
      await configure({ novel: false });
      expect((await api(ctx, 'GET', '/web-serials/admin/settings', manager.token)).statusCode).toBe(200);
      expect((await api(ctx, 'GET', '/web-serials/jobs?scope=all', manager.token)).statusCode).toBe(200);
      expect((await api(ctx, 'POST', '/web-serials/queue/pause', manager.token)).statusCode).toBe(200);
      await api(ctx, 'POST', '/web-serials/queue/resume', manager.token);
      const job = await createJob(ctx, ctx.user.token, mangaJobBody(manga));
      expect((await api(ctx, 'GET', `/web-serials/jobs/${job.id}`, manager.token)).statusCode).toBe(200);
      await waitForJob(ctx, job.id);
    });
  });

  // ---------------------------------------------------------------------------------------
  // extensions
  // ---------------------------------------------------------------------------------------

  describe('LNReader chapter downloads', () => {
    const sources = () => ctx.fakes.novelSources;
    const volumeThree = { selection: { mode: 'range', fromSequence: '3', toSequence: '3' } };

    async function configureLnreader() {
      sources().addSource({ id: 'alpha', name: 'Alpha Novels' });
      const response = await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, {
        novel: {
          engine: 'lnreader',
          url: sources().url,
          password: 'novel-token',
          sourceIds: ['alpha'],
          targetLibraryId: library.libraryId,
          targetFolderId: library.folderId,
        },
      });
      expect(response.statusCode).toBe(200);
    }

    function seriesKey(path: string) {
      return `nl:alpha:${Buffer.from(path).toString('base64url')}`;
    }

    function jobBody(path: string, extra: Record<string, unknown> = {}) {
      return { seriesKey: seriesKey(path), packaging: 'volume', selection: { mode: 'all' }, libraryId: library.libraryId, ...extra };
    }

    async function chapterCount(path: string) {
      return (await zipEntryNames(path)).filter((name) => name.startsWith('OEBPS/chapters/')).length;
    }

    it('files a grown last volume as a book of its own with the new chapters, and skips a range it already has', async () => {
      await configureLnreader();
      sources().addNovel({ sourceId: 'alpha', path: 'n/grow', name: 'Growing Tale', chapters: 250 });

      expect(await runToEnd(ctx.user.token, jobBody('n/grow', volumeThree))).toMatchObject({ status: 'completed', unitsDone: 1 });
      sources().novels.find((novel) => novel.path === 'n/grow')!.chapters = 280;
      ctx.app.get(WebSerialsSettingsService).bumpCatalogVersion();
      const detail = (await api(ctx, 'GET', `/web-serials/series/${seriesKey('n/grow')}`, ctx.user.token)).json() as WebSerialSeriesDetail;
      expect(detail.units.map((unit) => unit.key)).toContain('volume-3:201-280');
      expect(detail.importedUnitKeys).not.toContain('volume-3:201-280');

      expect(await runToEnd(ctx.user.token, jobBody('n/grow', volumeThree))).toMatchObject({ status: 'completed', unitsDone: 1, unitsSkipped: 0 });
      const books = await listBooks(ctx, library.libraryId);
      expect(books.map((book) => book.title)).toEqual(['Growing Tale, Volume 3 (Chapters 201-250)', 'Growing Tale, Volume 3 (Chapters 201-280)']);
      expect(await chapterCount(books[1]!.files[0]!.path)).toBe(80);
      expect(sources().chapterCalls).toContain('n/grow/c280');

      expect(await runToEnd(ctx.user.token, jobBody('n/grow', volumeThree))).toMatchObject({ unitsDone: 0, unitsSkipped: 1 });
    });

    it('files a grown last block of a novel marked completed as a book of its own', async () => {
      await configureLnreader();
      sources().addNovel({ sourceId: 'alpha', path: 'n/epilogue', name: 'Finished Tale', chapters: 250, status: 'Completed' });

      expect(await runToEnd(ctx.user.token, jobBody('n/epilogue', volumeThree))).toMatchObject({ status: 'completed', unitsDone: 1 });
      sources().novels.find((novel) => novel.path === 'n/epilogue')!.chapters = 251;
      ctx.app.get(WebSerialsSettingsService).bumpCatalogVersion();
      const detail = (await api(ctx, 'GET', `/web-serials/series/${seriesKey('n/epilogue')}`, ctx.user.token)).json() as WebSerialSeriesDetail;
      expect(detail.units.map((unit) => unit.key)).toContain('volume-3:201-251');
      expect(detail.importedUnitKeys).not.toContain('volume-3:201-251');

      expect(await runToEnd(ctx.user.token, jobBody('n/epilogue', volumeThree))).toMatchObject({
        status: 'completed',
        unitsDone: 1,
        unitsSkipped: 0,
      });
      expect((await listBooks(ctx, library.libraryId)).map((book) => book.title)).toEqual([
        'Finished Tale, Volume 3 (Chapters 201-250)',
        'Finished Tale, Volume 3 (Chapters 201-251)',
      ]);
      expect(await runToEnd(ctx.user.token, jobBody('n/epilogue', volumeThree))).toMatchObject({ unitsDone: 0, unitsSkipped: 1 });
    });

    it('never files a volume whose chapters all failed, and says why', async () => {
      await configureLnreader();
      sources().addNovel({ sourceId: 'alpha', path: 'n/dead', name: 'Dead Links', chapters: 3 });
      for (const index of [1, 2, 3]) sources().failChapters.add(`n/dead/c${index}`);

      const done = await runToEnd(ctx.user.token, jobBody('n/dead'));
      expect(done).toMatchObject({ status: 'failed', unitsDone: 0, unitsFailed: 1 });
      expect(await countBooks(ctx, library.libraryId)).toBe(0);
      const [item] = (await getJob(ctx, ctx.user.token, done.id)).items;
      expect(item!.error).toBe('Volume 1: 3 of 3 chapters could not be fetched, too many to file this volume');
    }, 90_000);

    it('pauses through the API mid-chapter, keeps the chapters already saved, and resumes without fetching them again', async () => {
      await configureLnreader();
      sources().addNovel({ sourceId: 'alpha', path: 'n/pause', name: 'Pause Tale', chapters: 5 });
      const gate = sources().holdChapter('n/pause/c3');

      const job = await createJob(ctx, ctx.user.token, jobBody('n/pause'));
      await gateReached(gate);
      expect((await api(ctx, 'POST', `/web-serials/jobs/${job.id}/pause`, ctx.user.token)).statusCode).toBe(200);
      await until(async () => (await jobStatus(ctx, job.id)) === 'paused' && !ctx.runner.isJobActive(job.id), 'the job did not stop');
      expect(gate.isReleased).toBe(false);
      expect((await itemRows(ctx, job.id)).map((item) => item.status)).toEqual(['pending']);

      gate.release();
      expect((await api(ctx, 'POST', `/web-serials/jobs/${job.id}/resume`, ctx.user.token)).statusCode).toBe(200);
      expect(await waitForJob(ctx, job.id)).toMatchObject({ status: 'completed', unitsDone: 1 });
      expect(sources().chapterCalls).toEqual(['n/pause/c1', 'n/pause/c2', 'n/pause/c3', 'n/pause/c3', 'n/pause/c4', 'n/pause/c5']);
      const [book] = await listBooks(ctx, library.libraryId);
      expect(await chapterCount(book!.files[0]!.path)).toBe(5);
    });
  });

  describe('manga extensions', () => {
    beforeEach(() => {
      const extensions = suwayomi().extensions;
      const base = { versionName: '1.4.1', hasUpdate: false, iconUrl: '/api/v1/extension/icon/x', repo: 'https://repo.example/index.min.json' };
      extensions.push(
        { ...base, pkgName: 'eu.kanade.tachiyomi.extension.en.alpha', name: 'Alpha', lang: 'en', isInstalled: true, contentWarning: 'SAFE' },
        { ...base, pkgName: 'eu.kanade.tachiyomi.extension.en.beta', name: 'Beta Reader', lang: 'en', isInstalled: false, contentWarning: 'SAFE' },
        { ...base, pkgName: 'eu.kanade.tachiyomi.extension.ja.spicy', name: 'Spicy', lang: 'ja', isInstalled: false, contentWarning: 'NSFW' },
        {
          ...base,
          pkgName: 'eu.kanade.tachiyomi.extension.all.multi',
          name: 'Multi',
          lang: 'all',
          isInstalled: false,
          contentWarning: null,
          hasUpdate: true,
        },
      );
      suwayomi().addSource({ id: '1001', name: 'Alpha', lang: 'en', pkgName: 'eu.kanade.tachiyomi.extension.en.alpha' });
    });

    it('lists installed extensions first, hides adult ones by default, and filters by language and name', async () => {
      await configure({ novel: false });
      const list = async (query: string) =>
        (await api(ctx, 'GET', `/web-serials/admin/manga-extensions${query}`, ctx.admin.token)).json() as WebSerialMangaExtensionPage;

      const everything = await list('');
      expect(everything.items.map((item) => item.name)).toEqual(['Alpha', 'Beta Reader', 'Multi']);
      expect(everything.total).toBe(3);
      expect(everything.languages).toEqual(['all', 'en', 'ja']);
      expect(everything.items[0]).toMatchObject({ installed: true, adult: false });
      expect(everything.items[0]!.iconUrl).toBe('/api/v1/web-serials/admin/manga-extensions/eu.kanade.tachiyomi.extension.en.alpha/icon');
      expect(everything.items[2]).toMatchObject({ hasUpdate: true });

      expect((await list('?adult=true')).items.map((item) => item.name)).toEqual(['Alpha', 'Beta Reader', 'Multi', 'Spicy']);
      expect((await list('?lang=ja&adult=true')).items.map((item) => item.name)).toEqual(['Spicy']);
      expect((await list('?query=beta')).items.map((item) => item.name)).toEqual(['Beta Reader']);
      expect((await list('?installed=true')).items.map((item) => item.name)).toEqual(['Alpha']);
      expect((await list('?limit=1&offset=1')).items.map((item) => item.name)).toEqual(['Beta Reader']);
      expect((await api(ctx, 'GET', '/web-serials/admin/manga-extensions?limit=500', ctx.admin.token)).statusCode).toBe(400);
    });

    it('installs, updates and uninstalls an extension, and drops its sources from the selection on uninstall', async () => {
      await configure({ novel: false, mangaSourceIds: ['1001'] });
      const pkg = 'eu.kanade.tachiyomi.extension.en.beta';
      const install = await api(ctx, 'POST', `/web-serials/admin/manga-extensions/${pkg}/install`, ctx.admin.token);
      expect(install.statusCode).toBe(200);
      expect(install.json()).toMatchObject({ pkgName: pkg, installed: true });
      const update = await api(ctx, 'POST', '/web-serials/admin/manga-extensions/eu.kanade.tachiyomi.extension.all.multi/update', ctx.admin.token);
      expect(update.json()).toMatchObject({ hasUpdate: false });

      const uninstall = await api(
        ctx,
        'POST',
        '/web-serials/admin/manga-extensions/eu.kanade.tachiyomi.extension.en.alpha/uninstall',
        ctx.admin.token,
      );
      expect(uninstall.json()).toMatchObject({ installed: false });
      const settings = (await api(ctx, 'GET', '/web-serials/admin/settings', ctx.admin.token)).json() as WebSerialSettings;
      expect(settings.manga.sourceIds).toEqual([]);

      expect((await api(ctx, 'POST', '/web-serials/admin/manga-extensions/missing.package.name/install', ctx.admin.token)).statusCode).toBe(502);
      expect((await api(ctx, 'POST', '/web-serials/admin/manga-extensions/Bad%20Name/install', ctx.admin.token)).statusCode).toBe(400);
    });

    it('refreshes the catalogue, serves icons, and manages repositories', async () => {
      await configure({ novel: false });
      const refresh = await api(ctx, 'POST', '/web-serials/admin/manga-extensions/refresh', ctx.admin.token);
      expect(refresh.json()).toEqual({ total: 4 });

      const icon = await api(ctx, 'GET', '/web-serials/admin/manga-extensions/eu.kanade.tachiyomi.extension.en.alpha/icon', ctx.admin.token);
      expect(icon.statusCode).toBe(200);
      expect(icon.headers['content-type']).toContain('image/png');

      const url = 'https://repo.example/community/index.min.json';
      expect((await api(ctx, 'POST', '/web-serials/admin/manga-repos', ctx.admin.token, { url })).statusCode).toBe(204);
      expect((await api(ctx, 'GET', '/web-serials/admin/manga-repos', ctx.admin.token)).json()).toEqual([url]);
      expect((await api(ctx, 'DELETE', `/web-serials/admin/manga-repos?url=${encodeURIComponent(url)}`, ctx.admin.token)).statusCode).toBe(204);
      expect((await api(ctx, 'GET', '/web-serials/admin/manga-repos', ctx.admin.token)).json()).toEqual([]);
      expect((await api(ctx, 'POST', '/web-serials/admin/manga-repos', ctx.admin.token, { url: 'javascript:alert(1)' })).statusCode).toBe(400);
    });

    it('answers a bad gateway, not a crash, when the engine is down', async () => {
      await configure({ novel: false });
      suwayomi().failOp('graphql:BookOrbitExtensions', { mode: 'status', status: 503, times: 1 });
      expect((await api(ctx, 'GET', '/web-serials/admin/manga-extensions', ctx.admin.token)).statusCode).toBe(502);
      expect((await api(ctx, 'GET', '/web-serials/admin/manga-repos', ctx.admin.token)).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------
  // light novel index (LNReader engine)
  // ---------------------------------------------------------------------------------------

  describe('light novel index', () => {
    const sources = () => ctx.fakes.novelSources;
    const filler = () => ctx.app.get(WebSerialsNovelIndexFillerService);

    async function configureLnreader(sourceIds = ['alpha', 'beta']) {
      const response = await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, {
        lookup: { enabled: true },
        novel: {
          engine: 'lnreader',
          url: sources().url,
          password: 'novel-token',
          sourceIds,
          targetLibraryId: library.libraryId,
          targetFolderId: library.folderId,
        },
      });
      expect(response.statusCode).toBe(200);
    }

    function seedSources() {
      sources().addSource({ id: 'alpha', name: 'Alpha Novels' });
      sources().addSource({ id: 'beta', name: 'Beta Books' });
    }

    async function indexRows(sourceId?: string) {
      const rows = await ctx.db.select().from(webSerialNovelIndex).orderBy(asc(webSerialNovelIndex.path));
      return sourceId ? rows.filter((row) => row.sourceId === sourceId) : rows;
    }

    /** Brings forward the recheck of an unconfirmed last page, which otherwise waits for the next top-up interval. */
    async function recheckNow() {
      await ctx.db.update(webSerialNovelIndexSources).set({ recheckAt: null });
    }

    /** A fill ends only when its last page is still empty on a second run. */
    async function fillAll() {
      await filler().tick();
      await recheckNow();
      await filler().tick();
    }

    async function sourceState(sourceId: string) {
      const [row] = await ctx.db.select().from(webSerialNovelIndexSources).where(eq(webSerialNovelIndexSources.sourceId, sourceId));
      return row;
    }

    it('fills every enabled source A-Z page by page, resumes after a failed page, and tops up by latest until known entries', async () => {
      seedSources();
      for (const name of ['Gamma', 'Alpha', 'Epsilon', 'Beta', 'Delta', 'Zeta', 'Eta'])
        sources().addNovel({ sourceId: 'alpha', path: `n/${name.toLowerCase()}`, name });
      sources().addNovel({ sourceId: 'beta', path: 'b/one', name: 'Only One' });
      await configureLnreader();
      sources().failBrowse = { sourceId: 'alpha', page: 2 };

      await filler().tick();
      expect(await sourceState('alpha')).toMatchObject({ fillState: 'filling', nextPage: 2, lastError: 'site timeout' });
      expect(await sourceState('beta')).toMatchObject({ fillState: 'filling', nextPage: 2, emptyPage: 2, entries: 1 });
      expect((await sourceState('beta'))!.recheckAt!.getTime()).toBeGreaterThan(Date.now() + 2 * 60 * 60_000);

      await filler().tick();
      expect(await sourceState('alpha')).toMatchObject({ fillState: 'filling', nextPage: 4, emptyPage: 4 });
      expect(await sourceState('beta')).toMatchObject({ fillState: 'filling', emptyPage: 2 });
      await recheckNow();
      await filler().tick();
      expect(await sourceState('beta')).toMatchObject({ fillState: 'done', entries: 1, emptyPage: null, recheckAt: null });
      const alphaCalls = sources().browseCalls.filter((call) => call.sourceId === 'alpha');
      expect(alphaCalls.map((call) => call.page)).toEqual([1, 2, 2, 3, 4, 4]);
      expect(alphaCalls.every((call) => call.order === 'alphabetical' && !call.latest)).toBe(true);
      expect(await sourceState('alpha')).toMatchObject({ fillState: 'done', entries: 7, requestsToday: 6, lastError: null });
      expect((await indexRows('alpha')).map((row) => row.title)).toEqual(['Alpha', 'Beta', 'Delta', 'Epsilon', 'Eta', 'Gamma', 'Zeta']);

      sources().novels.find((novel) => novel.path === 'n/eta')!.name = 'Eta Renamed';
      sources().addNovel({ sourceId: 'alpha', path: 'n/new', name: 'Brand New', updated: 100 });
      await ctx.db
        .update(webSerialNovelIndexSources)
        .set({ lastTopupAt: new Date(Date.now() - 4 * 60 * 60_000) })
        .where(eq(webSerialNovelIndexSources.sourceId, 'alpha'));
      sources().browseCalls.length = 0;
      await filler().tick();

      const topup = sources().browseCalls.filter((call) => call.sourceId === 'alpha');
      expect(topup.map((call) => [call.page, call.order])).toEqual([
        [1, 'latest'],
        [2, 'latest'],
      ]);
      const rows = await indexRows('alpha');
      expect(rows).toHaveLength(8);
      expect(rows.find((row) => row.path === 'n/new')).toMatchObject({ title: 'Brand New', titleKey: 'brand new' });
      expect(sources().count('browse:beta')).toBe(3);
    });

    it('answers novel search from the index with typos, asks only unfilled sources live, and records what they return', async () => {
      seedSources();
      sources().addNovel({ sourceId: 'alpha', path: 'n/orv', name: 'Omniscient Reader', cover: 'https://alpha.example/orv.jpg' });
      sources().addNovel({ sourceId: 'alpha', path: 'n/orv-mtl', name: 'Omniscient Reader (MTL)' });
      sources().addNovel({ sourceId: 'beta', path: 'b/orv', name: 'Omniscient Reader' });
      await configureLnreader();
      await fillAll();
      sources().resetStats();

      const fuzzy = (await api(ctx, 'GET', '/web-serials/search?q=omniscent%20reader&kind=novel', ctx.user.token)).json() as WebSerialSearchResult;
      expect(fuzzy.hits.map((hit) => `${hit.sourceName}:${hit.mtl === true}`).sort()).toEqual([
        'Alpha Novels:false',
        'Alpha Novels:true',
        'Beta Books:false',
      ]);
      expect(fuzzy.hits.every((hit) => hit.seriesKey?.startsWith('nl:'))).toBe(true);
      expect(fuzzy.hits.find((hit) => hit.sourceName === 'Alpha Novels' && !hit.mtl)!.coverUrl).toMatch(/^\/api\/v1\/web-serials\/series\/nl:alpha:/);
      expect(sources().count(/^search:/)).toBe(0);

      await api(ctx, 'GET', '/web-serials/search?q=omniscent%20reader&kind=novel&refresh=1', ctx.user.token);
      expect(sources().count(/^search:/)).toBe(2);

      await ctx.db.update(webSerialNovelIndexSources).set({ fillState: 'filling' }).where(eq(webSerialNovelIndexSources.sourceId, 'beta'));
      sources().addNovel({ sourceId: 'beta', path: 'b/orv-side', name: 'Omniscient Reader Side Story' });
      sources().resetStats();
      const indexOnly = (
        await api(ctx, 'GET', '/web-serials/search?q=omniscient&kind=novel&phase=index', ctx.user.token)
      ).json() as WebSerialSearchResult;
      expect(indexOnly.livePending).toBe(true);
      expect(sources().count(/^search:/)).toBe(0);

      const full = (await api(ctx, 'GET', '/web-serials/search?q=omniscient&kind=novel', ctx.user.token)).json() as WebSerialSearchResult;
      expect(sources().count('search:beta')).toBe(1);
      expect(sources().count('search:alpha')).toBe(0);
      expect(full.hits.some((hit) => hit.title === 'Omniscient Reader Side Story')).toBe(true);
      expect((await indexRows('beta')).map((row) => row.path)).toContain('b/orv-side');
    });

    it('suggests one entry per series across sources, matched lazily to MangaBaka, within the sources the user left on', async () => {
      seedSources();
      sources().addNovel({ sourceId: 'alpha', path: 'n/orv', name: 'Omniscient Reader', cover: 'https://alpha.example/orv.jpg', chapters: 40 });
      sources().addNovel({ sourceId: 'alpha', path: 'n/orv-mtl', name: 'Omniscient Reader [MTL]' });
      sources().addNovel({ sourceId: 'beta', path: 'b/orv', name: 'Omniscient Reader', chapters: 551 });
      sources().addNovel({ sourceId: 'beta', path: 'b/omega', name: 'Omega Saga' });
      await configureLnreader();
      await fillAll();

      const short = (await api(ctx, 'GET', '/web-serials/suggest?q=om&kind=novel', ctx.user.token)).json() as WebSerialSuggestResult;
      expect(short.suggestions.map((entry) => entry.title).sort()).toEqual(['Omega Saga', 'Omniscient Reader']);
      expect((await api(ctx, 'GET', '/web-serials/suggest?q=o&kind=novel', ctx.user.token)).json()).toEqual({ query: 'o', suggestions: [] });

      const grouped = (await api(ctx, 'GET', '/web-serials/suggest?q=omniscient&kind=novel', ctx.user.token)).json() as WebSerialSuggestResult;
      expect(grouped.suggestions).toHaveLength(1);
      expect(grouped.suggestions[0]).toMatchObject({ kind: 'novel', title: 'Omniscient Reader', sourcesCount: 2, mtlOnly: false });
      expect(grouped.suggestions[0]!.entries).toHaveLength(3);
      expect(grouped.suggestions[0]!.cover).toMatch(/^\/api\/v1\/web-serials\/series\/nl:alpha:/);
      expect(grouped.suggestions[0]).not.toHaveProperty('matchId');

      ctx.fakes.mangabaka.addSeries({ id: 777, title: 'Omniscient Reader', type: 'novel', authors: ['Sing Shong'] });
      expect((await api(ctx, 'GET', '/web-serials/discover?q=omniscient&kind=novel', ctx.user.token)).statusCode).toBe(200);
      const unconfirmed = (await api(ctx, 'GET', '/web-serials/suggest?q=omniscient&kind=novel', ctx.user.token)).json() as WebSerialSuggestResult;
      expect(unconfirmed.suggestions[0]).not.toHaveProperty('matchId');

      sources().resetStats();
      const options = (await api(ctx, 'GET', '/web-serials/discover/novel/777/sources', ctx.user.token)).json() as WebSerialSourceOptions;
      expect(options.options.map((option) => [option.sourceName, option.confidence, option.chapterCount])).toEqual([
        ['Alpha Novels', 'title_match', 40],
        ['Beta Books', 'title_match', 0],
      ]);
      expect(sources().count(/^novel:/)).toBe(1);
      expect(sources().count(/^search:/)).toBe(0);
      const [opened] = await ctx.db.select().from(webSerialNovelIndex).where(eq(webSerialNovelIndex.path, 'n/orv'));
      expect(opened).toMatchObject({ chapterCount: 40, status: 'ongoing', author: 'Sing Shong', matchId: null });
      expect(opened!.detailsAt).toBeInstanceOf(Date);

      expect((await api(ctx, 'GET', '/web-serials/discover?q=omniscient&kind=novel', ctx.user.token)).statusCode).toBe(200);
      const matchIds = async () => Object.fromEntries((await indexRows()).map((row) => [`${row.sourceId}:${row.path}`, row.matchId]));
      expect(await matchIds()).toMatchObject({ 'alpha:n/orv': '777', 'beta:b/orv': null });
      const matched = (await api(ctx, 'GET', '/web-serials/suggest?q=omniscient&kind=novel', ctx.user.token)).json() as WebSerialSuggestResult;
      expect(matched.suggestions).toHaveLength(1);
      expect(matched.suggestions[0]).toMatchObject({ matchId: '777', sourcesCount: 2 });
      expect(matched.suggestions[0]!.entries.map((entry) => entry.path)).toEqual(['n/orv', 'b/orv', 'n/orv-mtl']);

      const mtlKey = `nl:alpha:${Buffer.from('n/orv-mtl').toString('base64url')}`;
      const preset = (await api(ctx, 'GET', `/web-serials/series/${mtlKey}/lookup?matchId=777`, ctx.user.token)).json() as WebSerialSeriesLookup;
      expect(preset.match).toMatchObject({ id: '777' });
      expect((await matchIds())['alpha:n/orv-mtl']).toBeNull();
      const betaKey = `nl:beta:${Buffer.from('b/orv').toString('base64url')}`;
      const confirmed = (await api(ctx, 'GET', `/web-serials/series/${betaKey}/lookup`, ctx.user.token)).json() as WebSerialSeriesLookup;
      expect(confirmed.match).toMatchObject({ id: '777' });
      expect((await matchIds())['beta:b/orv']).toBe('777');

      expect((await api(ctx, 'PUT', '/web-serials/novel-providers', ctx.user.token, { disabledDomains: ['beta'] })).statusCode).toBe(200);
      const scoped = (await api(ctx, 'GET', '/web-serials/suggest?q=omniscient&kind=novel', ctx.user.token)).json() as WebSerialSuggestResult;
      expect(scoped.suggestions[0]).toMatchObject({ sourcesCount: 1 });
      expect(scoped.suggestions.flatMap((entry) => entry.entries).every((entry) => entry.sourceId === 'alpha')).toBe(true);
      const other = (await api(ctx, 'GET', '/web-serials/suggest?q=omniscient&kind=novel', ctx.other.token)).json() as WebSerialSuggestResult;
      expect(other.suggestions[0]).toMatchObject({ matchId: '777', sourcesCount: 2 });
      expect((await api(ctx, 'GET', '/web-serials/suggest?q=omniscient&kind=novel', ctx.outsider.token)).statusCode).toBe(403);
    });

    it('offers the site carrying the whole web novel for each light novel arc, author confirmed, and credits the first arc there', async () => {
      seedSources();
      sources().addNovel({ sourceId: 'alpha', path: 'n/water-magician', name: 'Water Magician', chapters: 12, author: 'Kubou Tadashi' });
      sources().addNovel({ sourceId: 'beta', path: 'b/water-magician', name: 'Water Magician', chapters: 30, author: 'Someone Else' });
      const baka = ctx.fakes.mangabaka;
      const arc = { type: 'novel' as const, authors: ['Tadashi Kubou'], genres: ['fantasy'] };
      baka.addSeries({ ...arc, id: 9101, title: 'The Water Magician: The Central Provinces Arc', year: 2021 });
      baka.addSeries({ ...arc, id: 9102, title: 'The Water Magician: The Western Provinces Arc', year: 2023 });
      baka.addSeries({
        ...arc,
        id: 9103,
        title: 'Mizu Zokusei no Mahou Tsukai Dai San-bu: Touhou Shokoku-hen',
        secondaryTitles: ['The Water Magician: The Eastern Provinces Arc'],
        year: 2025,
      });
      await configureLnreader();
      await fillAll();

      for (const id of [9102, 9101, 9103]) {
        const options = (await api(ctx, 'GET', `/web-serials/discover/novel/${id}/sources`, ctx.user.token)).json() as WebSerialSourceOptions;
        expect(options.options.map((option) => [option.sourceName, option.confidence, option.chapterCount])).toEqual([
          ['Alpha Novels', 'whole_series', 12],
        ]);
      }
      expect(sources().count(/^search:/)).toBe(0);

      const seriesKey = `nl:alpha:${Buffer.from('n/water-magician').toString('base64url')}`;
      const lookup = (await api(ctx, 'GET', `/web-serials/series/${seriesKey}/lookup`, ctx.user.token)).json() as WebSerialSeriesLookup;
      expect(lookup).toMatchObject({
        state: 'matched',
        match: { id: '9101', title: 'The Water Magician: The Central Provinces Arc', genres: ['Fantasy'], scope: 'part' },
        chapterVolumes: null,
      });
      const preset = (await api(ctx, 'GET', `/web-serials/series/${seriesKey}/lookup?matchId=9101`, ctx.user.token)).json() as WebSerialSeriesLookup;
      expect(preset).toMatchObject({ state: 'matched', match: { id: '9101' } });
      const [row] = await ctx.db.select().from(webSerialNovelIndex).where(eq(webSerialNovelIndex.path, 'n/water-magician'));
      expect(row!.matchId).toBeNull();
      const again = (await api(ctx, 'GET', '/web-serials/discover/novel/9101/sources', ctx.user.token)).json() as WebSerialSourceOptions;
      expect(again.options.map((option) => option.confidence)).toEqual(['whole_series']);

      const other = `nl:beta:${Buffer.from('b/water-magician').toString('base64url')}`;
      const otherLookup = (await api(ctx, 'GET', `/web-serials/series/${other}/lookup`, ctx.user.token)).json() as WebSerialSeriesLookup;
      expect(otherLookup.state).toBe('no_match');
    });

    it('lets an admin see, fill and rebuild each source, and forgets a removed source', async () => {
      seedSources();
      sources().addNovel({ sourceId: 'alpha', path: 'n/a', name: 'First' });
      sources().addNovel({ sourceId: 'beta', path: 'b/b', name: 'Second' });
      await configureLnreader(['alpha']);

      const before = (await api(ctx, 'GET', '/web-serials/admin/novel-index', ctx.admin.token)).json() as WebSerialNovelIndexStatus;
      expect(before.dailyBudget).toBe(1500);
      expect(before.sources.map((source) => [source.sourceId, source.name, source.enabled])).toEqual([
        ['alpha', 'Alpha Novels', true],
        ['beta', 'Beta Books', false],
      ]);
      expect((await api(ctx, 'GET', '/web-serials/admin/novel-index', ctx.user.token)).statusCode).toBe(403);
      expect((await api(ctx, 'POST', '/web-serials/admin/novel-index/alpha/fill', ctx.user.token)).statusCode).toBe(403);
      expect((await api(ctx, 'POST', '/web-serials/admin/novel-index/missing/fill', ctx.admin.token)).statusCode).toBe(404);

      expect((await api(ctx, 'POST', '/web-serials/admin/novel-index/alpha/fill', ctx.admin.token)).statusCode).toBe(200);
      await waitFor(async () => (await sourceState('alpha'))?.emptyPage === 2, 'alpha never reached its last page');
      await waitFor(() => !filler().isRunning, 'the filler never finished');
      expect((await api(ctx, 'POST', '/web-serials/admin/novel-index/alpha/fill', ctx.admin.token)).statusCode).toBe(200);
      await waitFor(async () => (await sourceState('alpha'))?.fillState === 'done', 'alpha was never filled');
      await waitFor(() => !filler().isRunning, 'the filler never finished');
      expect((await sourceState('beta'))?.fillState).toBe('pending');

      expect((await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, { novel: { indexDailyBudget: 200 } })).statusCode).toBe(200);
      const rebuilt = await api(ctx, 'POST', '/web-serials/admin/novel-index/alpha/rebuild', ctx.admin.token);
      expect(rebuilt.statusCode).toBe(200);
      expect((rebuilt.json() as WebSerialNovelIndexStatus).dailyBudget).toBe(200);
      await waitFor(async () => (await sourceState('alpha'))?.emptyPage === 2 && !filler().isRunning, 'alpha was never refilled');
      await recheckNow();
      await filler().tick();
      await waitFor(
        async () => (await sourceState('alpha'))?.fillState === 'done' && (await indexRows('alpha')).length === 1,
        'alpha was never rebuilt',
      );
      await waitFor(() => !filler().isRunning, 'the filler never finished');

      await ctx.db.insert(webSerialNovelIndex).values({ sourceId: 'beta', path: 'b/x', title: 'Left Over', titleKey: 'left over' });
      expect((await api(ctx, 'DELETE', '/web-serials/admin/novel-source-catalog/beta', ctx.admin.token)).statusCode).toBe(204);
      expect(await indexRows('beta')).toEqual([]);
      expect(await sourceState('beta')).toBeUndefined();
    });

    it('owns a volume from another source only when an owned range holds all of it, never by its number', async () => {
      seedSources();
      sources().addNovel({ sourceId: 'alpha', path: 'n/orv', name: "Omniscient Reader's Viewpoint", chapters: 250 });
      await configureLnreader();
      const ledger = async (seriesKey: string, values: Partial<typeof webSerialImports.$inferInsert>, seriesName: string) => {
        const [book] = await ctx.db
          .insert(schema.books)
          .values({ libraryId: library.libraryId, libraryFolderId: library.folderId, folderPath: `orv-${seriesKey}-${values.unitKey}` })
          .returning({ id: schema.books.id });
        await ctx.db.insert(schema.bookMetadata).values({ bookId: book!.id, title: `${seriesName}, ${values.unitKey}`, seriesName });
        await ctx.db.insert(webSerialImports).values({
          userId: ctx.user.userId,
          seriesKey,
          kind: 'novel',
          unitKey: 'volume-1',
          sequence: '1',
          packaging: 'volume',
          bookId: book!.id,
          ...values,
        });
      };
      // Another engine numbered its own volumes: volume 1 there says nothing about chapters 1-100 here.
      await ledger('n:old-crawler-id', { unitKey: 'vol-1', chapterFrom: 1, chapterTo: 100 }, 'Omniscient Reader’s Viewpoint');
      // Another LNReader source of the same novel, filed before ranges were stored: only its own source may use it.
      await ledger('nl:beta:b2xk', { unitKey: 'volume-1' }, 'Omniscient Reader’s Viewpoint');
      // Same engine, a range that holds every chapter of volume 2, filed under a title with an edition tag.
      await ledger(
        'nl:beta:b3Jh',
        { unitKey: 'volume-2', sequence: '2', chapterFrom: 101, chapterTo: 200 },
        'Omniscient Reader’s Viewpoint (Web Novel)',
      );
      // Same engine and title, but a shorter range than the growing last volume holds now.
      await ledger('nl:beta:b3Jh', { unitKey: 'volume-3:201-230', sequence: '3', chapterFrom: 201, chapterTo: 230 }, 'Omniscient Reader’s Viewpoint');

      const remoteId = `alpha:${Buffer.from('n/orv').toString('base64url')}`;
      const detail = (await api(ctx, 'GET', `/web-serials/series/nl:${remoteId}`, ctx.user.token)).json() as WebSerialSeriesDetail;
      expect(detail.units.map((unit) => unit.key)).toEqual(['volume-1', 'volume-2', 'volume-3:201-250']);
      expect(detail.importedUnitKeys).toEqual(['volume-2']);
      const stranger = (await api(ctx, 'GET', `/web-serials/series/nl:${remoteId}`, ctx.other.token)).json() as WebSerialSeriesDetail;
      expect(stranger.importedUnitKeys).toEqual([]);
    });

    it('stores a catalogue entry whose cover link is too long without the link, instead of failing the page', async () => {
      seedSources();
      sources().addNovel({ sourceId: 'alpha', path: 'n/long', name: 'Long Cover', cover: `https://alpha.example/${'c'.repeat(3000)}.jpg` });
      sources().addNovel({ sourceId: 'alpha', path: 'n/fine', name: 'Fine', cover: 'https://alpha.example/fine.jpg' });
      await configureLnreader(['alpha']);

      await fillAll();

      expect(await sourceState('alpha')).toMatchObject({ fillState: 'done', entries: 2, lastError: null });
      expect((await indexRows('alpha')).map((row) => [row.path, row.coverUrl])).toEqual([
        ['n/fine', 'https://alpha.example/fine.jpg'],
        ['n/long', null],
      ]);
    });

    it('keeps the index entries of a source the service no longer has out of search and suggestions', async () => {
      seedSources();
      sources().addNovel({ sourceId: 'alpha', path: 'n/orv', name: 'Omniscient Reader' });
      sources().addNovel({ sourceId: 'beta', path: 'b/orv', name: 'Omniscient Reader Side Story' });
      await configureLnreader();
      await fillAll();
      const suggested = async () =>
        ((await api(ctx, 'GET', '/web-serials/suggest?q=omniscient&kind=novel', ctx.user.token)).json() as WebSerialSuggestResult).suggestions
          .flatMap((entry) => entry.entries.map((copy) => copy.sourceId))
          .sort();
      const searched = async (q: string) =>
        ((await api(ctx, 'GET', `/web-serials/search?q=${q}&kind=novel`, ctx.user.token)).json() as WebSerialSearchResult).hits
          .map((hit) => hit.sourceName)
          .sort();
      expect(await suggested()).toEqual(['alpha', 'beta']);
      expect(await searched('omniscient')).toEqual(['Alpha Novels', 'Beta Books']);

      sources().sources.splice(
        sources().sources.findIndex((source) => source.id === 'beta'),
        1,
      );
      ctx.app.get(WebSerialsSettingsService).bumpCatalogVersion();

      expect(await suggested()).toEqual(['alpha']);
      expect(await searched('omniscient%20reader')).toEqual(['Alpha Novels']);
      expect(await indexRows('beta')).toHaveLength(1);
    });

    it('fills the suggestion list up to its limit when unmatched copies fold into one series', async () => {
      const titles = Array.from({ length: 10 }, (_, index) => `Omniscient Reader ${index + 1}`);
      await ctx.db.insert(webSerialNovelIndex).values([
        ...titles.map((title, index) => ({ sourceId: 'alpha', path: `m/${index}`, title, titleKey: title.toLowerCase(), matchId: '777' })),
        ...titles.map((title, index) => ({ sourceId: 'beta', path: `c/${index}`, title, titleKey: title.toLowerCase() })),
        ...Array.from({ length: 10 }, (_, index) => {
          const title = `Omniscient Zebra Chronicles ${index + 1}`;
          return { sourceId: 'beta', path: `z/${index}`, title, titleKey: title.toLowerCase() };
        }),
      ]);

      const suggestions = await ctx.app.get(WebSerialsNovelIndexRepository).suggestNovelIndex('omniscient', ['alpha', 'beta'], 8);

      expect(suggestions).toHaveLength(8);
      expect(suggestions[0]).toMatchObject({ matchId: '777', sourcesCount: 2 });
      expect(suggestions[0]!.entries).toHaveLength(20);
      expect(suggestions.slice(1).every((entry) => entry.title.startsWith('Omniscient Zebra'))).toBe(true);
    });

    it('finds a multi-word title among thousands of titles that share one of its words', async () => {
      await ctx.db.execute(sql`insert into web_serial_novel_index (source_id, path, title, title_key, mtl)
        select src, 'p/' || i, t, t, i % 9 = 0 from (
          select i,
            case when i <= 60000 then 's1' when i <= 85000 then 's2' when i <= 95000 then 's3' when i <= 99000 then 's4' else 's5' end as src,
            (array['the','i','my','a','reincarnated','the','return','of','the','villainess','in','another','world','with','my','level','up','system','the','demon','king','is','a','god','sword','saint','dragon','academy','tower','hunter','solo','the','strongest','mage'])[1 + (i * 7) % 34] || ' ' ||
            (array['the','of','in','a','to','my','is','reincarnated','world','villainess','system','hero','lord','king','queen','prince','duke','daughter','son','return','regression','martial','god','emperor'])[1 + (i * 13) % 24] || ' ' ||
            (array['the','of','in','another','world','as','a','villain','with','cheat','skill','for','dummies','again','forever','tower','dungeon','sword','magic','academy'])[1 + (i * 31) % 20] || ' ' ||
            substr(md5(i::text), 1, 5) as t
          from generate_series(1, 100000) as i
        ) generated`);
      await ctx.db
        .insert(webSerialNovelIndex)
        .values({ sourceId: 's1', path: 'target', title: 'The Villainess Turns the Hourglass', titleKey: 'the villainess turns the hourglass' });
      await ctx.db.execute(sql`analyze web_serial_novel_index`);
      const repo = ctx.app.get(WebSerialsNovelIndexRepository);
      const sourceIds = ['s1', 's2', 's3', 's4', 's5'];
      try {
        const [{ qualifying }] = (
          await ctx.db.execute<{ qualifying: number }>(
            sql`select count(*)::int as qualifying from web_serial_novel_index where 'villainess turns' <% title_key`,
          )
        ).rows as [{ qualifying: number }];
        expect(qualifying).toBeGreaterThan(1000);

        const startedAt = performance.now();
        const hits = await repo.searchNovelIndex('villainess turns', sourceIds, 5);
        const searchMs = performance.now() - startedAt;
        const suggestions = await repo.suggestNovelIndex('villainess turns', sourceIds, 8);
        console.log(`[novel-index-similarity] qualifying=${qualifying} searchMs=${Math.round(searchMs)}`);

        expect(hits[0]).toMatchObject({ path: 'target', title: 'The Villainess Turns the Hourglass' });
        expect(suggestions[0]!.title).toBe('The Villainess Turns the Hourglass');
        expect(searchMs).toBeLessThan(250);
      } finally {
        await ctx.db.delete(webSerialNovelIndex);
      }
    });

    it('suggests quickly on 100k index rows through the trigram and prefix indexes', async () => {
      await ctx.db.execute(sql`insert into web_serial_novel_index (source_id, path, title, title_key, mtl)
        select 'scale', 'p/' || i, initcap(t), t, i % 7 = 0
        from (
          select i, (array['shadow','reader','omniscient','sword','dragon','return','level','solo','king','academy'])[1 + i % 10] || ' ' ||
            (array['of','the','returned','eternal','second','villain','tower','hunter','saint','mage'])[1 + (i / 10) % 10] || ' ' ||
            substr(md5(i::text), 1, 6) as t
          from generate_series(1, 100000) as i
        ) generated`);
      await ctx.db.insert(webSerialNovelIndex).values(
        Array.from({ length: 500 }, (_, index) => ({
          sourceId: `other-${index % 5}`,
          path: `o/${index}`,
          title: `Sword Hunter ${index}`,
          titleKey: `sword hunter ${index}`,
        })),
      );
      await ctx.db.execute(sql`analyze web_serial_novel_index`);
      const repo = ctx.app.get(WebSerialsNovelIndexRepository);
      try {
        for (const warm of ['omni', 'om']) await repo.suggestNovelIndex(warm, ['scale'], 8);
        const timings: Record<string, number> = {};
        for (const query of ['omniscient tower', 'omniscient towr', 'omni', 'om', 'sword huntr']) {
          const runs: number[] = [];
          for (let run = 0; run < 5; run += 1) {
            const startedAt = performance.now();
            const found = await repo.suggestNovelIndex(query, ['scale'], 8);
            runs.push(performance.now() - startedAt);
            expect(found.length, query).toBeGreaterThan(0);
          }
          timings[query] = runs.sort((a, b) => a - b)[2]!;
        }
        const explain = (query: ReturnType<typeof sql>) =>
          ctx.db.transaction(async (tx) => {
            await tx.execute(sql`set local enable_seqscan = off`);
            return (await tx.execute<{ 'QUERY PLAN': string }>(query)).rows.map((row) => row['QUERY PLAN']).join('\n');
          });
        const plan = await explain(sql`explain analyze ${repo.novelIndexSearchQuery('omniscient tower', ['scale'], 8)}`);
        const prefixPlan = await explain(
          sql`explain analyze select id from web_serial_novel_index where source_id in ('scale') and title_key like 'om%' order by title_key using ~<~ limit 200`,
        );
        console.log(`[novel-index-scale] medianMs=${JSON.stringify(timings)}`);
        console.log(`[novel-index-scale] trigram plan:\n${plan}`);
        console.log(`[novel-index-scale] prefix plan:\n${prefixPlan}`);
        expect(plan).toContain('Bitmap Index Scan on web_serial_novel_index_title_filter_idx');
        expect(plan).toMatch(/Index Scan using web_serial_novel_index_title_gist_idx[^\n]*\(actual time/);
        expect(prefixPlan).toContain('web_serial_novel_index_title_prefix_idx');
        // The target is 20 ms; the assertion leaves room for slower CI machines.
        for (const value of Object.values(timings)) expect(value).toBeLessThan(50);
      } finally {
        await ctx.db.delete(webSerialNovelIndex);
      }
    });
  });

  it('keeps the scratch data model honest: no job item survives its job', async () => {
    const manga = seedManga({ title: 'Cascade Series', chapters: 2 });
    await configure({ novel: false });
    const done = await runToEnd(ctx.user.token, mangaJobBody(manga));
    expect(await ctx.db.$count(webSerialJobItems, eq(webSerialJobItems.jobId, done.id))).toBe(2);
    await api(ctx, 'DELETE', `/web-serials/jobs/${done.id}`, ctx.user.token);
    expect(await ctx.db.$count(webSerialJobItems)).toBe(0);
  });
});
