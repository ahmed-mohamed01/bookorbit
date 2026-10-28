import { Module } from '@nestjs/common';

import { AchievementModule } from '../achievement/achievement.module';
import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { ScannerModule } from '../scanner/scanner.module';
import { UserBookStatusModule } from '../user-book-status/user-book-status.module';
import { EditionLinkProgressModule } from './edition-link-progress.module';
import { EditionLinkController } from './edition-link.controller';
import { EditionLinkRepository } from './edition-link.repository';
import { EditionLinkSchemaBootstrapService } from './edition-link-schema-bootstrap.service';
import { EditionLinkService } from './edition-link.service';
import { WorkController } from './work.controller';
import { WorkEventsService } from './work-events.service';
import { WorkMatchRepository } from './work-match.repository';
import { WorkMatchService } from './work-match.service';
import { WorkProgressMirrorService } from './work-progress-mirror.service';
import { WorkRepository } from './work.repository';
import { WorkService } from './work.service';
import { WorkStateService } from './work-state.service';

@Module({
  imports: [BookModule, LibraryModule, EditionLinkProgressModule, UserBookStatusModule, AchievementModule, ScannerModule],
  controllers: [EditionLinkController, WorkController],
  providers: [
    EditionLinkRepository,
    EditionLinkSchemaBootstrapService,
    EditionLinkService,
    WorkRepository,
    WorkEventsService,
    WorkStateService,
    WorkService,
    WorkMatchRepository,
    WorkMatchService,
    WorkProgressMirrorService,
  ],
  exports: [EditionLinkRepository, EditionLinkService, WorkService],
})
export class EditionLinkModule {}
