import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...clauses: unknown[]) => ({ op: 'and', clauses })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: 'eq', left, right })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', text: strings.join(''), values })),
}));

import { eq, sql } from 'drizzle-orm';

import { MonitoredAuthorStoreService } from './monitored-author-store.service';

describe('MonitoredAuthorStoreService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes an orphan author in one statement guarded on both books and monitors', async () => {
    const deleteBuilder = { where: vi.fn(), returning: vi.fn() };
    deleteBuilder.where.mockReturnValue(deleteBuilder);
    deleteBuilder.returning.mockResolvedValue([]);
    const db = { delete: vi.fn().mockReturnValue(deleteBuilder) };
    const store = new MonitoredAuthorStoreService(db as never);

    await expect(store.deleteOrphanAuthor(35)).resolves.toBe(false);

    const guards = vi.mocked(sql).mock.calls.filter(([strings]) => (strings as unknown as string[]).join('').includes('NOT EXISTS'));
    expect(guards).toHaveLength(2);
    expect(deleteBuilder.where).toHaveBeenCalledOnce();
    expect(eq).toHaveBeenCalledWith(expect.anything(), 35);
  });
});
