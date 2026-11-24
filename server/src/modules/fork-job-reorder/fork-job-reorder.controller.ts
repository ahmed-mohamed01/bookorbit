import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { JOBS_VIEW_PERMISSIONS, type JobReorderResult } from '@bookorbit/types';

import { InteractiveOnly } from '../../common/decorators/api-key-policy.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../common/decorators/require-any-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { JobReorderDto } from './dto/job-reorder.dto';
import { ForkJobReorderService } from './fork-job-reorder.service';

@Controller('fork/jobs')
@InteractiveOnly()
export class ForkJobReorderController {
  constructor(private readonly service: ForkJobReorderService) {}

  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(...JOBS_VIEW_PERMISSIONS)
  reorder(@Body() dto: JobReorderDto, @CurrentUser() user: RequestUser): Promise<JobReorderResult> {
    return this.service.reorder(user, dto);
  }
}
