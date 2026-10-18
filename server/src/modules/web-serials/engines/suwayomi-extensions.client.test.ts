/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { safeFetch } from '../../../common/utils/safe-fetch';
import { SuwayomiExtensionsClient } from './suwayomi-extensions.client';
import { BASIC, conn, gql, installGraphql } from '../../../../test/support/web-serials/suwayomi-test-support';

vi.mock('../../../common/utils/safe-fetch', () => ({ safeFetch: vi.fn() }));
vi.mock('../../../common/utils/self-hosted-service-url.utils', () => ({
  ensureSafeSelfHostedUrl: vi.fn().mockResolvedValue(undefined),
  selfHostedSafeRemoteHostOptions: vi.fn().mockReturnValue({}),
}));

beforeEach(() => {
  vi.mocked(safeFetch).mockReset();
});

describe('SuwayomiExtensionsClient extension repositories', () => {
  it('lists repositories', async () => {
    const calls = installGraphql(() => gql({ extensionStores: { nodes: [{ indexUrl: 'https://example.com/index.pb' }] } }));

    await expect(new SuwayomiExtensionsClient().listExtensionRepos(conn)).resolves.toEqual(['https://example.com/index.pb']);
    expect(calls[0].query).toContain('extensionStores { nodes { indexUrl } }');
  });

  it('adds and removes repositories with escaped URLs', async () => {
    const calls = installGraphql(() => gql({ addExtensionStore: { clientMutationId: null }, removeExtensionStore: { clientMutationId: null } }));
    const client = new SuwayomiExtensionsClient();

    await client.addExtensionRepo(conn, 'https://example.com/"repo"');
    await client.removeExtensionRepo(conn, 'https://example.com/index.pb');

    expect(calls[0].query).toContain('addExtensionStore(input: { indexUrl: "https://example.com/\\"repo\\"" })');
    expect(calls[1].query).toContain('removeExtensionStore(input: { indexUrl: "https://example.com/index.pb" })');
  });
});

describe('SuwayomiExtensionsClient extension catalogue', () => {
  const extension = {
    pkgName: 'eu.kanade.tachiyomi.extension.en.alpha',
    name: 'Alpha',
    lang: 'en',
    versionName: '1.2.3',
    isInstalled: true,
    hasUpdate: false,
    contentWarning: null,
    iconUrl: '/api/v1/extension/icon/alpha',
    repo: 'https://example.com/index.pb',
  };

  it('refreshes the catalogue and returns its count', async () => {
    const calls = installGraphql((query) =>
      query.includes('BookOrbitRefreshExtensions') ? gql({ fetchExtensions: { clientMutationId: null } }) : gql({ extensions: { totalCount: 1433 } }),
    );

    await expect(new SuwayomiExtensionsClient().refreshExtensions(conn)).resolves.toBe(1433);
    expect(calls[0].query).toContain('fetchExtensions(input: {})');
    expect(calls[1].query).toContain('extensions(first: 1, offset: 0)');
  });

  it('pages installed extensions before available extensions and hides adult available entries', async () => {
    const calls = installGraphql((query) => {
      if (query.includes('isInstalled: true')) return gql({ extensions: { totalCount: 1, nodes: [extension] } });
      return gql({
        extensions: { totalCount: 8, nodes: [{ ...extension, pkgName: 'eu.kanade.tachiyomi.extension.en.beta', name: 'Beta', isInstalled: false }] },
      });
    });

    const result = await new SuwayomiExtensionsClient().listExtensions(conn, { query: 'a"b', lang: 'en', limit: 2, offset: 0 });

    expect(result.totalCount).toBe(9);
    expect(result.nodes.map((item) => item.name)).toEqual(['Alpha', 'Beta']);
    expect(calls[0].query).toContain('condition: { isInstalled: true, lang: "en" }');
    expect(calls[0].query).toContain('name: { includesInsensitive: "a\\"b" }');
    expect(calls[0].query).not.toContain('contentWarning: { isNull: true }');
    expect(calls[1].query).toContain('condition: { isInstalled: false, lang: "en" }');
    expect(calls[1].query).toContain('{ or: [{ contentWarning: { isNull: true } }, { contentWarning: { notEqualTo: NSFW } }] }');
  });

  it('honours explicit installed and adult filters in one engine request', async () => {
    const calls = installGraphql(() => gql({ extensions: { totalCount: 1, nodes: [extension] } }));

    await new SuwayomiExtensionsClient().listExtensions(conn, { installed: false, adult: true, limit: 50, offset: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('condition: { isInstalled: false }');
    expect(calls[0].query).not.toContain('contentWarning: { equalTo: SAFE }');
    expect(calls[0].query).toContain('first: 50, offset: 5, order: [{ by: NAME }]');
  });

  it('collects distinct languages from bounded pages', async () => {
    const calls = installGraphql((query) =>
      query.includes('offset: 0')
        ? gql({ extensions: { totalCount: 3, nodes: [{ lang: 'EN' }, { lang: 'ja' }] } })
        : gql({ extensions: { totalCount: 3, nodes: [{ lang: 'en' }] } }),
    );

    await expect(new SuwayomiExtensionsClient().listExtensionLanguages(conn)).resolves.toEqual(['en', 'ja']);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.query.includes('first: 100'))).toBe(true);
  });

  it.each(['install', 'uninstall', 'update'] as const)('updates an extension with the %s patch', async (action) => {
    const calls = installGraphql(() => gql({ updateExtension: { extension } }));

    await expect(new SuwayomiExtensionsClient().updateExtension(conn, extension.pkgName, action)).resolves.toEqual(extension);
    expect(calls[0].query).toContain(`patch: { ${action}: true }`);
    expect(calls[0].query).toContain(`id: "${extension.pkgName}"`);
  });

  it('finds source ids for one extension using bounded pages', async () => {
    const calls = installGraphql((query) =>
      query.includes('offset: 0')
        ? gql({
            sources: {
              totalCount: 3,
              nodes: [
                { id: '1', extension: { pkgName: extension.pkgName } },
                { id: '2', extension: { pkgName: 'other' } },
              ],
            },
          })
        : gql({ sources: { totalCount: 3, nodes: [{ id: '3', extension: { pkgName: extension.pkgName } }] } }),
    );

    await expect(new SuwayomiExtensionsClient().listExtensionSourceIds(conn, extension.pkgName)).resolves.toEqual(['1', '3']);
    expect(calls).toHaveLength(2);
    expect(calls[0].query).toContain('nodes { id extension { pkgName } }');
  });

  it('fetches an authenticated extension icon', async () => {
    const calls = installGraphql(() => gql({}));
    vi.mocked(safeFetch).mockImplementationOnce(async (rawUrl, init) => {
      calls.push({ method: 'GET', path: new URL(String(rawUrl)).pathname, headers: (init?.headers ?? {}) as Record<string, string>, query: '' });
      return new Response(Buffer.from('icon'), { headers: { 'content-type': 'image/png' } });
    });

    const icon = await new SuwayomiExtensionsClient().fetchExtensionIcon(conn, extension.pkgName);

    expect(icon).toEqual({ body: Buffer.from('icon'), contentType: 'image/png' });
    expect(calls[0].path).toBe(`/api/v1/extension/icon/${extension.pkgName}`);
    expect(calls[0].headers.Authorization).toBe(BASIC);
  });
});
