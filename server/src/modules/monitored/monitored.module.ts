import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { StringValue } from 'ms';

import { AuthModule } from '../auth/auth.module';
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
import { MonitoredFetchCoordinator } from './fetch/monitored-fetch-coordinator.service';
import { MonitoredFetchJobService } from './fetch/monitored-fetch-job.service';
import { MONITORED_FETCH_REQUESTS } from './fetch/monitored-fetch-requests';
import { MonitoredGateway } from './monitored.gateway';
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
import { MonitoredReleaseDateLookupService } from './monitored-release-date-lookup.service';
import { MonitoredReleaseProbeStore } from './monitored-release-probe-store.service';
import { MonitoredReleaseProbeService } from './monitored-release-probe.service';
import { MonitoredUniversalSearchService } from './monitored-universal-search.service';
import { AppleBooksClient } from './release-probe/apple-books.client';
import { AudibleCatalogClient } from './release-probe/audible-catalog.client';
import { AmazonProductPageClient } from './release-probe/amazon-product-page.client';

@Module({
  imports: [
    AuthModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtSecret'),
        signOptions: { expiresIn: config.getOrThrow<StringValue | number>('auth.jwtExpiresIn') },
      }),
    }),
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
    MonitoredGateway,
    MonitoredFetchJobService,
    MonitoredFetchCoordinator,
    { provide: MONITORED_FETCH_REQUESTS, useExisting: MonitoredFetchCoordinator },
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
    MonitoredReleaseProbeStore,
    MonitoredReleaseProbeService,
    MonitoredReleaseDateLookupService,
    MonitoredUniversalSearchService,
    AppleBooksClient,
    AudibleCatalogClient,
    AmazonProductPageClient,
  ],
  exports: [MonitoredService],
})
export class MonitoredModule {}
