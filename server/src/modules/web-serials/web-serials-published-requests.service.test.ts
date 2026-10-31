import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { WebSerialsPublishedRequestsService } from './web-serials-published-requests.service';

const USER = { id: 7 } as RequestUser;

function setup() {
  const repo = {
    upsertVolumeRequest: vi.fn().mockResolvedValue(undefined),
    listVolumeRequests: vi.fn().mockResolvedValue([{ volume: '2', bookRequestId: 9 }]),
  };
  const bookRequests = { getOne: vi.fn().mockResolvedValue({ userId: USER.id }) };
  return { service: new WebSerialsPublishedRequestsService(repo as never, bookRequests as never), repo, bookRequests };
}

describe('WebSerialsPublishedRequestsService', () => {
  it('records a request under the calling user, never one named in the body', async () => {
    const { service, repo } = setup();

    await service.record(USER, { kind: 'manga', matchId: '12', volume: '2', bookRequestId: 9 });

    expect(repo.upsertVolumeRequest).toHaveBeenCalledWith(7, 'manga', '12', '2', 9);
  });

  it('lists only the calling user records for the series', async () => {
    const { service, repo } = setup();

    await expect(service.list(USER, 'novel', '12')).resolves.toEqual([{ volume: '2', bookRequestId: 9 }]);

    expect(repo.listVolumeRequests).toHaveBeenCalledWith(7, 'novel', '12');
  });
});

it('refuses to record another user request', async () => {
  const { service, repo, bookRequests } = setup();
  bookRequests.getOne.mockResolvedValue({ userId: 99 });
  await expect(service.record(USER, { kind: 'manga', matchId: '12', volume: '2', bookRequestId: 9 })).rejects.toThrow(
    'Book request belongs to another user',
  );
  expect(repo.upsertVolumeRequest).not.toHaveBeenCalled();
});

it('does not record a missing or inaccessible request', async () => {
  const { service, repo, bookRequests } = setup();
  bookRequests.getOne.mockRejectedValue(new NotFoundException('Book request not found'));
  await expect(service.record(USER, { kind: 'manga', matchId: '12', volume: '2', bookRequestId: 9 })).rejects.toBeInstanceOf(NotFoundException);
  expect(repo.upsertVolumeRequest).not.toHaveBeenCalled();
});
