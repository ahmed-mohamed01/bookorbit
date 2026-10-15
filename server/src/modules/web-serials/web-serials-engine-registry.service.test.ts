import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { isSeriesSourceAllowed, WebSerialsEngineRegistry } from './web-serials-engine-registry.service';

vi.mock('./engines/suwayomi.client', () => ({ SuwayomiClient: class {} }));
vi.mock('./engines/lncrawl.client', () => ({ LncrawlClient: class {} }));

const CONNECTION = { url: 'http://engine', username: null, password: null };

function build(allowedSources: string[] = ['source:11'], series: Record<string, unknown> = { sourceId: '11', language: 'en' }) {
  const state = { version: 1 };
  const settings = {
    get catalogVersion() {
      return state.version;
    },
    getEngineConfig: vi.fn().mockResolvedValue({ connection: CONNECTION, allowedSources }),
  };
  const suwayomi = { getSeries: vi.fn().mockImplementation(() => Promise.resolve({ title: 'T', units: [], ...series })) };
  const lncrawl = { getSeries: vi.fn().mockResolvedValue({ title: 'Novel', units: [], sourceId: null, language: null }) };
  const registry = new WebSerialsEngineRegistry(settings as never, suwayomi as never, lncrawl as never);
  return { registry, suwayomi, lncrawl, state };
}

describe('WebSerialsEngineRegistry requireConfig', () => {
  it('answers a translatable error code when the kind is not configured', async () => {
    const { registry } = build();
    (registry as never as { settings: { getEngineConfig: ReturnType<typeof vi.fn> } }).settings.getEngineConfig.mockResolvedValue(null);

    const error = await registry.requireConfig('novel').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      errorCode: 'WEB_SERIAL_KIND_UNAVAILABLE',
      errorMeta: { kind: 'novel' },
    });
  });
});

describe('WebSerialsEngineRegistry loadSeries', () => {
  it("repairs a source's capital after an apostrophe in the title", async () => {
    const { registry } = build(['source:11'], { title: "Frieren: Beyond Journey'S End", sourceId: '11', language: 'en' });

    await expect(registry.loadSeries('manga', '5')).resolves.toMatchObject({ title: "Frieren: Beyond Journey's End" });
  });

  it('scrapes a series once for the requests one preview fires together', async () => {
    const { registry, suwayomi } = build();

    await Promise.all([registry.loadSeries('manga', '5'), registry.loadSeries('manga', '5'), registry.loadSeries('manga', '5')]);
    await registry.loadSeries('manga', '5');

    expect(suwayomi.getSeries).toHaveBeenCalledTimes(1);
  });

  it('loads again after a settings or extension change', async () => {
    const { registry, suwayomi, state } = build();

    await registry.loadSeries('manga', '5');
    state.version += 1;
    await registry.loadSeries('manga', '5');

    expect(suwayomi.getSeries).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed load', async () => {
    const { registry, suwayomi } = build();
    suwayomi.getSeries.mockRejectedValueOnce(new Error('boom'));

    await expect(registry.loadSeries('manga', '5')).rejects.toThrow('boom');
    await expect(registry.loadSeries('manga', '5')).resolves.toMatchObject({ title: 'T' });
  });

  it('refuses a manga series from a source the admin has not enabled', async () => {
    const { registry } = build(['source:99']);

    await expect(registry.loadSeries('manga', '5')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses every series while the admin selection is empty', async () => {
    const { registry } = build([], { sourceId: '11', language: 'en' });

    await expect(registry.loadSeries('manga', '5')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not apply the manga source selection to novels', async () => {
    const { registry } = build(['example.com']);

    await expect(registry.loadSeries('novel', 'n1')).resolves.toMatchObject({ title: 'Novel' });
  });
});

describe('WebSerialsEngineRegistry LNReader novels', () => {
  const remoteId = (sourceId: string) => `${sourceId}:${Buffer.from('/novel/x').toString('base64url')}`;

  function buildNovel(allowedSources: string[]) {
    const settings = {
      catalogVersion: 1,
      getEngineConfig: vi.fn().mockResolvedValue({ engine: 'lnreader', connection: CONNECTION, allowedSources }),
    };
    const novelSources = { getSeries: vi.fn().mockResolvedValue({ title: 'Novel', units: [], sourceId: null, language: null }) };
    const registry = new WebSerialsEngineRegistry(settings as never, {} as never, {} as never, novelSources as never);
    return { registry, novelSources };
  }

  it('refuses a series from a site the admin disabled before asking the service', async () => {
    const { registry, novelSources } = buildNovel(['novelfire']);

    const error = await registry.loadSeries('novel', remoteId('novelbin')).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({ errorCode: 'WEB_SERIAL_SOURCE_DISABLED' });
    expect(novelSources.getSeries).not.toHaveBeenCalled();
    await expect(registry.loadSeries('novel', remoteId('novelfire'))).resolves.toMatchObject({ title: 'Novel' });
    await expect(registry.requireEnabledSource('novel', remoteId('novelbin'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(registry.requireEnabledSource('novel', remoteId('novelfire'))).resolves.toBeUndefined();
  });

  it('shares a still-loading answer between concurrent callers and never caches it', async () => {
    const { registry, novelSources } = buildNovel(['novelfire']);
    const loading = new ServiceUnavailableException({ message: 'The chapter list is still loading', errorCode: 'WEB_SERIAL_SERIES_LOADING' });
    novelSources.getSeries.mockRejectedValueOnce(loading);

    const results = await Promise.allSettled([
      registry.loadSeries('novel', remoteId('novelfire')),
      registry.loadSeries('novel', remoteId('novelfire')),
    ]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(novelSources.getSeries).toHaveBeenCalledTimes(1);
    await expect(registry.loadSeries('novel', remoteId('novelfire'))).resolves.toMatchObject({ title: 'Novel' });
    await registry.loadSeries('novel', remoteId('novelfire'));
    expect(novelSources.getSeries).toHaveBeenCalledTimes(2);
  });
});

describe('isSeriesSourceAllowed', () => {
  it('matches picked source ids exactly', () => {
    expect(isSeriesSourceAllowed({ sourceId: '11', language: 'en' }, ['source:11', 'source:12'])).toBe(true);
    expect(isSeriesSourceAllowed({ sourceId: '13', language: 'en' }, ['source:11', 'source:12'])).toBe(false);
  });

  it('falls back to languages, including a regional variant, while no sources were picked', () => {
    expect(isSeriesSourceAllowed({ sourceId: '1', language: 'pt-BR' }, ['pt'])).toBe(true);
    expect(isSeriesSourceAllowed({ sourceId: '1', language: 'es' }, ['en'])).toBe(false);
  });

  it('cannot judge a series that reports no source id and lets it through', () => {
    expect(isSeriesSourceAllowed({ sourceId: null, language: null }, ['source:11'])).toBe(true);
  });
});
