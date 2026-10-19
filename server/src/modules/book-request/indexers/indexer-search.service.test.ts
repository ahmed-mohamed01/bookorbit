import type { BookRequestRow } from '../../../db/schema';
import { emptyReleaseProfiles } from '@bookorbit/types';
import type { IndexerAdapterType } from '@bookorbit/types';

import { BookRequestSourcesService } from '../book-request-sources.service';
import { IndexerSearchException, type ReleaseCandidate, type ResolvedIndexerConfig } from './indexer-adapter';
import { IndexerOperationLock } from './indexer-operation-lock';
import { IndexerSearchService } from './indexer-search.service';

function request(overrides: Partial<BookRequestRow> = {}): BookRequestRow {
  return {
    id: 7,
    title: 'Dune',
    authors: ['Frank Herbert'],
    isbn13: null,
    isbn10: null,
    metadataSources: [],
    mediaKind: 'ebook',
    preferredFormats: ['epub'],
    language: null,
    ...overrides,
  } as BookRequestRow;
}

/**
 * Torznab is the only built-in type, so anything else a row can name is a plugin slug. Cast the way
 * `IndexerConfigService` casts a row it read from the database, which is where these come from.
 */
const pluginType = (slug: string) => slug as IndexerAdapterType;

function indexer(overrides: Partial<ResolvedIndexerConfig> = {}): ResolvedIndexerConfig {
  return {
    id: 1,
    managerId: null,
    managerPriority: null,
    name: 'jackett',
    color: null,
    adapterType: 'torznab',
    baseUrl: 'http://127.0.0.1:9117',
    credential: null,
    allowPrivateAddress: true,
    applyTrackerSeedGoals: true,
    seedRatioGoal: null,
    seedTimeMinutes: null,
    categories: { ebook: [7020], audiobook: [3030] },
    disabledMediaKinds: [],
    isbnSearchDisabled: false,
    settings: null,
    networkProfile: null,
    perIndexerTimeoutSeconds: 20,
    overallSearchBudgetSeconds: null,
    autoExpandCategories: false,
    credentialError: null,
    ...overrides,
  };
}

function release(overrides: Partial<ReleaseCandidate> = {}): ReleaseCandidate {
  return {
    indexerId: 1,
    guid: 'g1',
    title: 'Frank Herbert - Dune [EPUB]',
    sizeBytes: 2 * 1024 * 1024,
    seeders: 10,
    leechers: 1,
    format: 'epub',
    ...overrides,
  };
}

/**
 * Adapters here declare every medium unless a test says otherwise, so a stub is not silently read
 * as a source that carries nothing.
 */
function makeService(
  configs: ResolvedIndexerConfig[],
  adapters: Record<
    string,
    {
      search: ReturnType<typeof vi.fn>;
      mediaKinds?: readonly string[];
      seedsBack?: boolean;
      supportsIsbnSearch?: boolean;
      delivery?: 'torrent' | 'usenet' | 'file';
      selfHosted?: boolean;
      keepalive?: ReturnType<typeof vi.fn>;
      searchesConcurrently?: boolean;
      skipsTitleOnlyRetry?: boolean;
    }
  >,
) {
  // The rows that exist, of which `configs` is the enabled subset. Every case here builds its
  // sources enabled, so the two counts match unless a case says otherwise.
  const indexers = {
    resolveEnabledConfigs: vi.fn().mockResolvedValue(configs),
    resolveConfig: vi.fn((id: number) => Promise.resolve(configs.find((config) => config.id === id))),
    findColorsByIds: vi.fn((ids: number[]) =>
      Promise.resolve(configs.filter((config) => ids.includes(config.id)).map((config) => ({ id: config.id, color: config.color }))),
    ),
    countSources: vi.fn().mockResolvedValue({ configured: configs.length, enabled: configs.length }),
    recordSearchOutcomes: vi.fn().mockResolvedValue(undefined),
  };
  const registry = {
    find: vi.fn((type: string) => {
      const adapter = adapters[type];
      return adapter ? { mediaKinds: ['ebook', 'audiobook'], supportsIsbnSearch: false, ...adapter } : undefined;
    }),
    seedsBack: vi.fn((type: string) => adapters[type]?.seedsBack ?? true),
    delivery: vi.fn((type: string) => adapters[type]?.delivery ?? (adapters[type]?.seedsBack === false ? 'file' : 'torrent')),
  };
  // No profile, which is the shipped default and keeps these cases about search and scoring.
  const automationSettings = { get: vi.fn(() => Promise.resolve({ profiles: emptyReleaseProfiles() })) };
  const factsRepository = { findByHashes: vi.fn().mockResolvedValue(new Map()) };
  const requestSources = new BookRequestSourcesService(indexers as never, registry as never);
  return {
    service: new IndexerSearchService(
      indexers as never,
      registry as never,
      automationSettings as never,
      new IndexerOperationLock(),
      requestSources,
      factsRepository as never,
    ),
    indexers,
    adapters,
    automationSettings,
    factsRepository,
  };
}

