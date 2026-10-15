import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { WebSerialsSecretService } from './web-serials-secret.service';
import { WebSerialsSettingsService } from './web-serials-settings.service';

vi.mock('./engines/suwayomi.client', () => ({ SuwayomiClient: class {} }));
vi.mock('./engines/lncrawl.client', () => ({ LncrawlClient: class {} }));
vi.mock('./engines/novel-sources.client', () => ({ NovelSourcesClient: class {} }));
vi.mock('./web-serials-url.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./web-serials-url.utils')>()),
  ensureSafeEngineUrl: vi.fn().mockResolvedValue(undefined),
}));

const ADMIN = { id: 1, isSuperuser: true } as RequestUser;
const HEALTH = { ok: true, checkedAt: '2026-10-13T00:00:00.000Z', version: '1.0', searchableSources: 4, error: null };

const secrets = new WebSerialsSecretService({ encryptionKey: 'k' });

function build(row: Record<string, unknown> | undefined = undefined) {
  const repo = {
    getSettings: vi.fn().mockResolvedValue(row),
    upsertSettings: vi.fn().mockResolvedValue({}),
    recordCheck: vi.fn().mockResolvedValue(undefined),
    findLibraryFolders: vi.fn().mockResolvedValue([{ id: 5, path: '/lib' }]),
  };
  const libraryService = {
    verifyUserAccess: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn().mockResolvedValue({ allowedFormats: [] }),
  };
  const suwayomi = { health: vi.fn().mockResolvedValue(HEALTH), listSources: vi.fn().mockResolvedValue([]) };
  const lncrawl = { health: vi.fn().mockResolvedValue(HEALTH), listSources: vi.fn().mockResolvedValue([]) };
  const novelSources = { health: vi.fn().mockResolvedValue(HEALTH), listInstalled: vi.fn().mockResolvedValue([]) };
  const service = new WebSerialsSettingsService(
    repo as never,
    secrets,
    libraryService as never,
    suwayomi as never,
    lncrawl as never,
    novelSources as never,
  );
  return { service, repo, libraryService, suwayomi, lncrawl, novelSources };
}

