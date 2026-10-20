import { BadRequestException } from '@nestjs/common';
import { ACTIVE_BOOK_REQUEST_STATUSES } from '@bookorbit/types';
import type { ReleaseFileInspection, ReleaseSelectionManifest } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { BookRequestBatchService } from './book-request-batch.service';

function user(): RequestUser {
  return { id: 5, name: 'Ann', isSuperuser: false, permissions: [] } as unknown as RequestUser;
}

function selection(mediaKinds: Array<'ebook' | 'audiobook'> = ['ebook', 'ebook', 'ebook', 'ebook', 'ebook']): ReleaseSelectionManifest {
  return {
    rootName: 'Series Pack',
    files: mediaKinds.flatMap((_, index) => [
      { path: `b${index}/book.epub`, sizeBytes: 10, unitIndex: index },
      { path: `b${index}/cover.jpg`, sizeBytes: 1, unitIndex: index },
    ]),
    units: mediaKinds.map((mediaKind, index) => ({
      index,
      title: `Book ${index}`,
      mediaKind,
      sizeBytes: 11,
      primaryPath: `b${index}/book.epub`,
    })),
  };
}

function inspection(overrides: Partial<ReleaseFileInspection> = {}): ReleaseFileInspection {
  return { unitCount: 5, totalFiles: 10, selection: selection(), ...overrides } as ReleaseFileInspection;
}

const DTO = { sourceRequestId: 7, indexerId: 9, releaseGuid: 'g-1', downloadClientId: 4, unitIndexes: [1, 2, 3] };

function makeService(options: { inspection?: ReleaseFileInspection; adapterType?: string; grabError?: Error } = {}) {
  const requests = {
    findById: vi.fn().mockResolvedValue({ request: { id: 7, title: 'Source', authors: ['Ann Author'], targetLibraryId: 4, targetFolderId: 9 } }),
    create: vi.fn().mockResolvedValue({ id: 21 }),
    updateIf: vi.fn().mockResolvedValue(undefined),
  };
  const batches = {
    setKind: vi.fn().mockResolvedValue(undefined),
    insertUnits: vi.fn().mockResolvedValue(undefined),
    findUnits: vi.fn().mockResolvedValue([]),
  };
  const fulfillment = {
    inspectRelease: vi.fn().mockResolvedValue(options.inspection ?? inspection()),
    assertTorrentFree: vi.fn().mockResolvedValue(undefined),
    grabSelection: options.grabError ? vi.fn().mockRejectedValue(options.grabError) : vi.fn().mockResolvedValue(undefined),
  };
  const clients = { findOne: vi.fn().mockResolvedValue({ id: 4, adapterType: options.adapterType ?? 'qbittorrent' }) };
  const releases = { find: vi.fn().mockReturnValue({ title: 'Series Pack [EPUB]' }) };
  const requestService = { getOne: vi.fn().mockResolvedValue({}) };
  const downloads = {
    findLatestForRequests: vi.fn().mockResolvedValue(new Map()),
    updateIf: vi.fn().mockResolvedValue({ id: 11 }),
    setFilesPendingSince: vi.fn().mockResolvedValue(undefined),
    findUnsettledByClientKey: vi.fn().mockResolvedValue(undefined),
  };
  const adapter = { status: vi.fn().mockResolvedValue([]) };
  const registry = { require: vi.fn().mockReturnValue(adapter) };
  const gateway = { emitChanged: vi.fn() };
  const service = new BookRequestBatchService(
    requests as never,
    batches as never,
    fulfillment as never,
    clients as never,
    releases as never,
    requestService as never,
    downloads as never,
    registry as never,
    gateway as never,
  );
  return { service, requests, batches, fulfillment, clients, requestService, downloads, adapter, registry, gateway };
}

