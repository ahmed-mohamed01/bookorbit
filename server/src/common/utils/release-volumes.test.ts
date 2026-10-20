import { compressVolumeRanges, parseReleaseVolumes, WEB_SERIAL_MAX_PUBLISHED_VOLUMES } from '@bookorbit/types';

const range = (start: number, end: number): number[] => Array.from({ length: end - start + 1 }, (_, index) => start + index);

it.each([
  ['Mushoku Tensei v01-26 (Seven Seas) [Premium]', range(1, 26)],
  ['Mushoku Tensei - Jobless Reincarnation Vol. 1-24 (epub)', range(1, 24)],
  ['Mushoku Tensei: Jobless Reincarnation Vol. 25', [25]],
  ['Overlord Volume 03', [3]],
  ['Overlord Vol.1-Vol.5', range(1, 5)],
  ['Overlord Vol. 1 - Vol. 5', range(1, 5)],
  ['Spice and Wolf v01 - v05', range(1, 5)],
  ['Re Zero Volume 1 ~ Volume 3', range(1, 3)],
  ['Spice and Wolf v3', [3]],
  ['Slime Volumes 1~5', range(1, 5)],
  ['Bookworm Vol 1 to 12', range(1, 12)],
  ['Konosuba Vol. 1, 3, 5', [1, 3, 5]],
  ['Re Zero v10.5', null],
  ['Re Zero v01-10.5', range(1, 10)],
  ['Mushoku Tensei LN complete batch', null],
  ['Kumo Desu ga (2023) [v2] x265', null],
  ['Some Series v2.0 EPUB', null],
  ['No volume here', null],
])('parses %s', (title, expected) => expect(parseReleaseVolumes(title)).toEqual(expected));
it('caps at max', () => expect(parseReleaseVolumes('X v01-999', 30)).toEqual(range(1, 30)));
it('unit titles without a volume token', () => expect(parseReleaseVolumes('01.epub')).toBeNull());
it('compresses ranges', () => expect(compressVolumeRanges([7, 8, 10, 12, 13, 14])).toBe('7-8, 10, 12-14'));

it('sorts and deduplicates volumes across tokens and lists', () => {
  expect(parseReleaseVolumes('X Vol. 5, 1, 5 v3')).toEqual([1, 3, 5]);
});
it('uses the published volume limit by default', () => {
  expect(parseReleaseVolumes('X v1-999')).toEqual(range(1, WEB_SERIAL_MAX_PUBLISHED_VOLUMES));
});
it('excludes zero and fractional list entries', () => {
  expect(parseReleaseVolumes('X Vol. 0, 1, 2.5, 3')).toEqual([1, 3]);
});
it('compresses unsorted duplicate volumes without mutating the input', () => {
  const volumes = [3, 1, 2, 2, 5];
  expect(compressVolumeRanges(volumes)).toBe('1-3, 5');
  expect(volumes).toEqual([3, 1, 2, 2, 5]);
  expect(compressVolumeRanges([])).toBe('');
});
