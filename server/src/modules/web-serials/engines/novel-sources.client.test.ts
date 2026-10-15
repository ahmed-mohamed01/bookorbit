import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyFailure } from '../web-serials-failure.utils';
import { NOVEL_SOURCES_ROUTE_TIMEOUTS_MS } from './novel-source-limits';
import { decodeNovelRemoteId, NovelSourcesClient } from './novel-sources.client';
import { MissingChaptersError, TooManyMissingChaptersError, UnitDownloadStopped } from './web-serial-engine';

const failWrite = vi.hoisted(() => ({ match: null as RegExp | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [path, data] = args;
      if (typeof path === 'string' && typeof data === 'string' && failWrite.match?.test(path)) {
        await actual.writeFile(path, data.slice(0, 4));
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      return actual.writeFile(...args);
    },
  };
});

const fetchEngineResponse = vi.fn();
vi.mock('./engine-http.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./engine-http.utils')>()),
  fetchEngineResponse: (...args: unknown[]) => fetchEngineResponse(...args),
}));

const CONN = { url: 'http://novel-sources:8282', username: null, password: 'token' };
const SOURCES = [
  { id: 'a', name: 'Source A', site: 'https://www.a.test', lang: 'English', version: '1', installed: true },
  { id: 'b', name: 'Source B', site: 'https://b.test', lang: 'English', version: '1', installed: true },
];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function build() {
  const epub = {
    build: vi.fn(async ({ outputPath }: { outputPath: string }) => {
      await writeFile(outputPath, 'epub');
      return { path: outputPath, size: 4 };
    }),
  };
  const lncrawl = { resolveUrl: vi.fn() };
  return { client: new NovelSourcesClient(epub as never, lncrawl as never), epub, lncrawl };
}

afterEach(() => {
  fetchEngineResponse.mockReset();
  failWrite.match = null;
});

function unitHandle(workDir: string, titles: string[]) {
  return {
    unitKey: 'v1',
    remote: {
      sourceId: 'a',
      seriesPath: '/n',
      seriesTitle: 'Novel',
      authors: [],
      cover: null,
      chapterPaths: titles.map((_title, index) => `/c/${index + 1}`),
      chapterTitles: titles,
      chapterUrls: titles.map(() => null),
      volumeIndex: '1',
      volumeLabel: 'Volume 1',
      workDir,
    },
  };
}

function chapterPathOf(call: unknown[]): string {
  return new URL(`http://x${call[1] as string}`).searchParams.get('path') ?? '';
}

