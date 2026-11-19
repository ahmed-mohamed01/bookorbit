import { Permission, type BatchSummary, type BookRequestKind } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { JobSourceRegistry } from '../../jobs/job-source.registry';
import { BookRequestService } from '../book-request.service';
import { RequestDownloadJobSource } from '../request-download-job-source';
import type { RequestDownloadPageRow } from '../request-download-job.repository';
import { BatchDownloadJobDecorator } from './batch-download-job-decorator';

const fulfiller = { id: 7, active: true, isSuperuser: false, permissions: [Permission.BookRequestAccess, Permission.BookRequestSelfFulfill] };

function page(change: Partial<RequestDownloadPageRow> = {}): RequestDownloadPageRow {
  return {
    id: 11,
    requestId: 40,
    status: 'downloading',
    progressPercent: 42,
    failureCode: null,
    createdAt: new Date('2026-11-15T10:00:00.000Z'),
    grabbedAt: new Date('2026-11-15T10:01:00.000Z'),
    importedAt: null,
    updatedAt: new Date('2026-11-15T11:00:00.000Z'),
    userId: 5,
    fulfillerUserId: fulfiller.id,
    ownerName: 'Sam Whitfield',
    title: 'The Stormlight Archive',
    authors: ['Brandon Sanderson'],
    coverUrl: null,
    mediaKind: 'ebook',
    key: { prefix: [0, 0], suffix: [1], id: 11 },
    ...change,
  };
}

function setup(kinds: Record<number, BookRequestKind>, summaries: Record<number, BatchSummary> = {}) {
  const batches = {
    findKinds: vi.fn((ids: number[]) => Promise.resolve(new Map(ids.flatMap((id) => (kinds[id] ? [[id, kinds[id]] as const] : []))))),
    summaries: vi.fn((ids: number[]) => Promise.resolve(new Map(ids.flatMap((id) => (summaries[id] ? [[id, summaries[id]] as const] : []))))),
  };
  const jobs = {
    pageForJobs: vi.fn((): Promise<RequestDownloadPageRow[]> => Promise.resolve([])),
    findActionRows: vi.fn(() =>
      Promise.resolve([{ id: 11, requestId: 40, status: 'downloading', failureCode: null, userId: 5, fulfillerUserId: fulfiller.id }]),
    ),
  };
  const requests = {
    canManageAll: BookRequestService.prototype.canManageAll,
    canSelfFulfil: BookRequestService.prototype.canSelfFulfil,
    canDrive: BookRequestService.prototype.canDrive,
    cancelDownload: vi.fn(() => Promise.resolve({})),
  };
  const decorator = new BatchDownloadJobDecorator(batches as never);
  const source = new RequestDownloadJobSource(new JobSourceRegistry(), jobs as never, requests as never, { emit: vi.fn() } as never, decorator);
  return { source, jobs, batches, requests };
}

async function listed(kinds: Record<number, BookRequestKind>, rows: RequestDownloadPageRow[], summaries: Record<number, BatchSummary> = {}) {
  const harness = setup(kinds, summaries);
  harness.jobs.pageForJobs.mockResolvedValue(rows);
  const items = await harness.source.list({ view: 'queue', owner: null, cutoffAt: new Date(), after: null, typeIndex: 6, limit: 50 });
  return { ...harness, items };
}

const viewer = { user: fulfiller as unknown as RequestUser, access: { own: true, all: false } };

describe('BatchDownloadJobDecorator through RequestDownloadJobSource', () => {
  it('leaves an ordinary request exactly as upstream lists it, and reads no batch summary', async () => {
    const { items, batches } = await listed({ 40: 'single' }, [page({ status: 'completed' })]);
    expect(items[0]!.item).toMatchObject({ kind: 'ebook', status: 'running', phase: 'downloaded', done: null, total: null });
    expect(batches.summaries).not.toHaveBeenCalled();
  });

  it('names a downloading batch as one, so cancelling reads as cancelling the batch, and keeps the cancel action', async () => {
    const { items, source } = await listed({ 40: 'batch' }, [page()]);
    expect(items[0]!.item).toMatchObject({ kind: 'batch', status: 'running', phase: 'batch-downloading', percent: 42 });
    expect(source.actions(items[0]!, viewer)).toEqual({ actions: ['cancel'], note: null });
  });

  it('shows the import phase as books placed in the Library Dock once the transfer is done', async () => {
    const { items, batches } = await listed({ 40: 'batch' }, [page({ status: 'completed', progressPercent: 100 })], {
      40: { total: 12, inDock: 5, filed: 0, failed: 1 },
    });
    expect(items[0]!.item).toMatchObject({ kind: 'batch', status: 'running', phase: null, done: 5, total: 12, extra: { failed: 1 } });
    expect(items[0]!.key).toEqual({ prefix: [0, 0], suffix: [1], id: 11 });
    expect(batches.summaries).toHaveBeenCalledWith([40]);
  });

  it('counts failed units on a finished batch and keeps it completed', async () => {
    const { items } = await listed({ 40: 'batch' }, [page({ status: 'imported', importedAt: new Date('2026-11-15T12:00:00.000Z') })], {
      40: { total: 12, inDock: 11, filed: 3, failed: 1 },
    });
    expect(items[0]!.item).toMatchObject({ kind: 'batch', status: 'completed', done: null, total: null, extra: { failed: 1 } });
  });

  it('reads kinds and summaries once per page, only for batch rows past their transfer', async () => {
    const { items, batches } = await listed(
      { 40: 'batch', 41: 'single', 42: 'batch' },
      [page(), page({ id: 12, requestId: 41, status: 'completed' }), page({ id: 13, requestId: 42, status: 'completed' })],
      { 42: { total: 3, inDock: 0, filed: 0, failed: 0 } },
    );
    expect(batches.findKinds).toHaveBeenCalledTimes(1);
    expect(batches.findKinds).toHaveBeenCalledWith([40, 41, 42]);
    expect(batches.summaries).toHaveBeenCalledTimes(1);
    expect(batches.summaries).toHaveBeenCalledWith([42]);
    expect(items.map((row) => row.item.kind)).toEqual(['batch', 'ebook', 'batch']);
    expect(items[2]!.item).toMatchObject({ done: 0, total: 3, extra: null });
  });

  it('still cancels a batch through the request service, which cancels the whole request', async () => {
    const { source, requests } = setup({ 40: 'batch' });
    const [result] = await source.act('cancel', ['11'], viewer);
    expect(result).toMatchObject({ outcome: 'done' });
    expect(requests.cancelDownload).toHaveBeenCalledWith(40, 11, fulfiller);
  });

  it('keeps the upstream rows when no decorator is provided', async () => {
    const jobs = { pageForJobs: vi.fn(() => Promise.resolve([page()])) };
    const source = new RequestDownloadJobSource(new JobSourceRegistry(), jobs as never, {} as never, {} as never);
    const [row] = await source.list({ view: 'queue', owner: null, cutoffAt: new Date(), after: null, typeIndex: 6, limit: 50 });
    expect(row!.item).toMatchObject({ kind: 'ebook', phase: 'downloading' });
  });
});
