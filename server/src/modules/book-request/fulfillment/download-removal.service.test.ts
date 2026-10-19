import type { BookRequestDownloadRow } from '../../../db/schema';
import { DownloadRemovalService } from './download-removal.service';

const INFO_HASH = 'c9e15763f722f23e98a29decdfae341b98d53056';

function download(overrides: Partial<BookRequestDownloadRow> = {}): BookRequestDownloadRow {
  return {
    id: 11,
    requestId: 7,
    downloadClientId: 4,
    clientKey: INFO_HASH,
    source: 'torrent_file',
    status: 'downloading',
    ...overrides,
  } as BookRequestDownloadRow;
}

function makeService(options: { latest?: BookRequestDownloadRow | null; removeError?: Error; extended?: boolean; shared?: boolean } = {}) {
  const row = options.latest === undefined ? download() : options.latest;
  const downloads = {
    findLatestForRequests: vi.fn().mockResolvedValue(row ? new Map([[7, { download: row, downloadClientName: 'qbit' }]]) : new Map()),
    findById: vi.fn().mockResolvedValue(row ?? undefined),
    update: vi.fn().mockResolvedValue(undefined),
    existsOtherForClientKey: vi.fn().mockResolvedValue(options.shared === true),
    findExtension: vi.fn().mockResolvedValue({ filesPendingSince: null, extendsExisting: options.extended === true }),
    updateIf: vi
      .fn()
      .mockImplementation((id: number, expected: string[], patch: Record<string, unknown>) =>
        Promise.resolve(expected.includes(row?.status ?? '') ? { ...row, id, ...patch } : undefined),
      ),
  };
  const clients = { resolveConfig: vi.fn().mockResolvedValue({ id: 4, adapterType: 'qbittorrent' }) };
  const adapter = {
    remove: options.removeError ? vi.fn().mockRejectedValue(options.removeError) : vi.fn().mockResolvedValue(undefined),
  };
  const registry = { require: vi.fn().mockReturnValue(adapter) };
  const direct = {
    remove: options.removeError ? vi.fn().mockRejectedValue(options.removeError) : vi.fn().mockResolvedValue(undefined),
  };

  const service = new DownloadRemovalService(downloads as never, clients as never, registry as never, direct as never);
  return { service, downloads, clients, adapter, registry, direct };
}

