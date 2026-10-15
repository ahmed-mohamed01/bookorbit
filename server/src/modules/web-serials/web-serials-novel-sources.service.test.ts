import { BadGatewayException, Logger } from '@nestjs/common';

import { EngineCredentialsRejectedException } from './engines/engine-http.utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebSerialsNovelSourcesService } from './web-serials-novel-sources.service';

vi.mock('./web-serials-settings.service', () => ({ WebSerialsSettingsService: class {} }));

function build() {
  const settings = {
    getNovelEngineConfig: vi.fn().mockResolvedValue({ connection: { url: 'http://novel-sources:8282' } }),
    bumpCatalogVersion: vi.fn(),
    refreshHealth: vi.fn().mockResolvedValue(undefined),
  };
  const repo = {
    removeNovelSourceId: vi.fn().mockResolvedValue(undefined),
    addNovelSourceId: vi.fn().mockResolvedValue(undefined),
    deleteNovelIndexSources: vi.fn().mockResolvedValue(3),
  };
  const client = {
    updateSource: vi.fn().mockResolvedValue(undefined),
    listInstalled: vi.fn().mockResolvedValue([]),
    listAvailable: vi.fn().mockResolvedValue([]),
  };
  return { service: new WebSerialsNovelSourcesService(settings as never, repo as never, repo as never, client as never), repo, client };
}

afterEach(() => vi.restoreAllMocks());

describe('WebSerialsNovelSourcesService', () => {
  it('drops a removed source from the selection and from the light novel index', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, repo } = build();

    await service.change('novelbuddy', 'remove', { id: 1 } as never);
    await service.change('novelbuddy', 'install', { id: 1 } as never);

    expect(repo.removeNovelSourceId).toHaveBeenCalledWith('novelbuddy');
    expect(repo.deleteNovelIndexSources).toHaveBeenCalledTimes(1);
    expect(repo.deleteNovelIndexSources).toHaveBeenCalledWith(['novelbuddy']);
    expect(repo.addNovelSourceId).toHaveBeenCalledWith('novelbuddy');
  });

  it('keeps the code of a coded failure, so rejected credentials never read as a generic engine error', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, client } = build();
    const codeOf = (error: unknown) => ((error as BadGatewayException).getResponse() as { errorCode?: string }).errorCode;

    client.updateSource.mockRejectedValueOnce(new EngineCredentialsRejectedException());
    expect(codeOf(await service.change('a', 'install', { id: 1 } as never).catch((error: unknown) => error))).toBe(
      'WEB_SERIAL_ENGINE_CREDENTIALS_REJECTED',
    );

    client.updateSource.mockRejectedValueOnce(new Error('socket hang up'));
    expect(codeOf(await service.change('a', 'install', { id: 1 } as never).catch((error: unknown) => error))).toBe('WEB_SERIAL_ENGINE_ERROR');
  });

  it('passes a plugin that failed to load through as broken, and every other source as not broken', async () => {
    const { service, client } = build();
    const source = { id: 'a', name: 'A', site: 'https://a.test', lang: 'English', version: '1.0.0', installed: true };
    client.listInstalled.mockResolvedValue([
      { ...source, broken: true },
      { ...source, id: 'b' },
    ]);
    client.listAvailable.mockResolvedValue([source]);

    expect((await service.installed()).map((entry) => [entry.id, entry.broken])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect((await service.available('English'))[0]!.broken).toBe(false);
  });
});
