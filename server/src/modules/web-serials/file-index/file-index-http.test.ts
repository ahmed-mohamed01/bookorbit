import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EngineCredentialsRejectedException } from '../engines/engine-http.utils';
import { assertFileIndexOk, fetchFileIndex } from './file-index-http';

const safeFetch = vi.hoisted(() => vi.fn());
const ensureSafe = vi.hoisted(() => vi.fn());
vi.mock('../../../common/utils/safe-fetch', () => ({ safeFetch }));
vi.mock('../../../common/utils/self-hosted-service-url.utils', () => ({
  ensureSafeSelfHostedUrl: ensureSafe,
  selfHostedSafeRemoteHostOptions: () => ({ allowLocal: true, allowPrivate: true, blockLinkLocal: true }),
}));

const signal = new AbortController().signal;

function redirect(location: string | null): Response {
  return new Response(null, { status: 302, headers: location ? { location } : {} });
}

describe('fetchFileIndex', () => {
  beforeEach(() => {
    safeFetch.mockReset();
    ensureSafe.mockReset().mockResolvedValue(undefined);
  });

  it('follows redirects, checking every hop, and sends credentials only to the first origin', async () => {
    safeFetch
      .mockResolvedValueOnce(redirect('/listing/index.json'))
      .mockResolvedValueOnce(redirect('https://cdn.example/index.json'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const response = await fetchFileIndex('http://files.example/index.json', { authorization: 'Basic abc', signal });

    expect(response.status).toBe(200);
    expect(ensureSafe.mock.calls.map(([url]) => url)).toEqual([
      'http://files.example/index.json',
      'http://files.example/listing/index.json',
      'https://cdn.example/index.json',
    ]);
    expect(safeFetch.mock.calls.map(([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers.Authorization)).toEqual([
      'Basic abc',
      'Basic abc',
      undefined,
    ]);
  });

  it('returns a 304 without following it', async () => {
    safeFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await fetchFileIndex('http://files.example/index.json', { signal })).status).toBe(304);
  });

  it('refuses redirect loops, missing locations and non-http targets', async () => {
    safeFetch.mockResolvedValue(redirect('/again'));
    await expect(fetchFileIndex('http://files.example/a', { signal })).rejects.toThrow('too many times');
    safeFetch.mockReset().mockResolvedValueOnce(redirect(null));
    await expect(fetchFileIndex('http://files.example/a', { signal })).rejects.toThrow('without a location');
    safeFetch.mockReset().mockResolvedValueOnce(redirect('file:///etc/passwd'));
    await expect(fetchFileIndex('http://files.example/a', { signal })).rejects.toThrow('unsupported address');
  });

  it('reports an unreachable host as unavailable', async () => {
    safeFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(fetchFileIndex('http://files.example/a', { signal })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('assertFileIndexOk', () => {
  it('maps statuses to engine errors', () => {
    expect(() => assertFileIndexOk(new Response('', { status: 401 }))).toThrow(EngineCredentialsRejectedException);
    expect(() => assertFileIndexOk(new Response('', { status: 503 }))).toThrow(ServiceUnavailableException);
    expect(() => assertFileIndexOk(new Response('', { status: 404 }))).toThrow(BadGatewayException);
    expect(() => assertFileIndexOk(new Response(null, { status: 304 }))).not.toThrow();
  });
});
