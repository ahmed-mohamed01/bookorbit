import { describe, expect, it } from 'vitest';

import type { EngineUnitSpec } from './engines/web-serial-engine';
import { carriedVolumes, countAvailableMembers, countMembers, describeMoveUnit, indexSavedUnits } from './web-serials-move.utils';

const volume = {
  unitKey: 'vol:3',
  label: 'Volume 3',
  sequence: '3',
  chapterCount: 2,
  publishedAt: null,
  volume: '3',
  packaging: 'volume',
  remote: { chapters: [{ sequence: '20' }, { sequence: '21' }] },
} as unknown as EngineUnitSpec;

const empty = indexSavedUnits([]);

describe('describeMoveUnit', () => {
  it('expands a volume item into the chapter sequences of its members', () => {
    const unit = describeMoveUnit({ id: 1, sequence: '3', remoteRef: { unit: volume } }, empty.byKey, empty.bySequence);

    expect(unit).toEqual({ id: 1, sequence: '3', members: ['20', '21'], volume: '3' });
  });

  it('treats a chapter item as its own single member', () => {
    const unit = describeMoveUnit({ id: 2, sequence: '7', remoteRef: { unit: { packaging: 'chapter', remote: {} } } }, empty.byKey, empty.bySequence);

    expect(unit).toEqual({ id: 2, sequence: '7', members: ['7'], volume: null });
  });

  it('reads the saved job units when the item carries no remote reference, by unit key before sequence', () => {
    const chapter = { ...volume, unitKey: 'c3', packaging: 'chapter', volume: undefined, remote: {} } as unknown as EngineUnitSpec;
    const saved = indexSavedUnits([chapter, volume]);

    expect(describeMoveUnit({ id: 3, sequence: '3', unitKey: 'vol:3' }, saved.byKey, saved.bySequence).members).toEqual(['20', '21']);
    expect(describeMoveUnit({ id: 4, sequence: '3', unitKey: 'c3' }, saved.byKey, saved.bySequence).members).toEqual(['3']);
  });
});

describe('move counts and carried volumes', () => {
  const units = [
    describeMoveUnit({ id: 1, sequence: '3', remoteRef: { unit: volume } }, empty.byKey, empty.bySequence),
    describeMoveUnit({ id: 2, sequence: '22' }, empty.byKey, empty.bySequence),
  ];

  it('counts chapters rather than units', () => {
    expect(countMembers(units)).toBe(3);
    expect(countAvailableMembers(units, new Set(['20', '21', '22']))).toBe(3);
    expect(countAvailableMembers(units, new Set(['20', '22']))).toBe(1);
  });

  it('maps the source volume of each moved chapter onto the target unit keys', () => {
    const targets = [20, 21, 22].map((n) => ({ unitKey: `t${n}`, sequence: `${n}.0` }) as EngineUnitSpec);

    expect(carriedVolumes(units, targets)).toEqual({ t20: '3', t21: '3' });
    expect(carriedVolumes([units[1]!], targets)).toBeNull();
  });
});
