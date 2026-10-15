import { BadGatewayException, BadRequestException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { WebSerialsExtensionsService } from './web-serials-extensions.service';

const USER = { id: 42 } as RequestUser;
const CONNECTION = { url: 'http://suwayomi:4567', username: 'admin', password: 'secret' };
const EXTENSION = {
  pkgName: 'eu.kanade.tachiyomi.extension.en.alpha',
  name: 'Alpha',
  lang: 'en',
  versionName: '1.2.3',
  isInstalled: false,
  hasUpdate: false,
  contentWarning: 'SAFE' as 'SAFE' | 'MIXED' | 'NSFW' | null,
  iconUrl: '/api/v1/extension/icon/alpha',
  repo: 'https://example.com/index.pb',
};

function build(configured = true) {
  const settings = {
    getEngineConfig: vi.fn().mockResolvedValue(configured ? { connection: CONNECTION, allowedSources: [] } : null),
    bumpCatalogVersion: vi.fn(),
    refreshHealth: vi.fn().mockResolvedValue(undefined),
  };
  const repo = {
    getSettings: vi.fn().mockResolvedValue({ mangaSourceIds: ['1', '2', '3'] }),
    upsertSettings: vi.fn().mockResolvedValue({}),
  };
  const suwayomi = {
    listExtensions: vi.fn().mockResolvedValue({ nodes: [EXTENSION], totalCount: 1 }),
    listExtensionLanguages: vi.fn().mockResolvedValue(['en', 'ja']),
    refreshExtensions: vi.fn().mockResolvedValue(1433),
    listExtensionSourceIds: vi.fn().mockResolvedValue(['1', '3']),
    updateExtension: vi.fn().mockResolvedValue(EXTENSION),
    fetchExtensionIcon: vi.fn().mockResolvedValue({ body: Buffer.from('icon'), contentType: 'image/png' }),
    listExtensionRepos: vi.fn().mockResolvedValue(['https://example.com/index.pb']),
    addExtensionRepo: vi.fn().mockResolvedValue(undefined),
    removeExtensionRepo: vi.fn().mockResolvedValue(undefined),
  };
  const service = new WebSerialsExtensionsService(settings as never, repo as never, suwayomi as never);
  return { service, settings, repo, suwayomi };
}

describe('WebSerialsExtensionsService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a configured manga engine', async () => {
    await expect(build(false).service.listExtensions({}, USER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a catalogue page and applies defaults', async () => {
    const { service, suwayomi } = build();
    suwayomi.listExtensions.mockResolvedValue({ nodes: [{ ...EXTENSION, contentWarning: 'NSFW' }], totalCount: 1 });

    const page = await service.listExtensions({ query: 'alpha' }, USER);

    expect(suwayomi.listExtensions).toHaveBeenCalledWith(CONNECTION, { query: 'alpha', adult: false, limit: 50, offset: 0 });
    expect(page).toEqual({
      items: [
        {
          pkgName: EXTENSION.pkgName,
          name: 'Alpha',
          lang: 'en',
          versionName: '1.2.3',
          installed: false,
          hasUpdate: false,
          adult: true,
          iconUrl: `/api/v1/web-serials/admin/manga-extensions/${EXTENSION.pkgName}/icon`,
          repo: 'https://example.com/index.pb',
        },
      ],
      total: 1,
      languages: ['en', 'ja'],
    });
  });

  it('treats only NSFW extensions as adult, not mixed-content aggregators', async () => {
    const { service, suwayomi } = build();
    suwayomi.listExtensions.mockResolvedValue({
      nodes: [
        { ...EXTENSION, pkgName: 'a.mixed', contentWarning: 'MIXED' },
        { ...EXTENSION, pkgName: 'a.nsfw', contentWarning: 'NSFW' },
      ],
      totalCount: 2,
    });

    const page = await service.listExtensions({ adult: true }, USER);

    expect(page.items.map((item) => [item.pkgName, item.adult])).toEqual([
      ['a.mixed', false],
      ['a.nsfw', true],
    ]);
  });

  it('caches catalogue languages for repeated page requests', async () => {
    const { service, suwayomi } = build();

    await service.listExtensions({}, USER);
    await service.listExtensions({ offset: 50 }, USER);

    expect(suwayomi.listExtensions).toHaveBeenCalledTimes(2);
    expect(suwayomi.listExtensionLanguages).toHaveBeenCalledOnce();
  });

  it('returns a plain bad gateway when the catalogue fails', async () => {
    const { service, suwayomi } = build();
    suwayomi.listExtensions.mockRejectedValue(new Error('secret upstream details'));

    await expect(service.listExtensions({}, USER)).rejects.toMatchObject({
      constructor: BadGatewayException,
      message: 'The manga engine did not answer.',
    });
  });

  it('refreshes the catalogue and returns its total', async () => {
    const { service, suwayomi } = build();

    await expect(service.refreshExtensions(USER)).resolves.toEqual({ total: 1433 });
    expect(suwayomi.refreshExtensions).toHaveBeenCalledWith(CONNECTION);
  });

  it('installs and updates an extension', async () => {
    const { service, suwayomi } = build();
    suwayomi.updateExtension.mockResolvedValue({ ...EXTENSION, isInstalled: true });

    await expect(service.updateExtension(EXTENSION.pkgName, 'install', USER)).resolves.toMatchObject({ installed: true });
    await service.updateExtension(EXTENSION.pkgName, 'update', USER);

    expect(suwayomi.updateExtension).toHaveBeenNthCalledWith(1, CONNECTION, EXTENSION.pkgName, 'install');
    expect(suwayomi.updateExtension).toHaveBeenNthCalledWith(2, CONNECTION, EXTENSION.pkgName, 'update');
    expect(suwayomi.listExtensionSourceIds).not.toHaveBeenCalled();
  });

  it('re-checks the saved searchable count after an extension changes', async () => {
    const { service, settings } = build();

    await service.updateExtension(EXTENSION.pkgName, 'install', USER);

    expect(settings.refreshHealth).toHaveBeenCalledWith('manga');
  });

  it('removes an uninstalled extension source ids from the saved selection', async () => {
    const { service, repo, suwayomi } = build();

    await service.updateExtension(EXTENSION.pkgName, 'uninstall', USER);

    expect(suwayomi.listExtensionSourceIds).toHaveBeenCalledWith(CONNECTION, EXTENSION.pkgName);
    expect(suwayomi.updateExtension).toHaveBeenCalledWith(CONNECTION, EXTENSION.pkgName, 'uninstall');
    expect(repo.upsertSettings).toHaveBeenCalledWith({ mangaSourceIds: ['2'] });
  });

  it('does not create a source selection while uninstalling', async () => {
    const { service, repo } = build();
    repo.getSettings.mockResolvedValue({ mangaSourceIds: null });

    await service.updateExtension(EXTENSION.pkgName, 'uninstall', USER);

    expect(repo.upsertSettings).not.toHaveBeenCalled();
  });

  it('rejects an invalid package name before calling the engine', async () => {
    const { service, suwayomi } = build();

    await expect(service.updateExtension('bad-package!', 'install', USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(suwayomi.updateExtension).not.toHaveBeenCalled();
  });

  it('does not write start and end log lines for each icon on the hot path', async () => {
    const { service } = build();
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.getExtensionIcon(EXTENSION.pkgName, USER);

    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['install', (service: WebSerialsExtensionsService) => service.updateExtension(EXTENSION.pkgName, 'install', USER)],
    ['uninstall', (service: WebSerialsExtensionsService) => service.updateExtension(EXTENSION.pkgName, 'uninstall', USER)],
    ['update', (service: WebSerialsExtensionsService) => service.updateExtension(EXTENSION.pkgName, 'update', USER)],
    ['refresh', (service: WebSerialsExtensionsService) => service.refreshExtensions(USER)],
    ['add repo', (service: WebSerialsExtensionsService) => service.addRepo('https://example.com/index.json', USER)],
    ['remove repo', (service: WebSerialsExtensionsService) => service.removeRepo('https://example.com/index.json', USER)],
  ])('invalidates the search and source caches after %s', async (_name, act) => {
    const { service, settings } = build();

    await act(service);

    expect(settings.bumpCatalogVersion).toHaveBeenCalledTimes(1);
  });

  it('returns only supported image types for extension icons', async () => {
    const { service, suwayomi } = build();

    await expect(service.getExtensionIcon(EXTENSION.pkgName, USER)).resolves.toEqual({ body: Buffer.from('icon'), contentType: 'image/png' });
    suwayomi.fetchExtensionIcon.mockResolvedValue({ body: Buffer.from('<svg/>'), contentType: 'image/svg+xml' });
    await expect(service.getExtensionIcon(EXTENSION.pkgName, USER)).rejects.toThrow('The manga engine did not answer.');
  });

  it('lists, adds with a refresh, and removes repositories', async () => {
    const { service, suwayomi } = build();
    const url = 'https://example.com/index.pb';

    await expect(service.listRepos(USER)).resolves.toEqual([url]);
    await service.addRepo(url, USER);
    await service.removeRepo(url, USER);

    expect(suwayomi.addExtensionRepo).toHaveBeenCalledWith(CONNECTION, url);
    expect(suwayomi.refreshExtensions).toHaveBeenCalledWith(CONNECTION);
    expect(suwayomi.removeExtensionRepo).toHaveBeenCalledWith(CONNECTION, url);
  });

  it('rejects non-http repository URLs as bad requests', async () => {
    const { service, suwayomi } = build();

    await expect(service.addRepo('ftp://example.com/index.pb', USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(suwayomi.addExtensionRepo).not.toHaveBeenCalled();
  });

  it('maps repository engine errors to a plain bad gateway', async () => {
    const { service, suwayomi } = build();
    suwayomi.removeExtensionRepo.mockRejectedValue(new Error('private engine error'));

    await expect(service.removeRepo('https://example.com/index.pb', USER)).rejects.toThrow('The manga engine did not answer.');
  });
});
