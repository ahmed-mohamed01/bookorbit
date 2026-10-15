import { describe, expect, it, vi } from 'vitest';

import {
  beforeDeadline,
  pickOnePerSource,
  rankDiscoverOptions,
  shortlistHits,
  TIMED_OUT,
  type LoadedSourceCandidate,
} from './web-serials-candidate.utils';

function loaded(
  seriesKey: string,
  sourceName: string,
  chapterCount: number,
  confidence: LoadedSourceCandidate['confidence'],
  publishedAt: string | null = null,
) {
  return {
    seriesKey,
    confidence,
    hit: { remoteId: seriesKey, url: null, title: 'T', author: null, remoteCoverPath: null, sourceName, chapterCount, status: 'unknown' },
    series: { title: 'T', sourceName, chapterCount, units: publishedAt ? [{ publishedAt }] : [] },
  } as unknown as LoadedSourceCandidate;
}

describe('rankDiscoverOptions', () => {
  it('ranks a whole-series copy below every exact match, however many chapters it has', () => {
    const options = rankDiscoverOptions([
      loaded('n:whole', 'Novel Fire', 800, 'whole_series'),
      loaded('n:title', 'Light Novel Pub', 40, 'title_match'),
      loaded('n:same', 'NovelBin', 30, 'same_series'),
    ]);

    expect(options.map((option) => [option.seriesKey, option.confidence])).toEqual([
      ['n:same', 'same_series'],
      ['n:title', 'title_match'],
      ['n:whole', 'whole_series'],
    ]);
    expect(options[0]!.mostComplete).toBe(true);
  });

  it('puts the most complete source first, then the closer match, and flags only the first', () => {
    const options = rankDiscoverOptions([
      loaded('m:1', 'B', 50, 'title_match'),
      loaded('m:2', 'C', 80, 'title_match'),
      loaded('m:3', 'A', 80, 'same_series', '2026-10-01T00:00:00Z'),
    ]);

    expect(options.map((option) => [option.seriesKey, option.mostComplete])).toEqual([
      ['m:3', true],
      ['m:2', false],
      ['m:1', false],
    ]);
    expect(options[0]).toMatchObject({ latestAt: '2026-10-01T00:00:00Z', confidence: 'same_series' });
  });

  it('never marks a title-only copy most complete over a confirmed copy of the series, whatever the chapter counts', () => {
    const options = rankDiscoverOptions([
      loaded('n:other', 'Y', 300, 'title_match'),
      loaded('n:ours', 'X', 0, 'same_series'),
      loaded('n:also', 'Z', 120, 'same_series'),
    ]);

    expect(options.map((option) => [option.seriesKey, option.mostComplete])).toEqual([
      ['n:also', true],
      ['n:ours', false],
      ['n:other', false],
    ]);
  });

  it('puts an MTL source after the others even when it has more chapters, and flags it', () => {
    const mtl = loaded('m:1', 'A', 900, 'same_series');
    mtl.hit.title = 'MTL-T';
    const options = rankDiscoverOptions([mtl, loaded('m:2', 'B', 100, 'title_match')]);

    expect(options.map((option) => [option.seriesKey, option.mostComplete, option.mtl])).toEqual([
      ['m:2', true, undefined],
      ['m:1', false, true],
    ]);
  });

  it('is empty for no candidates', () => {
    expect(rankDiscoverOptions([])).toEqual([]);
  });
});

describe('shortlistHits and pickOnePerSource', () => {
  it('puts title-equal hits first and caps hits per source', () => {
    const hit = (title: string, sourceName: string) => ({ title, sourceName });
    const picked = shortlistHits([hit('x', 'S'), hit('y', 'S'), hit('z', 'S'), hit('Wanted', 'S'), hit('q', 'O')], ['wanted']);

    expect(picked.map((entry) => entry.title)).toEqual(['Wanted', 'x', 'y', 'q']);
  });

  it('keeps one entry per source, same-series first', () => {
    const entries = [
      { hit: { sourceName: 'A', title: 'T' }, confidence: 'title_match' as const },
      { hit: { sourceName: 'a', title: 'T' }, confidence: 'same_series' as const },
    ];

    expect(pickOnePerSource(entries)).toEqual([{ hit: { sourceName: 'a', title: 'T' }, confidence: 'same_series' }]);
  });

  it('prefers a non-MTL copy within a source, and keeps an MTL copy when it is the only one', () => {
    const entry = (title: string, sourceName: string, confidence: 'same_series' | 'title_match') => ({ hit: { sourceName, title }, confidence });

    expect(
      pickOnePerSource([entry('MTL-Story', 'S', 'same_series'), entry('Story (Web Novel KR)', 'S', 'title_match')]).map((e) => e.hit.title),
    ).toEqual(['Story (Web Novel KR)']);
    expect(pickOnePerSource([entry('MTL-Story', 'S', 'same_series')]).map((e) => e.hit.title)).toEqual(['MTL-Story']);
  });

  it('shortlists a non-MTL hit ahead of an MTL hit of the same title', () => {
    const hit = (title: string) => ({ title, sourceName: 'S' });
    const picked = shortlistHits([hit('MTL-Story'), hit('x'), hit('y'), hit('Story')], ['Story']);

    expect(picked.map((entry) => entry.title)).toEqual(['Story', 'MTL-Story', 'x']);
  });
});

describe('beforeDeadline', () => {
  it('returns the marker when the work is slower than the deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = beforeDeadline(new Promise<string>(() => undefined), Date.now() + 100);
      await vi.advanceTimersByTimeAsync(150);
      await expect(pending).resolves.toBe(TIMED_OUT);
    } finally {
      vi.useRealTimers();
    }
  });
});
