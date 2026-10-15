import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BookDockModule } from '../book-dock/book-dock.module';
import { BookMetadataLockModule } from '../book-metadata-lock/book-metadata-lock.module';
import { LibraryModule } from '../library/library.module';
import { MetadataModule } from '../metadata/metadata.module';
import { NotificationModule } from '../notification/notification.module';
import { LncrawlClient } from './engines/lncrawl.client';
import { NovelSourcesClient } from './engines/novel-sources.client';
import { SuwayomiClient } from './engines/suwayomi.client';
import { SuwayomiExtensionsClient } from './engines/suwayomi-extensions.client';
import { MangaBakaClient } from './lookup/mangabaka.client';
import { MangaDexClient } from './lookup/mangadex.client';
import { WebSerialsLookupService } from './lookup/web-serials-lookup.service';
import { WebSerialsAdminController } from './web-serials-admin.controller';
import { WebSerialsCatalogService } from './web-serials-catalog.service';
import { WebSerialsDiscoverService } from './web-serials-discover.service';
import { WebSerialsCoverService } from './web-serials-cover.service';
import { WebSerialsEngineRegistry } from './web-serials-engine-registry.service';
import { WebSerialsExtensionsService } from './web-serials-extensions.service';
import { WebSerialsCleanupService } from './web-serials-cleanup.service';
import { WebSerialJobMoveService } from './web-serials-job-move.service';
import { WebSerialsIllustratorBackfillService } from './web-serials-illustrator-backfill.service';
import { WebSerialsImportService } from './web-serials-import.service';
import { WebSerialsJobRunnerService } from './web-serials-job-runner.service';
import { WebSerialJobsService } from './web-serials-jobs.service';
import { WebSerialsNovelCandidatesService } from './web-serials-novel-candidates.service';
import { WebSerialsNovelIndexFillerService } from './web-serials-novel-index-filler.service';
import { WebSerialsNovelIndexService } from './web-serials-novel-index.service';
import { WebSerialsPublishedRequestsService } from './web-serials-published-requests.service';
import { WebSerialsNovelProvidersService } from './web-serials-novel-providers.service';
import { WebSerialsNovelSourcesService } from './web-serials-novel-sources.service';
import { WebSerialsEpubBuilder } from './web-serials-epub.builder';
import { WebSerialsSchemaBootstrapService } from './web-serials-schema-bootstrap.service';
import { WebSerialsSecretService } from './web-serials-secret.service';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { webSerialsConfig } from './web-serials.config';
import { WebSerialsController } from './web-serials.controller';
import { WebSerialsNovelIndexRepository } from './web-serials-novel-index.repository';
import { WebSerialsRepository } from './web-serials.repository';

@Module({
  imports: [ConfigModule.forFeature(webSerialsConfig), LibraryModule, BookDockModule, NotificationModule, MetadataModule, BookMetadataLockModule],
  controllers: [WebSerialsAdminController, WebSerialsController],
  providers: [
    WebSerialsRepository,
    WebSerialsNovelIndexRepository,
    WebSerialsSecretService,
    WebSerialsSchemaBootstrapService,
    WebSerialsSettingsService,
    WebSerialsExtensionsService,
    SuwayomiClient,
    SuwayomiExtensionsClient,
    LncrawlClient,
    NovelSourcesClient,
    WebSerialsEpubBuilder,
    MangaBakaClient,
    MangaDexClient,
    WebSerialsLookupService,
    WebSerialsEngineRegistry,
    WebSerialsCoverService,
    WebSerialsImportService,
    WebSerialsJobRunnerService,
    WebSerialsCleanupService,
    WebSerialsCatalogService,
    WebSerialsNovelCandidatesService,
    WebSerialsDiscoverService,
    WebSerialsNovelProvidersService,
    WebSerialsPublishedRequestsService,
    WebSerialsNovelSourcesService,
    WebSerialsNovelIndexService,
    WebSerialsNovelIndexFillerService,
    WebSerialJobsService,
    WebSerialJobMoveService,
    WebSerialsIllustratorBackfillService,
  ],
})
export class WebSerialsModule {}
