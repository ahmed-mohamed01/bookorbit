vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}));

vi.mock('dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('dns/promises')>()),
  lookup: vi.fn(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }])),
}));

import { forgetDispatchers } from '../../../../common/utils/safe-fetch';
import { IndexerSearchException, type ReleaseQuery, type ResolvedIndexerConfig } from '../indexer-adapter';
import { ShelfmarkIndexerAdapter } from './shelfmark.adapter';

function config(overrides: Partial<ResolvedIndexerConfig> = {}): ResolvedIndexerConfig {
  return {
    id: 4,
    name: 'Shelfmark',
    adapterType: 'shelfmark',
    baseUrl: 'http://127.0.0.1:8084/shelfmark',
    credential: 'shelf-key',
    credentialError: null,
    allowPrivateAddress: true,
    applyTrackerSeedGoals: false,
    seedRatioGoal: null,
    seedTimeMinutes: null,
    categories: { ebook: [], audiobook: [] },
    disabledMediaKinds: [],
    isbnSearchDisabled: false,
    settings: { shelfmarkSources: 'direct_download' },
    networkProfile: null,
    ...overrides,
  } as ResolvedIndexerConfig;
}

function query(overrides: Partial<ReleaseQuery> = {}): ReleaseQuery {
  return {
    title: 'The Primal Hunter 14',
    author: 'Zogarth',
    isbn13: null,
    isbn13s: [],
    mediaKind: 'ebook',
    language: null,
    limit: 50,
    ...overrides,
  } as ReleaseQuery;
}

const RELEASE = {
  source: 'direct_download',
  source_id: 'md5abc',
  title: 'The Primal Hunter 14',
  format: 'EPUB',
  language: 'en',
  size_bytes: 2_400_000,
  protocol: 'http',
  extra: { author: 'Zogarth' },
};

interface Call {
  url: URL;
  init: RequestInit;
}

