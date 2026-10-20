import { IndexerSearchService } from '../book-request/indexers/indexer-search.service';
import { RequestFulfillmentService } from '../book-request/fulfillment/request-fulfillment.service';
import { BatchUnitFilingService } from '../book-request/batch/batch-unit-filing.service';
import { UserService } from '../user/user.service';
import { Permission } from '@bookorbit/types';
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WebSerialsPrintService } from './web-serials-print.service';
import { WebSerialsRepository } from './web-serials.repository';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { BookRequestBatchService } from '../book-request/batch/book-request-batch.service';
import { BookRequestService } from '../book-request/book-request.service';
import { SeriesService } from '../series/series.service';
import type { RequestUser } from '../../common/types/request-user';

const user = { id: 7 } as RequestUser;
const input = { title: 'Story', altTitles: ['Other'], authors: ['Author'], url: 'https://example.com/1', volumeCount: 4 };
const row = { id: 1, userId: 7, kind: 'novel', matchId: '12', bookRequestId: 9, seriesKeys: ['story'] };
async function setup() {
  const repo = {
    findVolumeChildren: vi.fn().mockResolvedValue([]),
    setSeriesDraft: vi.fn().mockResolvedValue(true),
    deleteUntouchedDraft: vi.fn().mockResolvedValue(1),
    hasSeriesRequestReference: vi.fn().mockResolvedValue(false),
    findStaleDrafts: vi.fn().mockResolvedValue([]),
    findSeriesRequestByBatch: vi.fn().mockResolvedValue(row),
    insertVolumeChild: vi.fn(),
    findSeriesRequests: vi.fn().mockResolvedValue([row]),
    listVolumeRequests: vi.fn().mockResolvedValue([1, 2, 3, 4].map((volume) => ({ volume: String(volume), bookRequestId: 9 }))),
    findBatchIds: vi.fn().mockResolvedValue(new Map([[1, [10]]])),
    insertSeriesRequest: vi.fn().mockResolvedValue(row),
    upsertVolumeRequest: vi.fn(),
    findSeriesRequestById: vi.fn().mockResolvedValue(row),
    linkBatch: vi.fn(),
  };
  const requests = {
    cancel: vi.fn(),
    remove: vi.fn(),
    getOne: vi.fn(),
    create: vi.fn().mockResolvedValue({ requestId: 10 }),
    findRequestsByIds: vi.fn().mockResolvedValue(new Map([[9, { userId: 7, status: 'pending' }]])),
    findBatchUnits: vi.fn().mockResolvedValue(new Map([[10, []]])),
    submit: vi.fn().mockResolvedValue({ request: { id: 9, status: 'pending' } }),
    settleAvailable: vi.fn().mockResolvedValue(true),
  };
  const users = { findByIdWithPermissions: vi.fn().mockResolvedValue({ ...user, username: 'owner', active: true }) };
  const series = { findOwnedVolumes: vi.fn().mockResolvedValue(new Map()) };
  const module = await Test.createTestingModule({
    providers: [
      WebSerialsPrintService,
      { provide: IndexerSearchService, useValue: { adoptCandidate: vi.fn().mockReturnValue(true) } },
      { provide: UserService, useValue: users },
      { provide: RequestFulfillmentService, useValue: { listReleases: vi.fn().mockResolvedValue({ releases: [] }), grab: vi.fn() } },
      { provide: BatchUnitFilingService, useValue: { registerMetadataResolver: vi.fn() } },
      { provide: WebSerialsRepository, useValue: repo },
      { provide: BookRequestService, useValue: requests },
      { provide: BookRequestBatchService, useValue: requests },
      { provide: SeriesService, useValue: series },
      {
        provide: WebSerialsSettingsService,
        useValue: { getSettings: vi.fn().mockResolvedValue({ novel: { targetLibraryId: 3, targetFolderId: 4 } }) },
      },
    ],
  }).compile();
  return {
    search: module.get(IndexerSearchService),
    service: module.get(WebSerialsPrintService),
    repo,
    users,
    requests,
    series,
    fulfillment: module.get(RequestFulfillmentService),
    filing: module.get(BatchUnitFilingService),
  };
}
it('state precedence owned beats in_dock beats downloading beats requested', async () => {
  const { service, requests, series } = await setup();
  series.findOwnedVolumes.mockResolvedValue(new Map([[1, 100]]));
  requests.findBatchUnits.mockResolvedValue(
    new Map([
      [
        10,
        [
          { title: 'Story Vol 1-3', status: 'placing' },
          { title: 'Story Vol 1-2', status: 'in_dock' },
        ],
      ],
    ]),
  );
  expect((await service.getState(user, '12', input)).volumes.map((v) => v.state)).toEqual(['owned', 'in_dock', 'downloading', 'requested']);
});
it('failed unit keeps the volume requested and carries its error', async () => {
  const { service, requests } = await setup();
  requests.findBatchUnits.mockResolvedValue(new Map([[10, [{ title: 'Story Vol 1', status: 'failed', errorMessage: 'Download failed' }]]]));
  expect((await service.getState(user, '12', input)).volumes[0]).toEqual({ volume: 1, state: 'requested', bookId: null, error: 'Download failed' });
});
it('requestVolumes files one request with autoGrab false and the novel default library', async () => {
  const { service, repo, requests } = await setup();
  repo.findSeriesRequests.mockResolvedValue([]);
  await service.requestVolumes(user, '12', { ...input, volumes: [1, 2, 4] });
  expect(requests.submit).toHaveBeenCalledWith(
    {
      title: 'Story (light novel volumes)',
      seriesName: 'Story',
      authors: ['Author'],
      mediaKind: 'ebook',
      preferredFormats: ['epub'],
      targetLibraryId: 3,
      targetFolderId: 4,
      autoGrab: false,
      note: 'MangaBaka: https://example.com/1 · Volumes: 1-2, 4',
    },
    user,
  );
  expect(repo.upsertVolumeRequest).toHaveBeenCalledWith(7, 'novel', '12', '4', 9);
});
it('requestVolumes extends an active request instead of filing a second', async () => {
  const { service, requests, repo } = await setup();
  await service.requestVolumes(user, '12', { ...input, volumes: [2] });
  expect(requests.submit).not.toHaveBeenCalled();
  expect(repo.upsertVolumeRequest).toHaveBeenCalledWith(7, 'novel', '12', '2', 9);
});
it('rejects volumes beyond volumeCount', async () => {
  const { service } = await setup();
  await expect(service.requestVolumes(user, '12', { ...input, volumes: [5] })).rejects.toThrow(BadRequestException);
});
it('does not settle while a volume is missing', async () => {
  const { service, requests } = await setup();
  await service.getState(user, '12', input);
  expect(requests.settleAvailable).not.toHaveBeenCalled();
});
it('settles when every requested volume is owned', async () => {
  const { service, requests, series } = await setup();
  series.findOwnedVolumes.mockResolvedValue(new Map([1, 2, 3, 4].map((v) => [v, v])));
  await service.getState(user, '12', input);
  expect(requests.settleAvailable).toHaveBeenCalledWith(9, 'Every requested volume is in the library');
});

