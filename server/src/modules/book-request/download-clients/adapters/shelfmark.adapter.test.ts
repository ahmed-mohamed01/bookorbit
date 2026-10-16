import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}));

vi.mock('dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('dns/promises')>()),
  lookup: vi.fn(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }])),
}));

import { forgetDispatchers } from '../../../../common/utils/safe-fetch';
import { shelfmarkClientKey } from '../../shelfmark/shelfmark-release';
import type { ResolvedClientConfig } from '../download-client-adapter';
import { ShelfmarkDownloadClientAdapter } from './shelfmark.adapter';

const RELEASE = { source: 'direct_download', source_id: 'md5abc', title: 'The Primal Hunter 14', format: 'epub' };
const KEY = shelfmarkClientKey('md5abc');

function config(overrides: Partial<ResolvedClientConfig> = {}): ResolvedClientConfig {
  return {
    id: 3,
    name: 'Shelfmark',
    adapterType: 'shelfmark',
    baseUrl: 'http://127.0.0.1:8084',
    username: null,
    password: 'shelf-key',
    category: 'bookorbit',
    allowPrivateAddress: true,
    settings: null,
    ...overrides,
  };
}

interface Call {
  url: URL;
  init: RequestInit;
}

function mockShelfmark(status: Record<string, unknown>, onDownload: () => unknown = () => ({ status: 'queued' })): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string, init: RequestInit = {}) => {
      const url = new URL(input.toString());
      calls.push({ url, init });
      const body = url.pathname === '/api/status' ? status : url.pathname === '/api/releases/download' ? onDownload() : { ok: true };
      return Promise.resolve(body instanceof Response ? body : new Response(JSON.stringify(body)));
    }),
  );
  return calls;
}

describe('ShelfmarkDownloadClientAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetDispatchers();
  });

  it('queues the release exactly as the indexer found it, with the API key', async () => {
    const calls = mockShelfmark({});

    await expect(new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config())).resolves.toEqual({
      clientKey: KEY,
    });

    const queued = calls.find((call) => call.url.pathname === '/api/releases/download');
    expect(queued?.init.method).toBe('POST');
    expect(JSON.parse(queued?.init.body as string)).toEqual(RELEASE);
    expect(new Headers(queued?.init.headers).get('X-Api-Key')).toBe('shelf-key');
  });

  it('adopts a task Shelfmark is already working on instead of queueing it twice', async () => {
    const calls = mockShelfmark({ downloading: { md5abc: { id: 'md5abc', status: 'downloading', progress: 10 } } });

    await new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config());

    expect(calls.some((call) => call.url.pathname === '/api/releases/download')).toBe(false);
  });

  it('queues again when the earlier task failed', async () => {
    const calls = mockShelfmark({ error: { md5abc: { id: 'md5abc', status: 'error' } } });

    await new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config());

    expect(calls.some((call) => call.url.pathname === '/api/releases/download')).toBe(true);
  });

  it('refuses a grab that carries no Shelfmark release', async () => {
    mockShelfmark({});

    await expect(new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, magnet: 'magnet:?xt=urn:btih:abc' }, config())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses when Shelfmark does not say it queued the release', async () => {
    mockShelfmark({}, () => ({ status: 'rejected' }));

    await expect(new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config())).rejects.toThrow(
      'Shelfmark did not queue that release: rejected',
    );
  });

  it('passes on why Shelfmark refused to queue, as a refusal of this release alone', async () => {
    mockShelfmark({}, () => new Response(JSON.stringify({ error: "Anna's Archive is not configured" }), { status: 500 }));

    const refusal = await new ShelfmarkDownloadClientAdapter()
      .add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config())
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).message).toBe("Shelfmark did not queue that release: Anna's Archive is not configured");
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ errorCode: 'GRAB_RELEASE_REFUSED' });
  });

  it('adopts a release that was queued between reading the queue and asking', async () => {
    mockShelfmark({}, () => new Response(JSON.stringify({ error: 'Release is already in the download queue' }), { status: 500 }));

    await expect(new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config())).resolves.toEqual({
      clientKey: KEY,
    });
  });

  it('treats an exception while queueing as Shelfmark being briefly unavailable', async () => {
    mockShelfmark({}, () => new Response(JSON.stringify({ error: 'Error queueing release: database is locked' }), { status: 500 }));

    await expect(new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('queues again over a finished task whose file is gone, instead of adopting it', async () => {
    const calls = mockShelfmark({ complete: { md5abc: { status: 'complete', download_path: null } } });

    await new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config());

    expect(calls.some((call) => call.url.pathname === '/api/releases/download')).toBe(true);
  });

  it("treats Shelfmark's own storage faults as it being briefly unavailable", async () => {
    mockShelfmark({}, () => new Response(JSON.stringify({ error: 'database is locked' }), { status: 500 }));

    await expect(new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports a request policy block as a refusal of the release, not a bad API key', async () => {
    mockShelfmark({}, () => new Response(JSON.stringify({ error: 'Download not allowed by policy', code: 'policy_blocked' }), { status: 403 }));

    const refusal = (await new ShelfmarkDownloadClientAdapter()
      .add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config())
      .catch((error: unknown) => error)) as BadRequestException;

    expect(refusal.message).toBe("Shelfmark's request policy does not allow that release: Download not allowed by policy");
    expect(refusal.getResponse()).toMatchObject({ errorCode: 'GRAB_RELEASE_REFUSED' });
  });

  it('says how many files a finished task wrote when it names only the first', async () => {
    const packKey = shelfmarkClientKey('pack');
    mockShelfmark({
      complete: {
        md5abc: { status: 'complete', status_message: 'Complete (12 files)', download_path: '/audiobooks/Book/01.mp3' },
        pack: { status: 'complete', status_message: 'Complete (2 books, 5 files)', download_path: '/books/a.epub' },
      },
    });

    const statuses = await new ShelfmarkDownloadClientAdapter().status([KEY, packKey], config());

    expect(statuses).toEqual([
      expect.objectContaining({ state: 'completed', contentPath: '/audiobooks/Book/01.mp3', contentFileCount: 12 }),
      expect.objectContaining({ state: 'completed', contentFileCount: 5 }),
    ]);
  });

  it('dates each task by when Shelfmark created it', async () => {
    mockShelfmark({ error: { md5abc: { status: 'error', added_time: 1_760_000_000.5 } } });

    const [status] = await new ShelfmarkDownloadClientAdapter().status([KEY], config());

    expect(status?.startedAt).toEqual(new Date(1_760_000_000_500));
  });

  it('treats a server failure with no reason as Shelfmark being unavailable', async () => {
    mockShelfmark({}, () => new Response('<html>Bad Gateway</html>', { status: 502 }));

    await expect(new ShelfmarkDownloadClientAdapter().add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('keeps the donator key out of a refusal Shelfmark explains with a link', async () => {
    mockShelfmark(
      {},
      () =>
        new Response(JSON.stringify({ error: 'Failed https://annas-archive.gl/dyn/api/fast_download.json?md5=abc&key=SECRET key=SECRET' }), {
          status: 500,
        }),
    );

    const refusal = (await new ShelfmarkDownloadClientAdapter()
      .add({ clientKey: KEY, shelfmarkRelease: RELEASE }, config())
      .catch((error: unknown) => error)) as Error;

    expect(refusal.message).toBe('Shelfmark did not queue that release: Failed https://annas-archive.gl key=[REDACTED]');
  });

  it('reports a cancel as a cancel, not as the step the task was on', async () => {
    mockShelfmark({ cancelled: { md5abc: { status: 'cancelled', status_message: 'Trying Welib (3/12)' } } });

    await expect(new ShelfmarkDownloadClientAdapter().status([KEY], config())).resolves.toEqual([
      expect.objectContaining({ state: 'failed', errorMessage: 'Cancelled in Shelfmark' }),
    ]);
  });

  it('fails a finished task that kept no file, which there is nothing to import from', async () => {
    mockShelfmark({ complete: { md5abc: { status: 'complete', progress: 100, download_path: null } } });

    await expect(new ShelfmarkDownloadClientAdapter().status([KEY], config())).resolves.toEqual([
      expect.objectContaining({
        state: 'failed',
        contentPath: null,
        errorMessage: 'Shelfmark finished but kept no file for BookOrbit to import. Set its output mode to Folder.',
      }),
    ]);
  });

  it('strips links from the status message it stores', async () => {
    mockShelfmark({
      error: { md5abc: { status: 'error', status_message: 'Download failed: https://wtgadtq.org/d4/X/SECRETPART/f/1/book.epub refused' } },
    });

    await expect(new ShelfmarkDownloadClientAdapter().status([KEY], config())).resolves.toEqual([
      expect.objectContaining({ errorMessage: 'Shelfmark: Download failed: https://wtgadtq.org refused' }),
    ]);
  });

  it('reports each status bucket by the digest BookOrbit stores', async () => {
    const otherKey = shelfmarkClientKey('abb-1');
    const failedKey = shelfmarkClientKey('irc-1');
    mockShelfmark({
      complete: { md5abc: { id: 'md5abc', status: 'complete', progress: 100, size: '3.3MB', download_path: '/books/The Primal Hunter 14.epub' } },
      resolving: { 'abb-1': { id: 'abb-1', status: 'resolving', progress: 0 } },
      error: { 'irc-1': { id: 'irc-1', status: 'error', status_message: 'no download source worked' } },
    });

    const statuses = await new ShelfmarkDownloadClientAdapter().status([KEY, otherKey, failedKey, 'f'.repeat(40)], config());

    expect(statuses).toEqual([
      expect.objectContaining({
        clientKey: KEY,
        state: 'completed',
        progressPercent: 100,
        totalBytes: 3_460_301,
        downloadedBytes: 3_460_301,
        contentPath: '/books/The Primal Hunter 14.epub',
      }),
      expect.objectContaining({ clientKey: otherKey, state: 'queued', contentPath: null }),
      expect.objectContaining({ clientKey: failedKey, state: 'failed', errorMessage: 'Shelfmark: no download source worked' }),
    ]);
  });

  it('cancels an active task by its Shelfmark id and leaves a finished one alone', async () => {
    const calls = mockShelfmark({
      downloading: { 'https://abb/x y': { status: 'downloading' } },
      complete: { md5abc: { status: 'complete' } },
    });
    const adapter = new ShelfmarkDownloadClientAdapter();

    await adapter.remove(shelfmarkClientKey('https://abb/x y'), config());
    await adapter.remove(KEY, config());

    const cancels = calls.filter((call) => call.init.method === 'DELETE');
    expect(cancels.map((call) => call.url.pathname)).toEqual([`/api/download/${encodeURIComponent('https://abb/x y')}/cancel`]);
  });

  it('needs an API key', async () => {
    mockShelfmark({});

    await expect(new ShelfmarkDownloadClientAdapter().test(config({ password: null }))).resolves.toEqual({
      success: false,
      error: 'Shelfmark needs an API key',
    });
  });
});
