import { Module } from '@nestjs/common';

import { AppSettingsModule } from '../app-settings/app-settings.module';
import { BookCoverStoreModule } from '../book-cover-store/book-cover-store.module';
import { CoverThumbnailBackfillRepository } from './cover-thumbnail-backfill.repository';
import { CoverThumbnailBackfillService } from './cover-thumbnail-backfill.service';
import { CoverThumbnailsController } from './cover-thumbnails.controller';

/** Fork: cover thumbnail backfill. See FORK_MAINTENANCE.md. */
@Module({
  imports: [AppSettingsModule, BookCoverStoreModule],
  controllers: [CoverThumbnailsController],
  providers: [CoverThumbnailBackfillRepository, CoverThumbnailBackfillService],
})
export class CoverThumbnailsModule {}
