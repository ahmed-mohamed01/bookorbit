import { Module } from '@nestjs/common';

import { AuthorsModule } from '../authors/authors.module';
import { BookRequestModule } from '../book-request/book-request.module';
import { CoverModule } from '../cover/cover.module';
import { HardcoverModule } from '../hardcover/hardcover.module';
import { LibraryModule } from '../library/library.module';
import { MetadataFetchModule } from '../metadata-fetch/metadata-fetch.module';
import { MetadataPreferencesModule } from '../metadata-preferences/metadata-preferences.module';
import { MonitoredCatalogService } from './monitored-catalog.service';
import { MonitoredAutoRequestService } from './monitored-autorequest.service';
import { MonitoredCoverService } from './monitored-cover.service';
import { MonitoredProviderConfigService } from './monitored-provider-config.service';
import { MonitoredController } from './monitored.controller';
import { AudibleBibliographyProvider } from './providers/audible-bibliography.provider';
import { GoodreadsBibliographyProvider } from './providers/goodreads-bibliography.provider';
import { HardcoverBibliographyProvider } from './providers/hardcover-bibliography.provider';
import { MonitoredService } from './monitored.service';
import { MonitoredStoreService } from './monitored-store.service';

@Module({
  imports: [AuthorsModule, BookRequestModule, CoverModule, HardcoverModule, LibraryModule, MetadataFetchModule, MetadataPreferencesModule],
  controllers: [MonitoredController],
  providers: [
    MonitoredStoreService,
    HardcoverBibliographyProvider,
    GoodreadsBibliographyProvider,
    AudibleBibliographyProvider,
    MonitoredCatalogService,
    MonitoredAutoRequestService,
    MonitoredCoverService,
    MonitoredProviderConfigService,
    MonitoredService,
  ],
  exports: [MonitoredService],
})
export class MonitoredModule {}
