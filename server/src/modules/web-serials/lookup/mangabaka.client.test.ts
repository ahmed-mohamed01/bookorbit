import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ResponseTooLargeError } from '../../../common/utils/bounded-response';
import { safeFetch } from '../../../common/utils/safe-fetch';
import { MangaBakaClient } from './mangabaka.client';

vi.mock('../../../common/utils/safe-fetch', () => ({ safeFetch: vi.fn() }));

const series = {
  id: 1995,
  state: 'active',
  merged_with: null,
  title: 'Frieren: Beyond Journey’s End',
  native_title: '葬送のフリーレン',
  romanized_title: 'Sousou no Frieren',
  secondary_titles: { en: [{ title: "Frieren: Beyond Journey's End" }] },
  authors: ['Kanehito Yamada'],
  artists: ['Tsukasa Abe'],
  status: 'hiatus',
  year: 2020,
  genres: ['slice_of_life'],
  type: 'manga',
  content_rating: 'safe',
  source: { anilist: { id: 118586 } },
};

function response(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ status: 200, data }), { status: 200, headers });
}

beforeEach(() => vi.mocked(safeFetch).mockReset());

describe('MangaBakaClient', () => {
  it('searches with a bounded public request and identifies the kind', async () => {
    vi.mocked(safeFetch).mockResolvedValue(response([series]));

    const result = await new MangaBakaClient().search('Frieren & Fern', 'manga');

    expect(result).toEqual([series]);
    expect(result[0]!.source?.anilist?.id).toBe(118586);
    const [url, init, options] = vi.mocked(safeFetch).mock.calls[0]!;
    expect(url).toBe('https://api.mangabaka.org/v1/series/search?q=Frieren+%26+Fern&limit=5&type=manga&type=manhwa&type=manhua&type=oel');
    expect(init?.headers).toMatchObject({ Accept: 'application/json', 'User-Agent': expect.stringContaining('bookorbit') });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(options).toMatchObject({ signal: init?.signal });
  });

  it('skips a malformed row instead of failing the whole search', async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      response([
        { ...series, id: 1, secondary_titles: { en: [null] } },
        { ...series, id: 2, authors: [null, 'Someone'] },
        { ...series, id: 3, genres: 'action' },
        { ...series, id: 4, native_title: 7 },
        series,
      ]),
    );

    await expect(new MangaBakaClient().search('Frieren', 'manga')).resolves.toEqual([series]);
  });

  it('asks only for novels when searching novels', async () => {
    vi.mocked(safeFetch).mockResolvedValue(response([]));
    await new MangaBakaClient().search('Overgeared', 'novel', undefined, 10);
    expect(vi.mocked(safeFetch).mock.calls[0]![0]).toBe('https://api.mangabaka.org/v1/series/search?q=Overgeared&limit=10&type=novel');
  });

  it('accepts a single fuzzy match and raw control characters inside strings', async () => {
    const json = JSON.stringify({ status: 200, data: { ...series, title: 'Frieren control' } }).replace('control', '\u0001');
    vi.mocked(safeFetch).mockResolvedValue(new Response(json));

    const result = await new MangaBakaClient().match('Frieren');

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toContain('\u0001');
  });

  it('follows a merged series once', async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(response({ ...series, id: 10, state: 'merged', merged_with: 20 }))
      .mockResolvedValueOnce(response({ ...series, id: 20 }));

    await expect(new MangaBakaClient().getSeries('10')).resolves.toMatchObject({ id: 20 });
    expect(vi.mocked(safeFetch).mock.calls.map((call) => call[0])).toEqual([
      'https://api.mangabaka.org/v1/series/10',
      'https://api.mangabaka.org/v1/series/20',
    ]);
  });

  it('answers null for an id MangaBaka does not know, by HTTP status or envelope status', async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 404, message: 'Not found' })));

    await expect(new MangaBakaClient().getSeries('404')).resolves.toBeNull();
    await expect(new MangaBakaClient().getSeries('405')).resolves.toBeNull();
  });

  it('still fails a search that gets a 404', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('{}', { status: 404 }));
    await expect(new MangaBakaClient().search('Frieren', 'manga')).rejects.toThrow('MangaBaka did not accept the request');
  });

  it('rejects an invalid id before the request', async () => {
    await expect(new MangaBakaClient().getSeries('1/x')).rejects.toBeInstanceOf(BadRequestException);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('refuses an oversized response before reading it', async () => {
    vi.mocked(safeFetch).mockResolvedValue(response([], { 'content-length': String(2 * 1024 * 1024 + 1) }));

    await expect(new MangaBakaClient().search('Frieren', 'manga')).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