function mockShelfmark(handler: (url: URL) => { status?: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string, init: RequestInit = {}) => {
      const url = new URL(input.toString());
      calls.push({ url, init });
      const { status = 200, body } = handler(url);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
  return calls;
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe('ShelfmarkIndexerAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetDispatchers();
  });

  it('searches the configured source by title and author, keeping the whole release for the grab', async () => {
    const calls = mockShelfmark(() => ({ body: { releases: [RELEASE] } }));

    const results = await new ShelfmarkIndexerAdapter().search(query(), config(), AbortSignal.timeout(5_000));

    expect(calls).toHaveLength(1);
    const url = calls[0]!.url;
    expect(url.pathname).toBe('/shelfmark/api/releases');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      provider: 'manual',
      title: 'The Primal Hunter 14',
      author: 'Zogarth',
      source: 'direct_download',
      content_type: 'ebook',
    });
    expect(headerOf(calls[0]!.init, 'X-Api-Key')).toBe('shelf-key');
    expect(results).toEqual([
      expect.objectContaining({
        indexerId: 4,
        guid: 'direct_download:md5abc',
        title: 'The Primal Hunter 14',
        sizeBytes: 2_400_000,
        seeders: null,
        format: 'epub',
        language: 'en',
        author: 'Zogarth',
        origin: "Anna's Archive",
        shelfmarkRelease: { ...RELEASE, content_type: 'ebook' },
      }),
    ]);
  });

  it('searches each source separately and keeps the releases of the ones that answered', async () => {
    const calls = mockShelfmark((url) =>
      url.searchParams.get('source') === 'libgen'
        ? { status: 503, body: { error: 'libgen mirrors unreachable' } }
        : { body: { releases: [{ ...RELEASE, source: 'irc', source_id: 'irc-1', seeders: 41 }] } },
    );

    const results = await new ShelfmarkIndexerAdapter().search(
      query(),
      config({ settings: { shelfmarkSources: 'irc,libgen' } }),
      AbortSignal.timeout(5_000),
    );

    expect(calls.map((call) => call.url.searchParams.get('source')).sort()).toEqual(['irc', 'libgen']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ guid: 'irc:irc-1', seeders: 41 });
  });

  it('only asks the sources that carry the requested medium', async () => {
    const calls = mockShelfmark(() => ({ body: { releases: [] } }));
    const adapter = new ShelfmarkIndexerAdapter();
    const sources = config({ settings: { shelfmarkSources: 'direct_download,audiobookbay,irc' } });

    await adapter.search(query(), sources, AbortSignal.timeout(5_000));
    await adapter.search(query({ mediaKind: 'audiobook' }), sources, AbortSignal.timeout(5_000));

    expect(calls.map((call) => `${call.url.searchParams.get('content_type')}:${call.url.searchParams.get('source')}`).sort()).toEqual([
      'audiobook:audiobookbay',
      'audiobook:irc',
      'ebook:direct_download',
      'ebook:irc',
    ]);
  });

  it('asks nothing when no configured source carries the medium', async () => {
    const calls = mockShelfmark(() => ({ body: { releases: [RELEASE] } }));

    await expect(new ShelfmarkIndexerAdapter().search(query({ mediaKind: 'audiobook' }), config(), AbortSignal.timeout(5_000))).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('searches Elscione for ebooks only and keeps its path id and label', async () => {
    const elscione = {
      ...RELEASE,
      source: 'elscione',
      source_id: 'Spice and Wolf/Spice and Wolf - Volume 01 [Yen Press][Kobo].epub',
      title: 'Spice and Wolf - Volume 01 [Yen Press][Kobo]',
      language: null,
      extra: { book_title: 'Spice and Wolf' },
    };
    const calls = mockShelfmark(() => ({ body: { releases: [elscione] } }));
    const adapter = new ShelfmarkIndexerAdapter();
    const sources = config({ settings: { shelfmarkSources: 'elscione' } });

    const results = await adapter.search(query({ title: 'Spice and Wolf Volume 1', author: 'Isuna Hasekura' }), sources, AbortSignal.timeout(5_000));
    await adapter.search(query({ mediaKind: 'audiobook' }), sources, AbortSignal.timeout(5_000));

    expect(calls.map((call) => `${call.url.searchParams.get('content_type')}:${call.url.searchParams.get('source')}`)).toEqual(['ebook:elscione']);
    expect(results).toEqual([
      expect.objectContaining({
        guid: `elscione:${elscione.source_id}`,
        title: elscione.title,
        origin: 'Elscione',
      }),
    ]);
  });

  it('elscione releases without a language are English', async () => {
    mockShelfmark(() => ({
      body: { releases: [undefined, null, '', '   '].map((language) => ({ ...RELEASE, source: 'elscione', language })) },
    }));

    const results = await new ShelfmarkIndexerAdapter().search(
      query(),
      config({ settings: { shelfmarkSources: 'elscione' } }),
      AbortSignal.timeout(5_000),
    );

    expect(results).toHaveLength(4);
    expect(results.map((release) => release.language)).toEqual(['en', 'en', 'en', 'en']);
  });

  it('a stated language is kept', async () => {
    mockShelfmark(() => ({ body: { releases: [{ ...RELEASE, source: 'elscione', language: 'ja' }] } }));

    const [release] = await new ShelfmarkIndexerAdapter().search(
      query(),
      config({ settings: { shelfmarkSources: 'elscione' } }),
      AbortSignal.timeout(5_000),
    );

    expect(release?.language).toBe('ja');
  });

  it('gives a source that just timed out a short budget until it answers again', async () => {
    let libgen: 'timeout' | 'answer' = 'timeout';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: URL | string) => {
        const source = new URL(input.toString()).searchParams.get('source');
        if (source === 'libgen' && libgen === 'timeout') return Promise.reject(new DOMException('timed out', 'TimeoutError'));
        const release = source === 'libgen' ? { ...RELEASE, source: 'libgen', source_id: 'lg-1' } : RELEASE;
        return Promise.resolve(new Response(JSON.stringify({ releases: [release] })));
      }),
    );
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const adapter = new ShelfmarkIndexerAdapter();
    const sources = config({ perIndexerTimeoutSeconds: 20, settings: { shelfmarkSources: 'direct_download,libgen' } });
    const budgets = async () => {
      timeout.mockClear();
      await adapter.search(query(), sources, new AbortController().signal);
      return timeout.mock.calls.map(([ms]) => ms).sort((a, b) => a - b);
    };

    expect(await budgets()).toEqual([18_500, 18_500]);
    libgen = 'answer';
    expect(await budgets()).toEqual([4_000, 18_500]);
    expect(await budgets()).toEqual([18_500, 18_500]);
    timeout.mockRestore();
  });

  it('keeps the donator key out of a source error Shelfmark passes on', async () => {
    mockShelfmark(() => ({
      status: 503,
      body: { error: "Anna's Archive: GET https://annas-archive.gl/dyn/api/fast_download.json?key=SECRET failed" },
    }));

    await expect(new ShelfmarkIndexerAdapter().search(query(), config(), AbortSignal.timeout(5_000))).rejects.toMatchObject({
      message: "Shelfmark: Anna's Archive: GET https://annas-archive.gl failed",
    });
  });

  it('scores a bare request title against the title without its subtitle, and counts one file', async () => {
    const full = 'Antimage: An Isekai LitRPG Adventure (Ends of Magic Book 1)';
    mockShelfmark(() => ({ body: { releases: [{ ...RELEASE, title: full }] } }));

    const [release] = await new ShelfmarkIndexerAdapter().search(query({ title: 'Antimage' }), config(), AbortSignal.timeout(5_000));

    expect(release).toMatchObject({ title: full, bookTitle: 'Antimage', primaryFileCount: 1 });
  });

  it('keeps the full title when the request names a subtitle too', async () => {
    mockShelfmark(() => ({ body: { releases: [{ ...RELEASE, title: 'Dune: Deluxe Edition' }] } }));

    const [release] = await new ShelfmarkIndexerAdapter().search(query({ title: 'Dune: Deluxe Edition' }), config(), AbortSignal.timeout(5_000));

    expect(release?.bookTitle).toBeUndefined();
  });

  it('reads the display size when Shelfmark states no byte count', async () => {
    mockShelfmark(() => ({ body: { releases: [{ ...RELEASE, size_bytes: null, size: '1,024.5 KB' }] } }));

    const [release] = await new ShelfmarkIndexerAdapter().search(query(), config(), AbortSignal.timeout(5_000));

    expect(release?.sizeBytes).toBe(1_049_088);
  });

  it('stops a slow source before the indexer deadline and keeps what the others found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: URL | string, init: RequestInit = {}) => {
        const url = new URL(input.toString());
        if (url.searchParams.get('source') === 'libgen') {
          return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        return Promise.resolve(new Response(JSON.stringify({ releases: [RELEASE] })));
      }),
    );

    const startedAt = Date.now();
    const results = await new ShelfmarkIndexerAdapter().search(
      query(),
      config({ perIndexerTimeoutSeconds: 2, settings: { shelfmarkSources: 'direct_download,libgen' } }),
      AbortSignal.timeout(5_000),
    );

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(results.map((release) => release.guid)).toEqual(['direct_download:md5abc']);
  });

  it('reports the failure when every source failed', async () => {
    mockShelfmark(() => ({ status: 503, body: { error: "Anna's Archive is behind a browser check" } }));

    const search = new ShelfmarkIndexerAdapter().search(query(), config(), AbortSignal.timeout(5_000));

    await expect(search).rejects.toBeInstanceOf(IndexerSearchException);
    await expect(search).rejects.toMatchObject({ failure: 'unreachable' });
  });

  it('maps a rejected API key to an unauthorized failure', async () => {
    mockShelfmark(() => ({ status: 401, body: { error: 'Unauthorized' } }));

    await expect(new ShelfmarkIndexerAdapter().search(query(), config(), AbortSignal.timeout(5_000))).rejects.toMatchObject({
      failure: 'unauthorized',
    });
  });

  it('drops releases without a source id, which could never be queued', async () => {
    mockShelfmark(() => ({ body: { releases: [{ ...RELEASE, source_id: '' }, RELEASE] } }));

    const results = await new ShelfmarkIndexerAdapter().search(query(), config(), AbortSignal.timeout(5_000));

    expect(results.map((release) => release.guid)).toEqual(['direct_download:md5abc']);
  });

  it('falls back to the default source when none of the configured ones is known', async () => {
    const calls = mockShelfmark(() => ({ body: { releases: [] } }));

    await new ShelfmarkIndexerAdapter().search(query(), config({ settings: { shelfmarkSources: 'prowlarr' } }), AbortSignal.timeout(5_000));

    expect(calls[0]!.url.searchParams.get('source')).toBe('direct_download');
  });

  it('passes the test only when every configured source is enabled in Shelfmark', async () => {
    mockShelfmark(() => ({
      body: [
        { name: 'direct_download', enabled: true },
        { name: 'audiobookbay', enabled: false },
      ],
    }));
    const adapter = new ShelfmarkIndexerAdapter();

    await expect(adapter.test(config())).resolves.toEqual({ success: true, indexerName: 'Shelfmark' });
    await expect(adapter.test(config({ settings: { shelfmarkSources: 'direct_download,audiobookbay' } }))).resolves.toEqual({
      success: false,
      error: 'Shelfmark has these sources turned off or not set up: audiobookbay',
    });
  });
});
