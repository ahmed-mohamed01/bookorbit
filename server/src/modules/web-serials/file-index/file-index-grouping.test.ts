import { describe, expect, it } from 'vitest';

import { compareFiles, groupListing, parsePartNumber, parseVolumeNumber, seriesTitle } from './file-index-grouping';

describe('parseVolumeNumber', () => {
  it.each([
    ['S - Volume 01 - Spy Sensation [June][Kindle].epub', 1],
    ['Series Vol. 3.epub', 3],
    ['Series v03 [JNC].epub', 3],
    ['Series_Vol_12.5.epub', 12.5],
    ['Series 07 [Yen Press].epub', 7],
    ['Part 2 Volume 4.epub', 4],
  ])('%s -> %s', (name, volume) => {
    expect(parseVolumeNumber(name)).toBe(volume);
  });

  it.each(['Love Bite.epub', 'Series 2019 Edition.epub', 'Side Stories.epub'])('%s has no volume', (name) => {
    expect(parseVolumeNumber(name)).toBeNull();
  });
});

describe('parsePartNumber', () => {
  it('reads a part marker and nothing else', () => {
    expect(parsePartNumber('Series Part 2 Volume 1.epub')).toBe(2);
    expect(parsePartNumber('Counterpart Volume 1.epub')).toBeNull();
  });
});

describe('seriesTitle', () => {
  it('strips release tags and joins a part folder to its series', () => {
    expect(seriesTitle('Officially Translated/Ascendance of a Bookworm [J-Novel Club]')).toBe('Ascendance of a Bookworm');
    expect(seriesTitle('Light Novels/Ascendance of a Bookworm/Part 2')).toBe('Ascendance of a Bookworm Part 2');
  });
});

describe('groupListing', () => {
  it('groups EPUBs by folder, counts other book formats as skipped and drops root files', () => {
    const grouped = groupListing([
      { path: '!Yaoi/S/S - Volume 02 - A Love Bite [June][Kindle].epub', name: 'S - Volume 02 - A Love Bite [June][Kindle].epub', size: 3 },
      { path: '!Yaoi/S/S - Volume 01 - Spy Sensation [June][Kindle].epub', name: 'S - Volume 01 - Spy Sensation [June][Kindle].epub', size: 2 },
      { path: '!Yaoi/S/S - Volume 01 [Kindle_LNWNCentral].pdf', name: 'S - Volume 01 [Kindle_LNWNCentral].pdf', size: 4 },
      { path: 'loose.epub', name: 'loose.epub', size: 1 },
      { path: 'Other/cover.jpg', name: 'cover.jpg', size: 1 },
      { path: '!Yaoi/S/cover.jpg', name: 'cover.jpg', size: 1 },
    ]);
    expect(grouped.skippedFiles).toBe(1);
    expect(grouped.unnumberedFiles).toBe(0);
    expect(grouped.fileCount).toBe(2);
    expect(grouped.series).toEqual([
      {
        folderPath: '!Yaoi/S',
        title: 'S',
        titleKey: 's',
        coverPath: '!Yaoi/S/cover.jpg',
        files: [
          expect.objectContaining({ name: 'S - Volume 01 - Spy Sensation [June][Kindle].epub', volume: 1 }),
          expect.objectContaining({ name: 'S - Volume 02 - A Love Bite [June][Kindle].epub', volume: 2 }),
        ],
      },
    ]);
  });

  it('keeps the larger copy of a repeated volume, both parts of a split series, and skips unnumbered files', () => {
    const grouped = groupListing([
      { path: 'A/A Vol 1 [small].epub', name: 'A Vol 1 [small].epub', size: 10 },
      { path: 'A/A Vol 1 [big].epub', name: 'A Vol 1 [big].epub', size: 20 },
      { path: 'A/A Part 2 Vol 1.epub', name: 'A Part 2 Vol 1.epub', size: 5 },
      { path: 'A/A Extra.epub', name: 'A Extra.epub', size: 5 },
    ]);
    expect(grouped.series[0]!.files.map((file) => file.name)).toEqual(['A Vol 1 [big].epub', 'A Part 2 Vol 1.epub']);
    expect(grouped.unnumberedFiles).toBe(1);
  });

  it('orders by part before volume', () => {
    const files = [
      { name: 'Part 2 Volume 1.epub', volume: 1 },
      { name: 'Part 1 Volume 2.epub', volume: 2 },
      { name: 'Part 1 Volume 1.epub', volume: 1 },
    ];
    expect(files.sort(compareFiles).map((file) => file.name)).toEqual(['Part 1 Volume 1.epub', 'Part 1 Volume 2.epub', 'Part 2 Volume 1.epub']);
  });
});
