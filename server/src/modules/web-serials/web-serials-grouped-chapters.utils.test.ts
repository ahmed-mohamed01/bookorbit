import { describe, expect, it } from 'vitest';

import type { EngineUnitSpec } from './engines/web-serial-engine';
import { isGroupedMangaUnit, memberSequence, memberUnitKey, parseGroupedChapters, seriesRangeNumber } from './web-serials-grouped-chapters.utils';

const unit = (chapters: unknown): EngineUnitSpec => ({
  unitKey: 'vol:1',
  label: 'Volume 1',
  sequence: '1',
  chapterCount: 2,
  publishedAt: null,
  packaging: 'volume',
  remote: { chapters },
});

describe('grouped chapter parsing', () => {
  it('reads each member once with typed fields and keeps the raw description', () => {
    const [first, second] = parseGroupedChapters(unit([{ chapterId: 7, sequence: 3, label: 'Three' }, { publishedAt: '2026-01-01' }]));

    expect(first).toMatchObject({ chapterId: '7', sequence: '3', label: 'Three', publishedAt: null });
    expect(first!.raw).toEqual({ chapterId: 7, sequence: 3, label: 'Three' });
    expect(second).toMatchObject({ chapterId: null, sequence: null, label: null, publishedAt: '2026-01-01' });
  });

  it('falls back to the unit key and position for a member without ids', () => {
    const [chapter] = parseGroupedChapters(unit([{}]));

    expect(memberUnitKey(chapter!, 'vol:1', 0)).toBe('vol:1:1');
    expect(memberSequence(chapter!, 0)).toBe('1');
  });

  it('describes a book range from its first and last chapter, or the unit sequence without them', () => {
    expect(seriesRangeNumber(unit([{ sequence: '4' }, { sequence: '9' }]))).toBe('4-9');
    expect(seriesRangeNumber(unit([{}, {}]))).toBe('1');
  });

  it('rejects a malformed description and only groups manga units that carry chapters', () => {
    expect(() => parseGroupedChapters(unit('nope'))).toThrow('invalid');
    expect(() => parseGroupedChapters(unit([1]))).toThrow('invalid');
    expect(isGroupedMangaUnit('manga', unit([]))).toBe(true);
    expect(isGroupedMangaUnit('novel', unit([]))).toBe(false);
    expect(isGroupedMangaUnit('manga', undefined)).toBe(false);
  });
});
