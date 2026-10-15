import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { fetchUntrusted, resolveImageType } from './untrusted-fetch.utils';

// The test server is on loopback, so "public" is simulated by path: only /public/* passes the address policy.
vi.mock('../../../common/utils/ssrf.utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../common/utils/ssrf.utils')>();
  return {
    ...actual,
    ensureSafeUrl: (raw: string) => {
      const url = new URL(raw);
      if (!url.pathname.startsWith('/public')) return Promise.reject(new actual.PrivateAddressException());
      return Promise.resolve(url);
    },
    isPrivateOrLocalAddress: () => false,
  };
});

let server: Server;
let base = '';
let internalHits = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/public/to-internal') {
      response.writeHead(302, { location: '/internal/secret.png' }).end();
    } else if (request.url === '/public/to-public') {
      response.writeHead(301, { location: '/public/image.png' }).end();
    } else if (request.url === '/public/loop') {
      response.writeHead(302, { location: '/public/loop' }).end();
    } else if (request.url === '/public/image.png' || request.url === '/internal/secret.png') {
      if (request.url.startsWith('/internal')) internalHits += 1;
      response.writeHead(200, { 'content-type': 'image/png' }).end('png');
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchUntrusted', () => {
  it('refuses a redirect from an allowed URL to an internal one without requesting it', async () => {
    await expect(fetchUntrusted(`${base}/public/to-internal`, { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
    expect(internalHits).toBe(0);
  });

  it('follows a redirect whose target passes the same check', async () => {
    const response = await fetchUntrusted(`${base}/public/to-public`, { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('png');
  });

  it('gives up on a redirect loop', async () => {
    await expect(fetchUntrusted(`${base}/public/loop`, { signal: AbortSignal.timeout(5000) })).rejects.toThrow('too many times');
  });
});

describe('resolveImageType', () => {
  it('maps jpg aliases and sniffs generic types from the bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(resolveImageType('image/jpg', Buffer.alloc(0))).toBe('image/jpeg');
    expect(resolveImageType('application/octet-stream', jpeg)).toBe('image/jpeg');
    expect(resolveImageType('application/octet-stream', Buffer.from('<html>'))).toBeNull();
  });
});