describe('NovelSourcesClient', () => {
  function healthAnswers(health: Record<string, unknown>, sources: () => Response = () => json(SOURCES)) {
    fetchEngineResponse.mockImplementation((_url, path: string) => Promise.resolve(path === '/api/v1/health' ? json(health) : sources()));
  }

  it('checks the token against the source list and counts the sources the service loaded', async () => {
    healthAnswers({ ok: true, version: '1.2.3', installed: 7 }, () => json([...SOURCES, { ...SOURCES[0], id: 'c', broken: true }]));

    await expect(build().client.health(CONN)).resolves.toMatchObject({ ok: true, version: '1.2.3', searchableSources: 7 });
    const [, path, init] = fetchEngineResponse.mock.calls[0]!;
    expect(path).toBe('/api/v1/health');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    const [, sourcesPath, sourcesInit] = fetchEngineResponse.mock.calls[1]!;
    expect(sourcesPath).toBe('/api/v1/sources');
    expect(new Headers(sourcesInit.headers).get('Authorization')).toBe('Bearer token');
  });

  it('fails the connection test when the service refuses the token', async () => {
    healthAnswers({ ok: true, version: '1.2.3', installed: 7 }, () => json({ error: 'Unauthorized' }, 401));

    await expect(build().client.health(CONN)).resolves.toMatchObject({
      ok: false,
      searchableSources: 0,
      error: 'The remote service rejected the configured credentials',
    });
  });

  describe('per-source search limit', () => {
    function slowSource(answerMs: number) {
      fetchEngineResponse.mockImplementation((_url, path: string, _init: unknown, options: { signal?: AbortSignal }) => {
        if (path === '/api/v1/sources') return Promise.resolve(json([SOURCES[0]]));
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(json({ items: [{ name: 'Slow Novel', path: 'n/1', url: 'https://a.test/n/1' }], page: 1, hasMore: false })),
            answerMs,
          );
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      });
    }

    function fakeTimeoutSignals() {
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('timeout')), ms);
        return controller.signal;
      });
    }

    async function searchAfter(conn: typeof CONN & { solver?: boolean }, answerMs: number) {
      vi.useFakeTimers();
      fakeTimeoutSignals();
      try {
        slowSource(answerMs);
        const pending = build().client.search(conn, 'Slow Novel', ['a']);
        await vi.advanceTimersByTimeAsync(35_000);
        return await pending;
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    }

    it('waits for a slow source when the service has a solver', async () => {
      const result = await searchAfter({ ...CONN, solver: true }, 20_000);
      expect(result.failedSources).toEqual([]);
      expect(result.hits).toHaveLength(1);
    });

    it('reports a source answering at 20 s as failed without a solver', async () => {
      const result = await searchAfter(CONN, 20_000);
      expect(result.failedSources).toEqual(['Source A']);
      expect(result.hits).toHaveLength(0);
    });

    it('still cuts a source off at the longer limit', async () => {
      const result = await searchAfter({ ...CONN, solver: true }, 33_000);
      expect(result.failedSources).toEqual(['Source A']);
    });

    it('reads solver from health and treats a missing field as false', async () => {
      healthAnswers({ ok: true, installed: 1, solver: true });
      const withSolver = build();
      await expect(withSolver.client.health(CONN)).resolves.toMatchObject({ solver: true });
      healthAnswers({ ok: true, installed: 1 });
      await expect(build().client.health(CONN)).resolves.toMatchObject({ solver: false });
    });
  });

  it('fans search out, keeps partial failures and marks MTL titles', async () => {
    fetchEngineResponse.mockImplementation((_url, path: string) => {
      if (path === '/api/v1/sources') return Promise.resolve(json(SOURCES));
      if (path.includes('/a/search'))
        return Promise.resolve(
          json({
            items: [{ name: 'Good Novel (MTL)', path: '/novel/good', url: 'https://a.test/novel/good', cover: null }],
            page: 1,
            hasMore: false,
          }),
        );
      return Promise.resolve(json({ error: 'blocked', code: 'CHALLENGE' }, 503));
    });
    const result = await build().client.search(CONN, 'Good Novel', ['a', 'b']);
    expect(result.failedSources).toEqual(['Source B']);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ sourceName: 'Source A', mtl: true });
    expect(result.hits[0]!.remoteId).toContain('a:');
    expect(
      fetchEngineResponse.mock.calls
        .filter((call) => call[1] !== '/api/v1/health')
        .every((call) => new Headers(call[2].headers).get('Authorization') === 'Bearer token'),
    ).toBe(true);
  });

  it('browses one source page in bulk priority, with the chosen sort filters or the latest switch', async () => {
    fetchEngineResponse.mockImplementation(() =>
      Promise.resolve(json({ items: [{ name: 'A', path: 'novel/a', url: null, cover: null }], page: 3, hasMore: true })),
    );
    const { client } = build();

    const page = await client.browse(CONN, 'novel buddy', 3, { latest: false, filters: { orderBy: { value: 'alphabetical' } } });
    expect(page.items).toHaveLength(1);
    const url = new URL(`http://x${fetchEngineResponse.mock.calls[0]![1] as string}`);
    expect(url.pathname).toBe('/api/v1/sources/novel%20buddy/browse');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '3',
      latest: '0',
      priority: 'bulk',
      filters: JSON.stringify({ orderBy: { value: 'alphabetical' } }),
    });

    await client.browse(CONN, 'a', 1, { latest: true });
    const latest = new URL(`http://x${fetchEngineResponse.mock.calls[1]![1] as string}`);
    expect(latest.searchParams.get('latest')).toBe('1');
    expect(latest.searchParams.has('filters')).toBe(false);
  });

  it('matches pasted links by normalized host and falls back to lncrawl', async () => {
    fetchEngineResponse.mockImplementation(() => Promise.resolve(json(SOURCES)));
    const { client, lncrawl } = build();
    const resolved = await client.resolveUrl(CONN, 'https://a.test/novel/one?x=1');
    expect(decodeNovelRemoteId(resolved!.remoteId)).toEqual({ sourceId: 'a', path: 'novel/one' });

    lncrawl.resolveUrl.mockResolvedValue({ kind: 'novel', remoteId: 'legacy' });
    await expect(
      client.resolveUrl({ ...CONN, fallback: { url: 'http://lncrawl', username: null, password: null } }, 'https://other.test/x'),
    ).resolves.toMatchObject({ remoteId: 'legacy' });
    await expect(client.resolveUrl(CONN, 'https://other.test/x')).rejects.toThrow(BadRequestException);
  });

  it('groups chapters into source-order volumes of 100 and keeps TOC titles', async () => {
    const chapters = Array.from({ length: 205 }, (_, index) => ({
      name: `Chapter ${index + 1}`,
      path: `/c/${index + 1}`,
      url: `https://a.test/c/${index + 1}`,
    }));
    fetchEngineResponse.mockImplementation((_url, path: string) => {
      if (path === '/api/v1/sources') return Promise.resolve(json(SOURCES));
      return Promise.resolve(json({ name: 'Novel', path: '/n', author: 'Author', summaryHtml: '<p>Summary</p>', genres: ['Fantasy'], chapters }));
    });
    const remoteId = `a:${Buffer.from('/n').toString('base64url')}`;
    const series = await build().client.getSeries(CONN, remoteId);
    expect(series.units.map((unit) => [unit.unitKey, unit.label, unit.chapterCount])).toEqual([
      ['volume-1', 'Volume 1', 100],
      ['volume-2', 'Volume 2', 100],
      ['volume-3:201-205', 'Volume 3', 5],
    ]);
    expect((series.units[0]!.remote['chapterTitles'] as string[])[0]).toBe('Chapter 1');
  });

  it('resumes chapter files, retries failures and reports progress', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
    await mkdir(join(dir, 'chapters'));
    await writeFile(join(dir, 'chapters', '0001.html'), '<p>done</p>');
    let secondAttempts = 0;
    fetchEngineResponse.mockImplementation((_url, path: string) => {
      if (path.includes('path=%2Fc%2F2')) {
        secondAttempts += 1;
        return Promise.resolve(secondAttempts < 3 ? json({ error: 'timeout', code: 'TIMEOUT' }, 504) : json({ html: '<p>two</p>' }));
      }
      return Promise.resolve(json({ html: '<p>unexpected</p>' }));
    });
    const { client, epub } = build();
    const progress = vi.fn();
    const download = await client.download(
      CONN,
      {
        unitKey: 'v1',
        remote: {
          sourceId: 'a',
          seriesPath: '/n',
          seriesTitle: 'Novel',
          authors: ['Author'],
          cover: null,
          chapterPaths: ['/c/1', '/c/2'],
          chapterTitles: ['One', 'Two'],
          chapterUrls: [null, null],
          volumeIndex: '1',
          volumeLabel: 'Volume 1',
          workDir: dir,
        },
      },
      undefined,
      progress,
    );
    expect(secondAttempts).toBe(3);
    expect(fetchEngineResponse.mock.calls.some((call) => String(call[1]).includes('path=%2Fc%2F1'))).toBe(false);
    expect(progress).toHaveBeenCalledWith({ chaptersDone: 2, chaptersTotal: 2, stage: 'building' });
    expect(epub.build).toHaveBeenCalled();
    expect(download.stream).toBeInstanceOf(Readable);
  });

  it('honours an aborted runner signal before fetching a chapter', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      build().client.download(
        CONN,
        {
          unitKey: 'v1',
          remote: {
            sourceId: 'a',
            seriesPath: '/n',
            seriesTitle: 'Novel',
            authors: [],
            cover: null,
            chapterPaths: ['/c/1'],
            chapterTitles: ['One'],
            chapterUrls: [null],
            volumeIndex: '1',
            volumeLabel: 'Volume 1',
            workDir: join(tmpdir(), 'aborted-novel-download'),
          },
        },
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(fetchEngineResponse).not.toHaveBeenCalled();
  });

  describe('route timeouts', () => {
    it('gives each route its own deadline instead of the 15 s default', async () => {
      fetchEngineResponse.mockImplementation((_url, path: string) => {
        if (path === '/api/v1/health') return Promise.resolve(json({ ok: true, installed: 1 }));
        if (path === '/api/v1/sources') return Promise.resolve(json(SOURCES));
        if (path.includes('/novel?')) return Promise.resolve(json({ name: 'Novel', path: '/n', chapters: [] }));
        if (path.includes('/browse?')) return Promise.resolve(json({ items: [], page: 1, hasMore: false }));
        if (path.includes('/search?')) return Promise.resolve(json({ items: [], page: 1, hasMore: false }));
        return Promise.resolve(json({}));
      });
      const { client } = build();
      await client.health(CONN);
      await client.getSeries(CONN, `a:${Buffer.from('/n').toString('base64url')}`, { priority: 'bulk' });
      await client.browse(CONN, 'a', 1, { latest: false });
      await client.updateSource(CONN, 'a', 'install');
      await client.search({ ...CONN, solver: true }, 'Novel', ['a']);

      const timeoutFor = (match: (path: string) => boolean) =>
        (fetchEngineResponse.mock.calls.find((call) => match(String(call[1])))![3] as { timeoutMs?: number }).timeoutMs;
      expect(timeoutFor((path) => path === '/api/v1/health')).toBe(NOVEL_SOURCES_ROUTE_TIMEOUTS_MS.health);
      expect(timeoutFor((path) => path.includes('/novel?'))).toBeLessThan(5 * 60_000);
      expect(timeoutFor((path) => path.includes('/browse?'))).toBe(60_000);
      expect(timeoutFor((path) => path.endsWith('/install'))).toBe(120_000);
      expect(timeoutFor((path) => path.includes('/search?'))).toBeGreaterThan(30_000);
    });

    it('gives up on a novel someone is waiting for after about 90 s, and keeps each download request under 5 minutes', async () => {
      fetchEngineResponse.mockImplementation((_url, path: string) =>
        Promise.resolve(path === '/api/v1/sources' ? json(SOURCES) : json({ name: 'Novel', path: '/n', chapters: [] })),
      );
      const { client } = build();
      const remoteId = `a:${Buffer.from('/n').toString('base64url')}`;
      await client.getSeries(CONN, remoteId);
      await client.getSeries(CONN, remoteId, { priority: 'bulk' });
      const timeouts = fetchEngineResponse.mock.calls
        .filter((call) => String(call[1]).includes('/novel?'))
        .map((call) => (call[3] as { timeoutMs?: number }).timeoutMs);
      expect(timeouts).toEqual([90_000, NOVEL_SOURCES_ROUTE_TIMEOUTS_MS.novel]);
    });

    it('opens a novel in the interactive lane unless the caller asks for the bulk one', async () => {
      fetchEngineResponse.mockImplementation((_url, path: string) =>
        Promise.resolve(path === '/api/v1/sources' ? json(SOURCES) : json({ name: 'Novel', path: '/n', chapters: [] })),
      );
      const { client } = build();
      const remoteId = `a:${Buffer.from('/n').toString('base64url')}`;
      await client.getSeries(CONN, remoteId);
      await client.getSeries(CONN, remoteId, { priority: 'bulk' });
      const lanes = fetchEngineResponse.mock.calls
        .filter((call) => String(call[1]).includes('/novel?'))
        .map((call) => new URL(`http://x${call[1] as string}`).searchParams.get('priority'));
      expect(lanes).toEqual(['interactive', 'bulk']);
    });

    it('waits up to a minute for a chapter, in the bulk lane', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
      fetchEngineResponse.mockResolvedValue(json({ html: '<p>Chapter text</p>' }));
      await build().client.download(CONN, unitHandle(dir, ['One']));
      const [, path, , options] = fetchEngineResponse.mock.calls[0]!;
      expect(new URL(`http://x${path as string}`).searchParams.get('priority')).toBe('bulk');
      expect((options as { timeoutMs?: number }).timeoutMs).toBe(NOVEL_SOURCES_ROUTE_TIMEOUTS_MS.chapter);
    });
  });

  describe('volume ranges', () => {
    const remoteId = `a:${Buffer.from('/n').toString('base64url')}`;
    function listOf(chapters: Array<{ name: string; path: string; chapterNumber?: number }>) {
      fetchEngineResponse.mockImplementation((_url, path: string) =>
        Promise.resolve(path === '/api/v1/sources' ? json(SOURCES) : json({ name: 'Novel', path: '/n', chapters })),
      );
    }

    function numbered(length: number, status?: string) {
      // A prologue numbered 0 and a skipped chapter 50: the site's numbers are not 1..n.
      const chapters = Array.from({ length }, (_, index) => ({
        name: `Chapter ${index}`,
        path: `/c/${index}`,
        chapterNumber: index < 50 ? index : index + 1,
      }));
      fetchEngineResponse.mockImplementation((_url, path: string) =>
        Promise.resolve(path === '/api/v1/sources' ? json(SOURCES) : json({ name: 'Novel', path: '/n', status, chapters })),
      );
    }

    it('keys and ranges blocks by list position whatever the site numbers its chapters, ranging only the growing end', async () => {
      numbered(205, 'Ongoing');

      const series = await build().client.getSeries(CONN, remoteId);

      expect(series.units.map((unit) => [unit.unitKey, unit.chapterRange])).toEqual([
        ['volume-1', { from: 1, to: 100 }],
        ['volume-2', { from: 101, to: 200 }],
        ['volume-3:201-205', { from: 201, to: 205 }],
      ]);
    });

    it('ranges the short last block of a finished novel too, since an epilogue can still join it', async () => {
      numbered(150, 'Completed');

      const series = await build().client.getSeries(CONN, remoteId);

      expect(series.units.map((unit) => [unit.unitKey, unit.chapterRange])).toEqual([
        ['volume-1', { from: 1, to: 100 }],
        ['volume-2:101-150', { from: 101, to: 150 }],
      ]);
    });

    it('keeps the plain key for a block of the usual size', async () => {
      listOf(Array.from({ length: 100 }, (_, index) => ({ name: `Chapter ${index + 1}`, path: `/c/${index}` })));

      const series = await build().client.getSeries(CONN, remoteId);

      expect(series.units.map((unit) => unit.unitKey)).toEqual(['volume-1']);
    });
  });

  describe('chapter lists still loading', () => {
    const remoteId = `a:${Buffer.from('/n').toString('base64url')}`;

    function loadingThen(pendingCalls: number, retryAfterMs = 5000) {
      let novelCalls = 0;
      fetchEngineResponse.mockImplementation((_url, path: string) => {
        if (path === '/api/v1/sources') return Promise.resolve(json(SOURCES));
        novelCalls += 1;
        if (novelCalls <= pendingCalls) return Promise.resolve(json({ pending: true, retryAfterMs }, 202));
        return Promise.resolve(json({ name: 'Novel', path: '/n', chapters: [{ name: 'One', path: '/c/1' }] }));
      });
    }

    it('tells someone waiting on a preview that the list is still loading, and when to ask again', async () => {
      loadingThen(1, 7000);
      const { client } = build();
      await client.listInstalled(CONN);
      const failure = await client.getSeries(CONN, remoteId).catch((error: unknown) => error);

      expect((failure as BadRequestException).getStatus()).toBe(503);
      expect((failure as BadRequestException).getResponse()).toEqual({
        message: 'The chapter list is still loading',
        errorCode: 'WEB_SERIAL_SERIES_LOADING',
        errorMeta: { source: 'Source A', retryAfterMs: 7000 },
      });
    });

    it('never retries a path the service refuses as outside the source site', async () => {
      fetchEngineResponse.mockImplementation(() => Promise.resolve(json({ error: "path must point to the source's own site" }, 400)));
      const failure = await build()
        .client.getSeries(CONN, remoteId, { priority: 'bulk' })
        .catch((error: unknown) => error);
      expect(classifyFailure(failure)).toBe('unknown');
    });

    it('keeps asking for a download until the list is ready, waiting as long as the service says', async () => {
      loadingThen(3, 4000);
      const { client } = build();
      const wait = vi.spyOn(client as unknown as { wait: (ms: number) => Promise<void> }, 'wait').mockResolvedValue(undefined);

      const series = await client.getSeries(CONN, remoteId, { priority: 'bulk' });

      expect(series.chapterCount).toBe(1);
      expect(wait.mock.calls.map((call) => call[0])).toEqual([4000, 4000, 4000]);
      const novelCalls = fetchEngineResponse.mock.calls.filter((call) => String(call[1]).includes('/novel?'));
      expect(novelCalls).toHaveLength(4);
      for (const call of novelCalls) expect((call[3] as { timeoutMs: number }).timeoutMs).toBeLessThan(5 * 60_000);
    });

    it('stops waiting for a download the moment its job is paused, cancelled or shut down', async () => {
      loadingThen(Number.POSITIVE_INFINITY, 60_000);
      const stop = new AbortController();
      const loading = build().client.getSeries(CONN, remoteId, { priority: 'bulk', signal: stop.signal });
      await vi.waitFor(() => expect(fetchEngineResponse.mock.calls.some((call) => String(call[1]).includes('/novel?'))).toBe(true));
      const startedAt = Date.now();
      stop.abort();

      await expect(loading).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      const novelCall = fetchEngineResponse.mock.calls.find((call) => String(call[1]).includes('/novel?'))!;
      expect((novelCall[3] as { signal?: AbortSignal }).signal).toBe(stop.signal);
    });

    it('gives a download up once the service could no longer be loading it', async () => {
      loadingThen(Number.POSITIVE_INFINITY, 60_000);
      const { client } = build();
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      vi.spyOn(client as unknown as { wait: (ms: number) => Promise<void> }, 'wait').mockImplementation((ms: number) => {
        now += ms;
        return Promise.resolve();
      });
      try {
        const failure = await client.getSeries(CONN, remoteId, { priority: 'bulk' }).catch((error: unknown) => error);
        expect((failure as BadRequestException).getStatus()).toBe(504);
        expect(classifyFailure(failure)).toBe('source_unavailable');
        expect(fetchEngineResponse.mock.calls.filter((call) => String(call[1]).includes('/novel?')).length).toBeLessThanOrEqual(33);
      } finally {
        clock.mockRestore();
      }
    });
  });

  describe('failure classification', () => {
    it.each([
      ['SITE_FAILED', 502, 'source_unavailable'],
      ['TIMEOUT', 504, 'source_unavailable'],
      ['CHALLENGE', 502, 'source_blocked'],
      ['PLUGIN_ERROR', 502, 'unknown'],
      [null, 404, 'not_found'],
      [null, 503, 'source_unavailable'],
      [null, 400, 'unknown'],
    ])('classifies code %s with status %i as %s, whatever the message says', async (code, status, reason) => {
      fetchEngineResponse.mockImplementation(() => Promise.resolve(json({ error: 'Upstream request failed', ...(code ? { code } : {}) }, status)));
      const failure = await build()
        .client.getSeries(CONN, `a:${Buffer.from('n/x').toString('base64url')}`)
        .catch((error: unknown) => error);
      expect(classifyFailure(failure)).toBe(reason);
    });
  });

  describe('chapter downloads', () => {
    it('stops between chapters when the job is paused, keeping the chapters already fetched', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
      fetchEngineResponse.mockResolvedValue(json({ html: '<p>Chapter text</p>' }));
      let checks = 0;
      const shouldStop = vi.fn(() => {
        checks += 1;
        return Promise.resolve(checks > 1);
      });
      const { client, epub } = build();

      await expect(client.download(CONN, unitHandle(dir, ['One', 'Two', 'Three']), undefined, undefined, { shouldStop })).rejects.toBeInstanceOf(
        UnitDownloadStopped,
      );
      expect(fetchEngineResponse).toHaveBeenCalledTimes(1);
      expect(await readFile(join(dir, 'chapters', '0001.html'), 'utf8')).toBe('<p>Chapter text</p>');
      expect(epub.build).not.toHaveBeenCalled();
    });

    it('drops the chapter in flight when the job is paused, keeping the chapters already fetched for the resume', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
      const controller = new AbortController();
      fetchEngineResponse.mockImplementation((...call: unknown[]) => {
        if (chapterPathOf(call) !== '/c/2') return Promise.resolve(json({ html: '<p>Text</p>' }));
        const signal = (call[3] as { signal?: AbortSignal }).signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
          controller.abort();
        });
      });
      const { client, epub } = build();

      const failure = await client.download(CONN, unitHandle(dir, ['One', 'Two', 'Three']), controller.signal).catch((error: unknown) => error);
      expect(failure).not.toBeInstanceOf(MissingChaptersError);
      expect((failure as Error).name).toBe('AbortError');
      expect(fetchEngineResponse.mock.calls.map(chapterPathOf)).toEqual(['/c/1', '/c/2']);
      expect(await readFile(join(dir, 'chapters', '0001.html'), 'utf8')).toBe('<p>Text</p>');
      expect(epub.build).not.toHaveBeenCalled();

      fetchEngineResponse.mockReset();
      fetchEngineResponse.mockImplementation(() => Promise.resolve(json({ html: '<p>Text</p>' })));
      await client.download(CONN, unitHandle(dir, ['One', 'Two', 'Three']));
      expect(fetchEngineResponse.mock.calls.map(chapterPathOf)).toEqual(['/c/2', '/c/3']);
    });

    it('keeps the fetched chapters and fails the attempt when one chapter never loads', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
      fetchEngineResponse.mockImplementation((...call: unknown[]) =>
        Promise.resolve(chapterPathOf(call) === '/c/2' ? json({ error: 'gone', code: 'SITE_FAILED' }, 502) : json({ html: '<p>Text</p>' })),
      );
      const { client, epub } = build();

      const failure = await client.download(CONN, unitHandle(dir, ['One', 'Two', 'Three'])).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MissingChaptersError);
      expect((failure as MissingChaptersError).chapters).toEqual(['Two']);
      await expect(access(join(dir, 'chapters', '0001.html'))).resolves.toBeUndefined();
      await expect(access(join(dir, 'chapters', '0003.html'))).resolves.toBeUndefined();
      expect(epub.build).not.toHaveBeenCalled();

      fetchEngineResponse.mockClear();
      const download = await client.download(CONN, unitHandle(dir, ['One', 'Two', 'Three']), undefined, undefined, { allowMissingChapters: true });
      expect(fetchEngineResponse.mock.calls.map(chapterPathOf)).toEqual(['/c/2', '/c/2', '/c/2']);
      expect(download.missingChapters).toEqual(['Two']);
      const chapters = (epub.build.mock.calls[0]![0] as unknown as { chapters: Array<{ title: string; missing?: boolean }> }).chapters;
      expect(chapters.map((chapter) => [chapter.title, chapter.missing ?? false])).toEqual([
        ['One', false],
        ['Two', true],
        ['Three', false],
      ]);
    });

    it('names the source a failed request came from, so the reader can pick another', async () => {
      fetchEngineResponse.mockImplementation(() => Promise.resolve(json({ error: 'Cloudflare blocked the request', code: 'SITE_FAILED' }, 502)));
      const failure = await build()
        .client.getSeries(CONN, `a:${Buffer.from('n/x').toString('base64url')}`)
        .catch((error: unknown) => error);
      expect((failure as BadRequestException).getResponse()).toEqual({
        message: 'Cloudflare blocked the request',
        errorCode: 'WEB_SERIAL_SOURCE_FAILED',
        errorMeta: { source: 'a' },
      });

      fetchEngineResponse.mockImplementation(() => Promise.resolve(json({ error: 'Index unavailable' }, 502)));
      const service = await build()
        .client.listAvailable(CONN)
        .catch((error: unknown) => error);
      expect((service as BadRequestException).getResponse()).toMatchObject({ errorCode: 'WEB_SERIAL_ENGINE_ERROR' });
    });

    it('never files a volume most of whose chapters are missing, even on the last try', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
      fetchEngineResponse.mockImplementation(() => Promise.resolve(json({ error: 'gone', code: 'SITE_FAILED' }, 502)));
      const { client, epub } = build();

      const all = await client
        .download(CONN, unitHandle(dir, ['One', 'Two', 'Three']), undefined, undefined, { allowMissingChapters: true })
        .catch((error: unknown) => error);
      expect(all).toBeInstanceOf(TooManyMissingChaptersError);
      expect((all as Error).message).toBe('3 of 3 chapters could not be fetched, too many to file this volume');

      fetchEngineResponse.mockImplementation((...call: unknown[]) =>
        Promise.resolve(['/c/1', '/c/4'].includes(chapterPathOf(call)) ? json({ html: '<p>Text</p>' }) : json({ error: 'gone' }, 502)),
      );
      const mostly = await client
        .download(CONN, unitHandle(await mkdtemp(join(tmpdir(), 'novel-source-client-')), ['1', '2', '3', '4', '5']), undefined, undefined, {
          allowMissingChapters: true,
        })
        .catch((error: unknown) => error);
      expect(mostly).toBeInstanceOf(TooManyMissingChaptersError);
      expect(epub.build).not.toHaveBeenCalled();

      fetchEngineResponse.mockImplementation((...call: unknown[]) =>
        Promise.resolve(chapterPathOf(call) === '/c/2' ? json({ error: 'gone' }, 502) : json({ html: '<p>Text</p>' })),
      );
      const half = await client.download(
        CONN,
        unitHandle(await mkdtemp(join(tmpdir(), 'novel-source-client-')), ['1', '2', '3', '4']),
        undefined,
        undefined,
        { allowMissingChapters: true },
      );
      expect(half.missingChapters).toEqual(['2']);
    });

    it('counts a chapter already on disk as a success that ends a run of failures', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
      await mkdir(join(dir, 'chapters'));
      const titles = Array.from({ length: 12 }, (_value, index) => String(index + 1));
      for (const index of [3, 6, 7, 8, 9, 10, 11])
        await writeFile(join(dir, 'chapters', `${String(index + 1).padStart(4, '0')}.html`), '<p>Saved</p>');
      const failing = ['/c/1', '/c/2', '/c/3', '/c/5', '/c/6'];
      fetchEngineResponse.mockImplementation((...call: unknown[]) =>
        Promise.resolve(failing.includes(chapterPathOf(call)) ? json({ error: 'gone' }, 502) : json({ html: '<p>Text</p>' })),
      );

      const download = await build().client.download(CONN, unitHandle(dir, titles), undefined, undefined, { allowMissingChapters: true });
      expect(download.missingChapters).toEqual(['1', '2', '3', '5', '6']);
    });

    it('treats an empty page or a bot challenge as a failed fetch, not as the chapter', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
      fetchEngineResponse.mockImplementation((...call: unknown[]) => {
        const path = chapterPathOf(call);
        if (path === '/c/1') return Promise.resolve(json({ html: '<div>  </div>' }));
        if (path === '/c/2') return Promise.resolve(json({ html: '<title>Just a moment...</title><p>Checking your browser before accessing.</p>' }));
        return Promise.resolve(json({ html: '<p>Real text</p>' }));
      });

      const failure = await build()
        .client.download(CONN, unitHandle(dir, ['One', 'Two', 'Three']))
        .catch((error: unknown) => error);
      expect((failure as MissingChaptersError).chapters).toEqual(['One', 'Two']);
      await expect(access(join(dir, 'chapters', '0001.html'))).rejects.toThrow();
      await expect(access(join(dir, 'chapters', '0002.html'))).rejects.toThrow();
    });

    it('fails only a real challenge or login wall, and keeps a short chapter that mentions signing in', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
      const pages: Record<string, string> = {
        '/c/1': '<p>Sign in to read the bonus chapter on my Patreon!</p><p>Thanks for reading.</p>',
        '/c/2': '<html><head><title>DDoS-Guard</title></head><body><p>Checking your browser before accessing</p></body></html>',
        '/c/3': '<script>window._cf_chl_opt={cType:"managed"}</script><p>One moment please.</p>',
        '/c/4': '<h1>Members only</h1><form action="/login"><input name="user"><input type="password" name="pass"></form>',
        '/c/5': '<p>Log in to continue reading? No, the hero refused, and the door stayed shut.</p>',
      };
      fetchEngineResponse.mockImplementation((...call: unknown[]) => Promise.resolve(json({ html: pages[chapterPathOf(call)] })));

      const failure = await build()
        .client.download(CONN, unitHandle(dir, ['One', 'Two', 'Three', 'Four', 'Five']))
        .catch((error: unknown) => error);
      expect((failure as MissingChaptersError).chapters).toEqual(['Two', 'Three', 'Four']);
      expect(await readFile(join(dir, 'chapters', '0001.html'), 'utf8')).toBe(pages['/c/1']);
      expect(await readFile(join(dir, 'chapters', '0005.html'), 'utf8')).toBe(pages['/c/5']);
    });

    it('names a failing source by its display name once the installed list is known', async () => {
      const { client } = build();
      fetchEngineResponse.mockImplementation((_url, path: string) =>
        Promise.resolve(path === '/api/v1/sources' ? json(SOURCES) : json({ error: 'Not found on the site', code: 'SITE_FAILED' }, 404)),
      );
      await client.listInstalled(CONN);
      const failure = await client.browse(CONN, 'a', 1, { latest: false }).catch((error: unknown) => error);
      expect((failure as BadRequestException).getResponse()).toMatchObject({
        errorCode: 'WEB_SERIAL_SOURCE_FAILED',
        errorMeta: { source: 'Source A' },
      });
    });

    it('never reuses a chapter file cut off by a failed write', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'novel-source-client-'));
      fetchEngineResponse.mockImplementation(() => Promise.resolve(json({ html: '<p>The whole chapter</p>' })));
      const { client } = build();
      failWrite.match = /0001\.html/;
      await expect(client.download(CONN, unitHandle(dir, ['One']))).rejects.toThrow('no space left');

      failWrite.match = null;
      fetchEngineResponse.mockClear();
      await client.download(CONN, unitHandle(dir, ['One']));
      expect(fetchEngineResponse).toHaveBeenCalledTimes(1);
      expect(await readFile(join(dir, 'chapters', '0001.html'), 'utf8')).toBe('<p>The whole chapter</p>');
    });
  });
});
