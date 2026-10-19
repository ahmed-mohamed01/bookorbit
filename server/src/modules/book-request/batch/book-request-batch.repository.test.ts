import { createCapturingDb } from '../../../common/test-utils/capture-sql-db';
import { BookRequestBatchRepository } from './book-request-batch.repository';

describe('BookRequestBatchRepository.summaries', () => {
  it('rolls every request up in one grouped query', async () => {
    const { db, queries } = createCapturingDb();

    await new BookRequestBatchRepository(db as never).summaries([3, 4, 3]);

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('group by "book_request_batch_units"."request_id"');
    expect(queries[0].params).toEqual(expect.arrayContaining([3, 4]));
  });

  it('asks nothing for an empty page', async () => {
    const { db, queries } = createCapturingDb();

    await expect(new BookRequestBatchRepository(db as never).summaries([])).resolves.toEqual(new Map());
    expect(queries).toHaveLength(0);
  });
});

describe('BookRequestBatchRepository.findKinds', () => {
  it('reads kinds for the unique ids in one query', async () => {
    const { db, queries } = createCapturingDb();

    await new BookRequestBatchRepository(db as never).findKinds([8, 8, 9]);

    expect(queries).toHaveLength(1);
    expect(queries[0].params).toEqual([8, 9]);
  });
});

describe('BookRequestBatchRepository.resetUnitsForRetry', () => {
  it('touches only failed units, sending those with a live dock row to placing and the rest to waiting', async () => {
    const { db, queries } = createCapturingDb();

    await new BookRequestBatchRepository(db as never).resetUnitsForRetry(21);

    const updates = queries.filter((query) => query.sql.startsWith('update "book_request_batch_units"'));
    expect(updates).toHaveLength(2);
    for (const query of updates) {
      expect(query.params).toEqual(expect.arrayContaining([21, 'failed']));
      expect(query.params).not.toContain('in_dock');
    }
    expect(updates[0].params).toContain('placing');
    expect(updates[0].sql).toContain('exists (select 1 from "book_dock_files"');
    expect(updates[1].params).toContain('waiting');
  });
});
