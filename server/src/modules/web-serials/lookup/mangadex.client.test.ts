import { beforeEach, describe, expect, it, vi } from 'vitest';

import { safeFetch } from '../../../common/utils/safe-fetch';
import type { EngineUnitSpec } from '../engines/web-serial-engine';
import type { MangaBakaSeries } from './mangabaka.client';
import { MangaDexClient } from './mangadex.client';

vi.mock('../../../common/utils/safe-fetch', () => ({ safeFetch: vi.fn() }));

const series = {
  id: 1995,
  state: 'active',
  merged_with: null,
  title: 'Frieren',
  native_title: null,
  romanized_title: 'Sousou no Frieren',
  secondary_titles: { en: [{ title: 'Frieren: Beyond Journey’s End' }, { title: 'Frieren' }] },
  authors: [],
  artists: [],
  status: 'releasing',
  year: 2020,
  genres: [],
  type: 'manga',
  content_rating: 'safe',
  source: { anilist: { id: 118586 } },
} satisfies MangaBakaSeries;

const units = [
  { unitKey: 'c1', sequence: '1' },
  { unitKey: 'c2', sequence: '2.5' },
  { unitKey: 'c3', sequence: '3' },
] as EngineUnitSpec[];

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

beforeEach(() => vi.mocked(safeFetch).mockReset());

describe('MangaDexClient', () => {
  it('matches by AniList id across titles and maps chapter numbers to unit keys', async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(json({ data: [{ id: 'wrong', attributes: { links: { al: '1' } } }] }))
      .mockResolvedValueOnce(json({ data: [{ id: 'frieren-id', attributes: { links: { al: '118586' } } }] }))
      .mockResolvedValueOnce(
        json({
          volumes: {
            '1': { volume: '1', chapters: { a: { chapter: '1' }, b: { chapter: '2.5' } } },
            none: { volume: 'none', chapters: { c: { chapter: '3' } } },
          },
        }),
      );

    await expect(new MangaDexClient().chapterVolumes(series, units)).resolves.toEqual({ c1: '1', c2: '1' });
    expect(vi.mocked(safeFetch).mock.calls.map((call) => String(call[0]))).toEqual([
      'https://api.mangadex.org/manga?title=Frieren&limit=10',
      'https://api.mangadex.org/manga?title=Sousou+no+Frieren&limit=10',
      'https://api.mangadex.org/manga/frieren-id/aggregate',
    ]);
  });

  it('returns null without an AniList id or a matching MangaDex result', async () => {
    await expect(new MangaDexClient().chapterVolumes({ ...series, source: null }, units)).resolves.toBeNull();
    expect(safeFetch).not.toHaveBeenCalled();

    vi.mocked(safeFetch).mockImplementation(() => Promise.resolve(json({ data: [] })));
    await expect(new MangaDexClient().chapterVolumes(series, units)).resolves.toBeNull();
    expect(safeFetch).toHaveBeenCalledTimes(3);
  });
});