it('linkBatch refuses a series request from another series or user', async () => {
  const { service, repo } = await setup();
  await expect(service.linkBatch(user, 'other', { seriesRequestId: 1, batchRequestId: 10 })).rejects.toThrow(ForbiddenException);
  repo.findSeriesRequestById.mockResolvedValue({ ...row, userId: 8 });
  await expect(service.linkBatch(user, '12', { seriesRequestId: 1, batchRequestId: 10 })).rejects.toThrow(ForbiddenException);
});

it('uses the newest active request and ignores completed volume rows', async () => {
  const { service, repo, requests } = await setup();
  repo.findSeriesRequests.mockResolvedValue([{ ...row, id: 2, bookRequestId: 11 }, row]);
  requests.findRequestsByIds.mockResolvedValue(
    new Map([
      [11, { userId: 7, status: 'available' }],
      [9, { userId: 7, status: 'pending' }],
    ]),
  );
  repo.listVolumeRequests.mockResolvedValue([
    { volume: '1', bookRequestId: 11 },
    { volume: '2', bookRequestId: 9 },
  ]);
  const state = await service.getState(user, '12', input);
  expect(state.seriesRequestId).toBe(1);
  expect(state.bookRequestId).toBe(9);
  expect(state.volumes.map((v) => v.state)).toEqual(['missing', 'requested', 'missing', 'missing']);
});

