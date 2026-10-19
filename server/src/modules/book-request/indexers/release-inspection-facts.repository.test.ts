import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { DB } from '../../../db';
import { ReleaseInspectionFactsRepository } from './release-inspection-facts.repository';
import { releaseInspectionFacts } from '../schema/release-inspection-facts.schema';

describe('ReleaseInspectionFactsRepository', () => {
  it('does not query empty hashes and reads all requested hashes in one query', async () => {
    const facts = { infoHash: 'abc', fileCount: 1, unitCount: 1, primaryFileCount: 1, formats: ['epub'] };
    const where = vi.fn().mockResolvedValue([facts]);
    const from = vi.fn().mockReturnValue({ where });
    const db = { select: vi.fn().mockReturnValue({ from }) };
    const module = await Test.createTestingModule({ providers: [ReleaseInspectionFactsRepository, { provide: DB, useValue: db }] }).compile();
    const repo = module.get(ReleaseInspectionFactsRepository);
    expect(await repo.findByHashes([])).toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
    expect(await repo.findByHashes(['abc', 'def'])).toEqual(new Map([['abc', facts]]));
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.select).toHaveBeenCalledWith(expect.objectContaining({ unitCount: releaseInspectionFacts.unitCount }));
    where.mockResolvedValue([{ ...facts, unitCount: null }]);
    expect((await repo.findByHashes(['abc'])).get('abc')?.unitCount).toBeUndefined();
    expect(from).toHaveBeenCalledWith(releaseInspectionFacts);
  });
  it('upserts twice using the hash conflict target and replaces facts', async () => {
    const rows = new Map();
    const onConflictDoUpdate = vi.fn();
    const values = vi.fn().mockImplementation((row) => ({
      onConflictDoUpdate: (conflict: { target: unknown; set: object }) => {
        onConflictDoUpdate(conflict);
        rows.set(row.infoHash, rows.has(row.infoHash) ? { ...row, ...conflict.set } : row);
        return Promise.resolve();
      },
    }));
    const db = {
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({ from: () => ({ where: () => Promise.resolve([...rows.values()]) }) }),
    };
    const module = await Test.createTestingModule({ providers: [ReleaseInspectionFactsRepository, { provide: DB, useValue: db }] }).compile();
    const repo = module.get(ReleaseInspectionFactsRepository);
    const facts = { infoHash: 'abc', fileCount: 1, unitCount: 1, primaryFileCount: 1, formats: ['epub'] };
    await repo.upsert(facts);
    await repo.upsert({ ...facts, fileCount: 2, unitCount: 4 });
    expect((await repo.findByHashes(['abc'])).get('abc')?.unitCount).toBe(4);
    expect(rows.size).toBe(1);
    expect(rows.get('abc').fileCount).toBe(2);
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: releaseInspectionFacts.infoHash,
      set: expect.objectContaining({ fileCount: 2, unitCount: 4, inspectedAt: expect.any(Date) }),
    });
  });
});
