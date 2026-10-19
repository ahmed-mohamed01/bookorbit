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