it('chunks batch lookups and parses the primary path when title is null', async () => {
  const { service, repo, requests } = await setup();
  repo.findBatchIds.mockResolvedValue(new Map([[1, Array.from({ length: 51 }, (_, i) => i + 100)]]));
  requests.findBatchUnits.mockResolvedValue(new Map([[100, [{ title: null, primaryPath: '/downloads/Story Vol 3.epub', status: 'in_dock' }]]]));
  expect((await service.getState(user, '12', input)).volumes[2]!.state).toBe('in_dock');
  expect(requests.findBatchUnits.mock.calls.map((call) => call[0].length)).toEqual([50, 1]);
});

it('does not settle an empty request', async () => {
  const { service, repo, requests } = await setup();
  repo.listVolumeRequests.mockResolvedValue([]);
  await service.getState(user, '12', input);
  expect(requests.settleAvailable).not.toHaveBeenCalled();
});

it('allows an approver to link their own batch and series request but refuses another user batch', async () => {
  const { service, requests, repo } = await setup();
  requests.findRequestsByIds.mockResolvedValue(new Map([[10, { userId: 8, status: 'pending' }]]));
  await expect(service.linkBatch(user, '12', { seriesRequestId: 1, batchRequestId: 10 })).rejects.toThrow(ForbiddenException);
  expect(repo.linkBatch).not.toHaveBeenCalled();
  requests.findRequestsByIds.mockResolvedValue(new Map([[10, { userId: 7, status: 'pending' }]]));
  await service.linkBatch(user, '12', { seriesRequestId: 1, batchRequestId: 10 });
  expect(repo.linkBatch).toHaveBeenCalledWith(1, 10);
});

it('records the user series row and volumes when submit subscribes to another user request', async () => {
  const { service, repo, requests } = await setup();
  repo.findSeriesRequests.mockResolvedValueOnce([]);
  requests.submit.mockResolvedValue({ request: { id: 9, userId: 8, status: 'pending' }, subscribed: true });
  await service.requestVolumes(user, '12', { ...input, volumes: [1, 3] });
  expect(repo.insertSeriesRequest).toHaveBeenCalledWith({
    userId: 7,
    kind: 'novel',
    matchId: '12',
    bookRequestId: 9,
    seriesKeys: ['story', 'story (light novel)', 'other', 'other (light novel)'],
    draft: false,
  });
  expect(repo.upsertVolumeRequest.mock.calls).toEqual([
    [7, 'novel', '12', '1', 9],
    [7, 'novel', '12', '3', 9],
  ]);
});

it('returns null request ids when no request is active', async () => {
  const { service, repo } = await setup();
  repo.findSeriesRequests.mockResolvedValue([]);
  expect(await service.getState(user, '12', input)).toMatchObject({ seriesRequestId: null, bookRequestId: null });
});

it('never settles a request owned by another user', async () => {
  const { service, requests } = await setup();
  requests.findRequestsByIds.mockResolvedValue(new Map([[9, { userId: 8, status: 'pending' }]]));
  const owned = await service.settleIfComplete(row as never, user);
  expect(owned).toBe(false);
  expect(requests.settleAvailable).not.toHaveBeenCalled();
});

it('refuses a series request that is already available on create', async () => {
  const { service, repo, requests } = await setup();
  repo.findSeriesRequests.mockResolvedValue([]);
  requests.submit.mockResolvedValue({ request: { id: 9, status: 'available' } });
  await expect(service.requestVolumes(user, '12', { ...input, volumes: [1] })).rejects.toThrow(ConflictException);
  expect(repo.insertSeriesRequest).not.toHaveBeenCalled();
});
it('reuses the existing series row on a unique violation', async () => {
  const { service, repo } = await setup();
  repo.findSeriesRequests.mockResolvedValueOnce([]).mockResolvedValue([row]);
  repo.insertSeriesRequest.mockRejectedValue({ code: '23505' });
  const state = await service.requestVolumes(user, '12', { ...input, volumes: [1] });
  expect(state.seriesRequestId).toBe(1);
  expect(repo.upsertVolumeRequest).toHaveBeenCalledWith(7, 'novel', '12', '1', 9);
});
it('settle logs the request, user, volumes and owned count', async () => {
  const { service, series } = await setup();
  const log = vi.spyOn(service['logger'], 'log').mockImplementation(() => {});
  series.findOwnedVolumes.mockResolvedValue(new Map([1, 2, 3, 4].map((v) => [v, v])));
  await service.settleIfComplete(row as never, user);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('requestId=9 userId=7 volumes=4 owned=4'));
});
it('keeps a volume error only when no live unit covers it', async () => {
  const { service, requests } = await setup();
  requests.findBatchUnits.mockResolvedValue(
    new Map([
      [
        10,
        [
          { title: 'Story Vol 1', status: 'failed', errorMessage: 'old failure' },
          { title: 'Story Vol 1', status: 'placing' },
          { title: 'Story Vol 2', status: 'failed', errorMessage: 'real failure' },
        ],
      ],
    ]),
  );
  const volumes = (await service.getState(user, '12', input)).volumes;
  expect(volumes[0]).toMatchObject({ state: 'downloading', error: null });
  expect(volumes[1]).toMatchObject({ state: 'requested', error: 'real failure' });
});

