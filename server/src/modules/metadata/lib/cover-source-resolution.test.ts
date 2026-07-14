import { describe, expect, it } from 'vitest';

import {
  buildSidecarCoverPathByBookId,
  resolveCoverReadOrder,
  selectSidecarCoverPath,
  sidecarCoverRanksAboveEmbedded,
} from './cover-source-resolution';

describe('sidecarCoverRanksAboveEmbedded', () => {
  it('ranks sidecar above embedded under the default precedence', () => {
    expect(sidecarCoverRanksAboveEmbedded(undefined)).toBe(true);
    expect(sidecarCoverRanksAboveEmbedded([])).toBe(true);
    expect(sidecarCoverRanksAboveEmbedded(['folderStructure', 'sidecar', 'embedded', 'opfFile'])).toBe(true);
  });

  it('respects an explicit embedded-first ordering', () => {
    expect(sidecarCoverRanksAboveEmbedded(['embedded', 'sidecar', 'opfFile'])).toBe(false);
  });

  it('treats an absent entry as ranked below a present one', () => {
    expect(sidecarCoverRanksAboveEmbedded(['sidecar', 'opfFile'])).toBe(true);
    expect(sidecarCoverRanksAboveEmbedded(['embedded', 'opfFile'])).toBe(false);
    expect(sidecarCoverRanksAboveEmbedded(['opfFile'])).toBe(false);
  });
});

describe('resolveCoverReadOrder', () => {
  const primaryFile = { absolutePath: '/library/Book/book.m4b', format: 'm4b' };

  it('reads the sidecar cover first when it ranks above embedded', () => {
    const order = resolveCoverReadOrder({
      precedence: ['sidecar', 'embedded'],
      primaryFile,
      sidecarCoverPath: '/library/Book/cover.jpg',
    });
    expect(order).toEqual([
      { kind: 'sidecar', absolutePath: '/library/Book/cover.jpg' },
      { kind: 'embedded', absolutePath: primaryFile.absolutePath, format: 'm4b' },
    ]);
  });

  it('reads the embedded cover first with the sidecar as fallback when embedded ranks above', () => {
    const order = resolveCoverReadOrder({
      precedence: ['embedded', 'sidecar'],
      primaryFile,
      sidecarCoverPath: '/library/Book/cover.jpg',
    });
    expect(order).toEqual([
      { kind: 'embedded', absolutePath: primaryFile.absolutePath, format: 'm4b' },
      { kind: 'sidecar', absolutePath: '/library/Book/cover.jpg' },
    ]);
  });

  it('omits sources that are unavailable', () => {
    expect(resolveCoverReadOrder({ precedence: ['sidecar', 'embedded'], primaryFile: null, sidecarCoverPath: '/c.jpg' })).toEqual([
      { kind: 'sidecar', absolutePath: '/c.jpg' },
    ]);
    expect(resolveCoverReadOrder({ precedence: ['sidecar', 'embedded'], primaryFile, sidecarCoverPath: null })).toEqual([
      { kind: 'embedded', absolutePath: primaryFile.absolutePath, format: 'm4b' },
    ]);
    expect(
      resolveCoverReadOrder({ precedence: ['sidecar', 'embedded'], primaryFile: { absolutePath: '/b', format: null }, sidecarCoverPath: null }),
    ).toEqual([]);
  });
});

describe('selectSidecarCoverPath', () => {
  it('picks a strict cover.* file and ignores other cover-role images', () => {
    expect(
      selectSidecarCoverPath([
        { absolutePath: '/library/Book/front.png', format: 'png' },
        { absolutePath: '/library/Book/cover.jpg', format: 'jpg' },
      ]),
    ).toBe('/library/Book/cover.jpg');
  });

  it('tie-breaks by extension priority (jpg > png)', () => {
    expect(
      selectSidecarCoverPath([
        { absolutePath: '/library/Book/cover.png', format: 'png' },
        { absolutePath: '/library/Book/cover.jpg', format: 'jpg' },
      ]),
    ).toBe('/library/Book/cover.jpg');
  });

  it('rejects unsupported extensions and non-cover stems', () => {
    expect(selectSidecarCoverPath([{ absolutePath: '/library/Book/cover.tiff', format: 'tiff' }])).toBeNull();
    expect(selectSidecarCoverPath([{ absolutePath: '/library/Book/folder.jpg', format: 'jpg' }])).toBeNull();
    expect(selectSidecarCoverPath([{ absolutePath: '/library/Book/cover', format: null }])).toBeNull();
  });
});

describe('buildSidecarCoverPathByBookId', () => {
  it('resolves the winning cover per book from a batched row set', () => {
    const map = buildSidecarCoverPathByBookId([
      { bookId: 1, absolutePath: '/a/cover.png', format: 'png' },
      { bookId: 1, absolutePath: '/a/cover.jpg', format: 'jpg' },
      { bookId: 2, absolutePath: '/b/front.jpg', format: 'jpg' },
      { bookId: 3, absolutePath: '/c/cover.webp', format: 'webp' },
    ]);
    expect(map.get(1)).toBe('/a/cover.jpg');
    expect(map.has(2)).toBe(false);
    expect(map.get(3)).toBe('/c/cover.webp');
  });
});
