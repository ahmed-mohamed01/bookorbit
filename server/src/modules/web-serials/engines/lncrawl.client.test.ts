import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BadGatewayException, BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { safeFetch } from '../../../common/utils/safe-fetch';
import { EngineCredentialsRejectedException } from './engine-http.utils';
import { LncrawlClient } from './lncrawl.client';
import type { EngineConnection, EngineUnitSpec } from './web-serial-engine';

vi.mock('../../../common/utils/safe-fetch', () => ({ safeFetch: vi.fn() }));
vi.mock('../../../common/utils/self-hosted-service-url.utils', () => ({
  ensureSafeSelfHostedUrl: vi.fn().mockResolvedValue(undefined),
  selfHostedSafeRemoteHostOptions: vi.fn().mockReturnValue({}),
}));

function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8')) as T;
}

const conn: EngineConnection = { url: 'http://lnc:8181', username: 'admin', password: 'admin' };
const NOVEL_ID = '39a44bd3-ad95-4c24-a122-affaaa663c72';
const VOLUME_2 = '83daeca7-0c88-4291-bbd7-80d2119b158e';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: Call) => Response | Promise<Response> | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetch(handlers: Handler[]): Call[] {
  const calls: Call[] = [];
  vi.mocked(safeFetch).mockImplementation(async (rawUrl, init) => {
    const url = new URL(String(rawUrl));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    for (const handler of handlers) {
      const response = handler(call);
      if (response) return response;
    }
    return new Response('not found', { status: 404 });
  });
  return calls;
}

const login: Handler = (call) => (call.path === '/api/auth/login' ? json({ token: 'jwt-1', user: {} }) : undefined);

function route(method: string, path: string | RegExp, respond: (call: Call) => Response | Promise<Response>): Handler {
  return (call) => {
    if (call.method !== method) return undefined;
    const matches = typeof path === 'string' ? call.path === path : path.test(call.path);
    return matches ? respond(call) : undefined;
  };
}

class TestClient extends LncrawlClient {
  protected override sleep(): Promise<void> {
    return Promise.resolve();
  }
}

beforeEach(() => {
  vi.mocked(safeFetch).mockReset();
});

describe('LncrawlClient auth', () => {
  it('logs in once, caches the token and sends it as a bearer header', async () => {
    const calls = installFetch([login, route('GET', '/api/sources', () => json([]))]);
    const client = new TestClient();

    await client.listSources(conn);
    await client.listSources(conn);

    expect(calls.filter((call) => call.path === '/api/auth/login')).toHaveLength(1);
    expect(calls.find((call) => call.path === '/api/auth/login')?.body).toEqual({ email: 'admin', password: 'admin' });
    expect(calls.filter((call) => call.path === '/api/sources').every((call) => call.headers.Authorization === 'Bearer jwt-1')).toBe(true);
  });

  it('logs in again once after a 401 and retries the request', async () => {
    let logins = 0;
    let sources = 0;
    const calls = installFetch([
      route('POST', '/api/auth/login', () => json({ token: `jwt-${++logins}` })),
      route('GET', '/api/sources', (call) => {
        sources += 1;
        return call.headers.Authorization === 'Bearer jwt-2' ? json([]) : json({ detail: 'expired' }, 401);
      }),
    ]);

    await expect(new TestClient().listSources(conn)).resolves.toEqual([]);

    expect(logins).toBe(2);
    expect(sources).toBe(2);
    expect(calls).toHaveLength(4);
  });

  it('logs in once when several first calls run in parallel', async () => {
    let logins = 0;
    const calls = installFetch([
      route('POST', '/api/auth/login', async () => {
        logins += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json({ token: 'jwt-1' });
      }),
      route('GET', '/api/sources', () => json([])),
    ]);
    const client = new TestClient();

    await Promise.all([client.listSources(conn), client.listSources(conn), client.listSources(conn)]);

    expect(logins).toBe(1);
    expect(calls.filter((call) => call.path === '/api/sources')).toHaveLength(3);
  });

  it('answers 502, never 401, when the credentials are rejected', async () => {
    installFetch([route('POST', '/api/auth/login', () => json({ detail: 'no' }, 401))]);
    const error = await new TestClient().listSources(conn).catch((caught: unknown) => caught);
    expect((error as BadGatewayException).getStatus()).toBe(502);
  });

  it('gives up when the credentials are rejected', async () => {
    installFetch([route('POST', '/api/auth/login', () => json({ detail: 'no' }, 401))]);
    await expect(new TestClient().listSources(conn)).rejects.toBeInstanceOf(EngineCredentialsRejectedException);
  });

  it('does not loop when the retry is rejected too', async () => {
    const calls = installFetch([login, route('GET', '/api/sources', () => json({}, 401))]);
    await expect(new TestClient().listSources(conn)).rejects.toBeInstanceOf(EngineCredentialsRejectedException);
    expect(calls.filter((call) => call.path === '/api/sources')).toHaveLength(2);
  });
});