describe('BookRequestBatchService.create', () => {
  it('creates a batch request with one unit row per ticked unit and grabs only their files', async () => {
    const { service, requests, batches, fulfillment } = makeService();

    await expect(service.create(user(), DTO)).resolves.toEqual({ requestId: 21 });

    expect(requests.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Series Pack [EPUB]', authors: ['Ann Author'], userId: 5, status: 'approved', mediaKind: 'ebook' }),
    );
    expect(batches.setKind).toHaveBeenCalledWith(21, 'batch');
    const rows = batches.insertUnits.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.unitIndex)).toEqual([1, 2, 3]);
    expect(rows.every((row) => row.status === 'waiting' && row.requestId === 21)).toBe(true);
    expect(fulfillment.grabSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        batchRequestId: 21,
        sourceRequestId: 7,
        wantedPaths: ['b1/book.epub', 'b1/cover.jpg', 'b2/book.epub', 'b2/cover.jpg', 'b3/book.epub', 'b3/cover.jpg'],
      }),
      expect.anything(),
    );
  });

  it('uses audiobook only when every ticked unit is an audiobook', async () => {
    const { service, requests } = makeService({ inspection: inspection({ selection: selection(['audiobook', 'audiobook', 'audiobook', 'ebook']) }) });

    await service.create(user(), { ...DTO, unitIndexes: [0, 1, 2] });
    expect(requests.create).toHaveBeenCalledWith(expect.objectContaining({ mediaKind: 'audiobook' }));
  });

  it('refuses a single-unit release', async () => {
    const { service, requests } = makeService({ inspection: inspection({ selection: null, unitCount: 1 }) });

    await expect(service.create(user(), DTO)).rejects.toThrow(new BadRequestException('This release holds one book. Use Download release instead.'));
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('refuses a truncated release', async () => {
    const { service } = makeService({ inspection: inspection({ selection: null, unitCount: 40, totalFiles: 2500 }) });

    await expect(service.create(user(), DTO)).rejects.toThrow('This release has more than 2,000 files. Picking books works up to 2,000.');
  });

  it('refuses a client that cannot skip files', async () => {
    const { service, requests } = makeService({ adapterType: 'sabnzbd' });

    await expect(service.create(user(), DTO)).rejects.toThrow(
      'Picking books needs a client that can skip files: qBittorrent, Transmission or Deluge.',
    );
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('refuses a unit an earlier batch already placed in Book Dock', async () => {
    const { service, requests, fulfillment } = makeService({ inspection: inspection({ selection: { ...selection(), alreadyImported: [2] } }) });

    await expect(service.create(user(), DTO)).rejects.toThrow(new BadRequestException('These books are already in Book Dock from an earlier batch.'));
    expect(requests.create).not.toHaveBeenCalled();
    expect(fulfillment.grabSelection).not.toHaveBeenCalled();
  });

  it('allows units outside the already imported list', async () => {
    const { service } = makeService({ inspection: inspection({ selection: { ...selection(), alreadyImported: [0, 4] } }) });

    await expect(service.create(user(), DTO)).resolves.toEqual({ requestId: 21 });
  });

  it('refuses before creating a request when another batch holds the torrent', async () => {
    const { service, requests, fulfillment } = makeService();
    fulfillment.assertTorrentFree.mockRejectedValue(
      new BadRequestException('This torrent is still downloading for another batch. Try again when it finishes.'),
    );

    await expect(service.create(user(), DTO)).rejects.toThrow('This torrent is still downloading for another batch.');
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('records the file sizes of each unit from the manifest', async () => {
    const { service, batches } = makeService();

    await service.create(user(), DTO);

    const rows = batches.insertUnits.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.fileSizes)).toEqual([
      [10, 1],
      [10, 1],
      [10, 1],
    ]);
  });

  it('records no sizes for a unit with a file of unknown size', async () => {
    const base = selection();
    base.files[2] = { ...base.files[2], sizeBytes: null };
    const { service, batches } = makeService({ inspection: inspection({ selection: base }) });

    await service.create(user(), DTO);

    const rows = batches.insertUnits.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.fileSizes)).toEqual([null, [10, 1], [10, 1]]);
  });

  it('refuses unknown or duplicate unit indexes', async () => {
    const { service, requests } = makeService();

    await expect(service.create(user(), { ...DTO, unitIndexes: [1, 99] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(user(), { ...DTO, unitIndexes: [1, 1] })).rejects.toBeInstanceOf(BadRequestException);
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('does not change the source request', async () => {
    const { service, requests } = makeService();

    await service.create(user(), DTO);

    expect(requests.updateIf.mock.calls.filter(([id]) => id === 7)).toHaveLength(0);
  });

  it('marks the batch failed and keeps the unit rows when the grab fails', async () => {
    const { service, requests, batches } = makeService({
      grabError: new BadRequestException('The download client did not accept the file selection'),
    });

    await expect(service.create(user(), DTO)).rejects.toThrow('The download client did not accept the file selection');

    expect(batches.insertUnits).toHaveBeenCalledTimes(1);
    expect(requests.updateIf).toHaveBeenCalledWith(21, ['approved'], {
      status: 'failed',
      statusReason: 'The download client did not accept the file selection',
    });
  });
});

describe('BookRequestBatchService.create half-created batches', () => {
  it('leaves the batch failed, not approved, when inserting the units fails', async () => {
    const { service, requests, batches, fulfillment } = makeService();
    batches.insertUnits.mockRejectedValue(new Error('db down'));

    await expect(service.create(user(), DTO)).rejects.toThrow('db down');

    expect(requests.updateIf).toHaveBeenCalledWith(21, ['approved'], { status: 'failed', statusReason: 'db down' });
    expect(fulfillment.grabSelection).not.toHaveBeenCalled();
  });

  it("batch request inherits the source request's target library and folder", async () => {
    const { service, requests } = makeService();

    await service.create(user(), DTO);

    expect(requests.create).toHaveBeenCalledWith(expect.objectContaining({ targetLibraryId: 4, targetFolderId: 9 }));
  });
});

describe('BookRequestBatchService.listUnits', () => {
  it('checks the caller can see the request before listing', async () => {
    const { service, requestService, batches } = makeService();
    batches.findUnits.mockResolvedValue([
      {
        unitIndex: 0,
        title: 'A',
        primaryPath: 'a.epub',
        mediaKind: 'ebook',
        sizeBytes: 5,
        status: 'waiting',
        bookDockFileId: null,
        errorMessage: null,
      },
    ]);

    const units = await service.listUnits(user(), 21);

    expect(requestService.getOne).toHaveBeenCalledWith(21, expect.objectContaining({ id: 5 }));
    expect(units).toEqual([
      {
        unitIndex: 0,
        title: 'A',
        primaryPath: 'a.epub',
        mediaKind: 'ebook',
        sizeBytes: 5,
        status: 'waiting',
        bookDockFileId: null,
        errorMessage: null,
      },
    ]);
  });
});

describe('BookRequestBatchService.retry', () => {
  const NOT_RETRYABLE = 'Only a failed batch can be retried.';
  const GONE = 'The download client no longer has this torrent, so there is nothing to import. Send the batch again.';

  function retryHarness(
    overrides: {
      status?: string;
      kind?: string;
      download?: Record<string, unknown> | null;
      reported?: Array<{ clientKey: string; state?: string; progressPercent?: number }>;
    } = {},
  ) {
    const harness = makeService();
    harness.requests.findById.mockResolvedValue({ request: { id: 21, status: overrides.status ?? 'failed', statusReason: 'broke' } });
    (harness.batches as Record<string, unknown>).findKinds = vi.fn().mockResolvedValue(new Map([[21, overrides.kind ?? 'batch']]));
    (harness.batches as Record<string, unknown>).resetUnitsForRetry = vi.fn().mockResolvedValue(2);
    const download =
      overrides.download === null
        ? undefined
        : { id: 11, requestId: 21, status: 'failed', downloadClientId: 4, clientKey: 'ABC123', errorMessage: 'bad path', ...overrides.download };
    harness.downloads.findLatestForRequests.mockResolvedValue(download ? new Map([[21, { download }]]) : new Map());
    (harness.clients as Record<string, unknown>).resolveConfig = vi.fn().mockResolvedValue({ adapterType: 'qbittorrent' });
    harness.adapter.status.mockResolvedValue(overrides.reported ?? [{ clientKey: 'abc123', state: 'completed', progressPercent: 100 }]);
    harness.requests.updateIf.mockResolvedValue({ id: 21 });
    return harness as typeof harness & { batches: { resetUnitsForRetry: ReturnType<typeof vi.fn> } };
  }

  it('resets the request, units and download in one go and announces the change', async () => {
    const { service, requests, batches, downloads, gateway, adapter } = retryHarness();

    await service.retry(user(), 21);

    expect(adapter.status).toHaveBeenCalledWith(['ABC123'], { adapterType: 'qbittorrent' });
    expect(requests.updateIf).toHaveBeenCalledWith(21, ['failed'], {
      status: 'downloading',
      statusReason: null,
      failureCode: null,
      failureMeta: null,
    });
    expect(batches.resetUnitsForRetry).toHaveBeenCalledWith(21);
    expect(downloads.updateIf).toHaveBeenCalledWith(11, ['failed', 'imported'], { status: 'completed', errorMessage: null });
    expect(downloads.setFilesPendingSince).toHaveBeenCalledWith(11, null);
    expect(downloads.updateIf).not.toHaveBeenCalledWith(11, expect.anything(), expect.objectContaining({ bookDockFileId: expect.anything() }));
    expect(gateway.emitChanged).toHaveBeenCalled();
  });

  it.each([
    ['a request that is not failed', { status: 'available' }],
    ['a single request', { kind: 'single' }],
    ['a batch with no download row', { download: null }],
    ['a download with no client key', { download: { clientKey: null } }],
    ['a download with no client', { download: { downloadClientId: null } }],
  ])('refuses %s', async (_label, overrides) => {
    const { service, requests } = retryHarness(overrides);

    await expect(service.retry(user(), 21)).rejects.toThrow(new BadRequestException(NOT_RETRYABLE));
    expect(requests.updateIf).not.toHaveBeenCalled();
  });

  it('refuses when the client no longer reports the torrent', async () => {
    const { service, requests } = retryHarness({ reported: [] });

    await expect(service.retry(user(), 21)).rejects.toThrow(new BadRequestException(GONE));
    expect(requests.updateIf).not.toHaveBeenCalled();
  });

  it.each([
    ['still downloading', { clientKey: 'abc123', state: 'downloading', progressPercent: 100 }],
    ['below 100 percent', { clientKey: 'abc123', state: 'completed', progressPercent: 80 }],
  ])('refuses a torrent that is %s in the client', async (_label, reported) => {
    const { service, requests } = retryHarness({ reported: [reported] });

    await expect(service.retry(user(), 21)).rejects.toThrow(
      new BadRequestException('The download has not finished in the download client yet. Try again when it has.'),
    );
    expect(requests.updateIf).not.toHaveBeenCalled();
  });

  it('lets a concurrent change win when the request left failed', async () => {
    const { service, requests, batches, downloads } = retryHarness();
    requests.updateIf.mockResolvedValue(undefined);

    await expect(service.retry(user(), 21)).rejects.toThrow(NOT_RETRYABLE);
    expect(batches.resetUnitsForRetry).not.toHaveBeenCalled();
    expect(downloads.updateIf).not.toHaveBeenCalled();
  });

  it('puts the request back to failed when the download changed meanwhile', async () => {
    const { service, requests, downloads } = retryHarness();
    downloads.updateIf.mockResolvedValue(undefined);

    await expect(service.retry(user(), 21)).rejects.toThrow(NOT_RETRYABLE);
    expect(requests.updateIf).toHaveBeenLastCalledWith(21, ['downloading'], { status: 'failed', statusReason: 'broke' });
  });

  const BUSY = 'This torrent is still downloading for another batch. Try again when it finishes.';

  it('refuses before changing anything while another batch holds the torrent', async () => {
    const { service, requests, batches, downloads } = retryHarness();
    downloads.findUnsettledByClientKey.mockResolvedValue({ id: 99 });

    await expect(service.retry(user(), 21)).rejects.toThrow(new BadRequestException(BUSY));
    expect(downloads.findUnsettledByClientKey).toHaveBeenCalledWith(4, 'ABC123');
    expect(requests.updateIf).not.toHaveBeenCalled();
    expect(batches.resetUnitsForRetry).not.toHaveBeenCalled();
  });

  it('maps a unique violation during the claim to the busy message and restores the request', async () => {
    const { service, requests, downloads } = retryHarness();
    downloads.updateIf.mockRejectedValue({ code: '23505' });

    await expect(service.retry(user(), 21)).rejects.toThrow(new BadRequestException(BUSY));
    expect(requests.updateIf).toHaveBeenLastCalledWith(21, ['downloading'], { status: 'failed', statusReason: 'broke' });
  });
});

function joinedSeam(overrides: Record<string, unknown> = {}) {
  return {
    request: {
      authors: [],
      id: 12,
      userId: 1,
      status: 'pending',
      seriesName: null,
      targetLibraryId: null,
      targetFolderId: null,
      ...overrides,
    },
  };
}
function makeSeamService(overrides: { repo?: Record<string, unknown>; batches?: Record<string, unknown> } = {}) {
  const harness = makeService();
  const repo = Object.assign(harness.requests, { updateIf: vi.fn().mockResolvedValue({ id: 10 }), findByIds: vi.fn() }, overrides.repo);
  const batches = Object.assign(harness.batches, overrides.batches);
  return { ...harness, repo, batches };
}
describe('BookRequestBatchService system seams', () => {
  it('settleAvailable moves an approved request to available and returns true', async () => {
    const { service, repo, gateway } = makeSeamService();
    await expect(service.settleAvailable(10, 'serial complete')).resolves.toBe(true);
    expect(repo.updateIf).toHaveBeenCalledExactlyOnceWith(
      10,
      ACTIVE_BOOK_REQUEST_STATUSES.filter((status) => status !== 'available'),
      {
        status: 'available',
        statusReason: 'serial complete',
      },
    );
    expect(gateway.emitChanged).toHaveBeenCalledOnce();
  });

  it('settleAvailable leaves a cancelled request alone and returns false', async () => {
    const { service, repo, gateway } = makeSeamService({
      repo: {
        updateIf: vi
          .fn()
          .mockImplementation((_id, expected) => Promise.resolve(expected.includes('cancelled') ? { status: 'available' } : undefined)),
      },
    });
    await expect(service.settleAvailable(10, 'serial complete')).resolves.toBe(false);
    expect(repo.updateIf).toHaveBeenCalledOnce();
    expect(gateway.emitChanged).not.toHaveBeenCalled();
  });

  it('findBatchUnits groups units by request id', async () => {
    const unit = {
      unitIndex: 0,
      title: 'A',
      primaryPath: 'a.epub',
      mediaKind: 'ebook',
      sizeBytes: 5,
      status: 'waiting',
      bookDockFileId: null,
      errorMessage: null,
    };
    const { service, batches } = makeSeamService({
      batches: {
        findUnitsForRequests: vi.fn().mockResolvedValue([
          { ...unit, id: 1, requestId: 10, filePaths: ['a.epub'] },
          { ...unit, id: 2, requestId: 12 },
          { ...unit, id: 3, requestId: 10, unitIndex: 1 },
        ]),
      },
    });
    await expect(service.findBatchUnits([10, 12])).resolves.toEqual(
      new Map([
        [10, [unit, { ...unit, unitIndex: 1 }]],
        [12, [unit]],
      ]),
    );
    expect(batches.findUnitsForRequests).toHaveBeenCalledExactlyOnceWith([10, 12]);
  });

  it('findBatchUnits rejects more than 50 ids', async () => {
    const findUnitsForRequests = vi.fn();
    const { service } = makeSeamService({ batches: { findUnitsForRequests } });
    await expect(service.findBatchUnits(Array(51).fill(10))).rejects.toBeInstanceOf(BadRequestException);
    expect(findUnitsForRequests).not.toHaveBeenCalled();
  });

  it('findBatchUnits returns an empty map without querying for an empty list', async () => {
    const findUnitsForRequests = vi.fn();
    const { service } = makeSeamService({ batches: { findUnitsForRequests } });
    await expect(service.findBatchUnits([])).resolves.toEqual(new Map());
    expect(findUnitsForRequests).not.toHaveBeenCalled();
  });

  it('findRequestsByIds returns only the fields needed by system callers', async () => {
    const { service, repo } = makeSeamService({
      repo: {
        findByIds: vi
          .fn()
          .mockResolvedValue([
            joinedSeam({ id: 10, userId: 5, status: 'approved', seriesName: 'Series', targetLibraryId: 3, targetFolderId: 4 }),
            joinedSeam({ id: 12 }),
          ]),
      },
    });
    await expect(service.findRequestsByIds([10, 12, 99])).resolves.toEqual(
      new Map([
        [10, { userId: 5, status: 'approved', seriesName: 'Series', authors: [], targetLibraryId: 3, targetFolderId: 4 }],
        [12, { userId: 1, status: 'pending', seriesName: null, authors: [], targetLibraryId: null, targetFolderId: null }],
      ]),
    );
    expect(repo.findByIds).toHaveBeenCalledExactlyOnceWith([10, 12, 99]);
  });

  it('findBatchUnitByDockFileId maps the unit and its batch request, or returns null', async () => {
    const findUnitByDockFileId = vi
      .fn()
      .mockResolvedValueOnce({
        requestId: 50,
        unitIndex: 2,
        title: 'Vol 3',
        primaryPath: '/a/3.epub',
        filePaths: ['/a/3.epub'],
        mediaKind: 'ebook',
        sizeBytes: 1,
        status: 'in_dock',
        bookDockFileId: 5,
        errorMessage: null,
      })
      .mockResolvedValueOnce(undefined);
    const { service } = makeSeamService({ batches: { findUnitByDockFileId } });
    await expect(service.findBatchUnitByDockFileId(5)).resolves.toMatchObject({ batchRequestId: 50, unit: { unitIndex: 2, bookDockFileId: 5 } });
    await expect(service.findBatchUnitByDockFileId(6)).resolves.toBeNull();
  });

  it('findRequestsByIds rejects more than 50 ids without querying', async () => {
    const { service, repo } = makeSeamService();
    await expect(service.findRequestsByIds(Array(51).fill(10))).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.findByIds).not.toHaveBeenCalled();
  });

  it('findRequestsByIds returns an empty map without querying for an empty list', async () => {
    const { service, repo } = makeSeamService();
    await expect(service.findRequestsByIds([])).resolves.toEqual(new Map());
    expect(repo.findByIds).not.toHaveBeenCalled();
  });
});
