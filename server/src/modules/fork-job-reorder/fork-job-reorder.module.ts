import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { ForkJobReorderController } from './fork-job-reorder.controller';
import { ForkJobReorderService } from './fork-job-reorder.service';

@Module({
  imports: [JobsModule],
  controllers: [ForkJobReorderController],
  providers: [ForkJobReorderService],
})
export class ForkJobReorderModule {}
