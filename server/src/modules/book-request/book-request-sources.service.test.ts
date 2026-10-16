import { BadRequestException } from '@nestjs/common';
import type { IndexerAdapterType } from '@bookorbit/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedIndexerConfig } from './indexers/indexer-adapter';
import { BookRequestSourcesService } from './book-request-sources.service';

function config(overrides: Partial<ResolvedIndexerConfig> = {}): ResolvedIndexerConfig {
  return {
    id: 1,
    managerId: null,
    managerPriority: null,
    name: 'Source',
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

function makeService(configs: ResolvedIndexerConfig[] = []) {
  const indexers = { resolveEnabledConfigs: vi.fn().mockResolvedValue(configs) };
  const adapters = {
    torznab: { mediaKinds: ['ebook', 'audiobook'] },
    'ebook-only': { mediaKinds: ['ebook'] },
  };
  const registry = {
    find: vi.fn((adapterType: keyof typeof adapters) => adapters[adapterType]),
    delivery: vi.fn((adapterType: string) => (adapterType === 'ebook-only' ? 'file' : 'torrent')),
  };
  return { service: new BookRequestSourcesService(indexers as never, registry as never), indexers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BookRequestSourcesService', () => {
  it('lists enabled sources in name order with only the media each source carries', async () => {
    const ebookOnly = 'ebook-only' as IndexerAdapterType;
    const { service } = makeService([
      config({ id: 2, name: 'Zed', disabledMediaKinds: ['audiobook'] }),
      config({ id: 1, name: 'Alpha', adapterType: ebookOnly }),
    ]);

    await expect(service.list()).resolves.toEqual([
      { id: 1, name: 'Alpha', delivery: 'file', mediaKinds: ['ebook'] },
      { id: 2, name: 'Zed', delivery: 'torrent', mediaKinds: ['ebook'] },
    ]);
  });

  it('accepts requestable ids and rejects missing or incompatible ids', async () => {
    const { service } = makeService([config({ id: 4, disabledMediaKinds: ['audiobook'] })]);

    await expect(service.assertRequestable([4], 'ebook')).resolves.toBeUndefined();
    await expect(service.assertRequestable([4], 'audiobook')).rejects.toEqual(new BadRequestException('Choose sources that search for audiobooks'));
    await expect(service.assertRequestable([9], 'ebook')).rejects.toEqual(new BadRequestException('Choose sources that search for ebooks'));
  });

  it('does not read source configuration for a null or omitted selection', async () => {
    const { service, indexers } = makeService([config()]);

    await expect(service.assertRequestable(null, 'ebook')).resolves.toBeUndefined();
    await expect(service.assertRequestable(undefined, 'audiobook')).resolves.toBeUndefined();
    expect(indexers.resolveEnabledConfigs).not.toHaveBeenCalled();
  });

  it('shares one source read between concurrent callers', async () => {
    let resolveConfigs!: (configs: ResolvedIndexerConfig[]) => void;
    const pending = new Promise<ResolvedIndexerConfig[]>((resolve) => {
      resolveConfigs = resolve;
    });
    const indexers = { resolveEnabledConfigs: vi.fn().mockReturnValue(pending) };
    const registry = { find: vi.fn().mockReturnValue({ mediaKinds: ['ebook', 'audiobook'] }), delivery: vi.fn().mockReturnValue('torrent') };
    const service = new BookRequestSourcesService(indexers as never, registry as never);

    const first = service.list();
    const second = service.list();
    expect(indexers.resolveEnabledConfigs).toHaveBeenCalledTimes(1);
    resolveConfigs([config()]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ id: 1, name: 'Source', delivery: 'torrent', mediaKinds: ['ebook', 'audiobook'] }],
      [{ id: 1, name: 'Source', delivery: 'torrent', mediaKinds: ['ebook', 'audiobook'] }],
    ]);
  });

  it('reads source configuration again after five seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { service, indexers } = makeService([config()]);

    await service.list();
    await service.list();
    expect(indexers.resolveEnabledConfigs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await service.list();
    expect(indexers.resolveEnabledConfigs).toHaveBeenCalledTimes(2);
  });
});
