import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { isFileIndexRemoteId, makeSeriesKey, parseSeriesKey, SERIES_KEY_FORMAT, seriesCoverPath } from './web-serials-series-key.utils';

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

  it('round trips file index series without a colon in the remote id', () => {
    const key = makeSeriesKey('novel', 'fi-3-42');
    expect(key).toBe('nf:3-42');
    expect(parseSeriesKey(key)).toEqual({ kind: 'novel', remoteId: 'fi-3-42' });
    expect(SERIES_KEY_FORMAT.test(key)).toBe(true);
    expect(isFileIndexRemoteId('fi-3-42')).toBe(true);
    expect(isFileIndexRemoteId('3-42')).toBe(false);
    expect(isFileIndexRemoteId(undefined)).toBe(false);
  });

  it.each(['x:1', 'm:', 'nf:3', 'nf:a-1', 'nf:3:42', 'm:../etc', 'm:1/2', 'm:1 2', '123'])('rejects %s', (key) => {
    expect(() => parseSeriesKey(key)).toThrow(BadRequestException);
  });

  it('builds the same-origin cover path', () => {
    expect(seriesCoverPath('m:5')).toBe('/api/v1/web-serials/series/m:5/cover');
  });
});