describe('LncrawlClient health and sources', () => {
  const sources = [
    { domain: 'novelbuddy.com', language: 'en', can_search: true, is_disabled: false },
    { domain: 'royalroad.com', language: 'en', can_search: false, is_disabled: false },
    { domain: 'dead.example', language: 'en', can_search: true, is_disabled: true },
  ];

  it('maps the source list', async () => {
    installFetch([login, route('GET', '/api/sources', () => json(sources))]);
    await expect(new TestClient().listSources(conn)).resolves.toEqual([
      { domain: 'novelbuddy.com', language: 'en', canSearch: true, disabled: false },
      { domain: 'royalroad.com', language: 'en', canSearch: false, disabled: false },
      { domain: 'dead.example', language: 'en', canSearch: true, disabled: true },
    ]);
  });

  it('reports version and the number of searchable allowed sources', async () => {
    installFetch([
      route('GET', '/health', () => json({ status: 'ok', version: '4.14.0' })),
      login,
      route('GET', '/api/sources', () => json(sources)),
    ]);
    const health = await new TestClient().health(conn, ['NovelBuddy.com', 'royalroad.com', 'dead.example']);
    expect(health).toMatchObject({ ok: true, version: '4.14.0', searchableSources: 1, error: null });
  });

  it('reports a failed health check without throwing', async () => {
    installFetch([route('GET', '/health', () => json({ version: '4.14.0' })), route('POST', '/api/auth/login', () => json({}, 401))]);
    const health = await new TestClient().health(conn, []);
    expect(health.ok).toBe(false);
    expect(health.error).toEqual(expect.any(String));
  });
});

