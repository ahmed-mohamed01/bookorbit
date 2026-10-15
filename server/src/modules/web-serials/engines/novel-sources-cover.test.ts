import { BadGatewayException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NovelSourcesClient } from './novel-sources.client';
import { sniffImageType } from './untrusted-fetch.utils';

const safeFetch = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit, options?: unknown) => Promise<Response>>());

vi.mock('../../../common/utils/safe-fetch', () => ({ safeFetch }));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const CONN = { url: 'http://sources', username: null, password: 'token' };

function image(bytes: Buffer, contentType: string): Response {
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } });
}

describe('NovelSourcesClient covers', () => {
  const client = new NovelSourcesClient({} as never, {} as never);

  beforeEach(() => {
    safeFetch.mockReset();
  });

  it('recognises common image formats from their first bytes', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from('GIF89a----'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('<html>not an image</html>'))).toBeNull();
  });

  it('accepts a JPEG that the host labels application/octet-stream, as novelbuddy does', async () => {
    safeFetch.mockResolvedValue(image(JPEG, 'application/octet-stream'));

    await expect(client.fetchCover(CONN, 'https://rs.novelbuddy.me/covers/a.png')).resolves.toMatchObject({ contentType: 'image/jpeg' });
  });

  it('keeps a declared image type and refuses a generic file that is not an image', async () => {
    safeFetch.mockResolvedValueOnce(image(PNG, 'image/png'));
    await expect(client.fetchCover(CONN, 'https://img.test/b.png')).resolves.toMatchObject({ contentType: 'image/png' });

    safeFetch.mockResolvedValueOnce(image(Buffer.from('<html></html>'), 'application/octet-stream'));
    await expect(client.fetchCover(CONN, 'https://img.test/c.png')).rejects.toBeInstanceOf(BadGatewayException);

    safeFetch.mockResolvedValueOnce(image(JPEG, 'text/html'));
    await expect(client.fetchCover(CONN, 'https://img.test/d.png')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps image/jpg to image/jpeg', async () => {
    safeFetch.mockResolvedValueOnce(image(JPEG, 'image/jpg'));
    await expect(client.fetchCover(CONN, 'https://img.test/e.jpg')).resolves.toMatchObject({ contentType: 'image/jpeg' });
  });

  it('checks and pins every redirect hop instead of letting fetch follow it', async () => {
    safeFetch
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/moved.jpg' } }))
      .mockResolvedValueOnce(image(JPEG, 'image/jpeg'));

    await expect(client.fetchCover(CONN, 'https://img.test/f.jpg')).resolves.toMatchObject({ contentType: 'image/jpeg' });
    expect(safeFetch.mock.calls.map((call) => call[0])).toEqual(['https://img.test/f.jpg', 'https://img.test/moved.jpg']);
    for (const [, init, options] of safeFetch.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(options).toMatchObject({ pinResolvedAddress: true });
    }
  });
});
