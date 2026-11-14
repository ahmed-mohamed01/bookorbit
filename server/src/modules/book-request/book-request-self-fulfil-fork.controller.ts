import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AuditAction, AuditResource, Permission } from '@bookorbit/types';

import { Auditable } from '../../common/decorators/auditable.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { streamReleaseSearch } from '../../common/utils/sse-stream.utils';
import { BookRequestBatchService } from './batch/book-request-batch.service';
import { BookRequestService } from './book-request.service';
import { RequestFulfillmentService } from './fulfillment/request-fulfillment.service';
import { CreateBatchGrabDto } from './dto/create-batch-grab.dto';
import { StreamBookRequestReleasesDto } from './dto/stream-book-request-releases.dto';

/**
 * The fork's routes on `book-request-fulfilment`, kept beside `BookRequestSelfFulfilController` with
 * the same prefix and class-level permissions so neither the paths nor the guard change.
 */
@Controller('book-request-fulfilment')
@RequirePermission(Permission.BookRequestAccess, Permission.BookRequestSelfFulfill)
export class BookRequestSelfFulfilForkController {
  constructor(
    private readonly service: BookRequestService,
    private readonly fulfillment: RequestFulfillmentService,
    private readonly batches: BookRequestBatchService,
  ) {}

  @Post(':id/releases/stream')
  @HttpCode(HttpStatus.OK)
  async streamReleases(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: StreamBookRequestReleasesDto,
    @Res() reply: FastifyReply,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertCanFulfil(id, user);
    const search = await this.fulfillment.prepareReleaseSearch(id, {
      refresh: dto.overrides ? true : dto.refresh,
      overrides: dto.overrides,
    });
    await streamReleaseSearch(reply, search, `requestId=${id} userId=${user.id}`);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @Auditable({
    action: AuditAction.BookRequestGrab,
    resource: AuditResource.BookRequest,
    getResourceId: (_req, body) => (body as { requestId?: number } | null)?.requestId,
    description: 'Sent chosen books from a multi-book release to a download client for their own request',
  })
  async createBatch(@Body() dto: CreateBatchGrabDto, @CurrentUser() user: RequestUser) {
    await this.service.assertCanFulfil(dto.sourceRequestId, user);
    return this.batches.create(user, dto);
  }

  @Post('batch/:id/retry')
  @HttpCode(HttpStatus.OK)
  @Auditable({
    action: AuditAction.BookRequestGrab,
    resource: AuditResource.BookRequest,
    getResourceId: (req) => Number(req.params.id),
    description: 'Retried the import of a failed multi-book batch for their own request',
  })
  async retryBatch(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.service.assertCanFulfil(id, user);
    await this.batches.retry(user, id);
    return this.service.getOne(id, user);
  }

  @Get('batch/:id/units')
  listBatchUnits(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.batches.listUnits(user, id);
  }
}
