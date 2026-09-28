import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SelfWriteRegistryModule } from '../../common/self-write-registry.module';
import { BookModule } from '../book/book.module';
import { BookDockModule } from '../book-dock/book-dock.module';
import { EditionLinkModule } from '../edition-link/edition-link.module';
import { LibraryModule } from '../library/library.module';
import { NotificationModule } from '../notification/notification.module';
import { EpubModule } from '../reader/epub/epub.module';
import { UserModule } from '../user/user.module';
import { StorytellerReadAlongBuildService } from './storyteller-read-along-build.service';
import { StorytellerReadAlongImportService } from './storyteller-read-along-import.service';
import { StorytellerReadAlongNotifierService } from './storyteller-read-along-notifier.service';
import { StorytellerReadAlongOutputModule } from './storyteller-read-along-output.module';
import { StorytellerReadAlongStatusService } from './storyteller-read-along-status.service';
import { StorytellerClientService } from './storyteller-client.service';
import { storytellerConfig } from './storyteller.config';
import { StorytellerController } from './storyteller.controller';
import { StorytellerRepository } from './storyteller.repository';
import { StorytellerSchemaBootstrapService } from './storyteller-schema-bootstrap.service';
import { StorytellerSecretService } from './storyteller-secret.service';
import { StorytellerSettingsService } from './storyteller-settings.service';

@Module({
  imports: [
    ConfigModule.forFeature(storytellerConfig),
    EditionLinkModule,
    StorytellerReadAlongOutputModule,
    BookModule,
    LibraryModule,
    BookDockModule,
    SelfWriteRegistryModule,
    EpubModule,
    UserModule,
    NotificationModule,
  ],
  controllers: [StorytellerController],
  providers: [
    StorytellerRepository,
    StorytellerSecretService,
    StorytellerSchemaBootstrapService,
    StorytellerClientService,
    StorytellerSettingsService,
    StorytellerReadAlongNotifierService,
    StorytellerReadAlongImportService,
    StorytellerReadAlongBuildService,
    StorytellerReadAlongStatusService,
  ],
})
export class StorytellerModule {}