it('draft is reused, not duplicated', async () => {
  const { service, requests } = await setup();
  expect(await service.createDraft(user, '12', input)).toEqual({ seriesRequestId: 1, bookRequestId: 9 });
  expect(requests.submit).not.toHaveBeenCalled();
});
it("deleteDraft refuses another user's series request", async () => {
  const { service, repo } = await setup();
  repo.findSeriesRequestById.mockResolvedValue({ ...row, userId: 8 });
  await expect(service.deleteDraft(user, '12', 1)).rejects.toThrow(ForbiddenException);
});

it('deleteDraft removes an untouched draft', async () => {
  const { service, repo, requests } = await setup();
  repo.findSeriesRequestById.mockResolvedValue({ ...row, draft: true });
  repo.findBatchIds.mockResolvedValue(new Map());
  await service.deleteDraft(user, '12', 1);
  expect(requests.cancel).toHaveBeenCalledWith(9, user);
  expect(requests.remove).toHaveBeenCalledWith(9, user);
  expect(repo.deleteUntouchedDraft).toHaveBeenCalledWith(1, 7);
});
it('deleteDraft keeps a series request when conditional deletion loses the race', async () => {
  const { service, repo, requests } = await setup();
  repo.findSeriesRequestById.mockResolvedValue({ ...row, draft: true });
  repo.deleteUntouchedDraft.mockResolvedValue(0);
  await service.deleteDraft(user, '12', 1);
  repo.findBatchIds.mockResolvedValue(new Map());
  repo.findVolumeChildren.mockResolvedValue([{ volume: 1, bookRequestId: 11 }]);
  await service.deleteDraft(user, '12', 1);
  expect(requests.cancel).not.toHaveBeenCalled();
});
it('sweep removes stale drafts only', async () => {
  const { service, repo, requests } = await setup();
  repo.findStaleDrafts.mockResolvedValue([{ ...row, draft: true }]);
  repo.findBatchIds.mockResolvedValue(new Map());
  repo.findSeriesRequestById.mockResolvedValueOnce({ ...row, draft: true }).mockResolvedValue(undefined);
  expect(await service.sweepDrafts()).toBe(1);
  expect(repo.findStaleDrafts).toHaveBeenCalledWith(expect.any(Date));
  expect(requests.cancel).toHaveBeenCalledTimes(1);
});
function release(title: string, overrides: Record<string, unknown> = {}) {
  return { title, indexerId: 1, guid: title, format: 'epub', formats: ['epub'], score: 1, seeders: 1, sizeBytes: 10, ...overrides };
}
it('suggestion covers all missing with fewest releases', async () => {
  const { service, fulfillment, series } = await setup();
  series.findOwnedVolumes.mockResolvedValue(new Map([[1, 100]]));
  vi.mocked(fulfillment.listReleases).mockResolvedValue({ releases: [release('Story Vol 2'), release('Story Vol 2-4')] } as never);
  expect(await service.suggestion({ ...user, permissions: [Permission.ManageBookRequests] }, '12', { ...input, seriesRequestId: 1 })).toEqual({
    releases: [{ indexerId: 1, guid: 'Story Vol 2-4' }],
    volumes: [2, 3, 4],
    sizeBytes: 10,
  });
  expect(fulfillment.listReleases).toHaveBeenCalledWith(9, { refresh: false });
});
it('suggestion excludes off-series releases with volume markers', async () => {
  const { service, fulfillment } = await setup();
  vi.mocked(fulfillment.listReleases).mockResolvedValue({
    releases: [release("2-Minute Tabletop's Everything Pack V7 by 2-Minute Tabletop [ENG] [VIP]")],
  } as never);
  expect(
    await service.suggestion({ ...user, permissions: [Permission.ManageBookRequests] }, '12', {
      ...input,
      title: 'The Water Magician: The Central Provinces Arc',
      altTitles: [],
      volumeCount: 7,
      seriesRequestId: 1,
    }),
  ).toEqual({ releases: [], volumes: [], sizeBytes: 0 });
});
it('suggestion allows VIP and skips manga', async () => {
  const { service, fulfillment } = await setup();
  vi.mocked(fulfillment.listReleases).mockResolvedValue({
    releases: [release('Story Manga Vol 1-4'), release('Story Vol 1-4', { vipOnly: true })],
  } as never);
  expect(
    (await service.suggestion({ ...user, permissions: [Permission.ManageBookRequests] }, '12', { ...input, seriesRequestId: 1 })).releases,
  ).toEqual([{ indexerId: 1, guid: 'Story Vol 1-4' }]);
});
it('suggestion ignores packs whose volumes are unknown', async () => {
  const { service, fulfillment } = await setup();
  vi.mocked(fulfillment.listReleases).mockResolvedValue({ releases: [release('Story complete collection')] } as never);
  expect(
    (await service.suggestion({ ...user, permissions: [Permission.ManageBookRequests] }, '12', { ...input, seriesRequestId: 1 })).volumes,
  ).toEqual([]);
});
it('download makes a batch for a pack and a child request for a single', async () => {
  const { service, repo, requests, fulfillment } = await setup();
  requests.getOne.mockResolvedValue({ seriesName: 'Story' });
  requests.findRequestsByIds.mockResolvedValue(
    new Map([
      [9, { userId: 7, status: 'pending' }],
      [10, { userId: 7, status: 'pending' }],
    ]),
  );
  requests.submit.mockResolvedValue({ request: { id: 11, userId: 7, status: 'approved' } });
  await service.download(user, '12', {
    ...input,
    seriesRequestId: 1,
    downloadClientId: 2,
    picks: [
      { indexerId: 1, releaseGuid: 'pack', unitIndexes: [0, 1], volumes: [1, 2], downloadClientId: 8 },
      { indexerId: 1, releaseGuid: 'single', unitIndexes: null, volumes: [3] },
    ],
  });
  expect(requests.create).toHaveBeenCalledWith(user, {
    sourceRequestId: 9,
    indexerId: 1,
    releaseGuid: 'pack',
    downloadClientId: 8,
    unitIndexes: [0, 1],
  });
  expect(requests.submit).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Story Vol. 3', seriesName: 'Story', seriesIndex: 3, targetLibraryId: 3, targetFolderId: 4, autoGrab: false }),
    user,
  );
  expect(fulfillment.grab).toHaveBeenCalledWith(11, { indexerId: 1, releaseGuid: 'single' }, user);
  expect(repo.insertVolumeChild).toHaveBeenCalledWith(1, 3, 11);
  expect(repo.setSeriesDraft).toHaveBeenCalledWith(1, false);
});
it.each([undefined, null, 7])('routes single picks using only their own client %s', async (downloadClientId) => {
  const { service, requests, fulfillment } = await setup();
  requests.getOne.mockResolvedValue({ seriesName: 'Story' });
  requests.submit.mockResolvedValue({ request: { id: 11, userId: 7, status: 'approved' } });
  await service.download(user, '12', {
    ...input,
    seriesRequestId: 1,
    downloadClientId: 2,
    picks: [{ indexerId: 1, releaseGuid: 'single', unitIndexes: null, volumes: [3], downloadClientId }],
  });
  expect(fulfillment.grab).toHaveBeenCalledWith(
    11,
    {
      indexerId: 1,
      releaseGuid: 'single',
      ...(downloadClientId != null ? { downloadClientId } : {}),
    },
    user,
  );
});
it('print-state hides requested from approvers', async () => {
  const { service } = await setup();
  const state = await service.getState({ ...user, permissions: [Permission.ManageBookRequests] }, '12', input);
  expect(state.role).toBe('approver');
  expect(state.volumes.every((volume) => volume.state !== 'requested')).toBe(true);
});
it('child request available counts as owned', async () => {
  const { service, repo, requests } = await setup();
  repo.findVolumeChildren.mockResolvedValue([{ volume: 2, bookRequestId: 11 }]);
  requests.getOne.mockResolvedValue({ id: 11, title: 'Story Vol. 2', status: 'available', matchedBookId: 99 });
  expect((await service.getState(user, '12', input)).volumes[1]).toMatchObject({ state: 'owned', bookId: 99 });
});
it('resolver returns series name and volume for linked batches only', async () => {
  const { service, repo, requests, filing } = await setup();
  service.onModuleInit();
  expect(filing.registerMetadataResolver).toHaveBeenCalled();
  requests.findRequestsByIds.mockResolvedValue(new Map([[9, { userId: 7, seriesName: 'Story', authors: ['Author'] }]]));
  const unit = { title: 'Story Vol 3' } as never;
  expect(await service.resolveBatchMetadata(10, unit)).toEqual({ seriesName: 'Story', seriesIndex: '3', authors: ['Author'] });
  repo.findSeriesRequestByBatch.mockResolvedValue(undefined);
  expect(await service.resolveBatchMetadata(10, unit)).toBeNull();
});

