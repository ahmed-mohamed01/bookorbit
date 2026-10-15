import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { safeFetch } from '../../common/utils/safe-fetch';
import { WebSerialsCoverService } from './web-serials-cover.service';

vi.mock('../../common/utils/safe-fetch', () => ({ safeFetch: vi.fn() }));

vi.mock('./web-serials-engine-registry.service', () => ({ WebSerialsEngineRegistry: class {} }));

function setup(
  cover: { body: Buffer; contentType: string } = { body: Buffer.from('img'), contentType: 'image/png' },
  remoteCoverPath: string | null = '/thumb/1',
) {
  const client = {
    fetchCover: vi.fn().mockResolvedValue(cover),
  };
  const engines = {
    loadSeries: vi.fn().mockResolvedValue({ remoteCoverPath }),
    requireConfig: vi.fn().mockResolvedValue({ connection: { url: 'http://engine' } }),
    client: vi.fn().mockReturnValue(client),
  };
  return { service: new WebSerialsCoverService(engines as never), client, engines };
}

describe('WebSerialsCoverService', () => {
  it('uses the remembered cover path and caches the image', async () => {
    const { service, client, engines } = setup();
    service.remember('m:1', '/remembered');

    const first = await service.getCover('m:1');
    await service.getCover('m:1');

    expect(first).toEqual({ body: Buffer.from('img'), contentType: 'image/png' });
    expect(engines.loadSeries).not.toHaveBeenCalled();
    expect(client.fetchCover).toHaveBeenCalledTimes(1);
    expect(client.fetchCover).toHaveBeenCalledWith({ url: 'http://engine' }, '/remembered');
  });

  it('looks the series up through the shared series loader when the path is unknown', async () => {
    const { service, client, engines } = setup();

    await service.getCover('m:2');

    expect(engines.loadSeries).toHaveBeenCalledWith('manga', '2');
    expect(client.fetchCover).toHaveBeenCalledWith({ url: 'http://engine' }, '/thumb/1');
  });

  it('takes a light novel cover from the index before opening the novel', async () => {
    const { client, engines } = setup();
    const repo = { findNovelIndexCover: vi.fn().mockResolvedValue('https://a.test/c.jpg') };
    const service = new WebSerialsCoverService(engines as never, repo as never);
    const path = Buffer.from('novel/x').toString('base64url');

    await service.getCover(`nl:a:${path}`);

    expect(repo.findNovelIndexCover).toHaveBeenCalledWith('a', 'novel/x');
    expect(engines.loadSeries).not.toHaveBeenCalled();
    expect(client.fetchCover).toHaveBeenCalledWith({ url: 'http://engine' }, 'https://a.test/c.jpg');
  });

  it('shares one engine fetch between concurrent requests', async () => {
    const { service, client } = setup();
    service.remember('m:1', '/c');

    await Promise.all([service.getCover('m:1'), service.getCover('m:1')]);

    expect(client.fetchCover).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a series without a cover', async () => {
    const { service } = setup(undefined, null);

    await expect(service.getCover('m:3')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses svg and non-image content types', async () => {
    const { service } = setup({ body: Buffer.from('<svg/>'), contentType: 'image/svg+xml' });
    service.remember('m:1', '/c');

    await expect(service.getCover('m:1')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('refuses an image above 5 MB', async () => {
    const { service } = setup({ body: Buffer.alloc(5 * 1024 * 1024 + 1), contentType: 'image/jpeg' });
    service.remember('m:1', '/c');

    await expect(service.getCover('m:1')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects a malformed key before touching an engine', async () => {
    const { service, engines } = setup();

    await expect(service.getCover('bad')).rejects.toThrow('Invalid series key');
    expect(engines.requireConfig).not.toHaveBeenCalled();
  });
});

describe('WebSerialsCoverService remote covers', () => {
  const image = (type = 'image/jpeg', body = 'img', headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': type, ...headers } });

  it('proxies an https cover once and serves repeats from the cache', async () => {
    const { service } = setup();
    vi.mocked(safeFetch).mockResolvedValue(image('image/webp; charset=binary'));

    const first = await service.getRemoteCover('manga:1', 'https://cdn.example/1.webp');
    await service.getRemoteCover('manga:1', 'https://cdn.example/1.webp');

    expect(first).toEqual({ body: Buffer.from('img'), contentType: 'image/webp' });
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('checks and pins each redirect hop of a remote cover instead of letting fetch follow it', async () => {
    const { service } = setup();
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn2.example/1.jpg' } }))
      .mockResolvedValueOnce(image('image/jpeg'));

    await expect(service.getRemoteCover('manga:9', 'https://cdn.example/1.jpg')).resolves.toMatchObject({ contentType: 'image/jpeg' });
    expect(vi.mocked(safeFetch).mock.calls.map((call) => [call[0], call[1]?.redirect, call[2]?.pinResolvedAddress])).toEqual([
      ['https://cdn.example/1.jpg', 'manual', true],
      ['https://cdn2.example/1.jpg', 'manual', true],
    ]);
  });

  it('answers 404 for a url that is not https', async () => {
    const { service } = setup();

    await expect(service.getRemoteCover('manga:2', 'http://cdn.example/1.jpg')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getRemoteCover('manga:2', 'file:///etc/passwd')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses svg, an error status, an oversized body and a failed request', async () => {
    const { service } = setup();
    vi.mocked(safeFetch).mockResolvedValueOnce(image('image/svg+xml', '<svg/>'));
    await expect(service.getRemoteCover('manga:3', 'https://cdn.example/a.svg')).rejects.toBeInstanceOf(BadGatewayException);

    vi.mocked(safeFetch).mockResolvedValueOnce(new Response('no', { status: 500 }));
    await expect(service.getRemoteCover('manga:4', 'https://cdn.example/b.jpg')).rejects.toBeInstanceOf(BadGatewayException);

    vi.mocked(safeFetch).mockResolvedValueOnce(image('image/jpeg', 'x', { 'content-length': String(5 * 1024 * 1024 + 1) }));
    await expect(service.getRemoteCover('manga:5', 'https://cdn.example/c.jpg')).rejects.toThrow('too large');

    vi.mocked(safeFetch).mockRejectedValueOnce(new Error('private address'));
    await expect(service.getRemoteCover('manga:6', 'https://cdn.example/d.jpg')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
