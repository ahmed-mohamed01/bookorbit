import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import type { BookConsolidationParticipants, ConsolidationTx } from '../book-consolidation/book-consolidation-participants';
import { AudiobookshelfBookConsolidationParticipant } from './audiobookshelf-book-consolidation.participant';
import { audiobookshelfBookState } from './schema/audiobookshelf.schema';

describe('AudiobookshelfBookConsolidationParticipant', () => {
  it('registers itself', () => {
    const register = vi.fn();
    const participant = new AudiobookshelfBookConsolidationParticipant({ register } as unknown as BookConsolidationParticipants);
    participant.onModuleInit();
    expect(register).toHaveBeenCalledWith(participant);
  });

  it('repoints every row of the source book and writes nothing but the book id', async () => {
    const where = vi.fn<(condition: SQL) => Promise<void>>(() => Promise.resolve());
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const participant = new AudiobookshelfBookConsolidationParticipant({ register: vi.fn() } as unknown as BookConsolidationParticipants);

    await participant.moveBookRows({ update } as unknown as ConsolidationTx, 1, 2);

    expect(update).toHaveBeenCalledWith(audiobookshelfBookState);
    expect(set).toHaveBeenCalledWith({ bookId: 1 });
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.sql).toBe('"audiobookshelf_book_state"."book_id" = $1');
    expect(query.params).toEqual([2]);
  });
});
