import { readFile } from 'fs/promises';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  InvalidPathMappingError,
  assertMappablePathMappings,
  expectedCustomFolderOutputPath,
  normalizePathMappings,
  storytellerSafeFilepathSegment,
  toLocalPath,
  toRemotePath,
} from './storyteller-path.utils';

const MAPPINGS = [
  { localPrefix: '/books/text', remotePrefix: '/storyteller/library' },
  { localPrefix: '/books/audio', remotePrefix: '/storyteller/audio' },
];

// Nested on both sides, so `assertMappablePathMappings` now refuses it - but a config saved before
// that guard existed still reads, and longest-prefix-wins is what decides which row applies.
const LEGACY_NESTED_MAPPINGS = [
  { localPrefix: '/books', remotePrefix: '/storyteller/library' },
  { localPrefix: '/books/audio', remotePrefix: '/storyteller/library/audio' },
];

describe('module boundaries', () => {
  it('reaches into no feature module other than upstream planner path-mapping helpers', async () => {
    const source = await readFile(join(process.cwd(), 'src/modules/storyteller/storyteller-path.utils.ts'), 'utf8');
    const crossModuleImports = [...source.matchAll(/from '(\.\.\/[^']+)'/g)]
      .map((match) => match[1])
      .filter((target) => !target.startsWith('../../common/'));

    // Upstream's planner helpers are reused rather than copied (FORK_MAINTENANCE, "Watched
    // cross-module import"); nothing else outside common/ may be reached.
    expect(crossModuleImports.sort()).toEqual(['../migration/planner/matching.service', '../migration/planner/planner.types']);
  });
});

describe('normalizePathMappings', () => {
  it('canonicalizes both sides and keeps mappable rows', () => {
    expect(normalizePathMappings([{ localPrefix: ' /books// ', remotePrefix: '/data/library/' }])).toEqual([
      { localPrefix: '/books', remotePrefix: '/data/library' },
    ]);
  });

  it('drops rows that could never translate a path', () => {
    expect(
      normalizePathMappings([
        { localPrefix: '/', remotePrefix: '/data' },
        { localPrefix: '/books', remotePrefix: '/' },
        { localPrefix: '', remotePrefix: '/data' },
        { localPrefix: 'books', remotePrefix: '/data' },
      ]),
    ).toEqual([]);
  });

  it('keeps the first row when a prefix repeats on either side', () => {
    expect(
      normalizePathMappings([
        { localPrefix: '/books', remotePrefix: '/data/one' },
        { localPrefix: '/books/', remotePrefix: '/data/two' },
        { localPrefix: '/other', remotePrefix: '/data/one' },
      ]),
    ).toEqual([{ localPrefix: '/books', remotePrefix: '/data/one' }]);
  });

  it('tolerates a missing mapping list', () => {
    expect(normalizePathMappings(null)).toEqual([]);
  });
});

