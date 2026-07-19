import { Global, Module } from '@nestjs/common';

import { JsonSidecarFormatExtractor } from '../metadata/extractors/json-sidecar-format.extractor';
import { EXTRA_METADATA_EXTRACTORS, type MetadataExtractorEntry } from '../metadata/metadata-extraction.service';

// Registers Audiobookshelf's format extractors into the shared MetadataExtractionService
// through the EXTRA_METADATA_EXTRACTORS seam, so the upstream extractor map stays untouched.
// Global so the token resolves in MetadataModule's injector where the service is built.
@Global()
@Module({
  providers: [
    {
      provide: EXTRA_METADATA_EXTRACTORS,
      useValue: [['json', new JsonSidecarFormatExtractor()]] satisfies MetadataExtractorEntry[],
    },
  ],
  exports: [EXTRA_METADATA_EXTRACTORS],
})
export class AudiobookshelfMetadataModule {}
