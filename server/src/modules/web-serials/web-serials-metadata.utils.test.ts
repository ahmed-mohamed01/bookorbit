import { describe, expect, it } from 'vitest';

import type { EngineSeries } from './engines/web-serial-engine';
import { buildDockMetadata, growingVolumeRange, volumeKeyBase } from './web-serials-metadata.utils';

const series = {
  kind: 'manga',
  title: 'Dungeon Saga',
  authors: ['A. Writer', 'B. Artist'],
  synopsis: '<p>First &amp; best.</p><p>Second</p>',
  tags: ['Fantasy'],
  language: 'en',
} as EngineSeries;

describe('buildDockMetadata', () => {
  it('titles a manga chapter with its number and keeps a real chapter name', () => {
    expect(buildDockMetadata(series, { label: 'Chapter 12', sequence: '12' }, 'chapter')).toMatchObject({
      title: 'Dungeon Saga Ch. 12',
      seriesName: 'Dungeon Saga',
      seriesIndex: '12',
      authors: ['A. Writer', 'B. Artist'],
      genres: ['Fantasy'],
    });
    expect(buildDockMetadata(series, { label: 'The Gate Opens', sequence: '12.5' }, 'chapter')).toMatchObject({
      title: 'Dungeon Saga Ch. 12.5: The Gate Opens',
      seriesIndex: '12.5',
    });
  });

  it('drops a chapter number the source repeats in the chapter name', () => {
    expect(buildDockMetadata(series, { label: "Chapter 2: The Priest's Lie", sequence: '2' }, 'chapter').title).toBe(
      "Dungeon Saga Ch. 2: The Priest's Lie",
    );
    expect(buildDockMetadata(series, { label: 'Ch. 3 - Home', sequence: '3' }, 'chapter').title).toBe('Dungeon Saga Ch. 3: Home');
    expect(buildDockMetadata(series, { label: 'Volume 2: Ashes', sequence: '2' }, 'volume').title).toBe('Dungeon Saga, Volume 2: Ashes');
  });

  it('titles a novel volume and strips the synopsis markup', () => {
    const plain = buildDockMetadata(series, { label: 'Volume 2', sequence: '2' }, 'volume');
    expect(plain).toMatchObject({ title: 'Dungeon Saga, Volume 2', seriesIndex: '2', language: 'en' });
    expect(plain.description).toBe('First & best.\nSecond');
    expect(buildDockMetadata(series, { label: 'Arc of Ash', sequence: '2' }, 'volume').title).toBe('Dungeon Saga, Volume 2: Arc of Ash');
    expect(buildDockMetadata(series, { label: 'Volume 3', sequence: '3', chapterRange: '201-250' }, 'volume')).toMatchObject({
      title: 'Dungeon Saga, Volume 3 (Chapters 201-250)',
      seriesIndex: '3',
    });
  });

  it('names a whole series book after the series with no index', () => {
    const metadata = buildDockMetadata(series, { label: 'Dungeon Saga', sequence: '1' }, 'series');
    expect(metadata.title).toBe('Dungeon Saga');
    expect(metadata.seriesName).toBeUndefined();
    expect(metadata.seriesIndex).toBeUndefined();
  });

  it('names a partial manga series selection with its chapter range', () => {
    const metadata = buildDockMetadata(series, { label: 'Chapters 2-12', sequence: '2' }, 'series');
    expect(metadata.title).toBe('Dungeon Saga, Chapters 2-12');
    expect(metadata.seriesName).toBeUndefined();
  });

  it('drops a sequence that is not a valid series index', () => {
    expect(buildDockMetadata(series, { label: 'x', sequence: '-1' }, 'chapter').seriesIndex).toBeNull();
  });

  it('applies a match and overrides while preserving source metadata', () => {
    const metadata = buildDockMetadata(series, { label: 'Chapter 12', sequence: '12', publishedAt: '2026-10-13T10:30:00.000Z' }, 'chapter', {
      override: { authors: ['Final Author'], artists: ['Final Artist'] },
      match: {
        provider: 'mangabaka',
        id: '1',
        title: 'Canonical Saga',
        url: 'https://mangabaka.org/1',
        year: 2020,
        authors: ['Matched Author'],
        artists: ['Matched Artist'],
        status: 'ongoing',
        genres: ['fantasy', 'Slice of Life'],
      },
    });

    expect(metadata).toMatchObject({
      title: 'Canonical Saga Ch. 12',
      seriesName: 'Canonical Saga',
      authors: ['Final Author'],
      genres: ['Fantasy', 'Slice of Life'],
      publishedDate: '2026-10-13',
      comicMetadata: { pencillers: ['Final Artist'] },
    });
  });

  it('does not put artists into novel metadata', () => {
    const novel = { ...series, kind: 'novel' as const };
    const metadata = buildDockMetadata(novel, { label: 'Volume 1', sequence: '1' }, 'volume', {
      match: {
        provider: 'mangabaka',
        id: '2',
        title: 'Novel',
        url: 'https://mangabaka.org/2',
        year: null,
        authors: ['Writer'],
        artists: ['Illustrator'],
        status: 'unknown',
        genres: [],
      },
    });

    expect(metadata.authors).toEqual(['Writer']);
    expect(metadata.comicMetadata).toBeUndefined();
  });

  it('falls back to source authors when a match has no author credits', () => {
    const metadata = buildDockMetadata(series, { label: 'Chapter 1', sequence: '1' }, 'chapter', {
      match: {
        provider: 'mangabaka',
        id: '3',
        title: 'Dungeon Saga',
        url: 'https://mangabaka.org/3',
        year: null,
        authors: [],
        artists: [],
        status: 'unknown',
        genres: [],
      },
    });

    expect(metadata.authors).toEqual(['A. Writer', 'B. Artist']);
  });

  it('strips a leading volume and chapter token from a chapter title', () => {
    const named = buildDockMetadata(series, { label: 'Vol.2 Ch.15 - The Fight', sequence: '15' }, 'chapter');
    expect(named.title).toBe('Dungeon Saga Ch. 15: The Fight');

    const bare = buildDockMetadata(series, { label: 'Vol.2 Ch.15', sequence: '15' }, 'chapter');
    expect(bare.title).toBe('Dungeon Saga Ch. 15');
  });
});

