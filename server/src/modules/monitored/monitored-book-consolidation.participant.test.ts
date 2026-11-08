import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import type { BookConsolidationParticipants, ConsolidationTx } from '../book-consolidation/book-consolidation-participants';
import { MonitoredBookConsolidationParticipant } from './monitored-book-consolidation.participant';

const KEPT = 1;
const SOURCE = 2;
const dialect = new PgDialect();

async function run() {
  const execute = vi.fn<(statement: SQL) => Promise<void>>(() => Promise.resolve());
  const register = vi.fn();
  const participant = new MonitoredBookConsolidationParticipant({ register } as unknown as BookConsolidationParticipants);
  await participant.moveBookRows({ execute } as unknown as ConsolidationTx, KEPT, SOURCE);
  const statements = execute.mock.calls.map(([statement]) => dialect.sqlToQuery(statement));
  return { statements, register, participant };
}

describe('MonitoredBookConsolidationParticipant', () => {
  it('registers itself', async () => {
    const { participant, register } = await run();
    participant.onModuleInit();
    expect(register).toHaveBeenCalledWith(participant);
  });

  it('drops a kept-book rejection on a work the source book owns, before the works are repointed', async () => {
    const { statements } = await run();
    const rejections = statements[0];
    expect(rejections.sql).toContain('delete from monitored_match_overrides');
    expect(rejections.sql).toContain("o.decision = 'reject'");
    expect(rejections.sql).toContain("sw.source || ':' || sw.provider_work_id = o.identity_key");
    expect(rejections.sql).toContain('o.work_id = w.id');
    expect(rejections.params).toEqual([KEPT, SOURCE]);
  });

  it('repoints all five work columns, then clears a possible match the matched book answers, then moves overrides', async () => {
    const { statements } = await run();
    expect(statements).toHaveLength(5);
    const [, works, ebookPossibles, audioPossibles, overrides] = statements;
    for (const column of ['matched_book_id', 'matched_ebook_book_id', 'matched_audio_book_id', 'possible_ebook_book_id', 'possible_audio_book_id']) {
      expect(works.sql).toContain(`${column} = case when ${column} = $`);
      expect(works.sql).toMatch(new RegExp(`(where|or) ${column} = \\$`));
    }
    expect(works.params.filter((value) => value === KEPT)).toHaveLength(5);
    expect(works.params.filter((value) => value === SOURCE)).toHaveLength(10);
    expect(ebookPossibles.sql).toMatch(/set possible_ebook_book_id = null where possible_ebook_book_id = \$1 and matched_ebook_book_id = \$2/);
    expect(ebookPossibles.params).toEqual([KEPT, KEPT]);
    expect(audioPossibles.sql).toMatch(/set possible_audio_book_id = null where possible_audio_book_id = \$1 and matched_audio_book_id = \$2/);
    expect(overrides.sql).toContain('update monitored_match_overrides');
  });

  it('lets the kept book win an override key and keeps a rejection off a work now matched to it', async () => {
    const { statements } = await run();
    const overrides = statements[4];
    expect(overrides.sql).toContain('kept.monitor_author_id = o.monitor_author_id');
    expect(overrides.sql).toContain('kept.format = o.format');
    expect(overrides.sql).toContain('kept.identity_key = o.identity_key');
    expect(overrides.sql).toMatch(/kept\.book_id = \$\d/);
    expect(overrides.sql).toContain("o.decision = 'reject'");
    expect(overrides.sql).toContain("case when o.format = 'audiobook' then w.matched_audio_book_id else w.matched_ebook_book_id end");
    expect(overrides.sql).toContain("sw.source || ':' || sw.provider_work_id = o.identity_key");
    expect(overrides.params).toEqual([KEPT, SOURCE, KEPT, KEPT]);
  });
});
