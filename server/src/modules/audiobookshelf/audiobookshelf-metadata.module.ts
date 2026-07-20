import { Global, Module } from '@nestjs/common';

import { EXTRA_COVER_SOURCE_HANDLERS, type CoverSourceHandler } from '../metadata/cover-source-handler';
import { JsonSidecarFormatExtractor } from '../metadata/extractors/json-sidecar-format.extractor';
import { EXTRA_METADATA_EXTRACTORS, type MetadataExtractorEntry } from '../metadata/metadata-extraction.service';
import { AudiobookshelfSidecarCoverSourceHandler } from './audiobookshelf-sidecar-cover-source.handler';

// Global so Audiobookshelf's metadata extensions resolve where the shared services are built.
@Global()
@Module({
  providers: [
    {
      provide: EXTRA_METADATA_EXTRACTORS,
      useValue: [['json', new JsonSidecarFormatExtractor()]] satisfies MetadataExtractorEntry[],
    },
    {
      provide: EXTRA_COVER_SOURCE_HANDLERS,
      useValue: [new AudiobookshelfSidecarCoverSourceHandler()] satisfies CoverSourceHandler[],
    },
  ],
  exports: [EXTRA_METADATA_EXTRACTORS, EXTRA_COVER_SOURCE_HANDLERS],
})
export class AudiobookshelfMetadataModule {}
