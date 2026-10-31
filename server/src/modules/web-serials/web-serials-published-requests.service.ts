import { ForbiddenException, Injectable } from '@nestjs/common';

import type { RecordWebSerialPublishedRequestInput, WebSerialKind, WebSerialPublishedRequest } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { BookRequestService } from '../book-request/book-request.service';
import { WebSerialsRepository } from './web-serials.repository';

/** Remembers which Book Requests a user filed for a series' volumes; the requests themselves belong to Book Requests. */
@Injectable()
export class WebSerialsPublishedRequestsService {
  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly bookRequests: BookRequestService,
  ) {}

  async record(user: RequestUser, input: RecordWebSerialPublishedRequestInput): Promise<void> {
    const request = await this.bookRequests.getOne(input.bookRequestId, user);
    if (request.userId !== user.id) throw new ForbiddenException('Book request belongs to another user');
    await this.repo.upsertVolumeRequest(user.id, input.kind, input.matchId, input.volume, input.bookRequestId);
  }

  list(user: RequestUser, kind: WebSerialKind, matchId: string): Promise<WebSerialPublishedRequest[]> {
    return this.repo.listVolumeRequests(user.id, kind, matchId);
  }
}