it('does not count filed batch units as owned without a library match', async () => {
  const { service, requests } = await setup();
  requests.findBatchUnits.mockResolvedValue(new Map([[10, [{ title: 'Story Vol 1', status: 'filed' }]]]));
  const state = await service.getState({ ...user, permissions: [Permission.ManageBookRequests] }, '12', input);
  expect(state.volumes[0].state).toBe('missing');
  expect(state.downloads[0].status).toBe('filed');
});
it('skips grabbing a child that is already available', async () => {
  const { service, requests, fulfillment, repo } = await setup();
  requests.getOne.mockResolvedValue({ seriesName: 'Story' });
  requests.submit.mockResolvedValue({ request: { id: 11, status: 'available' } });
  await service.download(user, '12', {
    ...input,
    seriesRequestId: 1,
    downloadClientId: 2,
    picks: [{ indexerId: 1, releaseGuid: 'single', unitIndexes: null, volumes: [1] }],
  });
  expect(fulfillment.grab).not.toHaveBeenCalled();
  expect(repo.insertVolumeChild).not.toHaveBeenCalled();
});

it('suggestion does not count in-dock or downloading volumes', async () => {
  const { service, requests, fulfillment, series } = await setup();
  series.findOwnedVolumes.mockResolvedValue(new Map([[1, 100]]));
  requests.findBatchUnits.mockResolvedValue(
    new Map([
      [
        10,
        [
          { title: 'Story Vol 2', status: 'in_dock' },
          { title: 'Story Vol 3', status: 'placing' },
        ],
      ],
    ]),
  );
  vi.mocked(fulfillment.listReleases).mockResolvedValue({ releases: [release('Story Vol 2-3'), release('Story Vol 4')] } as never);
  expect(await service.suggestion({ ...user, permissions: [Permission.ManageBookRequests] }, '12', { ...input, seriesRequestId: 1 })).toEqual({
    releases: [{ indexerId: 1, guid: 'Story Vol 4' }],
    volumes: [4],
    sizeBytes: 10,
  });
});
it('suggestion does not count requested volumes', async () => {
  const { service, fulfillment } = await setup();
  vi.mocked(fulfillment.listReleases).mockResolvedValue({ releases: [release('Story Vol 1-4')] } as never);
  expect((await service.suggestion(user, '12', { ...input, seriesRequestId: 1 })).volumes).toEqual([]);
});
it('sweep deletes missing and inactive owners rows and continues after a failure', async () => {
  const { service, repo, users } = await setup();
  repo.findStaleDrafts.mockResolvedValue([1, 2, 3, 4].map((id) => ({ ...row, id, draft: true })));
  users.findByIdWithPermissions
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ ...user, active: false })
    .mockRejectedValueOnce(new ForbiddenException('lookup failed'));
  const deletion = vi.spyOn(service, 'deleteDraft').mockResolvedValue();
  repo.findSeriesRequestById.mockResolvedValue(undefined);
  expect(await service.sweepDrafts()).toBe(3);
  expect(repo.deleteUntouchedDraft.mock.calls).toEqual([
    [1, 7],
    [2, 7],
  ]);
  expect(deletion).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ username: 'owner', active: true }), '12', 4);
});

