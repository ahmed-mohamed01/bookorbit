import { Injectable } from '@nestjs/common';

import type { RecordWebSerialPublishedRequestInput, WebSerialKind, WebSerialPublishedRequest } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { WebSerialsRepository } from './web-serials.repository';

/** Remembers which Book Requests a user filed for a series' volumes; the requests themselves belong to Book Requests. */
@Injectable()
export class WebSerialsPublishedRequestsService {
  constructor(private readonly repo: WebSerialsRepository) {}

  async record(user: RequestUser, input: RecordWebSerialPublishedRequestInput): Promise<void> {
    await this.repo.upsertVolumeRequest(user.id, input.kind, input.matchId, input.volume, input.bookRequestId);
  }

  list(user: RequestUser, kind: WebSerialKind, matchId: string): Promise<WebSerialPublishedRequest[]> {
    return this.repo.listVolumeRequests(user.id, kind, matchId);
  }
}
