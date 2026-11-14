import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { Permission, type CoverThumbnailBackfillState } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { CoverThumbnailBackfillService } from './cover-thumbnail-backfill.service';
import { UpdateCoverThumbnailBackfillDto } from './dto/update-cover-thumbnail-backfill.dto';

@Controller('cover-thumbnails/backfill')
@RequirePermission(Permission.ManageAppSettings)
export class CoverThumbnailsController {
  constructor(private readonly backfill: CoverThumbnailBackfillService) {}

  @Get()
  getState(): Promise<CoverThumbnailBackfillState> {
    return this.backfill.getState();
  }

  @Patch()
  update(@Body() dto: UpdateCoverThumbnailBackfillDto, @CurrentUser() user: RequestUser): Promise<CoverThumbnailBackfillState> {
    return this.backfill.setEnabled(user, dto.enabled);
  }

  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  run(@CurrentUser() user: RequestUser): Promise<CoverThumbnailBackfillState> {
    return this.backfill.startManual(user);
  }
}
