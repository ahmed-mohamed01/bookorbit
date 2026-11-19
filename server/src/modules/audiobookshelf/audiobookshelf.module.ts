import { AudiobookChaptersModule } from '../audiobook-chapters/audiobook-chapters.module';
import { AudiobookshelfAudioPositionService } from './audiobookshelf-audio-position.service';
import { Module } from '@nestjs/common';

import { AchievementModule } from '../achievement/achievement.module';
import { BookConsolidationModule } from '../book-consolidation/book-consolidation.module';
import { BookModule } from '../book/book.module';
import { JobsModule } from '../jobs/jobs.module';
import { LibraryModule } from '../library/library.module';
import { UserModule } from '../user/user.module';
import { UserBookStatusModule } from '../user-book-status/user-book-status.module';
import { AudiobookshelfMetadataModule } from './audiobookshelf-metadata.module';
import { AudiobookshelfBookStateService } from './audiobookshelf-book-state.service';
import { AudiobookshelfBooksController } from './audiobookshelf-books.controller';
import { AudiobookshelfClientService } from './audiobookshelf-client.service';
import { AudiobookshelfController } from './audiobookshelf.controller';
import { AudiobookshelfMatchService } from './audiobookshelf-match.service';
import { AudiobookshelfSchemaBootstrapService } from './audiobookshelf-schema-bootstrap.service';
import { AudiobookshelfSessionsService } from './audiobookshelf-sessions.service';
import { AudiobookshelfSettingsService } from './audiobookshelf-settings.service';
import { AudiobookshelfCatalogListenerService } from './audiobookshelf-catalog-listener.service';
import { AudiobookshelfSyncSchedulerService } from './audiobookshelf-sync-scheduler.service';
import { AudiobookshelfSyncService } from './audiobookshelf-sync.service';
import { AudiobookshelfSyncJobSource } from './audiobookshelf-sync-job-source';
import { AudiobookshelfBookConsolidationParticipant } from './audiobookshelf-book-consolidation.participant';
import { AudiobookshelfProgressPushService } from './audiobookshelf-progress-push.service';
import { AudiobookshelfSyncCoordinatorService } from './audiobookshelf-sync-coordinator.service';

@Module({
  imports: [
    AudiobookChaptersModule,
    AchievementModule,
    BookConsolidationModule,
    BookModule,
    JobsModule,
    LibraryModule,
    UserModule,
    UserBookStatusModule,
    AudiobookshelfMetadataModule,
  ],
  controllers: [AudiobookshelfController, AudiobookshelfBooksController],
  providers: [
    AudiobookshelfAudioPositionService,
    AudiobookshelfBookConsolidationParticipant,
    AudiobookshelfClientService,
    AudiobookshelfSchemaBootstrapService,
    AudiobookshelfSettingsService,
    AudiobookshelfMatchService,
    AudiobookshelfBookStateService,
    AudiobookshelfSessionsService,
    AudiobookshelfSyncCoordinatorService,
    AudiobookshelfProgressPushService,
    AudiobookshelfSyncService,
    AudiobookshelfSyncSchedulerService,
    AudiobookshelfSyncJobSource,
    AudiobookshelfCatalogListenerService,
  ],
  exports: [
    AudiobookshelfClientService,
    AudiobookshelfSettingsService,
    AudiobookshelfMatchService,
    AudiobookshelfSyncService,
    AudiobookshelfSessionsService,
  ],
})
export class AudiobookshelfModule {}
