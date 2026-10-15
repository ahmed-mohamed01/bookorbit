import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { Permission } from '@bookorbit/types';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { WebSerialsAdminController } from './web-serials-admin.controller';
import { WebSerialsExtensionsService } from './web-serials-extensions.service';
import { WebSerialsLookupService } from './lookup/web-serials-lookup.service';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { WebSerialsNovelSourcesService } from './web-serials-novel-sources.service';
import { WebSerialsNovelIndexFillerService } from './web-serials-novel-index-filler.service';

vi.mock('./web-serials-settings.service', () => ({ WebSerialsSettingsService: class {} }));
vi.mock('./lookup/web-serials-lookup.service', () => ({ WebSerialsLookupService: class {} }));
vi.mock('./web-serials-extensions.service', () => ({ WebSerialsExtensionsService: class {} }));
vi.mock('./web-serials-novel-sources.service', () => ({ WebSerialsNovelSourcesService: class {} }));
vi.mock('./web-serials-novel-index-filler.service', () => ({ WebSerialsNovelIndexFillerService: class {} }));

const USER = { id: 42 } as RequestUser;

async function setup() {
  const settingsService = {
    getSettings: vi.fn().mockResolvedValue({ maxConcurrentJobs: 2 }),
    updateSettings: vi.fn().mockResolvedValue({ maxConcurrentJobs: 3 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    listNovelSources: vi.fn().mockResolvedValue([]),
    listMangaSources: vi.fn().mockResolvedValue([]),
  };
  const lookupService = { test: vi.fn().mockResolvedValue({ ok: true }) };
  const extensionsService = {
    listExtensions: vi.fn().mockResolvedValue({ items: [], total: 0, languages: [] }),
    refreshExtensions: vi.fn().mockResolvedValue({ total: 0 }),
    updateExtension: vi.fn().mockResolvedValue({ pkgName: 'ext' }),
    getExtensionIcon: vi.fn().mockResolvedValue({ body: Buffer.from('icon'), contentType: 'image/png' }),
    listRepos: vi.fn().mockResolvedValue([]),
    addRepo: vi.fn().mockResolvedValue(undefined),
    removeRepo: vi.fn().mockResolvedValue(undefined),
  };
  const novelSourcesService = {
    available: vi.fn().mockResolvedValue([]),
    installed: vi.fn().mockResolvedValue([]),
    change: vi.fn().mockResolvedValue(undefined),
  };
  const indexFiller = {
    status: vi.fn().mockResolvedValue({ dailyBudget: 1500, sources: [], unavailable: false }),
    fillNow: vi.fn().mockResolvedValue({ dailyBudget: 1500, sources: [], unavailable: false }),
    rebuild: vi.fn().mockResolvedValue({ dailyBudget: 1500, sources: [], unavailable: false }),
  };
  const module = await Test.createTestingModule({
    controllers: [WebSerialsAdminController],
    providers: [
      { provide: WebSerialsSettingsService, useValue: settingsService },
      { provide: WebSerialsLookupService, useValue: lookupService },
      { provide: WebSerialsExtensionsService, useValue: extensionsService },
      { provide: WebSerialsNovelSourcesService, useValue: novelSourcesService },
      { provide: WebSerialsNovelIndexFillerService, useValue: indexFiller },
    ],
  }).compile();
  return { controller: module.get(WebSerialsAdminController), settingsService, lookupService, extensionsService, novelSourcesService, indexFiller };
}

describe('WebSerialsAdminController', () => {
  it('delegates every route to the settings service with the current user', async () => {
    const { controller, settingsService, lookupService, extensionsService, novelSourcesService } = await setup();
    const reply = {
      header: vi.fn(),
      type: vi.fn(),
      send: vi.fn(),
    };
    reply.header.mockReturnValue(reply);
    reply.type.mockReturnValue(reply);

    await controller.getSettings();
    await controller.updateSettings({ maxConcurrentJobs: 3 }, USER);
    await controller.testConnection({ kind: 'manga', url: 'http://m' }, USER);
    await controller.testLookup();
    await controller.listNovelSources();
    await controller.listAvailableNovelSources({ lang: 'English' });
    await controller.listInstalledNovelSources();
    await controller.installNovelSource({ id: 'source.a' }, USER);
    await controller.updateNovelSource({ id: 'source.a' }, USER);
    await controller.removeNovelSource({ id: 'source.a' }, USER);
    await controller.listMangaSources();
    await controller.listMangaExtensions({ query: 'alpha' }, USER);
    await controller.refreshMangaExtensions(USER);
    await controller.installMangaExtension({ pkgName: 'pkg.name' }, USER);
    await controller.uninstallMangaExtension({ pkgName: 'pkg.name' }, USER);
    await controller.updateMangaExtension({ pkgName: 'pkg.name' }, USER);
    await controller.getMangaExtensionIcon({ pkgName: 'pkg.name' }, USER, reply as never);
    await controller.listMangaRepos(USER);
    await controller.addMangaRepo({ url: 'https://example.com/index.pb' }, USER);
    await controller.removeMangaRepo({ url: 'https://example.com/index.pb' }, USER);

    expect(settingsService.updateSettings).toHaveBeenCalledWith({ maxConcurrentJobs: 3 }, USER);
    expect(settingsService.testConnection).toHaveBeenCalledWith(USER, { kind: 'manga', url: 'http://m' });
    expect(lookupService.test).toHaveBeenCalledOnce();
    expect(settingsService.listNovelSources).toHaveBeenCalledOnce();
    expect(novelSourcesService.available).toHaveBeenCalledWith('English');
    expect(novelSourcesService.installed).toHaveBeenCalledOnce();
    expect(novelSourcesService.change).toHaveBeenNthCalledWith(1, 'source.a', 'install', USER);
    expect(novelSourcesService.change).toHaveBeenNthCalledWith(2, 'source.a', 'update', USER);
    expect(novelSourcesService.change).toHaveBeenNthCalledWith(3, 'source.a', 'remove', USER);
    expect(settingsService.listMangaSources).toHaveBeenCalledOnce();
    expect(extensionsService.listExtensions).toHaveBeenCalledWith({ query: 'alpha' }, USER);
    expect(extensionsService.refreshExtensions).toHaveBeenCalledWith(USER);
    expect(extensionsService.updateExtension).toHaveBeenNthCalledWith(1, 'pkg.name', 'install', USER);
    expect(extensionsService.updateExtension).toHaveBeenNthCalledWith(2, 'pkg.name', 'uninstall', USER);
    expect(extensionsService.updateExtension).toHaveBeenNthCalledWith(3, 'pkg.name', 'update', USER);
    expect(extensionsService.getExtensionIcon).toHaveBeenCalledWith('pkg.name', USER);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, max-age=3600');
    expect(reply.header).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(reply.type).toHaveBeenCalledWith('image/png');
    expect(reply.send).toHaveBeenCalledWith(Buffer.from('icon'));
    expect(extensionsService.listRepos).toHaveBeenCalledWith(USER);
    expect(extensionsService.addRepo).toHaveBeenCalledWith('https://example.com/index.pb', USER);
    expect(extensionsService.removeRepo).toHaveBeenCalledWith('https://example.com/index.pb', USER);
  });

  it('passes the light novel index actions through with the source and the current user', async () => {
    const { controller, indexFiller } = await setup();

    await controller.getNovelIndex();
    await controller.fillNovelIndex({ id: 'novelbuddy' }, USER);
    await controller.rebuildNovelIndex({ id: 'novelbuddy' }, USER);

    expect(indexFiller.status).toHaveBeenCalledOnce();
    expect(indexFiller.fillNow).toHaveBeenCalledWith('novelbuddy', USER);
    expect(indexFiller.rebuild).toHaveBeenCalledWith('novelbuddy', USER);
  });

  it('mounts under web-serials/admin', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WebSerialsAdminController)).toBe('web-serials/admin');
  });

  it.each([
    ['getSettings', RequestMethod.GET, 'settings'],
    ['updateSettings', RequestMethod.PUT, 'settings'],
    ['testConnection', RequestMethod.POST, 'test'],
    ['testLookup', RequestMethod.POST, 'lookup/test'],
    ['listNovelSources', RequestMethod.GET, 'novel-sources'],
    ['listAvailableNovelSources', RequestMethod.GET, 'novel-source-catalog'],
    ['listInstalledNovelSources', RequestMethod.GET, 'novel-source-catalog/installed'],
    ['installNovelSource', RequestMethod.POST, 'novel-source-catalog/:id/install'],
    ['updateNovelSource', RequestMethod.POST, 'novel-source-catalog/:id/update'],
    ['removeNovelSource', RequestMethod.DELETE, 'novel-source-catalog/:id'],
    ['getNovelIndex', RequestMethod.GET, 'novel-index'],
    ['fillNovelIndex', RequestMethod.POST, 'novel-index/:id/fill'],
    ['rebuildNovelIndex', RequestMethod.POST, 'novel-index/:id/rebuild'],
    ['listMangaSources', RequestMethod.GET, 'manga-sources'],
    ['listMangaExtensions', RequestMethod.GET, 'manga-extensions'],
    ['refreshMangaExtensions', RequestMethod.POST, 'manga-extensions/refresh'],
    ['installMangaExtension', RequestMethod.POST, 'manga-extensions/:pkgName/install'],
    ['uninstallMangaExtension', RequestMethod.POST, 'manga-extensions/:pkgName/uninstall'],
    ['updateMangaExtension', RequestMethod.POST, 'manga-extensions/:pkgName/update'],
    ['getMangaExtensionIcon', RequestMethod.GET, 'manga-extensions/:pkgName/icon'],
    ['listMangaRepos', RequestMethod.GET, 'manga-repos'],
    ['addMangaRepo', RequestMethod.POST, 'manga-repos'],
    ['removeMangaRepo', RequestMethod.DELETE, 'manga-repos'],
  ] as const)('%s is routed and gated by ManageAppSettings', (name, method, path) => {
    const handler = WebSerialsAdminController.prototype[name];

    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe(Permission.ManageAppSettings);
  });

  it('answers the test route with 200', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.testConnection)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.testLookup)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.refreshMangaExtensions)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.installMangaExtension)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.uninstallMangaExtension)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.updateMangaExtension)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.addMangaRepo)).toBe(204);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.removeMangaRepo)).toBe(204);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.installNovelSource)).toBe(204);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.updateNovelSource)).toBe(204);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebSerialsAdminController.prototype.removeNovelSource)).toBe(204);
  });
});
