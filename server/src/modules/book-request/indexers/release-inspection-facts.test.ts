import { describe, expect, it } from 'vitest';
import type { ReleaseFileInspection } from '@bookorbit/types';
import { factsFromInspection, releaseInfoHash } from './release-inspection-facts';

function inspection(paths: string[], totalFiles: number | null = paths.length): ReleaseFileInspection {
  return {
    source: 'torrent_file',
    status: 'ready',
    files: paths.map((path) => ({ path, sizeBytes: 1, bookFile: true })),
    totalFiles,
    primaryFileCount: null,
    truncated: false,
    units: [],
    unitCount: 0,
    ignoredFileCount: 0,
    containerCount: 0,
    selection: null,
    ranking: null,
  };
}
describe('release inspection facts', () => {
  it('records one EPUB', () =>
    expect(factsFromInspection('abc', inspection(['book.EPUB']))).toEqual({
      infoHash: 'abc',
      fileCount: 1,
      unitCount: 0,
      primaryFileCount: 1,
      formats: ['epub'],
    }));
  it('keeps distinct supported formats in path order', () =>
    expect(factsFromInspection('abc', inspection(['a.epub', 'b.mobi', 'c.epub', 'd.xyz']))?.formats).toEqual(['epub', 'mobi']));
  it('requires an exact file count', () => expect(factsFromInspection('abc', inspection([], null))).toBeNull());
  it('uses the exact primary count when provided', () =>
    expect(factsFromInspection('abc', { ...inspection(['a.epub']), primaryFileCount: 20 })?.primaryFileCount).toBe(20));
  it('prefers the stated lowercase hash', () => expect(releaseInfoHash({ infoHash: 'ABC', magnet: 'invalid' })).toBe('abc'));
  it('reads a magnet hash', () =>
    expect(releaseInfoHash({ magnet: 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).toBe('a'.repeat(40)));
  it('ignores malformed magnets', () => expect(releaseInfoHash({ magnet: 'invalid' })).toBeNull());
  it('ignores non-book files', () => {
    const value = inspection(['a.epub', 'b.mobi']);
    value.files[1]!.bookFile = false;
    expect(factsFromInspection('abc', value)).toEqual({ infoHash: 'abc', fileCount: 2, unitCount: 0, primaryFileCount: 1, formats: ['epub'] });
  });
  it('returns null without a hash', () => expect(releaseInfoHash({})).toBeNull());
});
