import { BadGatewayException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { WebSerialsNovelProvidersService } from './web-serials-novel-providers.service';

vi.mock('./web-serials-settings.service', () => ({ WebSerialsSettingsService: class {} }));

const USER = { id: 7 } as RequestUser;
const SOURCES = [
  { domain: 'royalroad.com', language: 'en', canSearch: true, disabled: false },
  { domain: 'scribblehub.com', language: 'en', canSearch: true, disabled: false },
  { domain: 'linkonly.example', language: 'en', canSearch: false, disabled: false },
  { domain: 'broken.example', language: 'en', canSearch: true, disabled: true },
];

function setup() {
  const repo = {
    getDisabledNovelDomains: vi.fn().mockResolvedValue([]),
    setDisabledNovelDomains: vi.fn().mockResolvedValue(undefined),
  };
  const settings = {
    catalogVersion: 1,
    getSettings: vi.fn().mockResolvedValue({ novel: { searchDomains: ['royalroad.com', 'scribblehub.com'] } }),
    listNovelSources: vi.fn().mockResolvedValue(SOURCES),
  };
  return { service: new WebSerialsNovelProvidersService(repo as never, settings as never), repo, settings };
}

describe('WebSerialsNovelProvidersService', () => {
  it('lists the admin domains with this user on/off and every working link site', async () => {
    const { service, repo } = setup();
    repo.getDisabledNovelDomains.mockResolvedValue(['scribblehub.com']);

    await expect(service.getProviders(USER)).resolves.toEqual({
      search: [
        { domain: 'royalroad.com', name: 'royalroad.com', enabled: true },
        { domain: 'scribblehub.com', name: 'scribblehub.com', enabled: false },
      ],
      linkSites: [
        { domain: 'royalroad.com', name: 'royalroad.com' },
        { domain: 'scribblehub.com', name: 'scribblehub.com' },
        { domain: 'linkonly.example', name: 'linkonly.example' },
      ],
      linkSitesTotal: 3,
      unavailable: false,
    });
    expect(repo.getDisabledNovelDomains).toHaveBeenCalledWith(7);
  });

  it('caches the link site list per catalog version', async () => {
    const { service, settings } = setup();

    await service.getProviders(USER);
    await service.getProviders(USER);
    expect(settings.listNovelSources).toHaveBeenCalledTimes(1);

    settings.catalogVersion = 2;
    await service.getProviders(USER);
    expect(settings.listNovelSources).toHaveBeenCalledTimes(2);
  });

  it('answers from settings with an unavailable flag when the novel engine cannot be reached, and retries next time', async () => {
    const { service, settings } = setup();
    settings.listNovelSources.mockRejectedValueOnce(new BadGatewayException('down'));

    await expect(service.getProviders(USER)).resolves.toMatchObject({
      search: [{ domain: 'royalroad.com' }, { domain: 'scribblehub.com' }],
      linkSites: [],
      linkSitesTotal: 0,
      unavailable: true,
    });
    await expect(service.getProviders(USER)).resolves.toMatchObject({ unavailable: false, linkSitesTotal: 3 });
  });

  it('saves the disabled list for this user only and returns the new state', async () => {
    const { service, repo } = setup();

    const result = await service.updateProviders(USER, { disabledDomains: ['royalroad.com'] });

    expect(repo.setDisabledNovelDomains).toHaveBeenCalledWith(7, ['royalroad.com']);
    expect(result.search).toEqual([
      { domain: 'royalroad.com', name: 'royalroad.com', enabled: false },
      { domain: 'scribblehub.com', name: 'scribblehub.com', enabled: true },
    ]);
  });

  it('drops domains the admin did not enable, normalizes case and removes duplicates', async () => {
    const { service, repo } = setup();

    await service.updateProviders(USER, { disabledDomains: [' RoyalRoad.com ', 'royalroad.com', 'linkonly.example', 'nope.example'] });

    expect(repo.setDisabledNovelDomains).toHaveBeenCalledWith(7, ['royalroad.com']);
  });

  it('can re-enable everything', async () => {
    const { service, repo } = setup();

    const result = await service.updateProviders(USER, { disabledDomains: [] });

    expect(repo.setDisabledNovelDomains).toHaveBeenCalledWith(7, []);
    expect(result.search.every((entry) => entry.enabled)).toBe(true);
  });

  it('preserves case-sensitive LNReader source ids in user preferences', async () => {
    const { service, repo, settings } = setup();
    settings.getSettings.mockResolvedValue({ novel: { engine: 'lnreader', sourceIds: ['Source.A'], searchDomains: [] } });

    await service.updateProviders(USER, { disabledDomains: [' Source.A ', 'source.a'] });

    expect(repo.setDisabledNovelDomains).toHaveBeenCalledWith(7, ['Source.A']);
  });
});