describe('LncrawlClient resolveUrl', () => {
  it('returns the novel id once the fetch job is done', async () => {
    const created = { ...fixture('lnc-job-done.json'), is_done: false, status: 0, extra: {} };
    const done = fixture('lnc-job-done.json');
    let polls = 0;
    const calls = installFetch([
      login,
      route('POST', '/api/job/create/fetch-novels', () => json(created)),
      route('GET', `/api/job/${done.id}`, () => json(++polls < 2 ? { ...created, is_running: 1, status: 1 } : done)),
    ]);

    const ref = await new TestClient().resolveUrl(conn, done.extra.url);

    expect(ref).toEqual({ kind: 'novel', remoteId: NOVEL_ID });
    expect(calls.find((call) => call.path === '/api/job/create/fetch-novels')?.body).toEqual({ urls: [done.extra.url], full: false });
  });

  it('returns null for a link the engine cannot handle', async () => {
    installFetch([login, route('POST', '/api/job/create/fetch-novels', () => json({ detail: 'unsupported' }, 422))]);
    await expect(new TestClient().resolveUrl(conn, 'https://example.org/x')).resolves.toBeNull();
  });

  it('surfaces rejected credentials instead of calling the link unsupported', async () => {
    installFetch([route('POST', '/api/auth/login', () => json({ detail: 'no' }, 401))]);
    await expect(new TestClient().resolveUrl(conn, 'https://example.org/x')).rejects.toBeInstanceOf(EngineCredentialsRejectedException);
  });

  it('returns null when the job fails', async () => {
    const failed = { ...fixture('lnc-job-done.json'), status: 3, error: 'boom', extra: {} };
    installFetch([login, route('POST', '/api/job/create/fetch-novels', () => json(failed)), route('GET', /^\/api\/job\//, () => json(failed))]);
    await expect(new TestClient().resolveUrl(conn, 'https://example.org/x')).resolves.toBeNull();
  });

  it('times out and cancels a job that never finishes', async () => {
    const pending = { ...fixture('lnc-job-done.json'), is_done: false, status: 1, extra: {} };
    const calls = installFetch([
      login,
      route('POST', '/api/job/create/fetch-novels', () => json(pending)),
      route('GET', /^\/api\/job\//, () => json(pending)),
      route('POST', /\/cancel$/, () => json(true)),
    ]);
    class Clock extends LncrawlClient {
      protected override sleep(): Promise<void> {
        vi.setSystemTime(Date.now() + 30_000);
        return Promise.resolve();
      }
    }
    vi.useFakeTimers();
    try {
      await expect(new Clock().resolveUrl(conn, 'https://example.org/x')).rejects.toBeInstanceOf(GatewayTimeoutException);
    } finally {
      vi.useRealTimers();
    }
    expect(calls.some((call) => call.path.endsWith('/cancel'))).toBe(true);
  });
});

describe('LncrawlClient getSeries', () => {
  it('maps the novel and its volumes, with the chapter positions each volume holds and the range in the last key', async () => {
    installFetch([
      login,
      route('GET', `/api/novel/${NOVEL_ID}`, () =>
        json({ ...fixture<Record<string, unknown>>('lnc-novel.json'), authors: 'Nobody103, Someone Else, ' }),
      ),
      route('GET', `/api/novel/${NOVEL_ID}/volumes`, () => json([...fixture<any[]>('lnc-novel-volumes.json')].reverse())),
    ]);

    const series = await new TestClient().getSeries(conn, NOVEL_ID);

    expect(series).toMatchObject({
      kind: 'novel',
      title: 'Mother Of Learning',
      author: 'Nobody103, Someone Else',
      authors: ['Nobody103', 'Someone Else'],
      language: 'en',
      status: 'unknown',
      sourceName: 'royalroad.com',
      sourceUrl: 'https://www.royalroad.com/fiction/21220/mother-of-learning',
      chapterCount: 109,
      remoteCoverPath: `novels/${NOVEL_ID}/cover.jpg`,
      packagingOptions: ['volume', 'series'],
      defaultPackaging: 'volume',
    });
    expect(series.tags).toContain('time loop');
    expect(series.synopsis).toContain('Zorian');
    expect(series.units).toEqual([
      {
        unitKey: 'b974dc81-e718-4c95-912f-3c0749c52c2e',
        label: 'Volume 1',
        sequence: '1',
        chapterCount: 100,
        publishedAt: null,
        packaging: 'volume',
        chapterRange: { from: 1, to: 100 },
        remote: { volumeId: 'b974dc81-e718-4c95-912f-3c0749c52c2e', serial: 1 },
      },
      {
        unitKey: `${VOLUME_2}:101-109`,
        label: 'Volume 2',
        sequence: '2',
        chapterCount: 9,
        publishedAt: null,
        packaging: 'volume',
        chapterRange: { from: 101, to: 109 },
        remote: { volumeId: VOLUME_2, serial: 2 },
      },
    ]);
  });

  it('has no cover path and no author when the engine has neither', async () => {
    installFetch([
      login,
      route('GET', `/api/novel/${NOVEL_ID}`, () =>
        json({ ...fixture<Record<string, unknown>>('lnc-novel.json'), authors: null, cover_available: false }),
      ),
      route('GET', `/api/novel/${NOVEL_ID}/volumes`, () => json([])),
    ]);
    const series = await new TestClient().getSeries(conn, NOVEL_ID);
    expect(series).toMatchObject({ author: null, authors: [], remoteCoverPath: null, units: [] });
  });
});

describe('LncrawlClient search', () => {
  function searchJob(domain: string, overrides: Record<string, unknown> = {}) {
    return {
      ...fixture('lnc-job-done.json'),
      id: `job-${domain}`,
      domain,
      extra: {
        domain,
        search_results: [
          { title: 'Shadow Slave', url: `https://${domain}/shadow-slave`, info: 'ongoing' },
          { title: 'MTL-the shadow', url: `https://${domain}/mtl-the-shadow`, info: 'completed' },
          { title: 'Broken', url: 'javascript:alert(1)', info: 'ongoing' },
        ],
      },
      ...overrides,
    };
  }

  it('runs one job per domain and maps extra.search_results', async () => {
    const calls = installFetch([
      login,
      route('POST', '/api/job/create/search-sources', (call) => json(searchJob(call.body.domain, { is_done: false, status: 0 }))),
      route('GET', /^\/api\/job\/job-/, (call) => json(searchJob(call.path.replace('/api/job/job-', '')))),
    ]);

    const result = await new TestClient().search(conn, '  shadow slave ', ['novelbuddy.com', 'other.com']);

    expect(result.failedSources).toEqual([]);
    expect(result.hits).toHaveLength(4);
    expect(result.hits[0]).toEqual({
      remoteId: null,
      url: 'https://novelbuddy.com/shadow-slave',
      title: 'Shadow Slave',
      author: null,
      remoteCoverPath: null,
      sourceName: 'novelbuddy.com',
      chapterCount: null,
      status: 'ongoing',
    });
    expect(result.hits[1].status).toBe('completed');
    expect(calls.filter((call) => call.path === '/api/job/create/search-sources').map((call) => call.body)).toEqual([
      { query: 'shadow slave', domain: 'novelbuddy.com' },
      { query: 'shadow slave', domain: 'other.com' },
    ]);
  });

  it('reports failing and erroring domains without losing the others', async () => {
    installFetch([
      login,
      route('POST', '/api/job/create/search-sources', (call) => {
        if (call.body.domain === 'down.com') return json({}, 500);
        if (call.body.domain === 'bad.com') return json(searchJob('bad.com', { status: 3, error: 'blocked', extra: {} }));
        return json(searchJob(call.body.domain));
      }),
    ]);
    const result = await new TestClient().search(conn, 'shadow', ['good.com', 'down.com', 'bad.com']);
    expect(result.failedSources.sort()).toEqual(['bad.com', 'down.com']);
    expect(result.hits.every((hit) => hit.sourceName === 'good.com')).toBe(true);
  });

  it('keeps partial results from a job that is still running at the budget and cancels it', async () => {
    const running = searchJob('slow.com', { is_done: false, status: 1 });
    const calls = installFetch([
      login,
      route('POST', '/api/job/create/search-sources', () => json(running)),
      route('GET', '/api/job/job-slow.com', () => json(running)),
      route('POST', '/api/job/job-slow.com/cancel', () => json(true)),
    ]);
    class Clock extends LncrawlClient {
      protected override sleep(): Promise<void> {
        vi.setSystemTime(Date.now() + 10_000);
        return Promise.resolve();
      }
    }
    vi.useFakeTimers();
    try {
      const result = await new Clock().search(conn, 'shadow', ['slow.com']);
      expect(result.failedSources).toEqual([]);
      expect(result.hits).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    expect(calls.some((call) => call.path === '/api/job/job-slow.com/cancel')).toBe(true);
  });

  it('reports a domain that never answered within the budget as failed, not as an empty result, and cancels the job', async () => {
    const running = searchJob('slow.com', { is_done: false, status: 1, extra: {} });
    const calls = installFetch([
      login,
      route('POST', '/api/job/create/search-sources', () => json(running)),
      route('GET', '/api/job/job-slow.com', () => json(running)),
      route('POST', '/api/job/job-slow.com/cancel', () => json(true)),
    ]);
    class Clock extends LncrawlClient {
      protected override sleep(): Promise<void> {
        vi.setSystemTime(Date.now() + 5_000);
        return Promise.resolve();
      }
    }
    vi.useFakeTimers();
    try {
      const result = await new Clock().search(conn, 'shadow', ['slow.com']);
      expect(result).toEqual({ hits: [], failedSources: ['slow.com'] });
    } finally {
      vi.useRealTimers();
    }
    expect(calls.some((call) => call.path === '/api/job/job-slow.com/cancel')).toBe(true);
  });

  it('keeps the partial hits of a domain cut off at the budget and still marks it failed', async () => {
    const partial = searchJob('slow.com', {
      is_done: false,
      status: 1,
      extra: { search_results: [{ title: 'Only one', url: 'https://slow.com/1', info: null }] },
    });
    installFetch([
      login,
      route('POST', '/api/job/create/search-sources', () => json({ ...partial, extra: {} })),
      route('GET', '/api/job/job-slow.com', () => json(partial)),
      route('POST', '/api/job/job-slow.com/cancel', () => json(true)),
    ]);
    class Clock extends LncrawlClient {
      protected override sleep(): Promise<void> {
        vi.setSystemTime(Date.now() + 8_000);
        return Promise.resolve();
      }
    }
    vi.useFakeTimers();
    try {
      const result = await new Clock().search(conn, 'shadow', ['slow.com']);
      expect(result.hits).toHaveLength(1);
      expect(result.failedSources).toEqual(['slow.com']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the results once they stop growing for two polls and cancels the running job', async () => {
    const grow = (count: number) =>
      searchJob('slow.com', {
        is_done: false,
        status: 1,
        extra: { search_results: Array.from({ length: count }, (_, i) => ({ title: `T${i}`, url: `https://slow.com/${i}`, info: null })) },
      });
    const states = [grow(0), grow(1), grow(3), grow(3), grow(3), grow(5)];
    let polls = 0;
    const calls = installFetch([
      login,
      route('POST', '/api/job/create/search-sources', () => json(states[0])),
      route('GET', '/api/job/job-slow.com', () => json(states[Math.min(++polls, states.length - 1)])),
      route('POST', '/api/job/job-slow.com/cancel', () => json(true)),
    ]);
    const sleeps: number[] = [];
    class Clock extends LncrawlClient {
      protected override sleep(ms: number): Promise<void> {
        sleeps.push(ms);
        vi.setSystemTime(Date.now() + ms);
        return Promise.resolve();
      }
    }
    vi.useFakeTimers();
    try {
      const result = await new Clock().search(conn, 'shadow', ['slow.com']);
      expect(result.hits).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
    expect(sleeps.every((ms) => ms === 400)).toBe(true);
    expect(polls).toBe(4);
    expect(calls.filter((call) => call.path === '/api/job/job-slow.com/cancel')).toHaveLength(1);
  });

  it('never runs more than three domain searches at once', async () => {
    let active = 0;
    let peak = 0;
    vi.mocked(safeFetch).mockImplementation(async (rawUrl, init) => {
      const url = new URL(String(rawUrl));
      if (url.pathname === '/api/auth/login') return json({ token: 't' });
      if (url.pathname === '/api/job/create/search-sources') {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return json(searchJob(JSON.parse(init?.body as string).domain));
      }
      return new Response('', { status: 404 });
    });
    const domains = Array.from({ length: 8 }, (_, index) => `d${index}.com`);
    const result = await new LncrawlClient().search(conn, 'shadow', domains);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(result.failedSources).toEqual([]);
  });

  it('skips the engine for a too-short query', async () => {
    const calls = installFetch([login]);
    await expect(new TestClient().search(conn, 'a', ['x.com'])).resolves.toEqual({ hits: [], failedSources: [] });
    expect(calls).toHaveLength(0);
  });
});

describe('LncrawlClient units', () => {
  const volumeUnit: EngineUnitSpec = {
    unitKey: VOLUME_2,
    label: 'Volume 2',
    sequence: '2',
    chapterCount: 9,
    publishedAt: null,
    packaging: 'volume',
    remote: { volumeId: VOLUME_2, serial: 2 },
  };
  const seriesUnit: EngineUnitSpec = {
    unitKey: 'series',
    label: 'Mother Of Learning',
    sequence: '1',
    chapterCount: 109,
    publishedAt: null,
    packaging: 'series',
    remote: {
      volumes: [
        { volumeId: 'b974dc81-e718-4c95-912f-3c0749c52c2e', serial: 1 },
        { volumeId: VOLUME_2, serial: 2 },
      ],
    },
  };

  const fetchJob = fixture('lnc-fetch-volumes-job.json');
  const makeJob = fixture('lnc-make-artifacts-job.json');

  it('starts a volume by fetching it first', async () => {
    const calls = installFetch([login, route('POST', '/api/job/create/fetch-volumes', () => json({ ...fetchJob, is_done: false, status: 0 }))]);

    const handle = await new TestClient().startUnit(conn, NOVEL_ID, volumeUnit);

    expect(calls.find((call) => call.path === '/api/job/create/fetch-volumes')?.body).toEqual({ volumes: [VOLUME_2] });
    expect(handle).toEqual({
      unitKey: VOLUME_2,
      remote: {
        stage: 'fetching',
        novelId: NOVEL_ID,
        jobId: fetchJob.id,
        volumes: [{ volumeId: VOLUME_2, serial: 2 }],
        serial: 2,
      },
    });
  });

  it('fetches every volume for a series unit and later builds without a volume', async () => {
    const calls = installFetch([
      login,
      route('POST', '/api/job/create/fetch-volumes', () => json({ ...fetchJob, is_done: false, status: 0 })),
      route('GET', `/api/job/${fetchJob.id}`, () => json(fetchJob)),
      route('POST', '/api/job/create/make-artifacts', () => json({ ...makeJob, is_done: false, status: 0 })),
    ]);
    const client = new TestClient();

    const handle = await client.startUnit(conn, NOVEL_ID, seriesUnit);
    expect(calls.find((call) => call.path === '/api/job/create/fetch-volumes')?.body.volumes).toHaveLength(2);
    expect(handle.remote.serial).toBeNull();

    await client.pollUnit(conn, handle);
    expect(calls.find((call) => call.path === '/api/job/create/make-artifacts')?.body).toEqual({
      novel_id: NOVEL_ID,
      formats: ['epub'],
    });
  });

  it('rejects a unit with no volumes', async () => {
    installFetch([login]);
    await expect(new TestClient().startUnit(conn, NOVEL_ID, { ...seriesUnit, remote: { volumes: [] } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('advances from fetching to building to done', async () => {
    const calls = installFetch([
      login,
      route('GET', `/api/job/${fetchJob.id}`, () => json(fetchJob)),
      route('POST', '/api/job/create/make-artifacts', () => json({ ...makeJob, is_done: false, status: 0 })),
      route('GET', `/api/job/${makeJob.id}`, () => json(makeJob)),
    ]);
    const client = new TestClient();
    const handle = {
      unitKey: VOLUME_2,
      remote: { stage: 'fetching', novelId: NOVEL_ID, jobId: fetchJob.id, volumes: [], serial: 2 } as Record<string, unknown>,
    };

    const first = await client.pollUnit(conn, handle);
    expect(first).toMatchObject({ state: 'running', stage: 'building' });
    expect(calls.find((call) => call.path === '/api/job/create/make-artifacts')?.body).toEqual({
      novel_id: NOVEL_ID,
      formats: ['epub'],
      volume: 2,
    });
    expect(handle.remote).toMatchObject({ stage: 'building', jobId: makeJob.id });

    await expect(client.pollUnit(conn, handle)).resolves.toEqual({ state: 'done' });
  });

  it('reports chapter counts while fetching and the building stage afterwards', async () => {
    installFetch([
      login,
      route('GET', `/api/job/${fetchJob.id}`, () =>
        json({ ...fetchJob, is_done: false, status: 1, is_running: 1, progress: 79, done: 1651, total: 2082 }),
      ),
      route('GET', `/api/job/${makeJob.id}`, () => json({ ...makeJob, is_done: false, status: 1, is_running: 1, progress: 50, done: 1, total: 1 })),
    ]);
    const client = new TestClient();
    const fetching = await client.pollUnit(conn, {
      unitKey: 'x',
      remote: { stage: 'fetching', novelId: NOVEL_ID, jobId: fetchJob.id, serial: 2 },
    });
    expect(fetching).toMatchObject({ state: 'running', stage: 'fetching', chaptersDone: 1651, chaptersTotal: 2082 });

    const building = await client.pollUnit(conn, {
      unitKey: 'x',
      remote: { stage: 'building', novelId: NOVEL_ID, jobId: makeJob.id, serial: 2 },
    });
    expect(building).toMatchObject({ state: 'running', stage: 'building' });
    expect(building).not.toHaveProperty('chaptersDone');
  });

  it('resumes a stored fetching handle after a restart', async () => {
    const calls = installFetch([
      login,
      route('GET', `/api/job/${fetchJob.id}`, () => json({ ...fetchJob, is_done: false, status: 1, is_running: 1, progress: 50 })),
    ]);
    const progress = await new TestClient().pollUnit(conn, {
      unitKey: VOLUME_2,
      remote: { stage: 'fetching', novelId: NOVEL_ID, jobId: fetchJob.id, volumes: [], serial: 2 },
    });
    expect(progress).toMatchObject({ state: 'running', progress: 0.45, stage: 'fetching' });
    expect(calls.some((call) => call.path.includes('create'))).toBe(false);
  });

  it('reports pending for a queued job', async () => {
    installFetch([login, route('GET', `/api/job/${fetchJob.id}`, () => json({ ...fetchJob, is_done: false, status: 0, progress: 0 }))]);
    await expect(
      new TestClient().pollUnit(conn, { unitKey: 'x', remote: { stage: 'fetching', novelId: NOVEL_ID, jobId: fetchJob.id, serial: 2 } }),
    ).resolves.toMatchObject({ state: 'pending', progress: 0 });
  });

  it('fails when chapters could not be fetched', async () => {
    installFetch([login, route('GET', `/api/job/${fetchJob.id}`, () => json({ ...fetchJob, failed: 3 }))]);
    await expect(
      new TestClient().pollUnit(conn, { unitKey: 'x', remote: { stage: 'fetching', novelId: NOVEL_ID, jobId: fetchJob.id, serial: 2 } }),
    ).resolves.toEqual({ state: 'failed', reason: '3 chapters could not be fetched' });
  });

  it('fails when the build job fails', async () => {
    installFetch([login, route('GET', `/api/job/${makeJob.id}`, () => json({ ...makeJob, status: 3, error: 'x' }))]);
    const progress = await new TestClient().pollUnit(conn, {
      unitKey: 'x',
      remote: { stage: 'building', novelId: NOVEL_ID, jobId: makeJob.id, serial: 2 },
    });
    expect(progress).toEqual({ state: 'failed', reason: 'The book file could not be built: x' });
  });

  it('rejects a corrupt handle', async () => {
    installFetch([login]);
    await expect(new TestClient().pollUnit(conn, { unitKey: 'x', remote: {} })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cancels the current job and swallows errors', async () => {
    const calls = installFetch([login, route('POST', `/api/job/${makeJob.id}/cancel`, () => json({}, 500))]);
    await expect(new TestClient().cancelUnit(conn, { unitKey: 'x', remote: { stage: 'building', jobId: makeJob.id } })).resolves.toBeUndefined();
    expect(calls.some((call) => call.path === `/api/job/${makeJob.id}/cancel`)).toBe(true);
    await expect(new TestClient().cancelUnit(conn, { unitKey: 'x', remote: {} })).resolves.toBeUndefined();
  });
});

describe('LncrawlClient download', () => {
  const handle = { unitKey: VOLUME_2, remote: { stage: 'building', novelId: NOVEL_ID, jobId: 'j', serial: 2 } };

  it('streams the newest matching epub with the token as a query parameter', async () => {
    const calls = installFetch([
      login,
      route('GET', /^\/api\/artifacts\?/, () => json(fixture('lnc-artifacts.json'))),
      route(
        'GET',
        /^\/static\//,
        () => new Response('PK-epub', { status: 200, headers: { 'content-type': 'application/epub+zip', 'content-length': '7' } }),
      ),
    ]);

    const download = await new TestClient().download(conn, handle);

    expect(download).toMatchObject({ fileName: 'Mother Of Learning.Vol_002.epub', format: 'epub', size: 7 });
    expect(await new Response(download.stream as ReadableStream).text()).toBe('PK-epub');
    const list = calls.find((call) => call.path.startsWith('/api/artifacts'));
    expect(list?.path).toContain(`novel_id=${NOVEL_ID}`);
    expect(list?.path).toContain('format=epub');
    const file = calls.find((call) => call.path.startsWith('/static/'));
    expect(file?.path).toBe(`/static/novels/${NOVEL_ID}/artifacts/Mother%20Of%20Learning.Vol_002.epub?token=jwt-1`);
    expect(file?.headers.Authorization).toBeUndefined();
  });

  it('picks the whole-series artifact when there is no volume', async () => {
    const items = [
      { ...fixture<any>('lnc-artifacts.json').items[0], volume: null, file_name: 'all.epub', created_at: 5 },
      { ...fixture<any>('lnc-artifacts.json').items[0], volume: 2, file_name: 'v2.epub', created_at: 9 },
    ];
    const calls = installFetch([
      login,
      route('GET', /^\/api\/artifacts\?/, () => json({ total: 2, offset: 0, limit: 100, items })),
      route('GET', /^\/static\//, () => new Response('x', { headers: { 'content-type': 'application/epub+zip' } })),
    ]);
    const download = await new TestClient().download(conn, { unitKey: 'series', remote: { ...handle.remote, serial: null } });
    expect(download.fileName).toBe('all.epub');
    expect(calls.find((call) => call.path.startsWith('/static/'))?.path).toContain('/all.epub?token=');
  });

  it('pages through artifacts until it finds one', async () => {
    const item = fixture<any>('lnc-artifacts.json').items[0];
    const other = { ...item, volume: 1, file_name: 'v1.epub' };
    const calls = installFetch([
      login,
      route('GET', /^\/api\/artifacts\?offset=0/, () => json({ total: 101, offset: 0, limit: 100, items: Array(100).fill(other) })),
      route('GET', /^\/api\/artifacts\?offset=100/, () => json({ total: 101, offset: 100, limit: 100, items: [item] })),
      route('GET', /^\/static\//, () => new Response('x', { headers: { 'content-type': 'application/epub+zip' } })),
    ]);
    const download = await new TestClient().download(conn, handle);
    expect(download.fileName).toBe(item.file_name);
    expect(calls.filter((call) => call.path.startsWith('/api/artifacts'))).toHaveLength(2);
  });

  it('fails when no artifact exists', async () => {
    installFetch([login, route('GET', /^\/api\/artifacts\?/, () => json({ total: 0, offset: 0, limit: 100, items: [] }))]);
    await expect(new TestClient().download(conn, handle)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects an HTML response that came back with status 200', async () => {
    installFetch([
      login,
      route('GET', /^\/api\/artifacts\?/, () => json(fixture('lnc-artifacts.json'))),
      route('GET', /^\/static\//, () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })),
    ]);
    await expect(new TestClient().download(conn, handle)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('logs in again when the static route rejects the token', async () => {
    let logins = 0;
    const calls = installFetch([
      route('POST', '/api/auth/login', () => json({ token: `jwt-${++logins}` })),
      route('GET', /^\/api\/artifacts\?/, () => json(fixture('lnc-artifacts.json'))),
      route('GET', /^\/static\//, (call) =>
        call.path.endsWith('token=jwt-2')
          ? new Response('x', { headers: { 'content-type': 'application/epub+zip' } })
          : new Response('no', { status: 403 }),
      ),
    ]);
    await expect(new TestClient().download(conn, handle)).resolves.toMatchObject({ format: 'epub' });
    expect(logins).toBe(2);
    expect(calls.filter((call) => call.path.startsWith('/static/'))).toHaveLength(2);
  });
});

describe('LncrawlClient fetchCover', () => {
  it('fetches the cover under /static with the token', async () => {
    const calls = installFetch([
      login,
      route('GET', /^\/static\//, () => new Response(Buffer.from('img'), { headers: { 'content-type': 'image/jpeg' } })),
    ]);
    const cover = await new TestClient().fetchCover(conn, `novels/${NOVEL_ID}/cover.jpg`);
    expect(cover.contentType).toBe('image/jpeg');
    expect(cover.body.toString()).toBe('img');
    expect(calls.find((call) => call.path.startsWith('/static/'))?.path).toBe(`/static/novels/${NOVEL_ID}/cover.jpg?token=jwt-1`);
  });

  it.each(['', '/etc/passwd', '../x.jpg', 'novels/../../x', 'novels//x.jpg', 'a\\b'])('rejects the path %j', async (path) => {
    installFetch([login]);
    await expect(new TestClient().fetchCover(conn, path)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-image response', async () => {
    installFetch([login, route('GET', /^\/static\//, () => new Response('<html>', { headers: { 'content-type': 'text/html' } }))]);
    await expect(new TestClient().fetchCover(conn, 'novels/x/cover.jpg')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
