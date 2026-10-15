import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { EngineSeries, EngineUnitSpec } from './engines/web-serial-engine';
import { assertValidSelection, packagingAllowedFor, selectUnits, toWebSerialSelection } from './web-serials-selection.utils';

const unit = (sequence: string, packaging: EngineUnitSpec['packaging'] = 'chapter'): EngineUnitSpec => ({
  unitKey: `u${sequence}`,
  label: `Unit ${sequence}`,
  sequence,
  chapterCount: 10,
  publishedAt: null,
  packaging,
  remote: { id: sequence },
});

const series = (units: EngineUnitSpec[]): EngineSeries => ({ title: 'Saga', units }) as EngineSeries;

describe('selectUnits', () => {
  it('returns every unit for mode all', () => {
    expect(selectUnits(series([unit('1'), unit('2')]), 'chapter', { mode: 'all' }).map((u) => u.sequence)).toEqual(['1', '2']);
  });

  it('selects an inclusive numeric range including decimals', () => {
    const result = selectUnits(series([unit('1'), unit('2'), unit('2.5'), unit('10')]), 'chapter', {
      mode: 'range',
      fromSequence: '2',
      toSequence: '10',
    });
    expect(result.map((u) => u.sequence)).toEqual(['2', '2.5', '10']);
  });

  it('selects an exact numeric-aware list', () => {
    const result = selectUnits(series([unit('1'), unit('2'), unit('2.5'), unit('10')]), 'chapter', {
      mode: 'list',
      sequences: ['02.500', '10.0'],
    });
    expect(result.map((u) => u.sequence)).toEqual(['2.5', '10']);
  });

  it('folds the selected volumes into one series unit', () => {
    const result = selectUnits(series([unit('1', 'volume'), unit('2', 'volume'), unit('3', 'volume')]), 'series', {
      mode: 'range',
      fromSequence: '2',
      toSequence: '3',
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ unitKey: 'series', packaging: 'series', chapterCount: 20, remote: { volumes: [{ id: '2' }, { id: '3' }] } });
  });

  it('returns nothing when the range matches no unit', () => {
    expect(selectUnits(series([unit('1', 'volume')]), 'series', { mode: 'range', fromSequence: '5', toSequence: '6' })).toEqual([]);
  });

  it('groups known manga volumes and keeps unknown chapters as chapter books', () => {
    const first = { ...unit('1'), volume: '1' };
    const result = selectUnits(
      { ...series([first, unit('2'), unit('3')]), kind: 'manga', status: 'completed' },
      'volume',
      { mode: 'all' },
      { u3: '1' },
    );

    expect(result).toEqual([
      expect.objectContaining({
        unitKey: 'vol:1',
        sequence: '1',
        packaging: 'volume',
        chapterCount: 20,
        remote: { chapters: [{ id: '1' }, { id: '3' }] },
      }),
      expect.objectContaining({ unitKey: 'u2', packaging: 'chapter' }),
    ]);
  });

  describe('the newest volume of a series that can still grow', () => {
    const chapter = (sequence: string, volume: string | null, extra = false): EngineUnitSpec => ({
      ...unit(sequence),
      ...(volume ? { volume } : {}),
      ...(extra ? { positional: true } : {}),
    });
    const units = [chapter('98', '11'), chapter('99', '11'), chapter('100', '12'), chapter('103', '12'), chapter('103.001', '12', true)];

    it('carries its chapter range in the key while the series is ongoing, and every volume records its range', () => {
      const result = selectUnits({ ...series(units), kind: 'manga', status: 'ongoing' } as EngineSeries, 'volume', { mode: 'all' });
      expect(result.map((u) => [u.unitKey, u.chapterRange])).toEqual([
        ['vol:11', { from: 98, to: 99 }],
        ['vol:12:100-103', { from: 100, to: 103 }],
      ]);
    });

    it('keeps the plain key once the series is finished or a newer chapter sits outside the volume', () => {
      const finished = selectUnits({ ...series(units), kind: 'manga', status: 'completed' } as EngineSeries, 'volume', { mode: 'all' });
      expect(finished.map((u) => u.unitKey)).toEqual(['vol:11', 'vol:12']);
      const closed = selectUnits({ ...series([...units, chapter('104', null)]), kind: 'manga', status: 'ongoing' } as EngineSeries, 'volume', {
        mode: 'all',
      });
      expect(closed.map((u) => u.unitKey)).toEqual(['vol:11', 'vol:12', 'u104']);
    });
  });

  describe('per-volume manga with chapters outside volumes', () => {
    const chapter = (sequence: string, volume: string | null): EngineUnitSpec => ({ ...unit(sequence), ...(volume ? { volume } : {}) });
    const onePiece = series([
      chapter('1071', '106'),
      chapter('1072', '106'),
      chapter('1072.1', '106'),
      chapter('1073', '106'),
      chapter('1079', '107'),
      chapter('1080', '107'),
      chapter('1080.1', null),
      chapter('1081', '107'),
      chapter('1082', '107'),
      chapter('1180', null),
      chapter('1181', null),
      chapter('1193', null),
    ]);
    const manga = { ...onePiece, kind: 'manga' } as EngineSeries;
    const shape = (units: EngineUnitSpec[]) => units.map((u) => (u.packaging === 'volume' ? `${u.unitKey}[${u.chapterCount / 10}]` : u.unitKey));

    it('keeps unvolumed chapters, in between and trailing, as chapter books beside whole volumes', () => {
      expect(shape(selectUnits(manga, 'volume', { mode: 'all' }))).toEqual(['vol:106[4]', 'vol:107[4]', 'u1080.1', 'u1180', 'u1181', 'u1193']);
    });

    it('snaps a range that starts mid-volume to the whole volume', () => {
      const result = selectUnits(manga, 'volume', { mode: 'range', fromSequence: '1072.1', toSequence: '1193' });
      expect(shape(result)).toEqual(['vol:106[4]', 'vol:107[4]', 'u1080.1', 'u1180', 'u1181', 'u1193']);
      expect(result[0]!.remote).toEqual({ chapters: [{ id: '1071' }, { id: '1072' }, { id: '1072.1' }, { id: '1073' }] });
    });

    it('snaps the end of a range to the last chapter of its volume', () => {
      expect(shape(selectUnits(manga, 'volume', { mode: 'range', fromSequence: '1079', toSequence: '1080' }))).toEqual(['vol:107[4]', 'u1080.1']);
    });

    it('files the chapters of a volume that is only partly listed as chapter books and never as the volume', () => {
      const result = selectUnits(manga, 'volume', { mode: 'list', sequences: ['1079', '1080', '1180'] });
      expect(shape(result)).toEqual(['u1079', 'u1080', 'u1180']);
      expect(result.every((u) => u.packaging === 'chapter')).toBe(true);
    });

    it('reads volumes from the volume database for chapters whose name has none', () => {
      const unnamed = { ...onePiece, kind: 'manga', units: onePiece.units.map((u) => ({ ...u, volume: null })) } as EngineSeries;
      const map = Object.fromEntries(onePiece.units.filter((u) => u.volume).map((u) => [u.unitKey, u.volume!]));
      expect(shape(selectUnits(unnamed, 'volume', { mode: 'all' }, map))).toEqual(['vol:106[4]', 'vol:107[4]', 'u1080.1', 'u1180', 'u1181', 'u1193']);
    });
  });

  it('groups a manga selection into one ordered unit with a stable range key', () => {
    const result = selectUnits({ ...series([unit('1'), unit('2'), unit('3')]), kind: 'manga' }, 'series', {
      mode: 'range',
      fromSequence: '2',
      toSequence: '3',
    });

    expect(result).toEqual([
      expect.objectContaining({ unitKey: 'sel:u2-u3', label: 'Chapters 2-3', packaging: 'series', remote: { chapters: [{ id: '2' }, { id: '3' }] } }),
    ]);
  });
});

