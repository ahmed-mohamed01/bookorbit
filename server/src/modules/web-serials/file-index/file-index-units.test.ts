import { describe, expect, it } from 'vitest';

import { fileIndexUnits, unitLabel } from './file-index-units';

const file = (id: number, name: string, volume: number) => ({ id, path: `S/${name}`, name, size: 1, volume });

describe('fileIndexUnits', () => {
  it('files numbered volumes as those volumes, in order, with stable keys', () => {
    const units = fileIndexUnits([
      file(2, 'S - Volume 02 - A Love Bite [June][Kindle].epub', 2),
      file(1, 'S - Volume 01 - Spy Sensation [June][Kindle].epub', 1),
    ]);
    expect(units).toEqual([
      expect.objectContaining({ unitKey: 'volume-1', sequence: '1', volume: '1', label: 'Volume 1: Spy Sensation', packaging: 'volume' }),
      expect.objectContaining({ unitKey: 'volume-2', sequence: '2', volume: '2', label: 'Volume 2: A Love Bite' }),
    ]);
    expect(units[0]!.remote).toEqual({ fileId: 1, path: 'S/S - Volume 01 - Spy Sensation [June][Kindle].epub' });
  });

  it('numbers by position when parts restart their volume numbers', () => {
    const units = fileIndexUnits([file(2, 'A Part 2 Vol 1.epub', 1), file(1, 'A Part 1 Vol 1.epub', 1), file(3, 'A Part 1 Vol 2.epub', 2)]);
    expect(units.map((unit) => [unit.unitKey, unit.sequence, unit.label])).toEqual([
      ['part-1-volume-1', '1', 'Part 1 Volume 1'],
      ['part-1-volume-2', '2', 'Part 1 Volume 2'],
      ['part-2-volume-1', '3', 'Part 2 Volume 1'],
    ]);
  });
});

describe('unitLabel', () => {
  it('heads a trailing-number volume like a marked one', () => {
    expect(unitLabel({ name: 'Series 07 [Yen Press].epub', volume: 7 })).toBe('Volume 7');
    expect(unitLabel({ name: 'Series Vol. 3.epub', volume: 3 })).toBe('Volume 3');
  });
});