describe('DownloadRemovalService.removeLatestForRequest', () => {
  it('hands the torrent to the client and fails the attempt behind it', async () => {
    const { service, downloads, adapter } = makeService();

    await expect(service.removeLatestForRequest(7, false, 'ann')).resolves.toEqual({ removed: true, error: null });

    expect(adapter.remove).toHaveBeenCalledWith(INFO_HASH, expect.anything(), { deleteFiles: false });
    expect(downloads.updateIf).toHaveBeenCalledWith(11, expect.arrayContaining(['downloading']), {
      status: 'failed',
      errorMessage: expect.stringContaining('ann'),
    });
  });

  it('leaves a finished attempt alone: the book is filed, the seed is not the request', async () => {
    const { service, downloads } = makeService({ latest: download({ status: 'imported' }) });

    await expect(service.removeLatestForRequest(7, false, 'ann')).resolves.toEqual({ removed: true, error: null });

    // The conditional write is offered and refused, which is what leaves an imported row alone.
    expect(downloads.updateIf).toHaveBeenCalledWith(11, expect.not.arrayContaining(['imported']), expect.anything());
  });

  it('deletes partial direct-download staging when a request is cancelled', async () => {
    const staged = download({ source: 'direct_url', downloadClientId: null });
    const { service, direct, clients } = makeService({ latest: staged });

    await service.removeLatestForRequest(7, false, 'ann');

    expect(direct.remove).toHaveBeenCalledWith(INFO_HASH, { deleteFiles: true });
    expect(clients.resolveConfig).not.toHaveBeenCalled();
  });

  it('reports nothing to remove for a request that was never grabbed', async () => {
    const { service, adapter } = makeService({ latest: null });

    await expect(service.removeLatestForRequest(7, false, 'ann')).resolves.toEqual({ removed: false, error: null });
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it('reports a torrent the download client no longer owns rather than resolving a config for null', async () => {
    const { service, clients } = makeService({ latest: download({ source: 'torrent_file', downloadClientId: null }) });

    await expect(service.removeLatestForRequest(7, false, 'ann')).resolves.toEqual({ removed: false, error: null });
    expect(clients.resolveConfig).not.toHaveBeenCalled();
  });

  /**
   * The caller is stopping or deleting the request itself. A client that is down must not be what
   * keeps a stuck request stuck, so the refusal comes back as a value and the caller decides.
   */
  it('carries a client refusal back instead of throwing', async () => {
    const { service } = makeService({ removeError: new Error('connection refused') });

    await expect(service.removeLatestForRequest(7, false, 'ann')).resolves.toEqual({ removed: false, error: 'connection refused' });
  });

  /**
   * The caller is settling the request whatever the client says. An attempt left in flight is one
   * the poll loop keeps asking about and keeps writing progress back from, onto a row that has
   * already been cancelled.
   */
  it('takes the attempt out of the in-flight set even when the client refused the detach', async () => {
    const { service, downloads } = makeService({ removeError: new Error('connection refused') });

    await service.removeLatestForRequest(7, false, 'ann');

    expect(downloads.updateIf).toHaveBeenCalledWith(11, expect.arrayContaining(['downloading']), {
      status: 'failed',
      errorMessage: expect.stringContaining('connection refused'),
    });
  });
});

describe('DownloadRemovalService.cleanupStagedDirectDownload', () => {
  it('deletes direct-download staging once the Book Dock owns the file', async () => {
    const staged = download({ source: 'direct_url', status: 'importing', downloadClientId: null });
    const { service, direct } = makeService({ latest: staged });

    await service.cleanupStagedDirectDownload(staged);

    expect(direct.remove).toHaveBeenCalledWith(INFO_HASH, { deleteFiles: true });
  });

  it('does not remove torrent data during import', async () => {
    const torrent = download({ source: 'torrent_file', status: 'importing' });
    const { service, adapter, direct } = makeService({ latest: torrent });

    await service.cleanupStagedDirectDownload(torrent);

    expect(adapter.remove).not.toHaveBeenCalled();
    expect(direct.remove).not.toHaveBeenCalled();
  });

  it('does not fail an imported book when staging cleanup fails', async () => {
    const staged = download({ source: 'direct_url', status: 'importing', downloadClientId: null });
    const { service } = makeService({ latest: staged, removeError: new Error('busy') });

    await expect(service.cleanupStagedDirectDownload(staged)).resolves.toBeUndefined();
  });
});

describe('DownloadRemovalService with a download that extended an existing torrent', () => {
  const LEFT = 'This torrent was already in the download client, so BookOrbit left it there.';

  it('cancel / delete / fulfil path: stops tracking without touching the client', async () => {
    const { service, downloads, adapter, clients } = makeService({ extended: true });

    await expect(service.removeLatestForRequest(7, true, 'ann')).resolves.toEqual({ removed: false, error: null });

    expect(adapter.remove).not.toHaveBeenCalled();
    expect(clients.resolveConfig).not.toHaveBeenCalled();
    expect(downloads.updateIf).toHaveBeenCalledWith(11, expect.anything(), { status: 'failed', errorMessage: LEFT });
  });

  it('remove-from-client and cancel-download path: never removes or deletes files', async () => {
    const { service, downloads, adapter } = makeService({ extended: true });

    await expect(service.removeAttempt(7, 11, true, 'ann')).resolves.toEqual({ wasInFlight: true, leftInClient: true, leftMessage: LEFT });

    expect(adapter.remove).not.toHaveBeenCalled();
    expect(downloads.updateIf).toHaveBeenCalledWith(11, expect.anything(), { status: 'failed', errorMessage: LEFT });
  });

  it('user cleanup path: detachAttempt leaves the torrent and reports no refusal', async () => {
    const { service, adapter } = makeService({ extended: true });

    await expect(service.detachAttempt(download(), true)).resolves.toBeNull();

    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it('logs the skipped removal with the extended_torrent reason', async () => {
    const { service } = makeService({ extended: true });
    const log = vi.spyOn((service as never as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);

    await service.detachAttempt(download(), false);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[book_request\.remove\] \[end\] .* reason=extended_torrent - /));
  });
});

describe('DownloadRemovalService when another attempt uses the same torrent', () => {
  const LEFT = 'Another request still uses this torrent, so BookOrbit left it in the download client.';

  it('leaves the torrent in place on delete / cancel (removeLatestForRequest) even with delete-files', async () => {
    const { service, adapter, downloads } = makeService({ shared: true });

    await expect(service.removeLatestForRequest(7, true, 'ann')).resolves.toEqual({ removed: false, error: null });

    expect(downloads.existsOtherForClientKey).toHaveBeenCalledWith(11, 7, 4, INFO_HASH);
    expect(adapter.remove).not.toHaveBeenCalled();
    expect(downloads.updateIf).toHaveBeenCalledWith(11, expect.anything(), { status: 'failed', errorMessage: LEFT });
  });

  it('leaves the torrent in place on remove-from-client (removeAttempt) with delete-files', async () => {
    const { service, adapter } = makeService({ shared: true, latest: download({ status: 'imported' }) });

    await expect(service.removeAttempt(7, 11, true, 'ann')).resolves.toEqual({ wasInFlight: false, leftInClient: true, leftMessage: LEFT });
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it('logs the skipped removal with the shared_torrent reason', async () => {
    const { service } = makeService({ shared: true });
    const log = vi.spyOn((service as never as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);

    await service.detachAttempt(download(), false);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[book_request\.remove\] \[end\] .* reason=shared_torrent - /));
  });

  it('still removes a torrent nobody else uses', async () => {
    const { service, adapter } = makeService();

    await service.removeLatestForRequest(7, true, 'ann');

    expect(adapter.remove).toHaveBeenCalledWith(INFO_HASH, expect.anything(), { deleteFiles: true });
  });

  it('asks about other requests only, so a request retrying its own hash still removes the torrent', async () => {
    const { service, adapter, downloads } = makeService({ shared: false });

    await service.removeLatestForRequest(7, true, 'ann');

    expect(downloads.existsOtherForClientKey).toHaveBeenCalledWith(11, 7, 4, INFO_HASH);
    expect(adapter.remove).toHaveBeenCalledWith(INFO_HASH, expect.anything(), { deleteFiles: true });
  });
});
