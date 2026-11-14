import { createCapturingDb } from '../../../common/test-utils/capture-sql-db';
import { BookRequestDownloadForkRepository } from './book-request-download-fork.repository';
import { BookRequestDownloadRepository } from './book-request-download.repository';

describe('BookRequestDownloadRepository resume sweep', () => {
  it('picks up a completed download that has no Book Dock row, which is what a retried batch becomes', async () => {
    const { db, queries } = createCapturingDb();

    await new BookRequestDownloadRepository(db as never).findCompletedAwaitingImport();

    const sql = queries.at(-1)?.sql ?? '';
    expect(sql).toContain('"book_request_downloads"."status" = $');
    expect(sql).toContain('"book_request_downloads"."book_dock_file_id" is null');
    expect(queries.at(-1)?.params).toContain('completed');
  });
});

describe('BookRequestDownloadForkRepository.setFilesPendingSince', () => {
  it('clears files_pending_since only on rows that still have it set', async () => {
    const { db, queries } = createCapturingDb();

    await new BookRequestDownloadForkRepository(db as never).setFilesPendingSince(11, null);

    expect(queries.at(-1)?.sql).toContain('"files_pending_since" is not null');
  });
});

describe('BookRequestDownloadForkRepository.existsOtherForClientKey', () => {
  it('only counts live attempts of other requests as sharing the torrent', async () => {
    const { db, queries } = createCapturingDb();

    await new BookRequestDownloadForkRepository(db as never).existsOtherForClientKey(11, 7, 4, 'abc');

    const sql = queries.at(-1)?.sql ?? '';
    expect(sql).toContain('"book_request_downloads"."id" <> $');
    expect(sql).toContain('"book_request_downloads"."request_id" <> $');
    expect(sql).toContain('"book_request_downloads"."status" <> \'failed\'');
    expect(queries.at(-1)?.params).toEqual(expect.arrayContaining([7, 11, 4, 'abc']));
  });

  it('narrows live attempts to the given statuses', async () => {
    const { db, queries } = createCapturingDb();

    await new BookRequestDownloadForkRepository(db as never).existsOtherForClientKey(11, 7, 4, 'abc', ['importing', 'needs_review']);

    const sql = queries.at(-1)?.sql ?? '';
    expect(sql).toContain('"book_request_downloads"."status" in ($');
    expect(sql).not.toContain("<> 'failed'");
    expect(queries.at(-1)?.params).toEqual(expect.arrayContaining(['importing', 'needs_review']));
  });
});
