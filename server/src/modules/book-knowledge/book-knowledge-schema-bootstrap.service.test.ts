import { Test } from '@nestjs/testing';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { BookKnowledgeSchemaBootstrapService } from './book-knowledge-schema-bootstrap.service';
import { BookKnowledgeRepository } from './book-knowledge.repository';
import { BOOK_KNOWLEDGE_SCHEMA_SQL } from './schema/book-knowledge-schema';
import { knowledgeCards, knowledgeIndex, knowledgeKindReviews } from './schema/book-knowledge.schema';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { BookKnowledgeBookConsolidationParticipant } from './book-knowledge-book-consolidation.participant';
import { BookConsolidationParticipants } from '../book-consolidation/book-consolidation-participants';
describe('Book Knowledge fork schema', () => {
  it('applies every idempotent statement on each bootstrap without a database', async () => {
    const repo = { bootstrap: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [BookKnowledgeSchemaBootstrapService, { provide: BookKnowledgeRepository, useValue: repo }],
    }).compile();
    const service = module.get(BookKnowledgeSchemaBootstrapService);
    await service.onModuleInit();
    await service.onModuleInit();
    const statements = splitSchemaStatements(BOOK_KNOWLEDGE_SCHEMA_SQL);
    expect(repo.bootstrap).toHaveBeenNthCalledWith(1, statements);
    expect(repo.bootstrap).toHaveBeenNthCalledWith(2, statements);
    for (const statement of statements) {
      expect(
        /^(CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS|CREATE OR REPLACE (FUNCTION|TRIGGER)|DROP (TRIGGER|FUNCTION) IF EXISTS|DO \$\$|ALTER TABLE \w+ DROP COLUMN IF EXISTS)/.test(
          statement,
        ) || statement.includes('ON CONFLICT'),
        statement,
      ).toBe(true);
    }
    expect(BOOK_KNOWLEDGE_SCHEMA_SQL).toContain('ON DELETE CASCADE');
    expect(BOOK_KNOWLEDGE_SCHEMA_SQL).toContain('INSERT INTO book_knowledge_cleanup');
  });
  it('drops the book file trigger so deleting a second EPUB keeps the index, cards and kind reviews', () => {
    const statements = splitSchemaStatements(BOOK_KNOWLEDGE_SCHEMA_SQL);
    const at = (prefix: string) => statements.findIndex((statement) => statement.startsWith(prefix));
    const trigger = at('DROP TRIGGER IF EXISTS book_knowledge_file_deleted ON book_files');
    const fn = at('DROP FUNCTION IF EXISTS book_knowledge_file_deleted()');
    expect(trigger).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(trigger);
    expect(BOOK_KNOWLEDGE_SCHEMA_SQL).not.toMatch(/CREATE[^;]*book_knowledge_file_deleted/);
    expect(BOOK_KNOWLEDGE_SCHEMA_SQL).not.toContain('AFTER DELETE ON book_files');
  });
  it('adds the kind review foreign key only when the column has none, so the old inline key is not doubled', () => {
    const block = splitSchemaStatements(BOOK_KNOWLEDGE_SCHEMA_SQL).find((statement) => statement.includes('book_knowledge_kind_reviews_book_fk'));
    expect(block).toMatch(/^DO \$\$/);
    expect(block).toContain("contype = 'f'");
    expect(block).toContain("'book_knowledge_kind_reviews'::regclass");
    expect(block).toContain('ON DELETE CASCADE');
    expect(BOOK_KNOWLEDGE_SCHEMA_SQL).not.toMatch(/book_id integer NOT NULL REFERENCES/);
  });
  it.each([knowledgeIndex, knowledgeCards])('indexes the book foreign key first', (table) => {
    const config = getTableConfig(table);
    expect(config.foreignKeys.some((fk) => fk.reference().columns[0].name === 'book_id')).toBe(true);
    expect(config.indexes.some((index) => (index.config.columns[0] as { name?: string }).name === 'book_id')).toBe(true);
  });
  it('declares the kind review book foreign key the merge rules test reads', () => {
    const config = getTableConfig(knowledgeKindReviews);
    expect(config.foreignKeys.some((fk) => fk.reference().columns[0].name === 'book_id')).toBe(true);
  });
  it('drops derived rows on both merge sides and registers the participant', async () => {
    const participants = { register: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [BookKnowledgeBookConsolidationParticipant, { provide: BookConsolidationParticipants, useValue: participants }],
    }).compile();
    const participant = module.get(BookKnowledgeBookConsolidationParticipant);
    participant.onModuleInit();
    expect(participants.register).toHaveBeenCalledWith(participant);
    const tx = { execute: vi.fn() };
    await participant.moveBookRows(tx as never, 3, 4);
    expect(tx.execute).toHaveBeenCalled();
  });
  it('drops only the merged-away book rows, so the kept book keeps its index and gets no cleanup row', async () => {
    const participant = new BookKnowledgeBookConsolidationParticipant({ register: vi.fn() } as never);
    const tx = { execute: vi.fn() };
    await participant.moveBookRows(tx as never, 3, 4);
    const dialect = new PgDialect();
    const queries = tx.execute.mock.calls.map(([query]) => dialect.sqlToQuery(query as SQL));
    expect(queries.map((query) => query.sql.match(/DELETE FROM (\w+)/)?.[1]).sort()).toEqual([
      'book_knowledge_cards',
      'book_knowledge_index',
      'book_knowledge_kind_reviews',
    ]);
    for (const query of queries) expect(query.params).toEqual([4]);
  });
});
