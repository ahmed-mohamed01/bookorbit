import { Global, Module } from '@nestjs/common';

import { BookMetadataLockModule } from '../book-metadata-lock/book-metadata-lock.module';
import { BookModule } from '../book/book.module';
import { BULK_COVER_REFRESHER } from '../book/bulk-cover-refresher';
import { EXTRA_COVER_SOURCE_HANDLERS, type CoverSourceHandler } from '../metadata/cover-source-handler';
import { JsonSidecarFormatExtractor } from '../metadata/extractors/json-sidecar-format.extractor';
import { EXTRA_METADATA_EXTRACTORS, type MetadataExtractorEntry } from '../metadata/metadata-extraction.service';
import { MetadataModule } from '../metadata/metadata.module';
import { EXTRA_METADATA_SOURCES, type MetadataSourceProvider } from '../scanner/metadata-source-provider';
import { AudiobookshelfCoverRefreshService } from './audiobookshelf-cover-refresh.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSidecarCoverSourceHandler } from './audiobookshelf-sidecar-cover-source.handler';
import { AudiobookshelfSidecarMetadataSourceProvider } from './audiobookshelf-sidecar-metadata-source.provider';

// Global so Audiobookshelf's metadata extensions resolve where the shared services are built.
@Global()
@Module({
  imports: [BookModule, BookMetadataLockModule, MetadataModule],
  providers: [
    AudiobookshelfRepository,
    AudiobookshelfCoverRefreshService,
    {
      provide: BULK_COVER_REFRESHER,
      useExisting: AudiobookshelfCoverRefreshService,
    },
    {
      provide: EXTRA_METADATA_EXTRACTORS,
      useValue: [['json', new JsonSidecarFormatExtractor()]] satisfies MetadataExtractorEntry[],
    },
    {
      provide: EXTRA_COVER_SOURCE_HANDLERS,
      useValue: [new AudiobookshelfSidecarCoverSourceHandler()] satisfies CoverSourceHandler[],
    },
    {
      provide: EXTRA_METADATA_SOURCES,
      useFactory: (repo: AudiobookshelfRepository): MetadataSourceProvider[] => [new AudiobookshelfSidecarMetadataSourceProvider(repo)],
      inject: [AudiobookshelfRepository],
    },
  ],
  exports: [AudiobookshelfRepository, BULK_COVER_REFRESHER, EXTRA_METADATA_EXTRACTORS, EXTRA_COVER_SOURCE_HANDLERS, EXTRA_METADATA_SOURCES],
})
export class AudiobookshelfMetadataModule {}
