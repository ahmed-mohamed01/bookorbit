import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BookModule } from '../book/book.module';
import { EditionLinkModule } from '../edition-link/edition-link.module';
import { LibraryModule } from '../library/library.module';
import { ScannerModule } from '../scanner/scanner.module';
import { StorytellerReadAlongBuildService } from './storyteller-read-along-build.service';
import { StorytellerReadAlongStatusService } from './storyteller-read-along-status.service';
import { StorytellerClientService } from './storyteller-client.service';
import { storytellerConfig } from './storyteller.config';
import { StorytellerController } from './storyteller.controller';
import { StorytellerRepository } from './storyteller.repository';
import { StorytellerSchemaBootstrapService } from './storyteller-schema-bootstrap.service';
import { StorytellerSecretService } from './storyteller-secret.service';
import { StorytellerSettingsService } from './storyteller-settings.service';

@Module({
  imports: [ConfigModule.forFeature(storytellerConfig), EditionLinkModule, BookModule, LibraryModule, ScannerModule],
  controllers: [StorytellerController],
  providers: [
    StorytellerRepository,
    StorytellerSecretService,
    StorytellerSchemaBootstrapService,
    StorytellerClientService,
    StorytellerSettingsService,
    StorytellerReadAlongBuildService,
    StorytellerReadAlongStatusService,
  ],
})
export class StorytellerModule {}