describe('WebSerialsSettingsService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSettings', () => {
    it('answers defaults before anything is saved', async () => {
      const { service } = build();

      await expect(service.getSettings()).resolves.toEqual({
        manga: {
          url: null,
          username: null,
          passwordConfigured: false,
          lastCheck: null,
          sourceIds: null,
          languages: ['en'],
          targetLibraryId: null,
          targetFolderId: null,
        },
        novel: {
          engine: 'lnreader',
          url: null,
          username: null,
          passwordConfigured: false,
          lastCheck: null,
          searchDomains: [],
          sourceIds: [],
          targetLibraryId: null,
          targetFolderId: null,
          defaultPackaging: 'volume',
          indexDailyBudget: 1500,
        },
        maxConcurrentJobs: 2,
        lookup: { enabled: true, lastCheck: null },
      });
    });

    it('returns the picked manga source ids', async () => {
      const { service } = build({ mangaSourceIds: ['1', '2'] });
      expect((await service.getSettings()).manga.sourceIds).toEqual(['1', '2']);
    });

    it('never returns the stored password, only whether one exists', async () => {
      const { service } = build({ mangaUrl: 'http://m', mangaUsername: 'u', mangaPasswordEnc: secrets.encrypt('pw'), mangaLanguages: ['en', 'ja'] });

      const settings = await service.getSettings();

      expect(settings.manga.passwordConfigured).toBe(true);
      expect(JSON.stringify(settings)).not.toContain('pw');
      expect(JSON.stringify(settings)).not.toContain('v1:');
      expect(settings.manga.languages).toEqual(['en', 'ja']);
    });

    it('keeps an existing lncrawl profile selected and redacts an LNReader token', async () => {
      const legacy = await build({ novelUrl: 'http://lncrawl:8181' }).service.getSettings();
      expect(legacy.novel.engine).toBe('lncrawl');

      const settings = await build({
        novelEngine: 'lnreader',
        novelSourcesUrl: 'http://novel-sources:8282',
        novelSourcesTokenEnc: secrets.encrypt('token-value'),
        novelSourceIds: ['a'],
      }).service.getSettings();
      expect(settings.novel).toMatchObject({ engine: 'lnreader', passwordConfigured: true, sourceIds: ['a'] });
      expect(JSON.stringify(settings)).not.toContain('token-value');
    });

    it('returns the saved lookup toggle and health', async () => {
      const lastCheck = { ok: false, checkedAt: '2026-10-13T00:00:00.000Z', error: 'Unavailable', pausedUntil: null };
      const { service } = build({ lookupEnabled: false, lookupLastCheck: lastCheck });

      await expect(service.getSettings()).resolves.toMatchObject({ lookup: { enabled: false, lastCheck } });
    });
  });

  describe('catalogVersion', () => {
    it('changes after every settings update so dependent caches are dropped', async () => {
      const { service } = build();
      const before = service.catalogVersion;

      await service.updateSettings({ maxConcurrentJobs: 3 }, ADMIN);

      expect(service.catalogVersion).toBe(before + 1);
    });
  });

  describe('updateSettings', () => {
    it('normalizes the url, encrypts the password and normalizes lists', async () => {
      const { service, repo } = build();

      await service.updateSettings(
        {
          novel: {
            engine: 'lncrawl',
            url: ' http://lncrawl:8181/ ',
            username: ' admin ',
            password: 'secret',
            searchDomains: [' NovelBuddy.com ', 'novelbuddy.com', ''],
            defaultPackaging: 'series',
            indexDailyBudget: 400,
          },
        },
        ADMIN,
      );

      const data = repo.upsertSettings.mock.calls[0]![0];
      expect(data).toMatchObject({
        novelUrl: 'http://lncrawl:8181',
        novelUsername: 'admin',
        novelSearchDomains: ['novelbuddy.com'],
        novelDefaultPackaging: 'series',
        novelIndexDailyBudget: 400,
      });
      expect(data.novelPasswordEnc).not.toBe('secret');
      expect(secrets.decrypt(data.novelPasswordEnc)).toBe('secret');
      expect(data).not.toHaveProperty('mangaUrl');
    });

    it('stores the LNReader profile separately and keeps source ids case-sensitive', async () => {
      const { service, repo } = build();

      await service.updateSettings(
        { novel: { engine: 'lnreader', url: 'http://novel-sources:8282', password: 'token', sourceIds: ['Source.A', 'Source.A', 'source.b'] } },
        ADMIN,
      );

      const data = repo.upsertSettings.mock.calls[0]![0];
      expect(data).toMatchObject({
        novelEngine: 'lnreader',
        novelSourcesUrl: 'http://novel-sources:8282',
        novelSourceIds: ['Source.A', 'source.b'],
      });
      expect(secrets.decrypt(data.novelSourcesTokenEnc)).toBe('token');
      expect(data).not.toHaveProperty('novelUrl');
    });

    it('re-checks the connection when the source selection changes so search turns on', async () => {
      const { service, suwayomi, repo } = build({
        mangaUrl: 'http://m',
        mangaLastCheck: { ok: true, searchableSources: 0 },
        mangaSourceIds: [],
      });
      repo.upsertSettings.mockImplementation((data: Record<string, unknown>) => {
        repo.getSettings.mockResolvedValue({ mangaUrl: 'http://m', mangaLastCheck: { ok: true, searchableSources: 0 }, ...data });
        return Promise.resolve({});
      });

      await service.updateSettings({ manga: { sourceIds: ['1'] } }, ADMIN);

      expect(suwayomi.health).toHaveBeenCalledWith({ url: 'http://m', username: null, password: null }, ['source:1']);
      expect(repo.recordCheck).toHaveBeenCalledWith('manga', HEALTH, 'http://m');
    });

    it('does not re-check when nothing about the selection changed', async () => {
      const { service, suwayomi } = build({ mangaUrl: 'http://m', mangaLastCheck: { ok: true, searchableSources: 1 } });

      await service.updateSettings({ maxConcurrentJobs: 3 }, ADMIN);

      expect(suwayomi.health).not.toHaveBeenCalled();
    });

    it('rejects a url that is not http(s)', async () => {
      const { service, repo } = build();

      await expect(service.updateSettings({ manga: { url: 'ftp://x' } }, ADMIN)).rejects.toThrow(BadRequestException);
      expect(repo.upsertSettings).not.toHaveBeenCalled();
    });

    it('clears the url with an empty string', async () => {
      const { service, repo } = build({ mangaUrl: 'http://old', mangaPasswordEnc: 'x' });

      await service.updateSettings({ manga: { url: '' } }, ADMIN);

      expect(repo.upsertSettings.mock.calls[0]![0]).toMatchObject({ mangaUrl: null, mangaPasswordEnc: null, mangaLastCheck: null });
    });

    it('drops the stored password and last check when the url changes', async () => {
      const { service, repo } = build({ mangaUrl: 'http://old', mangaPasswordEnc: secrets.encrypt('pw') });

      await service.updateSettings({ manga: { url: 'http://new' } }, ADMIN);

      expect(repo.upsertSettings.mock.calls[0]![0]).toMatchObject({ mangaUrl: 'http://new', mangaPasswordEnc: null, mangaLastCheck: null });
    });

    it('keeps the stored password and last check when the url is unchanged', async () => {
      const { service, repo } = build({ mangaUrl: 'http://same', mangaPasswordEnc: 'enc' });

      await service.updateSettings({ manga: { url: 'http://same/', username: 'bob' } }, ADMIN);

      const data = repo.upsertSettings.mock.calls[0]![0];
      expect(data).toMatchObject({ mangaUsername: 'bob' });
      expect(data).not.toHaveProperty('mangaPasswordEnc');
      expect(data).not.toHaveProperty('mangaLastCheck');
    });

    it('clears the password when sent empty', async () => {
      const { service, repo } = build({ mangaUrl: 'http://same', mangaPasswordEnc: 'enc' });

      await service.updateSettings({ manga: { password: '' } }, ADMIN);

      expect(repo.upsertSettings.mock.calls[0]![0]).toMatchObject({ mangaPasswordEnc: null });
    });

    it('validates the target library for the engine and resets the folder with it', async () => {
      const { service, repo, libraryService } = build();

      await service.updateSettings({ manga: { targetLibraryId: 3 } }, ADMIN);

      expect(libraryService.verifyUserAccess).toHaveBeenCalledWith(1, 3, true);
      expect(repo.upsertSettings.mock.calls[0]![0]).toMatchObject({ mangaTargetLibraryId: 3, mangaTargetFolderId: null });
    });

    it('rejects a manga target library that disallows cbz and a novel one that disallows epub', async () => {
      const { service, libraryService } = build();
      libraryService.findOne.mockResolvedValue({ allowedFormats: ['epub'] });

      await expect(service.updateSettings({ manga: { targetLibraryId: 3 } }, ADMIN)).rejects.toThrow('cbz');
      await expect(service.updateSettings({ novel: { targetLibraryId: 3 } }, ADMIN)).resolves.toBeDefined();
      libraryService.findOne.mockResolvedValue({ allowedFormats: ['cbz'] });
      await expect(service.updateSettings({ novel: { targetLibraryId: 3 } }, ADMIN)).rejects.toThrow('epub');
    });

    it('rejects a folder outside the library and a folder without a library', async () => {
      const { service } = build();

      await expect(service.updateSettings({ novel: { targetLibraryId: 3, targetFolderId: 99 } }, ADMIN)).rejects.toThrow(BadRequestException);
      await expect(service.updateSettings({ novel: { targetFolderId: 5 } }, ADMIN)).rejects.toThrow('target library is required');
    });

    it('accepts a folder of the existing library and allows clearing the library', async () => {
      const { service, repo } = build({ novelTargetLibraryId: 3 });

      await service.updateSettings({ novel: { targetFolderId: 5 } }, ADMIN);
      expect(repo.upsertSettings.mock.calls[0]![0]).toMatchObject({ novelTargetFolderId: 5 });

      await service.updateSettings({ novel: { targetLibraryId: null } }, ADMIN);
      expect(repo.upsertSettings.mock.calls[1]![0]).toMatchObject({ novelTargetLibraryId: null, novelTargetFolderId: null });
    });

    it('propagates a library access refusal and a missing library', async () => {
      const { service, libraryService } = build();
      libraryService.verifyUserAccess.mockRejectedValueOnce(new ForbiddenException());
      await expect(service.updateSettings({ manga: { targetLibraryId: 3 } }, ADMIN)).rejects.toThrow(ForbiddenException);

      libraryService.findOne.mockRejectedValueOnce(new NotFoundException());
      await expect(service.updateSettings({ manga: { targetLibraryId: 3 } }, ADMIN)).rejects.toThrow(NotFoundException);
    });

    it('stores the concurrency limit', async () => {
      const { service, repo } = build();

      await service.updateSettings({ maxConcurrentJobs: 4 }, ADMIN);

      expect(repo.upsertSettings.mock.calls[0]![0]).toEqual({ maxConcurrentJobs: 4 });
    });

    it('stores the lookup toggle', async () => {
      const { service, repo } = build({ lookupEnabled: true });

      await service.updateSettings({ lookup: { enabled: false } }, ADMIN);

      expect(repo.upsertSettings.mock.calls[0]![0]).toEqual({ lookupEnabled: false });
    });
  });

  describe('getEngineConfig', () => {
    it('is null until a url is saved', async () => {
      await expect(build().service.getEngineConfig('manga')).resolves.toBeNull();
    });

    it('decrypts the password and returns the per-kind allow-list', async () => {
      const { service } = build({
        mangaUrl: 'http://m',
        mangaUsername: 'u',
        mangaPasswordEnc: secrets.encrypt('pw'),
        mangaLanguages: ['ja'],
        novelUrl: 'http://n',
        novelSearchDomains: ['a.com'],
        novelTargetLibraryId: 2,
      });

      await expect(service.getEngineConfig('manga')).resolves.toMatchObject({
        connection: { url: 'http://m', username: 'u', password: 'pw' },
        allowedSources: ['ja'],
      });
      await expect(service.getEngineConfig('novel')).resolves.toMatchObject({
        connection: { url: 'http://n', username: null, password: null },
        allowedSources: ['a.com'],
        targetLibraryId: 2,
      });
    });
  });

  describe('manga source selection', () => {
    it('saves de-duplicated source ids, including an empty selection', async () => {
      const { service, repo } = build();

      await service.updateSettings({ manga: { sourceIds: ['1', '2', '1'] } }, ADMIN);
      expect(repo.upsertSettings.mock.calls[0]![0]).toMatchObject({ mangaSourceIds: ['1', '2'] });

      await service.updateSettings({ manga: { sourceIds: [] } }, ADMIN);
      expect(repo.upsertSettings.mock.calls[1]![0]).toMatchObject({ mangaSourceIds: [] });
    });

    it('leaves the stored selection alone when sourceIds is omitted', async () => {
      const { service, repo } = build();
      await service.updateSettings({ manga: { languages: ['en'] } }, ADMIN);
      expect(repo.upsertSettings.mock.calls[0]![0]).not.toHaveProperty('mangaSourceIds');
    });

    it('passes source ids instead of languages to search and health once sources are picked', async () => {
      const { service, suwayomi } = build({
        mangaUrl: 'http://m',
        mangaUsername: 'u',
        mangaPasswordEnc: secrets.encrypt('pw'),
        mangaLanguages: ['en'],
        mangaSourceIds: ['7', '8'],
      });

      await expect(service.getEngineConfig('manga')).resolves.toMatchObject({ allowedSources: ['source:7', 'source:8'] });
      await service.testConnection(ADMIN, { kind: 'manga' });
      expect(suwayomi.health).toHaveBeenCalledWith(expect.anything(), ['source:7', 'source:8']);
    });

    it('passes no sources at all for an empty selection', async () => {
      const { service } = build({ mangaUrl: 'http://m', mangaLanguages: ['en'], mangaSourceIds: [] });
      await expect(service.getEngineConfig('manga')).resolves.toMatchObject({ allowedSources: [] });
    });
  });

  describe('testConnection', () => {
    const saved = { mangaUrl: 'http://m', mangaUsername: 'u', mangaPasswordEnc: secrets.encrypt('stored-pw'), mangaLanguages: ['en'] };

    it('tests the saved connection with the stored password and persists the result', async () => {
      const { service, repo, suwayomi } = build(saved);

      await expect(service.testConnection(ADMIN, { kind: 'manga' })).resolves.toEqual(HEALTH);

      expect(suwayomi.health).toHaveBeenCalledWith({ url: 'http://m', username: 'u', password: 'stored-pw' }, ['en']);
      expect(repo.recordCheck).toHaveBeenCalledWith('manga', HEALTH, 'http://m');
    });

    it('uses the novel client and domains for novels', async () => {
      const { service, lncrawl, suwayomi } = build({
        novelUrl: 'http://n',
        novelUsername: 'a',
        novelPasswordEnc: secrets.encrypt('p'),
        novelSearchDomains: ['x.com'],
      });

      await service.testConnection(ADMIN, { kind: 'novel' });

      expect(lncrawl.health).toHaveBeenCalledWith({ url: 'http://n', username: 'a', password: 'p' }, ['x.com']);
      expect(suwayomi.health).not.toHaveBeenCalled();
    });

    it('tests an LNReader draft with its token and source ids', async () => {
      const { service, novelSources, lncrawl } = build({ novelSourceIds: ['a'] });

      await service.testConnection(ADMIN, { kind: 'novel', engine: 'lnreader', url: 'http://novel-sources:8282', password: 'token' });

      expect(novelSources.health).toHaveBeenCalledWith({ url: 'http://novel-sources:8282', username: null, password: 'token' }, ['a']);
      expect(lncrawl.health).not.toHaveBeenCalled();
    });

    it('does not persist a draft that changes the credentials', async () => {
      const { service, repo, suwayomi } = build(saved);

      await service.testConnection(ADMIN, { kind: 'manga', username: 'other', password: 'typed' });

      expect(suwayomi.health).toHaveBeenCalledWith({ url: 'http://m', username: 'other', password: 'typed' }, ['en']);
      expect(repo.recordCheck).not.toHaveBeenCalled();
    });

    it('never sends the stored password to an unsaved address', async () => {
      const { service, suwayomi, repo } = build(saved);

      const result = await service.testConnection(ADMIN, { kind: 'manga', url: 'http://evil.example.com' });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('password');
      expect(suwayomi.health).not.toHaveBeenCalled();
      expect(repo.recordCheck).not.toHaveBeenCalled();
    });

    it('tests an unsaved address with the typed password', async () => {
      const { service, suwayomi, repo } = build(saved);

      await service.testConnection(ADMIN, { kind: 'manga', url: 'http://new:4567/', password: 'typed' });

      expect(suwayomi.health).toHaveBeenCalledWith({ url: 'http://new:4567', username: 'u', password: 'typed' }, ['en']);
      expect(repo.recordCheck).not.toHaveBeenCalled();
    });

    it('reports an unparseable address and an unconfigured engine without calling the engine', async () => {
      const { service, suwayomi } = build();

      await expect(service.testConnection(ADMIN, { kind: 'manga', url: 'ftp://x' })).resolves.toMatchObject({
        ok: false,
        error: 'The address must be a valid http or https URL',
      });
      await expect(service.testConnection(ADMIN, { kind: 'novel' })).resolves.toMatchObject({
        ok: false,
        error: 'Novel connection is not configured',
      });
      expect(suwayomi.health).not.toHaveBeenCalled();
    });

    it('turns an engine failure into a failed health and records it for the saved connection', async () => {
      const { service, repo, suwayomi } = build(saved);
      suwayomi.health.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const result = await service.testConnection(ADMIN, { kind: 'manga' });

      expect(result).toMatchObject({ ok: false, version: null, searchableSources: 0, error: 'connect ECONNREFUSED' });
      expect(repo.recordCheck).toHaveBeenCalledWith('manga', result, 'http://m');
    });

    it('reports an undecryptable stored password', async () => {
      const { service } = build({ ...saved, mangaPasswordEnc: 'v1:bad:bad:bad' });

      const result = await service.testConnection(ADMIN, { kind: 'manga' });

      expect(result.error).toBe('Stored password could not be decrypted');
      expect(InternalServerErrorException).toBeDefined();
    });
  });

  describe('listNovelSources', () => {
    it('requires a configured novel connection', async () => {
      await expect(build().service.listNovelSources()).rejects.toThrow(BadRequestException);
    });

    it('returns the engine sources sorted by domain', async () => {
      const { service, lncrawl } = build({ novelUrl: 'http://n' });
      lncrawl.listSources.mockResolvedValue([
        { domain: 'b.com', language: 'en', canSearch: true, disabled: false },
        { domain: 'a.com', language: 'fr', canSearch: false, disabled: false },
      ]);

      const sources = await service.listNovelSources();

      expect(sources.map((s) => s.domain)).toEqual(['a.com', 'b.com']);
      expect(lncrawl.listSources).toHaveBeenCalledWith({ url: 'http://n', username: null, password: null });
    });

    it('hides the engine error behind a bad gateway', async () => {
      const { service, lncrawl } = build({ novelUrl: 'http://n' });
      lncrawl.listSources.mockRejectedValue(new Error('secret internals'));

      await expect(service.listNovelSources()).rejects.toThrow(BadGatewayException);
    });
  });

  describe('listMangaSources', () => {
    it('requires a configured manga connection', async () => {
      await expect(build().service.listMangaSources()).rejects.toThrow(BadRequestException);
    });

    it('returns the engine sources sorted by language then name', async () => {
      const { service, suwayomi } = build({ mangaUrl: 'http://m' });
      suwayomi.listSources.mockResolvedValue([
        { id: '3', name: 'Zed', lang: 'en', nsfw: false },
        { id: '2', name: 'Alpha', lang: 'ja', nsfw: false },
        { id: '1', name: 'Beta', lang: 'en', nsfw: true },
      ]);

      const sources = await service.listMangaSources();

      expect(sources.map((s) => s.id)).toEqual(['1', '3', '2']);
      expect(suwayomi.listSources).toHaveBeenCalledWith({ url: 'http://m', username: null, password: null });
    });

    it('hides the engine error behind a bad gateway', async () => {
      const { service, suwayomi } = build({ mangaUrl: 'http://m' });
      suwayomi.listSources.mockRejectedValue(new Error('secret internals'));

      await expect(service.listMangaSources()).rejects.toThrow(BadGatewayException);
    });
  });
});