describe('assertMappablePathMappings', () => {
  it('accepts prefixes that name a folder', () => {
    expect(() => assertMappablePathMappings(MAPPINGS)).not.toThrow();
  });

  it('rejects a root prefix', () => {
    expect(() => assertMappablePathMappings([{ localPrefix: '/', remotePrefix: '/data' }])).toThrow(InvalidPathMappingError);
  });

  it('rejects a relative prefix', () => {
    expect(() => assertMappablePathMappings([{ localPrefix: 'books/library', remotePrefix: '/data' }])).toThrow(/absolute/i);
    expect(() => assertMappablePathMappings([{ localPrefix: '/books', remotePrefix: 'data/library' }])).toThrow(/absolute/i);
  });

  it('rejects a repeated BookOrbit prefix instead of dropping it', () => {
    expect(() =>
      assertMappablePathMappings([
        { localPrefix: '/books', remotePrefix: '/data/one' },
        { localPrefix: '/books/', remotePrefix: '/data/two' },
      ]),
    ).toThrow(/BookOrbit path prefix/);
  });

  it('rejects a repeated Storyteller prefix instead of dropping it', () => {
    expect(() =>
      assertMappablePathMappings([
        { localPrefix: '/books', remotePrefix: '/data/one' },
        { localPrefix: '/other', remotePrefix: '/data/one/' },
      ]),
    ).toThrow(/Storyteller path prefix/);
  });

  it('rejects a BookOrbit prefix nested inside another, either way round', () => {
    expect(() =>
      assertMappablePathMappings([
        { localPrefix: '/books', remotePrefix: '/data/one' },
        { localPrefix: '/books/audio', remotePrefix: '/data/two' },
      ]),
    ).toThrow(/BookOrbit path prefixes cannot contain one another/);

    expect(() =>
      assertMappablePathMappings([
        { localPrefix: '/books/audio', remotePrefix: '/data/one' },
        { localPrefix: '/books', remotePrefix: '/data/two' },
      ]),
    ).toThrow(/BookOrbit path prefixes cannot contain one another/);
  });

  it('rejects a Storyteller prefix nested inside another, so the two directions stay inverses', () => {
    // Without this guard /a/sub/c maps out to /x/sub/c and back to /b/c.
    expect(() =>
      assertMappablePathMappings([
        { localPrefix: '/a', remotePrefix: '/x' },
        { localPrefix: '/b', remotePrefix: '/x/sub' },
      ]),
    ).toThrow(/Storyteller path prefixes cannot contain one another/);
  });

  it('accepts prefixes that merely share a textual head', () => {
    expect(() =>
      assertMappablePathMappings([
        { localPrefix: '/books', remotePrefix: '/data/one' },
        { localPrefix: '/booksshelf', remotePrefix: '/data/oneshot' },
      ]),
    ).not.toThrow();
  });

  it('stays a bad request so the settings route answers 400', () => {
    expect(() => assertMappablePathMappings([{ localPrefix: '/', remotePrefix: '/data' }])).toThrow(BadRequestException);
  });
});

describe('toRemotePath / toLocalPath', () => {
  it('translates in both directions', () => {
    expect(toRemotePath('/books/text/Author/Title.epub', MAPPINGS)).toBe('/storyteller/library/Author/Title.epub');
    expect(toLocalPath('/storyteller/library/Author/Title.epub', MAPPINGS)).toBe('/books/text/Author/Title.epub');
  });

  it('is an inverse of itself for every mappable path', () => {
    for (const localPath of ['/books/text/Author/Title.epub', '/books/audio/Title/01.mp3', '/books/audio/sub/deep/02.mp3']) {
      expect(toLocalPath(toRemotePath(localPath, MAPPINGS), MAPPINGS)).toBe(localPath);
    }
  });

  it('lets the longest matching prefix win in both directions', () => {
    expect(toRemotePath('/books/audio/Title/01.mp3', LEGACY_NESTED_MAPPINGS)).toBe('/storyteller/library/audio/Title/01.mp3');
    expect(toLocalPath('/storyteller/library/audio/Title/01.mp3', LEGACY_NESTED_MAPPINGS)).toBe('/books/audio/Title/01.mp3');
  });

  it('returns null for a path no mapping covers', () => {
    expect(toRemotePath('/elsewhere/Title.epub', MAPPINGS)).toBeNull();
    expect(toLocalPath('/mnt/other/Title.epub', MAPPINGS)).toBeNull();
  });

  it('returns null without mappings and for an empty path', () => {
    expect(toRemotePath('/books/text/Title.epub', [])).toBeNull();
    expect(toLocalPath('', MAPPINGS)).toBeNull();
  });

  it('matches a prefix only on a segment boundary', () => {
    expect(toRemotePath('/books/textbooks/Title.epub', MAPPINGS)).toBeNull();
  });

  it('normalizes duplicate separators before translating', () => {
    expect(toRemotePath('/books/text//Author//Title.epub', MAPPINGS)).toBe('/storyteller/library/Author/Title.epub');
  });

  it('resolves traversal before deciding a path is covered, and after rewriting it', () => {
    // Escapes the mapped root, so it is not a path this mapping covers at all.
    expect(toLocalPath('/storyteller/library/../../elsewhere/Title.epub', MAPPINGS)).toBeNull();
    expect(toRemotePath('/books/text/Author/../Other/Title.epub', MAPPINGS)).toBe('/storyteller/library/Other/Title.epub');
  });
});

