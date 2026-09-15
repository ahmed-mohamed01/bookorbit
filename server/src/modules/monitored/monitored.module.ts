import { Module } from '@nestjs/common';

import { AuthorsModule } from '../authors/authors.module';
import { AppSettingsModule } from '../app-settings/app-settings.module';
import { BookRequestModule } from '../book-request/book-request.module';
import { CoverModule } from '../cover/cover.module';
import { HardcoverModule } from '../hardcover/hardcover.module';
import { LibraryModule } from '../library/library.module';
import { MetadataFetchModule } from '../metadata-fetch/metadata-fetch.module';
import { MetadataPreferencesModule } from '../metadata-preferences/metadata-preferences.module';
import { NotificationModule } from '../notification/notification.module';
import { UserModule } from '../user/user.module';
import { MonitoredCatalogService } from './monitored-catalog.service';
import { MonitoredAuthorStoreService } from './monitored-author-store.service';
import { MonitoredAutoRequestService } from './monitored-autorequest.service';
import { MonitoredCoverService } from './monitored-cover.service';
import { MonitoredReleaseNotifier } from './monitored-release-notifier.service';
import { MonitoredReleaseWatcher } from './monitored-release-watcher.service';
import { MonitoredSyncSchedulerService } from './monitored-sync-scheduler.service';
import { MonitoredProviderConfigService } from './monitored-provider-config.service';
import { MonitoredController } from './monitored.controller';
import { AudibleBibliographyProvider } from './providers/audible-bibliography.provider';
import { GoodreadsBibliographyProvider } from './providers/goodreads-bibliography.provider';
import { HardcoverBibliographyProvider } from './providers/hardcover-bibliography.provider';
import { MonitoredService } from './monitored.service';
import { MonitoredSchemaBootstrapService } from './monitored-schema-bootstrap.service';
import { MonitoredStoreService } from './monitored-store.service';
import { MonitoredSettingsService } from './monitored-settings.service';

@Module({
  imports: [
    AppSettingsModule,
    AuthorsModule,
    BookRequestModule,
    CoverModule,
    HardcoverModule,
    LibraryModule,
    MetadataFetchModule,
    MetadataPreferencesModule,
    NotificationModule,
    UserModule,
  ],
  controllers: [MonitoredController],
  providers: [
    MonitoredStoreService,
    MonitoredAuthorStoreService,
    MonitoredSchemaBootstrapService,
    MonitoredSettingsService,
    HardcoverBibliographyProvider,
    GoodreadsBibliographyProvider,
    AudibleBibliographyProvider,
    MonitoredCatalogService,
    MonitoredAutoRequestService,
    MonitoredCoverService,
    MonitoredProviderConfigService,
    MonitoredService,
    MonitoredReleaseNotifier,
    MonitoredReleaseWatcher,
    MonitoredSyncSchedulerService,
  ],
  exports: [MonitoredService],
})
export class MonitoredModule {}