it('loads requests at most four at a time and skips inaccessible children', async () => {
  const { service, repo, requests } = await setup();
  repo.findBatchIds.mockResolvedValue(new Map());
  repo.findVolumeChildren.mockResolvedValue(Array.from({ length: 9 }, (_, i) => ({ volume: 1, bookRequestId: i + 20 })));
  let concurrent = 0;
  let peak = 0;
  requests.getOne.mockImplementation(async (id: number) => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    concurrent--;
    if (id === 20) throw new NotFoundException();
    if (id === 21) throw new ForbiddenException();
    return { id, title: 'Story Vol 1', status: 'downloading' };
  });
  const state = await service.getState(user, '12', input);
  expect(peak).toBe(4);
  expect(state.downloads).toHaveLength(7);
  expect(requests.getOne).toHaveBeenCalledWith(20, user);
});

it('adopts before grabbing and links only after success, cancelling failures and continuing picks', async () => {
  const { service, search, fulfillment, requests, repo } = await setup();
  requests.getOne.mockResolvedValue({ seriesName: 'Story' });
  requests.submit
    .mockResolvedValueOnce({ request: { id: 11, userId: 7, status: 'approved' } })
    .mockResolvedValueOnce({ request: { id: 12, userId: 7, status: 'approved' } });
  vi.mocked(fulfillment.grab)
    .mockRejectedValueOnce(new BadRequestException('Refused'))
    .mockResolvedValueOnce({} as never);
  const response = await service.download(user, '12', {
    ...input,
    seriesRequestId: 1,
    downloadClientId: 2,
    picks: [1, 2].map((volume) => ({ indexerId: 1, releaseGuid: `single${volume}`, unitIndexes: null, volumes: [volume] })),
  });
  expect(search.adoptCandidate).toHaveBeenCalledWith(9, 11, 1, 'single1');
  expect(vi.mocked(search.adoptCandidate).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fulfillment.grab).mock.invocationCallOrder[0]);
  expect(requests.cancel).toHaveBeenCalledWith(11, user);
  expect(repo.insertVolumeChild).toHaveBeenCalledExactlyOnceWith(1, 2, 12);
  expect(repo.insertVolumeChild.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(fulfillment.grab).mock.invocationCallOrder[1]);
  expect(response.failures).toEqual([{ indexerId: 1, releaseGuid: 'single1', error: 'Refused' }]);
});
it('all picks failing restores the draft so close deletes it', async () => {
  const { service, repo, requests, fulfillment } = await setup();
  const draftRow = { ...row, draft: true };
  repo.findSeriesRequestById.mockResolvedValue(draftRow);
  repo.setSeriesDraft.mockImplementation((_id, draft) => {
    draftRow.draft = draft;
    return Promise.resolve(true);
  });
  repo.findBatchIds.mockResolvedValue(new Map());
  requests.getOne.mockResolvedValue({ seriesName: 'Story' });
  requests.findRequestsByIds.mockResolvedValue(new Map([[9, { userId: 7, status: 'approved' }]]));
  requests.create.mockRejectedValue(new BadRequestException('Pack refused'));
  requests.submit.mockResolvedValue({ request: { id: 11, userId: 7, status: 'approved' } });
  vi.mocked(fulfillment.grab).mockRejectedValue(new BadRequestException('Single refused'));
  const response = await service.download(user, '12', {
    ...input,
    seriesRequestId: 1,
    downloadClientId: 2,
    picks: [
      { indexerId: 1, releaseGuid: 'pack', unitIndexes: [0, 1], volumes: [1, 2] },
      { indexerId: 1, releaseGuid: 'single', unitIndexes: null, volumes: [3] },
    ],
  });
  expect(response.failures).toHaveLength(2);
  expect(repo.insertVolumeChild).not.toHaveBeenCalled();
  expect(repo.setSeriesDraft).toHaveBeenLastCalledWith(1, true);
  await service.deleteDraft(user, '12', 1);
  expect(repo.deleteUntouchedDraft).toHaveBeenCalledWith(1, 7);
  expect(requests.cancel).toHaveBeenCalledWith(9, user);
  expect(requests.remove).toHaveBeenCalledWith(9, user);
});
it.each(['batch', 'child'])('failed picks preserve a series with an existing %s', async (existing) => {
  const { service, repo, requests } = await setup();
  requests.getOne.mockResolvedValue({ seriesName: 'Story' });
  requests.create.mockRejectedValue(new BadRequestException('Refused'));
  repo.findBatchIds.mockResolvedValue(new Map([[1, existing === 'batch' ? [10] : []]]));
  if (existing === 'child') repo.findVolumeChildren.mockResolvedValue([{ volume: 3, bookRequestId: 11 }]);
  await service.download(user, '12', {
    ...input,
    seriesRequestId: 1,
    downloadClientId: 2,
    picks: [{ indexerId: 1, releaseGuid: 'pack', unitIndexes: [0, 1], volumes: [1, 2] }],
  });
  expect(repo.setSeriesDraft).toHaveBeenCalledExactlyOnceWith(1, false);
});
it('rejects multi-volume single-file releases before any side effects', async () => {
  const { service, requests, repo } = await setup();
  await expect(
    service.download(user, '12', {
      ...input,
      seriesRequestId: 1,
      downloadClientId: 2,
      picks: [{ indexerId: 1, releaseGuid: 'omnibus', unitIndexes: null, volumes: [1, 2] }],
    }),
  ).rejects.toThrow(BadRequestException);
  expect(repo.setSeriesDraft).not.toHaveBeenCalled();
  expect(requests.submit).not.toHaveBeenCalled();
});
it.each([true, false])('deletes untouched rows without deleting shared or foreign requests: shared=%s', async (shared) => {
  const { service, repo, requests } = await setup();
  repo.findSeriesRequestById.mockResolvedValue({ ...row, draft: true });
  repo.hasSeriesRequestReference.mockResolvedValue(shared);
  if (!shared) requests.findRequestsByIds.mockResolvedValue(new Map([[9, { userId: 8, status: 'pending' }]]));
  await service.deleteDraft(user, '12', 1);
  expect(repo.deleteUntouchedDraft).toHaveBeenCalledWith(1, 7);
  expect(requests.cancel).not.toHaveBeenCalled();
  expect(requests.remove).not.toHaveBeenCalled();
});
it('protects the draft before starting external work', async () => {
  const { service, repo, requests } = await setup();
  requests.getOne.mockImplementation(() => {
    expect(repo.setSeriesDraft).toHaveBeenCalledWith(1, false);
    return Promise.resolve({ seriesName: 'Story' });
  });
  await service.download(user, '12', { ...input, seriesRequestId: 1, downloadClientId: 2, picks: [] });
});
it('uses batch download status and surfaces held unit reasons and children', async () => {
  const { service, requests, repo } = await setup();
  requests.getOne.mockResolvedValue({ id: 10, title: 'Pack', status: 'downloading', download: { progressPercent: 42 } });
  requests.findBatchUnits.mockResolvedValue(new Map([[10, [{ title: 'Story Vol 1', status: 'waiting' }]]]));
  expect((await service.getState(user, '12', input)).downloads[0]).toMatchObject({ status: 'downloading', percent: 42 });
  requests.getOne.mockImplementation((id) => Promise.resolve({ id, title: 'Review', status: 'needs_review', statusReason: 'Check match' }));
  requests.findBatchUnits.mockResolvedValue(new Map([[10, [{ title: 'Story Vol 1', status: 'in_dock', errorMessage: 'Uncertain match' }]]]));
  repo.findVolumeChildren.mockResolvedValue([{ volume: 2, bookRequestId: 11 }]);
  expect((await service.getState(user, '12', input)).downloads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: 'held', error: 'Uncertain match' }),
      expect.objectContaining({ status: 'held', error: 'Check match' }),
    ]),
  );
});