describe('selection validation', () => {
  it('rejects an inverted range', () => {
    expect(() => assertValidSelection({ mode: 'range', fromSequence: '5', toSequence: '2' })).toThrow(BadRequestException);
    expect(() => assertValidSelection({ mode: 'range', fromSequence: '2', toSequence: '5' })).not.toThrow();
  });

  it('requires 1 to 5000 valid list sequences', () => {
    expect(() => assertValidSelection({ mode: 'list', sequences: ['1', '2.5'] })).not.toThrow();
    expect(() => assertValidSelection({ mode: 'list', sequences: [] })).toThrow(BadRequestException);
    expect(() => assertValidSelection({ mode: 'list', sequences: ['-1'] })).toThrow(BadRequestException);
    expect(() => assertValidSelection({ mode: 'list', sequences: Array.from({ length: 5001 }, () => '1') })).toThrow(BadRequestException);
  });

  it('ties packaging to the kind', () => {
    expect(packagingAllowedFor('manga', 'chapter')).toBe(true);
    expect(packagingAllowedFor('manga', 'volume')).toBe(true);
    expect(packagingAllowedFor('manga', 'series')).toBe(true);
    expect(packagingAllowedFor('novel', 'series')).toBe(true);
    expect(packagingAllowedFor('novel', 'chapter')).toBe(false);
  });
});

describe('toWebSerialSelection', () => {
  it('narrows every mode and refuses a mode with missing fields', () => {
    expect(toWebSerialSelection({ mode: 'all' })).toEqual({ mode: 'all' });
    expect(toWebSerialSelection({ mode: 'list', sequences: ['1'] })).toEqual({ mode: 'list', sequences: ['1'] });
    expect(toWebSerialSelection({ mode: 'range', fromSequence: '1', toSequence: '5' })).toEqual({
      mode: 'range',
      fromSequence: '1',
      toSequence: '5',
    });
    expect(() => toWebSerialSelection({ mode: 'list' })).toThrow(BadRequestException);
    expect(() => toWebSerialSelection({ mode: 'range', toSequence: '5' })).toThrow(BadRequestException);
  });
});
