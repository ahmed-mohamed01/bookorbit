import { Global, Module } from '@nestjs/common';

import { CommonModule } from '../../common/common.module';
import { AchievementModule } from '../achievement/achievement.module';
import { AudiobookChaptersModule } from '../audiobook-chapters/audiobook-chapters.module';
import { BookModule } from '../book/book.module';
import { OVERLAY_SOURCE_RESOLVER } from '../book/overlay-source-provider';
import { LibraryModule } from '../library/library.module';
import { EPUB_DOM_SOURCE_RESOLVER } from '../position-converter/epub-dom-source-provider';
import { READ_ALOUD_HOOKS } from '../read-aloud/read-aloud-hooks';
import { ReadAloudModule } from '../read-aloud/read-aloud.module';
import { ReadingAlignmentModule } from '../reading-alignment/reading-alignment.module';
import { ScannerModule } from '../scanner/scanner.module';
import { UserModule } from '../user/user.module';
import { EditionSyncBookStateService } from './edition-sync-book-state.service';
import { EditionSyncFallbackService } from './edition-sync-fallback.service';
import { EditionSyncIndexStoreService } from './edition-sync-index-store.service';
import { EditionSyncIndexerService } from './edition-sync-indexer.service';
import { EditionSyncOverlaySourceService } from './edition-sync-overlay-source.service';
import { EditionSyncQueueService } from './edition-sync-queue.service';
import { EditionSyncReadAloudHooksService } from './edition-sync-read-aloud-hooks.service';
import { EditionSyncSchedulerService } from './edition-sync-scheduler.service';
import { EditionSyncSchemaBootstrapService } from './edition-sync-schema-bootstrap.service';
import { EditionSyncSettingsService } from './edition-sync-settings.service';
import { EditionSyncController } from './edition-sync.controller';
import { EditionSyncRepository } from './edition-sync.repository';

// Global so the read-aloud, progress-sync and EPUB DOM seams resolve where upstream builds those
// services. Unregistered, every seam falls back to its no-op default.
@Global()
@Module({
  imports: [
    AchievementModule,
    AudiobookChaptersModule,
    BookModule,
    CommonModule,
    LibraryModule,
    ReadAloudModule,
    ReadingAlignmentModule,
    ScannerModule,
    UserModule,
  ],
  controllers: [EditionSyncController],
  providers: [
    EditionSyncRepository,
    EditionSyncSchemaBootstrapService,
    EditionSyncSettingsService,
    EditionSyncBookStateService,
    EditionSyncIndexStoreService,
    EditionSyncQueueService,
    EditionSyncIndexerService,
    EditionSyncSchedulerService,
    EditionSyncReadAloudHooksService,
    EditionSyncOverlaySourceService,
    EditionSyncFallbackService,
    { provide: READ_ALOUD_HOOKS, useExisting: EditionSyncReadAloudHooksService },
    { provide: OVERLAY_SOURCE_RESOLVER, useExisting: EditionSyncOverlaySourceService },
    { provide: EPUB_DOM_SOURCE_RESOLVER, useExisting: EditionSyncOverlaySourceService },
  ],
  exports: [READ_ALOUD_HOOKS, OVERLAY_SOURCE_RESOLVER, EPUB_DOM_SOURCE_RESOLVER, EditionSyncFallbackService],
})
export class EditionSyncModule {}