it('does not start a download if deletion wins before draft protection', async () => {
  const { service, repo, requests } = await setup();
  repo.setSeriesDraft.mockResolvedValue(false);
  await expect(service.download(user, '12', { ...input, seriesRequestId: 1, downloadClientId: 2, picks: [] })).rejects.toThrow(ConflictException);
  expect(requests.getOne).not.toHaveBeenCalled();
});
it('preserves full volume count and alternate-title ownership in the response', async () => {
  const { service, requests, series } = await setup();
  requests.getOne.mockResolvedValue({ seriesName: 'Story' });
  series.findOwnedVolumes.mockResolvedValue(new Map([[20, 200]]));
  const response = await service.download(user, '12', { ...input, volumeCount: 26, seriesRequestId: 1, downloadClientId: 2, picks: [] });
  expect(response.volumes).toHaveLength(26);
  expect(series.findOwnedVolumes).toHaveBeenCalledWith(user, expect.arrayContaining(['other']), 26);
  expect(response.volumes[19]).toMatchObject({ state: 'owned', bookId: 200 });
});

it('suggestion reads the cache for the searched query', async () => {
  const { service, fulfillment } = await setup();
  const query = { title: 'Romaji title', authors: [] };
  await service.suggestion(user, '12', { ...input, seriesRequestId: 1, query });
  expect(fulfillment.listReleases).toHaveBeenCalledWith(9, { refresh: false, overrides: query });
});
