import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import type { BookConsolidationParticipants, ConsolidationTx } from '../book-consolidation/book-consolidation-participants';
import { webSerialImports, webSerialJobItems } from './schema/web-serials.schema';
import { WebSerialsBookConsolidationParticipant } from './web-serials-book-consolidation.participant';

describe('WebSerialsBookConsolidationParticipant', () => {
  it('registers itself', () => {
    const register = vi.fn();
    const participant = new WebSerialsBookConsolidationParticipant({ register } as unknown as BookConsolidationParticipants);
    participant.onModuleInit();
    expect(register).toHaveBeenCalledWith(participant);
  });

  it('repoints imports and job items, keeping an item timestamp', async () => {
    const writes: Array<{ table: unknown; values: Record<string, unknown>; where: SQL }> = [];
    const update = vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: SQL) => {
          writes.push({ table, values, where });
          return Promise.resolve();
        },
      }),
    }));
    const participant = new WebSerialsBookConsolidationParticipant({ register: vi.fn() } as unknown as BookConsolidationParticipants);

    await participant.moveBookRows({ update } as unknown as ConsolidationTx, 1, 2);

    expect(writes.map((write) => write.table)).toEqual([webSerialImports, webSerialJobItems]);
    expect(writes[0].values).toEqual({ bookId: 1 });
    expect(writes[1].values).toEqual(expect.objectContaining({ bookId: 1, updatedAt: expect.anything() }));
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(writes[1].values.updatedAt as SQL).sql).toBe('"web_serial_job_items"."updated_at"');
    expect(dialect.sqlToQuery(writes[0].where)).toMatchObject({ sql: '"web_serial_imports"."book_id" = $1', params: [2] });
    expect(dialect.sqlToQuery(writes[1].where)).toMatchObject({ sql: '"web_serial_job_items"."book_id" = $1', params: [2] });
  });
});
