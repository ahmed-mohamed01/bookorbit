import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import { AudioConvertJobPageRepository } from './audio-convert-job-page.repository';

function setup() {
  const where = vi.fn<(condition: SQL) => Promise<unknown[]>>(() => Promise.resolve([]));
  const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) };
  return { repository: new AudioConvertJobPageRepository(db as never), where };
}

async function countedWhere(owner: { id: number; ownerless: boolean } | null) {
  const { repository, where } = setup();
  await repository.countForJobs({ owner, libraryIds: null }, new Date('2026-11-08T12:00:00.000Z'));
  return new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
}

describe('AudioConvertJobPageRepository', () => {
  it("never counts an automatic job as the account's own, though it is stored under the admin who saved the settings", async () => {
    const query = await countedWhere({ id: 7, ownerless: false });
    expect(query.sql).toContain('"user_id" = $');
    expect(query.sql).toContain('"trigger" <> $');
    expect(query.sql).not.toContain('is null');
    expect(query.params).toEqual(expect.arrayContaining([7, 'auto']));
  });

  it('reads automatic and unowned jobs as ownerless for a viewer who sees those', async () => {
    const query = await countedWhere({ id: 7, ownerless: true });
    expect(query.sql).toContain('"user_id" is null');
    expect(query.sql).toContain('"trigger" = $');
    expect(query.sql).toContain('"trigger" <> $');
  });

  it('puts no owner filter on a read that covers everyone', async () => {
    const query = await countedWhere(null);
    expect(query.sql).not.toContain('"user_id"');
    expect(query.sql).not.toContain('"trigger"');
  });
});
