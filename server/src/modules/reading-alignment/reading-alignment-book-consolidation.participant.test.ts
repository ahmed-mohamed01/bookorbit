import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import type { BookConsolidationParticipants, ConsolidationTx } from '../book-consolidation/book-consolidation-participants';
import { ReadingAlignmentBookConsolidationParticipant } from './reading-alignment-book-consolidation.participant';

const KEPT = 1;
const SOURCE = 2;

async function statement() {
  const execute = vi.fn<(statement: SQL) => Promise<void>>(() => Promise.resolve());
  const participant = new ReadingAlignmentBookConsolidationParticipant({ register: vi.fn() } as unknown as BookConsolidationParticipants);
  await participant.moveBookRows({ execute } as unknown as ConsolidationTx, KEPT, SOURCE);
  expect(execute).toHaveBeenCalledTimes(1);
  return new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
}

describe('ReadingAlignmentBookConsolidationParticipant', () => {
  it('registers itself', () => {
    const register = vi.fn();
    const participant = new ReadingAlignmentBookConsolidationParticipant({ register } as unknown as BookConsolidationParticipants);
    participant.onModuleInit();
    expect(register).toHaveBeenCalledWith(participant);
  });

  it('repoints both columns of a pair', async () => {
    const { sql, params } = await statement();
    expect(sql).toMatch(/text_book_id = case when a\.text_book_id = \$\d+ then \$\d+::int else a\.text_book_id end/);
    expect(sql).toMatch(/audio_book_id = case when a\.audio_book_id = \$\d+ then \$\d+::int else a\.audio_book_id end/);
    expect(params.filter((value) => value === KEPT)).toHaveLength(4);
    expect(params.filter((value) => value === SOURCE)).toHaveLength(6);
  });

  it('leaves a row colliding with a kept pair, and moves one row per target pair, a ready build first', async () => {
    const { sql } = await statement();
    expect(sql).toContain('kept.text_book_id = c.new_text and kept.audio_book_id = c.new_audio');
    expect(sql).toContain('distinct on (c.new_text, c.new_audio) c.id');
    expect(sql).toContain("order by c.new_text, c.new_audio, (c.status = 'ready') desc");
  });
});