describe('artists fallback', () => {
  it('uses the source artists for pencillers when nothing is matched or overridden', () => {
    const metadata = buildDockMetadata({ ...series, artists: ['Pencil Source'] }, { label: 'Chapter 1', sequence: '1' }, 'chapter');
    expect(metadata.comicMetadata).toEqual({ pencillers: ['Pencil Source'] });
    const overridden = buildDockMetadata({ ...series, artists: ['Pencil Source'] }, { label: 'Chapter 1', sequence: '1' }, 'chapter', {
      override: { artists: ['Chosen'] },
    });
    expect(overridden.comicMetadata).toEqual({ pencillers: ['Chosen'] });
  });
});

describe('growing volume keys', () => {
  it('reads the range a lightnovel-crawler last volume carries, and no range from a plain volume id', () => {
    expect(growingVolumeRange('vol-1f2e:101-150', 'n:abc')).toBe('101-150');
    expect(growingVolumeRange('vol-1f2e', 'n:abc')).toBeNull();
    expect(growingVolumeRange('volume-3:201-250', 'nl:src:p')).toBe('201-250');
    expect(growingVolumeRange('vol:12:100-103', 'm:7')).toBe('100-103');
  });

  it('compares two copies of one volume by the key without its range', () => {
    expect(volumeKeyBase('vol-1f2e:101-180', 'n:abc')).toBe('vol-1f2e');
    expect(volumeKeyBase('vol-1f2e', 'n:abc')).toBe('vol-1f2e');
    expect(volumeKeyBase('series', 'n:abc')).toBeNull();
    expect(volumeKeyBase('volume-3:201-250', 'nl:src:p')).toBe('volume-3');
    expect(volumeKeyBase('vol:12', 'm:7')).toBe('vol:12');
    expect(volumeKeyBase('chapter-key', 'm:7')).toBeNull();
  });
});
