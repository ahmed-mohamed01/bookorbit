import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { makeSeriesKey, parseSeriesKey, seriesCoverPath } from './web-serials-series-key.utils';

describe('series keys', () => {
  it('round trips both kinds', () => {
    expect(parseSeriesKey(makeSeriesKey('manga', '123'))).toEqual({ kind: 'manga', remoteId: '123' });
    expect(parseSeriesKey('n:39a44bd3-ad95-4c24-a122-affaaa663c72')).toEqual({ kind: 'novel', remoteId: '39a44bd3-ad95-4c24-a122-affaaa663c72' });
  });

  it('round trips LNReader source and path keys', () => {
    const remoteId = `source-a:${Buffer.from('/novel/one').toString('base64url')}`;
    const key = makeSeriesKey('novel', remoteId);
    expect(key).toMatch(/^nl:source-a:/);
    expect(parseSeriesKey(key)).toEqual({ kind: 'novel', remoteId });
  });

  it.each(['x:1', 'm:', 'm:../etc', 'm:1/2', 'm:1 2', '123'])('rejects %s', (key) => {
    expect(() => parseSeriesKey(key)).toThrow(BadRequestException);
  });

  it('builds the same-origin cover path', () => {
    expect(seriesCoverPath('m:5')).toBe('/api/v1/web-serials/series/m:5/cover');
  });
});

it('print series keys include alt titles and suffix variants and are bounded', async () => {
  const { printSeriesKeys } = await import('./web-serials-series-key.utils');
  expect(printSeriesKeys(' Story ', ['OTHER', 'story'])).toEqual(['story', 'story (light novel)', 'other', 'other (light novel)']);
  expect(
    printSeriesKeys(
      'Story',
      Array.from({ length: 10 }, (_, i) => String(i)),
    ),
  ).toHaveLength(12);
});
