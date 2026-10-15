import { asc, eq } from 'drizzle-orm';
import { vi } from 'vitest';

import { NovelSourcesClient } from '../src/modules/web-serials/engines/novel-sources.client';
import { webSerialNovelIndex, webSerialNovelIndexSources } from '../src/modules/web-serials/schema/web-serials.schema';
import { WebSerialsNovelIndexFillerService } from '../src/modules/web-serials/web-serials-novel-index-filler.service';
import { WebSerialsNovelIndexRepository } from '../src/modules/web-serials/web-serials-novel-index.repository';
import {
  api,
  closeWebSerialsContext,
  createLibrary,
  createWebSerialsContext,
  resetWebSerialsState,
  type WebSerialsContext,
  type WebSerialsLibrary,
} from './e2e/web-serials/web-serials-harness';
import { Gate } from './e2e/web-serials/fake-serial-engines';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('Web Serials data and API (e2e)', () => {
  let ctx!: WebSerialsContext;
  let library!: WebSerialsLibrary;
  const sources = () => ctx.fakes.novelSources;
  const filler = () => ctx.app.get(WebSerialsNovelIndexFillerService);

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

  afterEach(() => vi.restoreAllMocks());

  async function configureLnreader(sourceIds: string[]) {
    const response = await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, {
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

  function seedAlpha(count = 7) {
    sources().addSource({ id: 'alpha', name: 'Alpha Novels' });
    for (let index = 0; index < count; index += 1) {
      sources().addNovel({ sourceId: 'alpha', path: `n/${index}`, name: `Title ${String.fromCharCode(65 + index)}` });
    }
  }

  async function sourceState(sourceId: string) {
    const [row] = await ctx.db.select().from(webSerialNovelIndexSources).where(eq(webSerialNovelIndexSources.sourceId, sourceId));
    return row;
  }

  async function indexPaths(sourceId: string) {
    const rows = await ctx.db
      .select()
      .from(webSerialNovelIndex)
      .where(eq(webSerialNovelIndex.sourceId, sourceId))
      .orderBy(asc(webSerialNovelIndex.path));
    return rows.map((row) => row.path);
  }

  /** Holds the browse of one page open until the returned gate is released, so an admin action can land mid-fetch. */
  function holdBrowse(page: number): Gate {
    const gate = new Gate();
    const client = ctx.app.get(NovelSourcesClient);
    const original = client.browse.bind(client);
    vi.spyOn(client, 'browse').mockImplementation(async (...args: Parameters<NovelSourcesClient['browse']>) => {
      const result = await original(...args);
      if (args[2] === page && !gate.isReleased) {
        gate.touch();
        while (!gate.isReleased) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return result;
    });
    return gate;
  }

  async function fillToEnd() {
    await filler().tick();
    await ctx.db.update(webSerialNovelIndexSources).set({ recheckAt: null });
    await filler().tick();
  }

  describe('light novel index races', () => {
    it('does not bring back a source removed while one of its pages was being fetched, so a reinstall fills from the first page', async () => {
      seedAlpha();
      await configureLnreader(['alpha']);
      const gate = holdBrowse(2);

      const run = filler().tick();
      await gate.reached;
      const removed = await api(ctx, 'DELETE', '/web-serials/admin/novel-source-catalog/alpha', ctx.admin.token);
      expect(removed.statusCode).toBeLessThan(300);
      gate.release();
      await run;

      expect(await sourceState('alpha')).toBeUndefined();
      expect(await indexPaths('alpha')).toEqual([]);

      vi.restoreAllMocks();
      seedAlpha();
      await configureLnreader(['alpha']);
      sources().browseCalls.length = 0;
      await fillToEnd();

      expect(sources().browseCalls.filter((call) => call.sourceId === 'alpha')[0]).toMatchObject({ page: 1 });
      expect(await sourceState('alpha')).toMatchObject({ fillState: 'done', entries: 7 });
      expect(await indexPaths('alpha')).toHaveLength(7);
    });

    it('keeps a rebuild that lands during a fetch at its first page, without the stale page', async () => {
      seedAlpha();
      await configureLnreader(['alpha']);
      const gate = holdBrowse(2);

      const run = filler().tick();
      await gate.reached;
      await ctx.app.get(WebSerialsNovelIndexRepository).resetNovelIndexSource('alpha');
      gate.release();
      await run;

      expect(await sourceState('alpha')).toMatchObject({ fillState: 'pending', nextPage: 1, entries: 0, fillSort: null });
      expect(await indexPaths('alpha')).toEqual([]);

      vi.restoreAllMocks();
      await fillToEnd();
      expect(await sourceState('alpha')).toMatchObject({ fillState: 'done', entries: 7 });
    });
  });

  describe('disabled light novel sites', () => {
    function seriesKey(sourceId: string, path: string) {
      return `nl:${sourceId}:${Buffer.from(path).toString('base64url')}`;
    }

    it('refuses preview, lookup, sources and downloads from a site the admin disabled but left installed', async () => {
      seedAlpha(1);
      sources().addSource({ id: 'beta', name: 'Beta Books' });
      sources().addNovel({ sourceId: 'beta', path: 'b/one', name: 'Only One' });
      await configureLnreader(['alpha']);
      const key = seriesKey('beta', 'b/one');

      for (const url of [`/web-serials/series/${key}`, `/web-serials/series/${key}/lookup`, `/web-serials/series/${key}/sources`]) {
        const response = await api(ctx, 'GET', url, ctx.user.token);
        expect([url, response.statusCode, (response.json() as { errorCode?: string }).errorCode]).toEqual([url, 404, 'WEB_SERIAL_SOURCE_DISABLED']);
      }
      const job = await api(ctx, 'POST', '/web-serials/jobs', ctx.user.token, {
        seriesKey: key,
        packaging: 'volume',
        selection: { mode: 'all' },
        libraryId: library.libraryId,
      });
      expect([job.statusCode, (job.json() as { errorCode?: string }).errorCode]).toEqual([404, 'WEB_SERIAL_SOURCE_DISABLED']);

      const allowed = await api(ctx, 'GET', `/web-serials/series/${seriesKey('alpha', 'n/0')}`, ctx.user.token);
      expect(allowed.statusCode).toBe(200);
    });
  });

  describe('permissions', () => {
    it('keeps the remaining user routes behind the Web Serials permission', async () => {
      const routes: Array<['GET' | 'POST' | 'PUT', string, unknown?]> = [
        ['GET', '/web-serials/suggest?q=omni'],
        ['GET', '/web-serials/novel-providers'],
        ['PUT', '/web-serials/novel-providers', { disabledDomains: [] }],
        ['GET', '/web-serials/published-requests?matchId=1'],
        ['POST', '/web-serials/published-requests', { matchId: '1', volume: 1, bookRequestId: 1 }],
        ['POST', '/web-serials/jobs/1/retry'],
      ];
      for (const [method, url, payload] of routes) {
        const response = await api(ctx, method, url, ctx.outsider.token, payload);
        expect([method, url, response.statusCode]).toEqual([method, url, 403]);
      }
    });

    it('keeps the light novel source catalogue and index routes for admins', async () => {
      const routes: Array<['GET' | 'POST' | 'DELETE', string]> = [
        ['GET', '/web-serials/admin/novel-source-catalog'],
        ['GET', '/web-serials/admin/novel-source-catalog/installed'],
        ['POST', '/web-serials/admin/novel-source-catalog/alpha/install'],
        ['POST', '/web-serials/admin/novel-source-catalog/alpha/update'],
        ['DELETE', '/web-serials/admin/novel-source-catalog/alpha'],
        ['GET', '/web-serials/admin/novel-index'],
        ['POST', '/web-serials/admin/novel-index/alpha/fill'],
        ['POST', '/web-serials/admin/novel-index/alpha/rebuild'],
      ];
      for (const [method, url] of routes) {
        for (const who of [ctx.user, ctx.other, ctx.outsider]) {
          const response = await api(ctx, method, url, who.token);
          expect([who.username, method, url, response.statusCode]).toEqual([who.username, method, url, 403]);
        }
      }
    });
  });
});
