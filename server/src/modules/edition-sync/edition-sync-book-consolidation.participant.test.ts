import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import type { BookConsolidationParticipants, ConsolidationTx } from '../book-consolidation/book-consolidation-participants';
import { EDITION_SYNC_FILE_CHANGE_REASONS } from './edition-sync.constants';
import { EditionSyncBookConsolidationParticipant } from './edition-sync-book-consolidation.participant';

const KEPT = 1;
const SOURCE = 2;

async function statements() {
  const execute = vi.fn<(statement: SQL) => Promise<void>>(() => Promise.resolve());
  const participant = new EditionSyncBookConsolidationParticipant({ register: vi.fn() } as unknown as BookConsolidationParticipants);
  await participant.moveBookRows({ execute } as unknown as ConsolidationTx, KEPT, SOURCE);
  return execute.mock.calls.map(([statement]) => new PgDialect().sqlToQuery(statement));
}

describe('EditionSyncBookConsolidationParticipant', () => {
  it('registers itself', () => {
    const register = vi.fn();
    const participant = new EditionSyncBookConsolidationParticipant({ register } as unknown as BookConsolidationParticipants);
    participant.onModuleInit();
    expect(register).toHaveBeenCalledWith(participant);
  });

  it('moves an override unless the kept book already has one for the user', async () => {
    const [overrides] = await statements();
    expect(overrides.sql).toContain('update edition_sync_book_overrides o set book_id = $1');
    expect(overrides.sql).toContain('kept.user_id = o.user_id and kept.book_id = $3');
    expect(overrides.params).toEqual([KEPT, SOURCE, KEPT]);
  });

  it('moves the index row as stale, only when the kept book has none', async () => {
    const [, index] = await statements();
    expect(index.sql).toContain("status = 'stale'");
    expect(index.sql).toContain("invalidated_reason = 'files_changed'");
    expect(EDITION_SYNC_FILE_CHANGE_REASONS).toContain('files_changed');
    expect(index.sql).toContain('not exists (select 1 from edition_sync_book_index kept where kept.book_id = $3)');
    expect(index.params).toEqual([KEPT, SOURCE, KEPT]);
  });
});