describe('IndexerSearchService', () => {
  it('looks up hashes once per indexer with hashed candidates and reuses cached results', async () => {
    const hash = 'a'.repeat(40);
    const otherHash = 'b'.repeat(40);
    const first = {
      search: vi
        .fn()
        .mockResolvedValueOnce([release({ infoHash: hash.toUpperCase() }), release({ guid: 'rejected', infoHash: 'c'.repeat(40), seeders: 0 })])
        .mockResolvedValueOnce([release({ indexerId: 3, guid: 'no-hash' })]),
    };
    const second = {
      search: vi
        .fn()
        .mockResolvedValue([
          release({ indexerId: 2, guid: 'other', infoHash: otherHash }),
          release({ indexerId: 2, guid: 'same-hash', magnet: 'magnet:?xt=urn:btih:' + hash }),
        ]),
    };
    const { service, factsRepository } = makeService([indexer(), indexer({ id: 2, adapterType: pluginType('nyaa') }), indexer({ id: 3 })], {
      torznab: first,
      nyaa: second,
    });
    await service.search(request());
    expect(factsRepository.findByHashes).toHaveBeenCalledTimes(2);
    expect(factsRepository.findByHashes).toHaveBeenCalledWith([hash]);
    expect(factsRepository.findByHashes).toHaveBeenCalledWith([otherHash, hash]);
    await service.search(request());
    expect(factsRepository.findByHashes).toHaveBeenCalledTimes(2);
  });

  it('returns releases when stored facts cannot be read', async () => {
    const hash = 'a'.repeat(40);
    const { service, factsRepository } = makeService([indexer()], {
      torznab: { search: vi.fn().mockResolvedValue([release({ infoHash: hash })]) },
    });
    const warn = vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    factsRepository.findByHashes.mockRejectedValue(new Error('missing "facts" table'));
    const result = await service.search(request());
    expect(result.releases).toHaveLength(1);
    expect(result.indexers[0]).toMatchObject({ ok: true, count: 1 });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[book_request.release_search] [fail] indexerId=1 hashes=1 errorClass=Error error="missing \\"facts\\" table" - stored release facts could not be read',
    );
  });

  it.each([true, false])('ranks unknown releases with stored facts=%s using one batched lookup', async (stored) => {
    const hash = 'a'.repeat(40);
    const candidate = release({ title: 'Dune', format: undefined, infoHash: hash, downloadUrl: 'https://nyaa.si/download/1.torrent' });
    const { service, automationSettings, factsRepository } = makeService([indexer()], {
      torznab: { search: vi.fn().mockResolvedValue([candidate]) },
    });
    const profiles = emptyReleaseProfiles();
    profiles.ebook = [{ id: 'epub', name: 'EPUB single', conditions: { formats: ['epub'], fileLayout: 'single' } }];
    automationSettings.get.mockResolvedValue({ profiles });
    if (stored)
      factsRepository.findByHashes.mockResolvedValue(new Map([[hash, { infoHash: hash, formats: ['epub'], fileCount: 3, primaryFileCount: 1 }]]));
    const result = await service.search(request());
    expect(factsRepository.findByHashes).toHaveBeenCalledExactlyOnceWith([hash]);
    expect(result.releases[0]).toMatchObject({ tier: stored ? 0 : null, inspectionWanted: !stored });
    if (stored) {
      expect(result.releases[0]).toMatchObject({ formats: ['epub'], fileCount: 1 });
      expect(result.releases[0].reasons).toContainEqual({ code: 'preferredFormat', points: 12, detail: 'epub' });
    } else {
      expect(result.releases[0].profileMismatch?.failures.map((failure) => failure.code)).toEqual(['formatUnknown', 'fileLayoutUnknown']);
    }
  });

  it('starts a self-hosted source at once instead of queueing it behind the tracker slots', async () => {
    const pending: Array<() => void> = [];
    const blocked = () => new Promise<ReleaseCandidate[]>((resolve) => pending.push(() => resolve([])));
    const trackers = { search: vi.fn(blocked) };
    const shelf = { search: vi.fn(blocked), selfHosted: true };
    const configs = [
      ...[1, 2, 3, 4].map((id) => indexer({ id, name: `tracker ${id}` })),
      indexer({ id: 5, name: 'shelf', adapterType: pluginType('shelf') }),
    ];
    const { service } = makeService(configs, { torznab: trackers, shelf });

    const searching = service.search(request());

    await vi.waitFor(() => expect(shelf.search).toHaveBeenCalledTimes(1));
    expect(trackers.search).toHaveBeenCalledTimes(3);
    while (pending.length > 0) {
      pending.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await searching;
  });

  it('keeps books and comic archives in the same non-audio search without returning audiobooks', async () => {
    const adapter = {
      mediaKinds: ['ebook', 'audiobook'],
      search: vi
        .fn()
        .mockResolvedValue([
          release({ guid: 'comic', format: 'cbz', title: 'Saga - Brian K Vaughan [CBZ]' }),
          release({ guid: 'book', format: 'epub', title: 'Saga - Brian K Vaughan [EPUB]' }),
          release({ guid: 'audio', format: 'mp3', title: 'Saga - Brian K Vaughan [MP3]' }),
        ]),
    };
    const { service } = makeService([indexer({ adapterType: pluginType('example-plugin') })], { 'example-plugin': adapter });

    const result = await service.search(request({ title: 'Saga', authors: ['Brian K Vaughan'], preferredFormats: ['cbz'] }));

    expect(adapter.search).toHaveBeenCalledWith(expect.objectContaining({ mediaKind: 'ebook' }), expect.anything(), expect.any(AbortSignal));
    expect(result.releases.map((item) => item.guid)).toEqual(['comic', 'book']);
    expect(result.releases[0]).toMatchObject({ format: 'cbz', formats: ['cbz'] });
    expect(result.indexers[0]).toMatchObject({ ok: true, count: 2, filtered: 1 });
  });

  /** The picker for an old comic request says why, rather than asking every tracker for nothing. */
  it('refuses to search for a request made for the retired comic medium', async () => {
    const search = vi.fn();
    const { service } = makeService([indexer()], { [indexer().adapterType]: { search } });

    await expect(service.search(request({ mediaKind: 'comic' }))).rejects.toThrow('Comic requests are no longer supported');
    expect(search).not.toHaveBeenCalled();
  });

  /**
   * A rotated or unset encryption key leaves stored credentials unreadable. Decrypting the whole
   * enabled list up front meant one such row threw out of the resolve and took every other source
   * with it, including the ones holding no credential at all.
   */
  it('reports a source whose credential cannot be read without abandoning the others', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const archive = { search: vi.fn().mockResolvedValue([release({ indexerId: 2, guid: 'g2' })]) };
    const { service } = makeService(
      [
        indexer({ credentialError: 'BOOK_REQUEST_ENCRYPTION_KEY may have changed' }),
        indexer({ id: 2, name: 'archive', adapterType: pluginType('internet-archive') }),
      ],
      { torznab, 'internet-archive': archive },
    );

    const result = await service.search(request());

    expect(torznab.search).not.toHaveBeenCalled();
    expect(archive.search).toHaveBeenCalled();
    expect(result.releases.map((item) => item.indexerName)).toEqual(['archive']);
    expect(result.indexers.find((status) => status.indexerId === 1)).toMatchObject({
      ok: false,
      failure: 'unauthorized',
      error: expect.stringContaining('ENCRYPTION_KEY'),
    });
  });

  /**
   * A grab resolves a release by guid, so an indexer that returns one twice is describing one
   * release however many rows it sent. The resolution map already collapsed them, so the picker
   * offered a duplicate row that resolved to the same release and the source's count claimed one
   * it does not have.
   */
  it('collapses a guid one indexer returned more than once', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release(), release(), release({ guid: 'g2' })]) };
    const { service } = makeService([indexer()], { torznab });

    const result = await service.search(request());

    expect(result.releases.map((item) => item.guid)).toEqual(['g1', 'g2']);
    expect(result.indexers[0]).toMatchObject({ ok: true, count: 2, filtered: 0 });
  });

  /** Two indexers naming the same guid are two releases; the key is scoped to the source. */
  it('keeps the same guid from two different indexers apart', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const archive = { search: vi.fn().mockResolvedValue([release({ indexerId: 2 })]) };
    const { service } = makeService([indexer(), indexer({ id: 2, name: 'archive', adapterType: pluginType('internet-archive') })], {
      torznab,
      'internet-archive': archive,
    });

    const result = await service.search(request());

    expect(result.releases).toHaveLength(2);
  });

  it('merges every enabled indexer into one list ranked by score', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release({ title: 'Something Else [EPUB]', seeders: 400 })]) };
    const archive = { search: vi.fn().mockResolvedValue([release({ indexerId: 2, guid: 'g2', seeders: 5 })]) };
    const { service } = makeService([indexer(), indexer({ id: 2, name: 'archive', adapterType: pluginType('internet-archive') })], {
      torznab,
      'internet-archive': archive,
    });

    const result = await service.search(request());

    expect(result.releases.map((item) => item.indexerName)).toEqual(['archive', 'jackett']);
    expect(result.releases[0].score).toBeGreaterThan(result.releases[1].score);
  });

  it('limits a search to the selected source ids', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const archive = { search: vi.fn().mockResolvedValue([release({ indexerId: 2, guid: 'g2' })]) };
    const { service } = makeService([indexer(), indexer({ id: 2, adapterType: pluginType('internet-archive') })], {
      torznab,
      'internet-archive': archive,
    });

    const result = await service.search(request(), { sourceIds: [2] });

    expect(torznab.search).not.toHaveBeenCalled();
    expect(archive.search).toHaveBeenCalledTimes(1);
    expect(result.indexers.map((status) => status.indexerId)).toEqual([2]);
  });

  it('keeps limited and unlimited searches in separate cache entries', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const archive = { search: vi.fn().mockResolvedValue([release({ indexerId: 2, guid: 'g2' })]) };
    const { service } = makeService([indexer(), indexer({ id: 2, adapterType: pluginType('internet-archive') })], {
      torznab,
      'internet-archive': archive,
    });

    await service.search(request(), { sourceIds: [1] });
    const unlimited = await service.search(request());

    expect(torznab.search).toHaveBeenCalledTimes(2);
    expect(archive.search).toHaveBeenCalledTimes(1);
    expect(unlimited.cached).toBe(false);
  });

  it('records the outcome of every source that took part in a real search', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const archive = { search: vi.fn().mockRejectedValue(new Error('tracker is offline')) };
    const { service, indexers } = makeService([indexer(), indexer({ id: 2, name: 'archive', adapterType: pluginType('internet-archive') })], {
      torznab,
      'internet-archive': archive,
    });

    await service.search(request());

    expect(indexers.recordSearchOutcomes).toHaveBeenCalledWith([
      { indexerId: 1, ok: true, error: null },
      { indexerId: 2, ok: false, error: 'tracker is offline' },
    ]);
  });

  it('reports the request fields used to search and rank the releases', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([]) };
    const { service } = makeService([indexer()], { torznab });

    const result = await service.search(
      request({
        authors: ['Frank Herbert', 'Brian Herbert'],
        isbn10: '0441172717',
        isbn13: '9780441172719',
        language: 'en',
        preferredFormats: ['epub', 'azw3'],
      }),
    );

    expect(result.criteria).toEqual({
      title: 'Dune',
      authors: ['Frank Herbert', 'Brian Herbert'],
      isbn10: null,
      isbn13: '9780441172719',
      activeIsbn: '9780441172719',
      isbns: ['9780441172719'],
      mediaKind: 'ebook',
      language: 'en',
      preferredFormats: ['epub', 'azw3'],
    });
  });

  it('searches only the recommended ISBN while retaining every distinct provider ISBN as an alternative', async () => {
    const libgen = { search: vi.fn().mockResolvedValueOnce([release()]), supportsIsbnSearch: true };
    const { service } = makeService([indexer({ adapterType: pluginType('libgen') })], { libgen });

    const result = await service.search(
      request({
        metadataSources: [
          { providerKey: 'google', providerId: 'g1', providerLabel: 'Google Books', isbn10: '0441013597', isbn13: null },
          { providerKey: 'amazon', providerId: 'a1', providerLabel: 'Amazon', isbn10: null, isbn13: '9781250301697' },
        ],
      }),
    );

    expect(libgen.search).toHaveBeenCalledWith(
      expect.objectContaining({ isbn13: '9780441013593', isbn13s: ['9780441013593'] }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.criteria).toMatchObject({ activeIsbn: '9780441013593', isbns: ['9780441013593', '9781250301697'] });
    expect(result.indexers[0]?.query).toEqual({ kind: 'isbn', value: '9780441013593' });
  });

  it('falls back from an empty ISBN search to title and author without identifiers', async () => {
    const libgen = {
      search: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([release()]),
      supportsIsbnSearch: true,
    };
    const { service } = makeService([indexer({ adapterType: pluginType('libgen') })], { libgen });

    const result = await service.search(request({ isbn13: '9780441172719' }));

    expect(libgen.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ isbn13: '9780441172719', isbn13s: ['9780441172719'] }),
      expect.anything(),
      expect.anything(),
    );
    expect(libgen.search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: 'Dune', author: 'Frank Herbert', isbn13: null, isbn13s: [] }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.releases).toHaveLength(1);
    expect(result.indexers[0]?.query).toEqual({ kind: 'titleAuthor', value: 'Dune Frank Herbert' });
  });

  it('uses the existing title-only fallback after ISBN and title-author searches are empty', async () => {
    const libgen = {
      search: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([release()]),
      supportsIsbnSearch: true,
    };
    const { service } = makeService([indexer({ adapterType: pluginType('libgen') })], { libgen });

    const result = await service.search(request({ isbn13: '9780441172719' }));

    expect(libgen.search).toHaveBeenCalledTimes(3);
    expect(libgen.search).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ title: 'Dune', author: null, isbn13: null, isbn13s: [] }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.releases).toHaveLength(1);
    expect(result.indexers[0]?.query).toEqual({ kind: 'titleAuthor', value: 'Dune Frank Herbert' });
  });

  it('uses explicit picker overrides instead of silently retaining request search fields', async () => {
    const libgen = { search: vi.fn().mockResolvedValue([]), supportsIsbnSearch: true };
    const { service } = makeService([indexer({ adapterType: pluginType('libgen') })], { libgen });

    const result = await service.search(request({ isbn13: '9780441172719', language: 'en' }), {
      refresh: true,
      overrides: {
        title: 'Dune Messiah',
        authors: ['Frank Herbert'],
        isbn: '9780593098233',
        language: null,
        preferredFormats: ['azw3'],
      },
    });

    expect(libgen.search).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Dune Messiah',
        author: 'Frank Herbert',
        isbn13: '9780593098233',
        isbn13s: ['9780593098233'],
        language: null,
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.criteria).toEqual({
      title: 'Dune Messiah',
      authors: ['Frank Herbert'],
      isbn10: null,
      isbn13: '9780593098233',
      activeIsbn: '9780593098233',
      isbns: ['9780593098233', '9780441172719'],
      mediaKind: 'ebook',
      language: null,
      preferredFormats: ['azw3'],
    });
  });

  it('lets an explicit null ISBN select a title and author search', async () => {
    const libgen = { search: vi.fn().mockResolvedValue([]), supportsIsbnSearch: true };
    const { service } = makeService([indexer({ adapterType: pluginType('libgen') })], { libgen });

    const result = await service.search(request({ isbn13: '9780441172719' }), { refresh: true, overrides: { isbn: null } });

    expect(libgen.search).toHaveBeenCalledWith(expect.objectContaining({ isbn13: null, isbn13s: [] }), expect.anything(), expect.anything());
    expect(result.criteria).toMatchObject({ activeIsbn: null, isbns: ['9780441172719'] });
    expect(result.indexers[0]?.query).toEqual({ kind: 'titleAuthor', value: 'Dune Frank Herbert' });
  });

  it('withholds the ISBN from a source the operator took it away from', async () => {
    const libgen = { search: vi.fn().mockResolvedValue([]), supportsIsbnSearch: true };
    const { service } = makeService([indexer({ adapterType: pluginType('libgen'), isbnSearchDisabled: true })], { libgen });

    const result = await service.search(request({ isbn13: '9780441172719' }));

    expect(libgen.search).toHaveBeenCalledWith(expect.objectContaining({ isbn13: null, isbn13s: [] }), expect.anything(), expect.anything());
    expect(result.indexers[0]?.query).toEqual({ kind: 'titleAuthor', value: 'Dune Frank Herbert' });
    // Still the request's ISBN: taking it from one source does not change what was asked for.
    expect(result.criteria).toMatchObject({ activeIsbn: '9780441172719' });
  });

  it('leaves a source with the ISBN taken away out of an ISBN-capable pass', async () => {
    const libgen = { search: vi.fn().mockResolvedValue([]), supportsIsbnSearch: true };
    const other = { search: vi.fn().mockResolvedValue([]), supportsIsbnSearch: true };
    const { service } = makeService(
      [indexer({ adapterType: pluginType('libgen'), isbnSearchDisabled: true }), indexer({ id: 2, name: 'other', adapterType: pluginType('other') })],
      { libgen, other },
    );

    const result = await service.search(request({ isbn13: '9780441172719' }), { indexerMode: 'isbn-capable' });

    expect(libgen.search).not.toHaveBeenCalled();
    expect(result.indexers.map((status) => status.indexerName)).toEqual(['other']);
  });

  it('limits fallback passes to ISBN-capable indexers', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([]) };
    const libgen = { search: vi.fn().mockResolvedValue([release({ indexerId: 2 })]), supportsIsbnSearch: true };
    const { service } = makeService([indexer(), indexer({ id: 2, name: 'libgen', adapterType: pluginType('libgen') })], {
      torznab,
      libgen,
    });

    const result = await service.search(request({ isbn13: '9780441172719' }), { indexerMode: 'isbn-capable' });

    expect(torznab.search).not.toHaveBeenCalled();
    expect(libgen.search).toHaveBeenCalledTimes(1);
    expect(result.indexers.map((status) => status.indexerName)).toEqual(['libgen']);
    expect(result.uncoveredIndexerCount).toBe(0);
  });

  it('sends the final title fallback only to ISBN-capable indexers', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([]) };
    const libgen = { search: vi.fn().mockResolvedValue([]), supportsIsbnSearch: true };
    const { service } = makeService([indexer(), indexer({ id: 2, name: 'libgen', adapterType: pluginType('libgen') })], {
      torznab,
      libgen,
    });

    const result = await service.search(request({ isbn13: '9780441172719' }), {
      indexerMode: 'isbn-capable',
      overrides: { isbn: null },
    });

    expect(torznab.search).not.toHaveBeenCalled();
    expect(libgen.search).toHaveBeenCalledWith(expect.objectContaining({ isbn13: null, isbn13s: [] }), expect.anything(), expect.anything());
    expect(result.indexers[0]?.query).toEqual({ kind: 'titleAuthor', value: 'Dune Frank Herbert' });
  });

  /** One tracker being down is a per-indexer state in the picker, not a failed search. */
  it('reports a failing indexer beside the results the others returned', async () => {
    const torznab = { search: vi.fn().mockRejectedValue(new IndexerSearchException('unauthorized', 'bad key')) };
    const archive = { search: vi.fn().mockResolvedValue([release({ indexerId: 2, guid: 'g2' })]) };
    const { service } = makeService([indexer(), indexer({ id: 2, name: 'archive', adapterType: pluginType('internet-archive') })], {
      torznab,
      'internet-archive': archive,
    });

    const result = await service.search(request());

    expect(result.releases).toHaveLength(1);
    expect(result.indexers).toEqual([
      {
        indexerId: 1,
        indexerName: 'jackett',
        color: null,
        ok: false,
        count: 0,
        filtered: 0,
        query: { kind: 'titleAuthor', value: 'Dune Frank Herbert' },
        failure: 'unauthorized',
        error: 'bad key',
        seedsBack: true,
        delivery: 'torrent',
      },
      {
        indexerId: 2,
        indexerName: 'archive',
        color: null,
        ok: true,
        count: 1,
        filtered: 0,
        query: { kind: 'titleAuthor', value: 'Dune Frank Herbert' },
        seedsBack: true,
        delivery: 'torrent',
      },
    ]);
  });

  /**
   * A source that serves the file itself has no swarm to report, which the picker must not read
   * as one release having omitted its seeder count. The answer belongs to the adapter, so it
   * travels with the indexer's status rather than being guessed from the merged release list.
   */
  it('reports whether each source joins a swarm', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const libgen = { search: vi.fn().mockResolvedValue([release({ indexerId: 2, guid: 'g2', seeders: null })]), seedsBack: false };
    const { service } = makeService([indexer(), indexer({ id: 2, name: 'libgen', adapterType: pluginType('libgen') })], { torznab, libgen });

    const result = await service.search(request());

    expect(result.indexers.map((status) => [status.indexerName, status.seedsBack])).toEqual([
      ['jackett', true],
      ['libgen', false],
    ]);
  });

  it('counts what the hard filters dropped, so an empty list stays explainable', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release({ seeders: 0 }), release({ guid: 'g2', format: 'mp3' })]) };
    const { service } = makeService([indexer()], { torznab });

    const result = await service.search(request());

    expect(result.releases).toHaveLength(0);
    expect(result.indexers[0]).toMatchObject({ ok: true, count: 0, filtered: 2 });
  });

  it('retries a title and author miss with the title alone', async () => {
    const torznab = {
      search: vi.fn((query: { author: string | null }) => Promise.resolve(query.author ? [] : [release()])),
    };
    const { service } = makeService([indexer()], { torznab });

    const result = await service.search(request());

    expect(torznab.search).toHaveBeenCalledTimes(2);
    expect(torznab.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ title: 'Dune', author: 'Frank Herbert' }),
      expect.anything(),
      expect.anything(),
    );
    expect(torznab.search).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'Dune', author: null }), expect.anything(), expect.anything());
    expect(result.releases).toHaveLength(1);
  });

  /** Reopening the picker must not re-hit a private tracker; `refresh` is the way past that. */
  it('serves a repeat search from the cache until asked to refresh', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const { service } = makeService([indexer()], { torznab });

    await service.search(request());
    const second = await service.search(request());
    expect(second.cached).toBe(true);
    expect(torznab.search).toHaveBeenCalledTimes(1);

    const refreshed = await service.search(request(), { refresh: true });
    expect(refreshed.cached).toBe(false);
    expect(torznab.search).toHaveBeenCalledTimes(2);
  });

  it('refreshes source colors when serving a cached search', async () => {
    const config = indexer({ color: 'blue' });
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const { service } = makeService([config], { torznab });

    await service.search(request());
    config.color = 'orange';

    const cached = await service.search(request());
    expect(cached.cached).toBe(true);
    expect(cached.indexers[0]?.color).toBe('orange');
    expect(torznab.search).toHaveBeenCalledOnce();
  });

  it('keeps manual and default search caches separate while retaining both pickable result sets', async () => {
    const torznab = {
      search: vi.fn((query: { title: string }) =>
        Promise.resolve([release(query.title === 'Dune Messiah' ? { guid: 'custom' } : { guid: 'default' })]),
      ),
    };
    const { service } = makeService([indexer()], { torznab });

    await service.search(request());
    await service.search(request(), { overrides: { title: 'Dune Messiah' } });
    const defaultAgain = await service.search(request());

    expect(defaultAgain.cached).toBe(true);
    expect(torznab.search).toHaveBeenCalledTimes(2);
    expect(service.find(7, 1, 'default')).toBeDefined();
    expect(service.find(7, 1, 'custom')).toBeDefined();
  });

  it('keeps all-indexer and ISBN-capable search caches separate', async () => {
    const libgen = { search: vi.fn().mockResolvedValue([release()]), supportsIsbnSearch: true };
    const { service } = makeService([indexer({ adapterType: pluginType('libgen') })], { libgen });
    const book = request({ isbn13: '9780441172719' });

    await service.search(book);
    await service.search(book, { indexerMode: 'isbn-capable' });
    const capableAgain = await service.search(book, { indexerMode: 'isbn-capable' });

    expect(libgen.search).toHaveBeenCalledTimes(2);
    expect(capableAgain.cached).toBe(true);
  });

  /**
   * An open library that holds only text has nothing to say about an audiobook. Nothing goes wrong
   * when it is asked for one, because it is never asked: the mismatch is a permanent property of
   * the source, known before any request, so it is left out of the search rather than reported as
   * a per-indexer failure the operator might try to fix.
   */
  it('leaves out a source that does not carry the requested medium instead of failing it', async () => {
    const gutenberg = { search: vi.fn(), mediaKinds: ['ebook'] as const };
    const { service } = makeService([indexer({ id: 2, name: 'gutenberg', adapterType: pluginType('project-gutenberg') })], {
      'project-gutenberg': gutenberg,
    });

    const result = await service.search(request({ mediaKind: 'audiobook' }));

    expect(gutenberg.search).not.toHaveBeenCalled();
    expect(result.indexers).toEqual([]);
  });

  /**
   * The operator's own narrowing, on top of what the adapter declares. A general torznab proxy in
   * front of an audiobook-only tracker still says it carries all three, and an empty category list
   * cannot express the exclusion either: torznab reads that as "send no `cat`".
   */
  it('leaves out a source the operator took out of this medium', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const { service } = makeService([indexer({ disabledMediaKinds: ['ebook'] })], { torznab });

    const result = await service.search(request({ mediaKind: 'ebook' }));

    expect(torznab.search).not.toHaveBeenCalled();
    expect(result.uncoveredIndexerCount).toBe(1);
  });

  it('still searches that source for the media it was left in', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const { service } = makeService([indexer({ disabledMediaKinds: ['ebook'] })], { torznab });

    await service.search(request({ mediaKind: 'audiobook' }));

    expect(torznab.search).toHaveBeenCalledTimes(1);
  });

  /**
   * A missing adapter is a fact about the build and is reported rather than hidden, but an
   * exclusion is a decision about the source, and it stands whether or not the adapter loaded.
   */
  it('honours the exclusion even for a row whose adapter this build no longer has', async () => {
    const { service } = makeService([indexer({ adapterType: pluginType('departed'), disabledMediaKinds: ['ebook'] })], {});

    const result = await service.search(request({ mediaKind: 'ebook' }));

    expect(result.indexers).toEqual([]);
    expect(result.uncoveredIndexerCount).toBe(1);
  });

  /** Counted rather than dropped, so an empty list can still say why it is empty. */
  it('counts the sources it left out, so an empty list stays explainable', async () => {
    const gutenberg = { search: vi.fn(), mediaKinds: ['ebook'] as const };
    const librivox = { search: vi.fn().mockResolvedValue([]), mediaKinds: ['audiobook'] as const };
    const { service } = makeService(
      [
        indexer({ id: 2, name: 'gutenberg', adapterType: pluginType('project-gutenberg') }),
        indexer({ id: 3, name: 'librivox', adapterType: pluginType('librivox') }),
      ],
      { 'project-gutenberg': gutenberg, librivox },
    );

    const result = await service.search(request({ mediaKind: 'audiobook' }));

    expect(result.uncoveredIndexerCount).toBe(1);
    expect(result.indexers).toEqual([expect.objectContaining({ indexerName: 'librivox', ok: true })]);
  });

  it('counts nothing as uncovered when every source carries the medium', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release()]) };
    const { service } = makeService([indexer()], { torznab });

    await expect(service.search(request())).resolves.toMatchObject({ uncoveredIndexerCount: 0 });
  });

  /**
   * The picker cannot ask for the indexer list, so an empty release list has to carry why it is
   * empty. Without these two counts "nothing is set up", "everything is switched off" and "this
   * book was not found" all arrive as the same empty array.
   */
  it('reports how many sources were enabled and how many exist at all', async () => {
    const { service, indexers } = makeService([], {});
    indexers.countSources.mockResolvedValue({ configured: 3, enabled: 0 });

    const result = await service.search(request());

    expect(result.enabledIndexerCount).toBe(0);
    expect(result.configuredIndexerCount).toBe(3);
    expect(result.releases).toEqual([]);
    expect(result.indexers).toEqual([]);
  });

  /**
   * A row whose adapter is gone cannot be judged on its media at all, so leaving it out here would
   * hide the one state the operator has to act on.
   */
  it('still searches a row whose adapter this build no longer has, so it is reported', async () => {
    const { service } = makeService([indexer({ adapterType: pluginType('departed') })], {});

    const result = await service.search(request({ mediaKind: 'audiobook' }));

    expect(result.uncoveredIndexerCount).toBe(0);
    expect(result.indexers).toEqual([expect.objectContaining({ ok: false, failure: 'error' })]);
  });

  it('resolves a picked release from its own results rather than anything a client sent', async () => {
    const torznab = { search: vi.fn().mockResolvedValue([release({ downloadUrl: 'https://tracker.example.com/dl?tid=1' })]) };
    const { service } = makeService([indexer()], { torznab });

    await service.search(request());

    expect(service.find(7, 1, 'g1')).toMatchObject({ downloadUrl: 'https://tracker.example.com/dl?tid=1' });
    expect(service.find(7, 1, 'unknown')).toBeUndefined();
    expect(service.find(99, 1, 'g1')).toBeUndefined();
  });

  it('reports an indexer whose adapter is not built rather than silently skipping it', async () => {
    const { service } = makeService([indexer({ adapterType: pluginType('internet-archive') })], {});

    const result = await service.search(request());

    expect(result.indexers[0]).toMatchObject({ ok: false, failure: 'error' });
  });

  /**
   * A signal an adapter is handed only ends the work that actually watches it, so the search races
   * the adapter against its own deadline rather than trusting it: one that never settles used to
   * hold a slot in the bounded search pool for the life of the process, and the `Promise.all` over
   * the indexers never resolved - a picker spinning with nothing to show and nothing to report.
   *
   * That the race ends a wait nothing is watching is proven in `with-deadline.utils.test.ts`,
   * where it costs milliseconds rather than the real twenty-second per-indexer deadline. What
   * belongs here is the deadline reaching the adapter at all, and an overrun landing as one
   * source's failure rather than the search's.
   */
  it('gives each source a deadline and reports the one that ran out of time', async () => {
    const slow = {
      search: vi.fn((_query: unknown, _config: unknown, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        return Promise.reject(new IndexerSearchException('timeout', 'jackett did not answer in time'));
      }),
    };
    const working = { search: vi.fn().mockResolvedValue([release({ indexerId: 2, guid: 'g2' })]) };
    const { service } = makeService([indexer(), indexer({ id: 2, name: 'archive', adapterType: pluginType('internet-archive') })], {
      torznab: slow,
      'internet-archive': working,
    });

    const result = await service.search(request());

    expect(slow.search.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    expect(result.indexers).toEqual([
      expect.objectContaining({ indexerId: 1, ok: false, failure: 'timeout' }),
      expect.objectContaining({ indexerId: 2, ok: true }),
    ]);
    expect(result.releases).toHaveLength(1);
  });

  it('serializes work for a source whose session a keepalive rotates, and resolves its latest credential inside the lock', async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const credentialsSeen: Array<string | null> = [];
    const torznab = {
      search: vi.fn(async (_query: unknown, config: ResolvedIndexerConfig) => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        credentialsSeen.push(config.credential);
        if (calls === 1) await firstHeld;
        active--;
        return [release()];
      }),
      keepalive: vi.fn(),
    };
    const { service, indexers } = makeService([indexer({ credential: 'session-1' })], { torznab });
    indexers.resolveConfig.mockResolvedValueOnce(indexer({ credential: 'session-1' })).mockResolvedValueOnce(indexer({ credential: 'session-2' }));

    const first = service.search(request({ id: 7 }), { refresh: true });
    await vi.waitFor(() => expect(torznab.search).toHaveBeenCalledTimes(1));
    const second = service.search(request({ id: 8 }), { refresh: true });
    await Promise.resolve();
    expect(torznab.search).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
    expect(credentialsSeen).toEqual(['session-1', 'session-2']);
  });

  it('lets two searches share a source with no session to protect, and holds a third', async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const torznab = {
      searchesConcurrently: true,
      search: vi.fn(async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active--;
        return [release()];
      }),
    };
    const { service } = makeService([indexer()], { torznab });

    const searches = [7, 8, 9].map((id) => service.search(request({ id }), { refresh: true }));
    await vi.waitFor(() => expect(torznab.search).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(torznab.search).toHaveBeenCalledTimes(2);

    while (pending.length > 0 || torznab.search.mock.calls.length < 3) {
      pending.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(searches);
    expect(maxActive).toBe(2);
  });

  it('keeps a source that has not declared concurrent searches, such as a plugin, to one search at a time', async () => {
    const pending: Array<() => void> = [];
    const plugin = {
      search: vi.fn(async () => {
        await new Promise<void>((resolve) => pending.push(resolve));
        return [release()];
      }),
    };
    const { service } = makeService([indexer({ adapterType: pluginType('session-plugin') })], { 'session-plugin': plugin });

    const searches = [7, 8].map((id) => service.search(request({ id }), { refresh: true }));
    await vi.waitFor(() => expect(plugin.search).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(plugin.search).toHaveBeenCalledTimes(1);

    while (pending.length > 0 || plugin.search.mock.calls.length < 2) {
      pending.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(searches);
  });

  it('counts time queued for a slot against the search, so a waiter times out instead of starting late', async () => {
    const pending: Array<() => void> = [];
    const torznab = {
      searchesConcurrently: true,
      search: vi.fn(async () => {
        await new Promise<void>((resolve) => pending.push(resolve));
        return [release()];
      }),
    };
    const { service } = makeService([indexer({ perIndexerTimeoutSeconds: 1 })], { torznab });

    const searches = [7, 8, 9].map((id) => service.search(request({ id }), { refresh: true }));
    const third = await searches[2]!;

    expect(third.indexers[0]).toMatchObject({ ok: false, failure: 'timeout' });
    expect(torznab.search).toHaveBeenCalledTimes(2);
    pending.forEach((resolve) => resolve());
    await Promise.all(searches);
  });

  it('takes an empty answer as final from a source that skips the title-only retry', async () => {
    const shelf = { search: vi.fn().mockResolvedValue([]), skipsTitleOnlyRetry: true };
    const { service } = makeService([indexer({ adapterType: pluginType('shelf') })], { shelf });

    await service.search(request());

    expect(shelf.search).toHaveBeenCalledTimes(1);
  });

  it('keeps the releases a picker was showing grabbable after another search replaces the cache entry', async () => {
    let round = 0;
    const torznab = {
      search: vi.fn(() => {
        round++;
        return Promise.resolve([release({ guid: `round-${round}`, infoHash: `round-${round}` })]);
      }),
    };
    const { service } = makeService([indexer()], { torznab });

    const first = await service.search(request(), { refresh: true });
    await service.search(request(), { refresh: true });

    expect(service.find(7, first.releases[0]!.indexerId, first.releases[0]!.guid)).toBeDefined();
  });

  it('keeps only the listed releases grabbable once the merged list is cut', async () => {
    const guids = (indexerId: number) => Array.from({ length: 50 }, (_, index) => `${indexerId}-${index}`);
    const torznab = {
      search: vi.fn((_query: unknown, config: ResolvedIndexerConfig) =>
        Promise.resolve(
          guids(config.id).map((guid, index) =>
            release({ indexerId: config.id, guid, infoHash: guid, sizeBytes: (config.id * 100 + index + 1) * 1024 * 1024 }),
          ),
        ),
      ),
    };
    const configs = [1, 2, 3].map((id) => indexer({ id, name: `tracker ${id}` }));
    const { service } = makeService(configs, { torznab });

    const result = await service.search(request());

    expect(result.releases).toHaveLength(100);
    expect(service.find(7, result.releases[0]!.indexerId, result.releases[0]!.guid)).toBeDefined();
    const listed = new Set(result.releases.map((item) => `${item.indexerId}:${item.guid}`));
    const unlisted = configs.find((config) => guids(config.id).some((guid) => !listed.has(`${config.id}:${guid}`)))!;
    const unlistedGuid = guids(unlisted.id).find((guid) => !listed.has(`${unlisted.id}:${guid}`))!;
    expect(service.find(7, unlisted.id, unlistedGuid)).toBeUndefined();
    const [first] = result.releases;
    expect(service.find(7, first!.indexerId, first!.guid)).toBeDefined();
  });

  /**
   * Scoring runs per candidate, so a release the scorer cannot read is one source misbehaving.
   * Outside the per-indexer accounting it threw out of the merge and 500d the whole picker,
   * including every other indexer that answered perfectly well.
   */
  it('reports the one source whose release could not be scored and keeps the rest', async () => {
    const malformed = {
      search: vi.fn().mockResolvedValue([
        // A getter rather than a value, because the sanitiser at the plugin boundary is what
        // ordinarily catches a bad shape: this is the layer behind it.
        Object.defineProperty(release(), 'title', {
          get() {
            throw new TypeError('title is not a string');
          },
        }),
      ]),
    };
    const working = { search: vi.fn().mockResolvedValue([release({ indexerId: 2, guid: 'g2' })]) };
    const { service } = makeService([indexer(), indexer({ id: 2, name: 'archive', adapterType: pluginType('internet-archive') })], {
      torznab: malformed,
      'internet-archive': working,
    });

    const result = await service.search(request());

    expect(result.indexers).toEqual([
      expect.objectContaining({ indexerId: 1, ok: false, failure: 'error' }),
      expect.objectContaining({ indexerId: 2, ok: true, count: 1 }),
    ]);
    expect(result.releases).toHaveLength(1);
  });

  it('uses Prowlarr priority only after tier, score, and seeders are tied', async () => {
    const torznab = {
      search: vi
        .fn()
        .mockResolvedValueOnce([release({ indexerId: 1, guid: 'lower-priority' })])
        .mockResolvedValueOnce([release({ indexerId: 2, guid: 'higher-priority' })]),
    };
    const { service } = makeService(
      [
        indexer({ id: 1, managerId: 3, managerPriority: 20, overallSearchBudgetSeconds: 60 }),
        indexer({ id: 2, managerId: 3, managerPriority: 5, overallSearchBudgetSeconds: 60 }),
      ],
      { torznab },
    );

    const result = await service.search(request());

    expect(result.releases.map((item) => item.guid)).toEqual(['higher-priority', 'lower-priority']);
  });

  it('expands categories only after a successful empty response', async () => {
    const torznab = { search: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([release()]) };
    const { service } = makeService([indexer({ autoExpandCategories: true })], { torznab });

    await service.search(request({ authors: [] }));

    expect(torznab.search).toHaveBeenCalledTimes(2);
    expect(torznab.search.mock.calls[0]?.[1].categories.ebook).toEqual([7020]);
    expect(torznab.search.mock.calls[1]?.[1].categories.ebook).toEqual([]);
  });

  it('keeps the title-only query when it expands categories after an author retry', async () => {
    const torznab = { search: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([release()]) };
    const { service } = makeService([indexer({ autoExpandCategories: true })], { torznab });

    await service.search(request());

    expect(torznab.search).toHaveBeenCalledTimes(3);
    expect(torznab.search.mock.calls[0]?.[0].author).toBe('Frank Herbert');
    expect(torznab.search.mock.calls[1]?.[0].author).toBeNull();
    expect(torznab.search.mock.calls[2]?.[0].author).toBeNull();
    expect(torznab.search.mock.calls[2]?.[1].categories.ebook).toEqual([]);
  });

  it('does not expand categories after a failed search', async () => {
    const torznab = { search: vi.fn().mockRejectedValue(new IndexerSearchException('unreachable', 'offline')) };
    const { service } = makeService([indexer({ autoExpandCategories: true })], { torznab });

    const result = await service.search(request({ authors: [] }));

    expect(torznab.search).toHaveBeenCalledTimes(1);
    expect(result.indexers[0]).toMatchObject({ ok: false, failure: 'unreachable' });
  });

  it('keeps a picked candidate actionable after the visible result cache expires', async () => {
    vi.useFakeTimers();
    try {
      const torznab = { search: vi.fn().mockResolvedValue([release()]) };
      const { service } = makeService([indexer()], { torznab });
      await service.search(request());

      vi.advanceTimersByTime(4 * 60 * 1000);

      expect(service.find(7, 1, 'g1')).toMatchObject({ guid: 'g1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes a stale managed URL only when the release identity still matches', async () => {
    const stale = release({ infoHash: 'ABC', downloadUrl: 'https://prowlarr.test/old' });
    const exact = release({ infoHash: 'abc', downloadUrl: 'https://prowlarr.test/fresh' });
    const lookalike = release({ guid: 'other', infoHash: 'def', downloadUrl: 'https://prowlarr.test/wrong' });
    const torznab = { search: vi.fn().mockResolvedValueOnce([stale]).mockResolvedValueOnce([lookalike, exact]) };
    const managed = indexer({ managerId: 3, managerPriority: 10, overallSearchBudgetSeconds: 60 });
    const { service } = makeService([managed], { torznab });
    await service.search(request());

    await expect(service.refreshCandidate(7, 1, stale)).resolves.toMatchObject({ downloadUrl: 'https://prowlarr.test/fresh' });
  });
});

describe('streaming release searches', () => {
  it('merges each completed source, ranks snapshots and preserves final pick order and cache behavior', async () => {
    const deferred = () => {
      let resolve!: (value: ReleaseCandidate[]) => void;
      const promise = new Promise<ReleaseCandidate[]>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const first = deferred();
    const second = deferred();
    const adapter = { search: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) };
    const { service } = makeService([indexer(), indexer({ id: 2, name: 'second' })], { torznab: adapter });
    const onProgress = vi.fn();
    const searching = service.search(request(), { onProgress });
    await vi.waitFor(() => expect(adapter.search).toHaveBeenCalledTimes(2));
    expect(onProgress.mock.calls[0][0]).toMatchObject({ releases: [], indexers: [], pending: [{ indexerId: 1 }, { indexerId: 2 }], cached: false });
    const candidate = release({ indexerId: 2, guid: 'second', seeders: 1 });
    second.resolve([candidate]);
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(2));
    expect(onProgress.mock.calls[1][0]).toMatchObject({ releases: [{ guid: 'second' }], indexers: [{ indexerId: 2 }], pending: [{ indexerId: 1 }] });
    expect(service.find(7, 2, 'second')).toBe(candidate);
    first.resolve([release({ guid: 'first', seeders: 10 })]);
    const result = await searching;
    expect(onProgress.mock.calls[2][0]).toMatchObject({ pending: [], releases: result.releases, indexers: result.indexers });
    expect(result.indexers.map((source) => source.indexerId)).toEqual([1, 2]);
    expect(result.releases.map((row) => row.guid)).toEqual(['first', 'second']);
    onProgress.mockClear();
    expect(await service.search(request(), { onProgress })).toMatchObject({ ...result, cached: true });
    expect(onProgress).not.toHaveBeenCalled();
    adapter.search.mockImplementation((_query, config) => Promise.resolve(config.id === 2 ? [candidate] : [release({ guid: 'first', seeders: 10 })]));
    const plain = await service.search(request(), { refresh: true });
    expect({ ...plain, searchedAt: result.searchedAt }).toEqual(result);
    service.forget(7);
    expect(service.find(7, 2, 'second')).toBeUndefined();
  });

  it('ignores observer exceptions and removes in-flight candidates after completion', async () => {
    const { service } = makeService([indexer()], { torznab: { search: vi.fn().mockResolvedValue([release()]) } });
    const onProgress = vi.fn(() => {
      throw new Error('disconnected');
    });
    const result = await service.search(request(), { onProgress });
    expect(result.releases).toHaveLength(1);
    service.forget(7);
    expect(service.find(7, 1, result.releases[0].guid)).toBeUndefined();
  });
});

it('removes in-flight candidates when the search throws before caching', async () => {
  const { service, indexers } = makeService([indexer()], { torznab: { search: vi.fn().mockResolvedValue([release()]) } });
  indexers.recordSearchOutcomes.mockImplementation(() => {
    throw new Error('write failed');
  });
  const onProgress = vi.fn((progress) => {
    if (progress.releases.length) expect(service.find(7, 1, progress.releases[0].guid)).toBeDefined();
  });
  await expect(service.search(request(), { onProgress })).rejects.toThrow('write failed');
  service.forget(7);
  expect(service.find(7, 1, release().guid)).toBeUndefined();
});
