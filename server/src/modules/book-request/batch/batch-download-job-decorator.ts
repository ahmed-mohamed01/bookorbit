import { Injectable } from '@nestjs/common';
import type { BatchSummary, BookRequestDownloadStatus } from '@bookorbit/types';

import type { SourceItem } from '../../jobs/job-source';
import type { RequestDownloadJobRow } from '../request-download-job-source';
import { BookRequestBatchRepository } from './book-request-batch.repository';
import type { RequestDownloadJobDecorator } from './request-download-job-decorator';

/** The attempt is done downloading: its units are being placed, or were. */
const PLACED = new Set<BookRequestDownloadStatus>(['completed', 'importing', 'imported']);

/**
 * Fork: a batch request's download row in the Jobs area. Cancelling it cancels the whole batch, so
 * a downloading batch names that in its phase; once the transfer is done the row counts the books
 * placed in the Library Dock, the way the request list does. Ordinary requests pass through untouched.
 */
@Injectable()
export class BatchDownloadJobDecorator implements RequestDownloadJobDecorator {
  constructor(private readonly batches: BookRequestBatchRepository) {}

  async decorate(rows: RequestDownloadJobRow[]): Promise<RequestDownloadJobRow[]> {
    if (rows.length === 0) return rows;
    const kinds = await this.batches.findKinds(rows.map((row) => row.job.requestId));
    const batch = rows.filter((row) => kinds.get(row.job.requestId) === 'batch');
    if (batch.length === 0) return rows;
    const summaries = await this.batches.summaries(batch.filter((row) => PLACED.has(row.job.status)).map((row) => row.job.requestId));
    return rows.map((row) =>
      kinds.get(row.job.requestId) === 'batch' ? { ...row, item: batchItem(row, summaries.get(row.job.requestId) ?? null) } : row,
    );
  }
}

function batchItem(row: RequestDownloadJobRow, summary: BatchSummary | null): SourceItem {
  const item: SourceItem = { ...row.item, kind: 'batch' };
  if (row.job.status === 'downloading') return { ...item, phase: 'batch-downloading' };
  if (!summary || summary.total === 0) return item;
  if (row.job.status === 'imported') return summary.failed > 0 ? { ...item, extra: { ...item.extra, failed: summary.failed } } : item;
  if (!PLACED.has(row.job.status)) return item;
  // No phase, so the page words the count: how many books are in the Library Dock so far.
  return {
    ...item,
    phase: null,
    done: summary.inDock,
    total: summary.total,
    extra: summary.failed > 0 ? { ...item.extra, failed: summary.failed } : item.extra,
  };
}
