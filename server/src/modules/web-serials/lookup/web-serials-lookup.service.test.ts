import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeSerialTitle } from '@bookorbit/types';

import { toPublication, WebSerialsLookupService } from './web-serials-lookup.service';

const frieren = {
  id: 1995,
  state: 'active',
  merged_with: null,
  title: 'Frieren: Beyond Journey’s End',
  native_title: '葬送のフリーレン',
  romanized_title: 'Sousou no Frieren',
  secondary_titles: { en: [{ title: "Frieren: Beyond Journey's End" }] },
  authors: ['Kanehito Yamada'],
  artists: ['Tsukasa Abe'],
  status: 'releasing',
  year: 2020,
  genres: ['slice_of_life', 'award_winning'],
  type: 'manga',
  content_rating: 'safe',
} as const;

function setup(enabled = true) {
  const client = {
    search: vi.fn().mockResolvedValue([frieren]),
    match: vi.fn().mockResolvedValue([]),
    getSeries: vi.fn().mockResolvedValue(frieren),
  };
  const settings = { getSettings: vi.fn().mockResolvedValue({ lookup: { enabled, lastCheck: null } }) };
  const repo = { recordLookupCheck: vi.fn().mockResolvedValue(undefined) };
  const mangaDex = { chapterVolumes: vi.fn().mockResolvedValue({ c1: '1' }) };
  const service = new WebSerialsLookupService(client as never, mangaDex as never, settings as never, repo as never);
  return { service, client, mangaDex, settings, repo };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('WebSerialsLookupService', () => {
  it('matches normalized alternate titles and maps clean details', async () => {
    const { service } = setup();

    await expect(service.lookup('manga', "Fríeren: Beyond Journey's End (Official)", null)).resolves.toEqual({
      state: 'matched',
      match: {
        provider: 'mangabaka',
        id: '1995',
        title: 'Frieren: Beyond Journey’s End',
        url: 'https://mangabaka.org/1995',
        year: 2020,
        authors: ['Kanehito Yamada'],
        artists: ['Tsukasa Abe'],
        status: 'ongoing',
        genres: ['Slice Of Life', 'Award Winning'],
        publication: { licensed: false, finalVolume: null, publishers: [] },
      },
      message: null,
      chapterVolumes: { c1: '1' },
    });
  });

  it('uses the fuzzy endpoint only after search has no acceptable match and caches no-match', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue([{ ...frieren, title: 'Unrelated', secondary_titles: null }]);

    await expect(service.lookup('manga', 'A Different Series', null)).resolves.toMatchObject({ state: 'no_match' });
    await expect(service.lookup('manga', 'A Different Series', null)).resolves.toMatchObject({ state: 'no_match' });

    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.match).toHaveBeenCalledTimes(1);
  });

  it('does not call MangaBaka when lookup is disabled', async () => {
    const { service, client } = setup(false);

    await expect(service.lookup('novel', 'Mother of Learning', null)).resolves.toEqual({
      state: 'disabled',
      match: null,
      message: null,
      chapterVolumes: null,
    });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('returns unavailable and pauses after three consecutive failures', async () => {
    const { service, client } = setup();
    client.search.mockRejectedValue(new Error('network down'));

    for (let count = 0; count < 4; count += 1) {
      await expect(service.lookup('manga', `Failure ${count}`, null)).resolves.toMatchObject({ state: 'unavailable' });
    }

    expect(client.search).toHaveBeenCalledTimes(3);
  });

  it('fetches and caches a match snapshot by id', async () => {
    const { service, client } = setup();

    await expect(service.getMatch('1995', 'manga')).resolves.toMatchObject({ id: '1995', authors: ['Kanehito Yamada'] });
    await service.getMatch('1995', 'manga');

    expect(client.getSeries).toHaveBeenCalledTimes(1);
  });

  it('adds MangaDex volume coverage only for manga and caches it with the match', async () => {
    const { service, mangaDex } = setup();
    const units = [{ unitKey: 'c1', sequence: '1' }] as never;

    await expect(service.lookup('manga', 'Frieren: Beyond Journey’s End', null, units)).resolves.toMatchObject({ chapterVolumes: { c1: '1' } });
    await service.lookup('manga', 'Frieren: Beyond Journey’s End', null, units);

    expect(mangaDex.chapterVolumes).toHaveBeenCalledTimes(1);
  });

  it('keeps the MangaBaka match when MangaDex fails and does not count it toward the breaker', async () => {
    const { service, mangaDex, client } = setup();
    mangaDex.chapterVolumes.mockRejectedValue(new Error('MangaDex down'));

    for (let count = 0; count < 5; count += 1) {
      await expect(service.lookup('manga', 'Frieren: Beyond Journey’s End', null, [], `m:${count}`)).resolves.toMatchObject({
        state: 'matched',
        match: { id: '1995' },
        chapterVolumes: null,
      });
    }

    expect(client.search).toHaveBeenCalledTimes(5);
  });

  it('retries MangaDex soon after a failure instead of caching the missing volumes for a day', async () => {
    vi.useFakeTimers();
    try {
      const { service, mangaDex } = setup();
      mangaDex.chapterVolumes.mockRejectedValueOnce(new Error('MangaDex down')).mockResolvedValue({ c1: '1' });
      const title = 'Frieren: Beyond Journey’s End';

      await service.lookup('manga', title, null, [], 'm:1');
      vi.setSystemTime(Date.now() + 6 * 60_000);

      await expect(service.lookup('manga', title, null, [], 'm:1')).resolves.toMatchObject({ chapterVolumes: { c1: '1' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds a match without MangaDex and without poisoning the full lookup cache', async () => {
    const { service, mangaDex } = setup();
    const units = [{ unitKey: 'c1', sequence: '1' }] as never;

    await expect(service.findMatch('manga', 'Frieren: Beyond Journey’s End', null, 'm:9')).resolves.toMatchObject({ id: '1995' });
    expect(mangaDex.chapterVolumes).not.toHaveBeenCalled();
    expect(service.peekCachedLookup('manga', 'm:9')).toBeNull();

    await expect(service.lookup('manga', 'Frieren: Beyond Journey’s End', null, units, 'm:9')).resolves.toMatchObject({
      chapterVolumes: { c1: '1' },
    });
    expect(mangaDex.chapterVolumes).toHaveBeenCalledTimes(1);
  });

  it('caches a match-only answer and reuses a full lookup that already exists', async () => {
    const { service, client } = setup();

    await service.findMatch('manga', 'Frieren: Beyond Journey’s End', null, 'm:1');
    await service.findMatch('manga', 'Frieren: Beyond Journey’s End', null, 'm:1');
    expect(client.search).toHaveBeenCalledTimes(1);

    await service.lookup('manga', 'Frieren: Beyond Journey’s End', null, [], 'm:2');
    await service.findMatch('manga', 'Frieren: Beyond Journey’s End', null, 'm:2');
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('answers null for a match-only lookup when lookup is disabled or the provider fails', async () => {
    const disabled = setup(false);
    await expect(disabled.service.findMatch('manga', 'Frieren', null, 'm:1')).resolves.toBeNull();
    expect(disabled.client.search).not.toHaveBeenCalled();

    const failing = setup();
    failing.client.search.mockRejectedValue(new Error('network down'));
    await expect(failing.service.findMatch('manga', 'Frieren', null, 'm:1')).resolves.toBeNull();
  });

  it('does not accept a spin-off whose title merely contains the series title', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue([
      { ...frieren, id: 7, title: 'One Piece', romanized_title: null, native_title: null, secondary_titles: null, authors: ['Eiichiro Oda'] },
    ]);

    await expect(service.lookup('manga', 'One Piece Party', 'Ei Oda')).resolves.toMatchObject({ state: 'no_match' });
  });

  it('never takes a same-titled series whose known author disagrees, even an exact title of the preferred type', async () => {
    const { service, client } = setup();
    const base = { ...frieren, romanized_title: null, native_title: null, secondary_titles: null, status: 'completed' };
    client.search.mockResolvedValue([
      { ...base, id: 100, title: 'Monster', authors: ['Naoki Urasawa'], type: 'manga', year: 1994 },
      { ...base, id: 200, title: 'Monster', authors: ['Kim Webtoon'], type: 'manhwa', year: 2019 },
    ]);

    await expect(service.findMatch('manga', 'Monster', 'Kim Webtoon', 'm:site-b-123')).resolves.toMatchObject({ id: '200' });
    await expect(service.findMatch('manga', 'Monster', 'Naoki Urasawa', 'm:site-a-1')).resolves.toMatchObject({ id: '100' });
    await expect(service.findMatch('manga', 'Monster', null, 'm:site-c-9')).resolves.toMatchObject({ id: '100' });
  });

  it('keeps a series when the site credits the same person in another spelling or only the artist', async () => {
    const { service, client } = setup();
    const base = { ...frieren, romanized_title: null, native_title: null, secondary_titles: null, status: 'completed' };
    client.search.mockResolvedValue([
      { ...base, id: 100, title: 'Monster', authors: ['Naoki Urasawa'], type: 'manga', year: 1994 },
      { ...base, id: 200, title: 'Monster', authors: ['Kim Webtoon'], artists: ['Lee Drawer'], type: 'manhwa', year: 2019 },
    ]);

    await expect(service.findMatch('manga', 'Monster', 'Urasawa, Naoki (Story & Art)', 'm:site-a-2')).resolves.toMatchObject({ id: '100' });
    await expect(service.findMatch('manga', 'Monster', 'Lee Drawer', 'm:site-b-2')).resolves.toMatchObject({ id: '200' });
    await expect(service.findMatch('manga', 'Monster', '浦沢直樹', 'm:site-a-3')).resolves.toMatchObject({ id: '100' });
  });

  it('rejects an exact title when the only candidate is by another author', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue([
      { ...frieren, id: 100, title: 'Monster', romanized_title: null, native_title: null, secondary_titles: null, authors: ['Naoki Urasawa'] },
    ]);

    await expect(service.lookup('manga', 'Monster', 'Kim Webtoon', [], 'm:b-1')).resolves.toMatchObject({ state: 'no_match' });
    await expect(service.lookup('manga', 'Monster', 'Unknown', [], 'm:c-1')).resolves.toMatchObject({ state: 'matched', match: { id: '100' } });
  });

  it('accepts a substring title when the author agrees, including one of several credited authors', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue([
      { ...frieren, id: 7, title: 'One Piece', romanized_title: null, native_title: null, secondary_titles: null, authors: ['Eiichiro Oda'] },
    ]);

    await expect(service.lookup('manga', 'One Piece Colored', 'Someone, Eiichiro Oda')).resolves.toMatchObject({
      state: 'matched',
      match: { id: '7' },
    });
  });

  it('writes the open breaker to the persisted health even inside the 60 second throttle', async () => {
    const { service, client, repo } = setup();
    client.search.mockRejectedValue(new Error('network down'));

    for (let count = 0; count < 3; count += 1) await service.lookup('manga', `Failure ${count}`, null);

    const persisted = repo.recordLookupCheck.mock.calls.map(([health]) => health as { pausedUntil: string | null });
    expect(persisted.at(-1)?.pausedUntil).not.toBeNull();
  });

  it('runs a live test and persists its health', async () => {
    const { service, client, repo } = setup();

    await expect(service.test()).resolves.toMatchObject({ ok: true, error: null, pausedUntil: null });

    expect(client.search).toHaveBeenCalledWith('Frieren', 'manga', expect.any(AbortSignal));
    expect(repo.recordLookupCheck).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});

describe('WebSerialsLookupService title search for ranking', () => {
  it('returns ranked main and alternative titles and caches per query and kind', async () => {
    const { service, client } = setup();

    const first = await service.searchTitles('Frieren', 'manga');
    await service.searchTitles(' frieren ', 'manga');

    expect(first).toEqual([{ rank: 1, titles: expect.arrayContaining(['Frieren: Beyond Journey’s End', 'Sousou no Frieren']) }]);
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search).toHaveBeenCalledWith('Frieren', 'manga', expect.any(AbortSignal), 10);
    await service.searchTitles('Frieren', 'novel');
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('returns nothing and does not call MangaBaka when lookup is disabled', async () => {
    const { service, client } = setup(false);
    await expect(service.searchTitles('Frieren', 'manga')).resolves.toEqual([]);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('returns nothing instead of throwing when MangaBaka fails, and respects the breaker', async () => {
    const { service, client } = setup();
    client.search.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 3; i += 1) await expect(service.searchTitles(`q${i}`, 'manga')).resolves.toEqual([]);
    await expect(service.searchTitles('q4', 'manga')).resolves.toEqual([]);
    expect(client.search).toHaveBeenCalledTimes(3);
  });

  it('gives up after the budget when MangaBaka is slow', async () => {
    vi.useFakeTimers();
    try {
      const { service, client } = setup();
      client.search.mockReturnValue(new Promise(() => undefined));
      const pending = service.searchTitles('Frieren', 'manga');
      await vi.advanceTimersByTimeAsync(2_600);
      await expect(pending).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('normalizeSerialTitle', () => {
  it('strips punctuation, diacritics and a trailing source label', () => {
    expect(normalizeSerialTitle('  Journey’s Café! (Doujinshi) ')).toBe('journey s cafe');
  });

  it.each([
    ['Omniscient Reader’s Viewpoint (Web Novel KR)', 'omniscient reader s viewpoint'],
    ['MTL-Omniscient Reader’s Viewpoint', 'omniscient reader s viewpoint'],
    ["Omniscient Reader's Viewpoint", 'omniscient reader s viewpoint'],
    ['Solo Leveling (Web Novel)', 'solo leveling'],
    ['Solo Leveling (WN)', 'solo leveling'],
    ['Solo Leveling (LN)', 'solo leveling'],
    ['Solo Leveling (Light Novel)', 'solo leveling'],
    ['Solo Leveling (Novel)', 'solo leveling'],
    ['Solo Leveling [MTL]', 'solo leveling'],
    ['Solo Leveling (MTL)', 'solo leveling'],
    ['MTL Solo Leveling', 'solo leveling'],
    ['Solo Leveling (KR)', 'solo leveling'],
    ['Solo Leveling (CN) (Web Novel)', 'solo leveling'],
    ['Solo Leveling (Light Novel, JP)', 'solo leveling'],
    ['Re:Zero (Re:Zero kara Hajimeru Isekai Seikatsu)', 're zero re zero kara hajimeru isekai seikatsu'],
    ['Mushoku Tensei (Jobless Reincarnation)', 'mushoku tensei jobless reincarnation'],
    ['Mtlfoo Story', 'mtlfoo story'],
  ])('ignores edition qualifiers but keeps real subtitles: %s', (title, expected) => {
    expect(normalizeSerialTitle(title)).toBe(expected);
  });
});

describe('WebSerialsLookupService catalog search', () => {
  it('returns active series of the kind in MangaBaka order and remembers them by id', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue([
      frieren,
      { ...frieren, id: 2, state: 'merged' },
      { ...frieren, id: 3, type: 'novel' },
      { ...frieren, id: 4, type: 'manhwa' },
    ]);

    const outcome = await service.searchCatalog('Frieren', 'manga');

    expect(outcome).toMatchObject({ state: 'ok' });
    expect(outcome.state === 'ok' && outcome.series.map((series) => series.id)).toEqual([1995, 4]);
    expect(client.search).toHaveBeenCalledWith('Frieren', 'manga', expect.any(AbortSignal), 20);
    await service.getCatalogSeries('4', 'manga');
    expect(client.getSeries).not.toHaveBeenCalled();
  });

  it('serves a repeated search from the cache', async () => {
    const { service, client } = setup();

    await service.searchCatalog('Frieren', 'manga');
    await service.searchCatalog('  frieren ', 'manga');

    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('reports disabled without calling MangaBaka', async () => {
    const { service, client } = setup(false);

    await expect(service.searchCatalog('Frieren', 'manga')).resolves.toEqual({ state: 'disabled' });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('reports unavailable when the call fails, and pauses after repeated failures', async () => {
    const { service, client } = setup();
    client.search.mockRejectedValue(new Error('down'));

    for (let index = 0; index < 3; index++) await expect(service.searchCatalog(`query ${index}`, 'manga')).resolves.toEqual({ state: 'unavailable' });
    client.search.mockClear();

    await expect(service.searchCatalog('another', 'manga')).resolves.toEqual({ state: 'unavailable' });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('gives up after about three seconds', async () => {
    vi.useFakeTimers();
    try {
      const { service, client } = setup();
      client.search.mockImplementation(() => new Promise(() => undefined));

      const pending = service.searchCatalog('Frieren', 'manga');
      await vi.advanceTimersByTimeAsync(3_100);

      await expect(pending).resolves.toEqual({ state: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an empty list when nothing matches', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue([]);

    await expect(service.searchCatalog('zzzz', 'manga')).resolves.toEqual({ state: 'ok', series: [] });
  });
});

describe('WebSerialsLookupService preset match', () => {
  it('looks up volumes for a known series id without guessing from the title', async () => {
    const { service, client, mangaDex } = setup();
    const units = [{ unitKey: 'c1', sequence: '1' }] as never;

    const lookup = await service.lookupByMatchId('manga', '1995', units, 'm:9');

    expect(lookup).toMatchObject({ state: 'matched', match: { id: '1995' }, chapterVolumes: { c1: '1' } });
    expect(client.search).not.toHaveBeenCalled();
    expect(client.match).not.toHaveBeenCalled();
    expect(mangaDex.chapterVolumes).toHaveBeenCalledTimes(1);
    await service.lookupByMatchId('manga', '1995', units, 'm:9');
    expect(client.getSeries).toHaveBeenCalledTimes(1);
  });

  it('is unavailable when the series cannot be fetched and disabled when lookup is off', async () => {
    const { service, client } = setup();
    client.getSeries.mockRejectedValue(new Error('down'));
    await expect(service.lookupByMatchId('manga', '7', [], 'm:1')).resolves.toMatchObject({ state: 'unavailable' });

    const off = setup(false);
    await expect(off.service.lookupByMatchId('manga', '7', [], 'm:1')).resolves.toMatchObject({ state: 'disabled' });
  });
});

describe('WebSerialsLookupService unknown ids', () => {
  it('never pauses lookups for ids MangaBaka does not know, and asks about each one only once for a while', async () => {
    const { service, client } = setup();
    client.getSeries.mockResolvedValue(null);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const id of ['1', '2', '3', '4']) await expect(service.getCatalogSeries(id, 'novel')).resolves.toBeNull();
    }
    await expect(service.getMatch('5', 'novel')).resolves.toBeNull();

    expect(client.getSeries).toHaveBeenCalledTimes(5);
    client.getSeries.mockResolvedValue(frieren);
    await expect(service.getCatalogSeries('1995', 'manga')).resolves.toMatchObject({ id: 1995 });
  });
});

describe('toPublication', () => {
  const base = { ...frieren } as never as Parameters<typeof toPublication>[0];

  it('reads the licence flag, the final volume and the publishers', () => {
    expect(
      toPublication({
        ...base,
        is_licensed: true,
        final_volume: '7',
        publishers: [
          { name: ' Kodansha ', type: 'Original', language: 'ja' },
          { name: '', type: 'English' },
        ],
      }),
    ).toEqual({ licensed: true, finalVolume: 7, publishers: [{ name: 'Kodansha', type: 'Original', language: 'ja' }] });
  });

  it('counts an English publisher as licensed even without the flag', () => {
    expect(toPublication({ ...base, is_licensed: false, publishers: [{ name: 'Yen Press', type: 'English', language: 'en' }] }).licensed).toBe(true);
  });

  it('ignores a final volume that is not a positive number', () => {
    for (const value of [null, '', '0', '-2', 'soon']) expect(toPublication({ ...base, final_volume: value }).finalVolume).toBeNull();
    expect(toPublication({ ...base, final_volume: '12.5' }).finalVolume).toBe(12);
  });
});

const waterMagicianArc = (id: number, title: string, year: number, extra: Partial<Record<string, unknown>> = {}) => ({
  ...frieren,
  id,
  title,
  native_title: null,
  romanized_title: null,
  secondary_titles: null,
  authors: ['Tadashi Kubou'],
  artists: [],
  status: 'releasing',
  year,
  genres: ['fantasy'],
  type: 'novel',
  ...extra,
});

const WATER_MAGICIAN_ARCS = [
  waterMagicianArc(30, 'The Water Magician: The Western Provinces Arc', 2023),
  waterMagicianArc(40, 'Mizu Zokusei no Mahou Tsukai Dai San-bu: Touhou Shokoku-hen', 2025, {
    secondary_titles: { en: [{ title: 'The Water Magician: The Eastern Provinces Arc' }] },
  }),
  waterMagicianArc(20, 'The Water Magician: The Central Provinces Arc', 2021),
  waterMagicianArc(50, 'Water Magician', 2019, { authors: ['Someone Else'] }),
];

describe('WebSerialsLookupService whole series filed in parts', () => {
  it('matches a site carrying the whole series to the earliest part, by base title and author in any name order', async () => {
    const { service, client, mangaDex } = setup();
    client.search.mockResolvedValue(WATER_MAGICIAN_ARCS.filter((series) => series.id !== 50));

    const result = await service.lookup('novel', 'Water Magician', 'Kubou Tadashi', [], 'nl:novelfire');

    expect(result).toMatchObject({
      state: 'matched',
      match: { id: '20', title: 'The Water Magician: The Central Provinces Arc', authors: ['Tadashi Kubou'], genres: ['Fantasy'], scope: 'part' },
      chapterVolumes: null,
    });
    expect(mangaDex.chapterVolumes).not.toHaveBeenCalled();
    await expect(service.getMatch('20', 'novel')).resolves.not.toHaveProperty('scope');
  });

  it('never uses the volume map of a part, even for manga', async () => {
    const { service, client, mangaDex } = setup();
    client.search.mockResolvedValue(WATER_MAGICIAN_ARCS.filter((series) => series.id !== 50).map((series) => ({ ...series, type: 'manga' })));

    const result = await service.lookup('manga', 'Water Magician', 'Kubou Tadashi', [{ unitKey: 'c1', sequence: '1' }] as never, 'm:wm');

    expect(result).toMatchObject({ match: { id: '20', scope: 'part' }, chapterVolumes: null });
    expect(mangaDex.chapterVolumes).not.toHaveBeenCalled();
  });

  it('keeps an exact title as a whole-series match', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue(WATER_MAGICIAN_ARCS);

    const result = await service.lookup('novel', 'Water Magician', 'Someone Else', [], 'nl:other');

    expect(result.match).toMatchObject({ id: '50' });
    expect(result.match).not.toHaveProperty('scope');
  });

  it('does not take a part when the author disagrees or is unknown', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue(WATER_MAGICIAN_ARCS.filter((series) => series.id !== 50));

    await expect(service.lookup('novel', 'Water Magician', 'Kanehito Yamada', [], 'nl:a')).resolves.toMatchObject({ state: 'no_match' });
    await expect(service.findMatch('novel', 'Water Magician', null, 'nl:b')).resolves.toBeNull();
  });

  it('weighs the fuzzy endpoint parts together with the search ones', async () => {
    const { service, client } = setup();
    client.search.mockResolvedValue([WATER_MAGICIAN_ARCS[0]]);
    client.match.mockResolvedValue([WATER_MAGICIAN_ARCS[2]]);

    await expect(service.findMatch('novel', 'Water Magician', 'Kubou Tadashi', 'nl:c')).resolves.toMatchObject({ id: '20', scope: 'part' });
  });
});
