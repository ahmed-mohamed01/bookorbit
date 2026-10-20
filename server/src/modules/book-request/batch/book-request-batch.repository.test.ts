import { createCapturingDb } from '../../../common/test-utils/capture-sql-db';
import { BookRequestBatchRepository } from './book-request-batch.repository';

describe('BookRequestBatchRepository.summaries', () => {
  it('rolls every request up in one grouped query', async () => {
    const { db, queries } = createCapturingDb();

    await new BookRequestBatchRepository(db as never).summaries([3, 4, 3]);

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('group by "book_request_batch_units"."request_id"');
    expect(queries[0].params).toEqual(expect.arrayContaining([3, 4]));
    expect(queries[0].sql).toContain("in ('in_dock', 'filed')");
    expect(queries[0].sql).toContain("= 'filed'");
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

describe('BookRequestBatchRepository.findUnitByDockFileId', () => {
  it('looks a unit up by its dock file id', async () => {
    const { db, queries } = createCapturingDb();

    await new BookRequestBatchRepository(db as never).findUnitByDockFileId(5);

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('"book_dock_file_id" = $1');
    expect(queries[0].params).toEqual(expect.arrayContaining([5]));
  });
});

describe('BookRequestBatchRepository.updateUnit', () => {
  it('placement does not overwrite a filed unit', async () => {
    const { db, queries } = createCapturingDb();
    const repository = new BookRequestBatchRepository(db as never);
    await repository.markFiled(3, 8);
    await repository.updateUnit(3, { status: 'in_dock', bookDockFileId: 1 });

    expect(queries).toHaveLength(2);
    expect(queries[0].params).toContain('filed');
    const placement = queries[1];
    expect(placement.sql).toContain('"book_request_batch_units"."status" in (');
    expect(placement.params.slice(-3)).toEqual([3, 'waiting', 'placing']);
  });
});