describe('storytellerSafeFilepathSegment', () => {
  it('replaces the characters Storyteller refuses in a filename', () => {
    expect(storytellerSafeFilepathSegment('Dune: Part One', '.epub')).toBe('Dune- Part One.epub');
    expect(storytellerSafeFilepathSegment('AC/DC \\ Back?', '.epub')).toBe('AC-DC - Back.epub');
    expect(storytellerSafeFilepathSegment('A "quoted" <title> | pipe*', '.epub')).toBe('A -quoted- -title- - pipe.epub');
  });

  it('collapses whitespace and drops trailing dots and dashes', () => {
    expect(storytellerSafeFilepathSegment('  The   Hobbit  ', '.epub')).toBe('The Hobbit.epub');
    expect(storytellerSafeFilepathSegment('Vol. 1...', '.epub')).toBe('Vol. 1.epub');
    // Storyteller trims before it strips the trailing dashes, so the space it uncovers stays.
    expect(storytellerSafeFilepathSegment('Trailing -- ', '.epub')).toBe('Trailing .epub');
  });

  it('drops a leading dot, which would make the read-along a file no scanner walk indexes', () => {
    expect(storytellerSafeFilepathSegment('.hack//SIGN', '.epub')).toBe('hack--SIGN.epub');
    expect(storytellerSafeFilepathSegment('...And Justice for All', '.epub')).toBe('And Justice for All.epub');
    // Nothing but dots is still nothing: callers fall back to their own name rather than publish
    // a hidden file every such title would share.
    expect(expectedCustomFolderOutputPath('/storyteller/readalongs', '..')).toBeNull();
  });

  it('keeps unicode and never splits a code point', () => {
    expect(storytellerSafeFilepathSegment('Café Naïve 日本語', '.epub')).toBe('Café Naïve 日本語.epub');

    const longUnicodeTitle = 'é'.repeat(200);
    const truncated = storytellerSafeFilepathSegment(longUnicodeTitle, '.epub');
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(150);
    // 145 bytes are left for the name once the 5-byte suffix is reserved, at 2 bytes per character.
    expect(truncated).toBe(`${'é'.repeat(72)}.epub`);
  });

  it('cuts a long title to 150 bytes including the suffix', () => {
    const truncated = storytellerSafeFilepathSegment('a'.repeat(400), '.epub');
    expect(truncated).toBe(`${'a'.repeat(145)}.epub`);
    expect(Buffer.byteLength(truncated, 'utf8')).toBe(150);
  });

  it('defaults to no suffix', () => {
    expect(storytellerSafeFilepathSegment('Plain Title')).toBe('Plain Title');
  });
});

describe('expectedCustomFolderOutputPath', () => {
  it('joins the configured folder with the sanitized title', () => {
    expect(expectedCustomFolderOutputPath('/storyteller/readalongs/', 'Dune: Part One')).toBe('/storyteller/readalongs/Dune- Part One.epub');
  });

  it('returns null without a folder', () => {
    expect(expectedCustomFolderOutputPath(null, 'Dune')).toBeNull();
  });

  it('returns null when the title sanitizes away, instead of a shared hidden file', () => {
    expect(expectedCustomFolderOutputPath('/storyteller/readalongs', '???')).toBeNull();
    expect(expectedCustomFolderOutputPath('/storyteller/readalongs', '   ')).toBeNull();
    expect(expectedCustomFolderOutputPath('/storyteller/readalongs', '...')).toBeNull();
  });
});
