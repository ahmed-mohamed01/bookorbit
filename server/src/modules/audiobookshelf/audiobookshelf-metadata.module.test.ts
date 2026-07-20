import { MODULE_METADATA } from '@nestjs/common/constants';

import { BULK_COVER_REFRESHER } from '../book/bulk-cover-refresher';
import { EXTRA_COVER_SOURCE_HANDLERS, type CoverSourceHandler } from '../metadata/cover-source-handler';
import { EXTRA_METADATA_EXTRACTORS, MetadataExtractionService, type MetadataExtractorEntry } from '../metadata/metadata-extraction.service';
import { AudiobookshelfCoverRefreshService } from './audiobookshelf-cover-refresh.service';
import { AudiobookshelfMetadataModule } from './audiobookshelf-metadata.module';

describe('AudiobookshelfMetadataModule seam', () => {
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AudiobookshelfMetadataModule) as Array<{
    provide?: unknown;
    useExisting?: unknown;
    useValue?: unknown;
  }>;

  function registrationFor(token: unknown) {
    return providers.find((provider) => provider.provide === token);
  }

  it('registers the JSON sidecar extractor and cover source handler', () => {
    const extractors = registrationFor(EXTRA_METADATA_EXTRACTORS)?.useValue as MetadataExtractorEntry[];
    const service = new MetadataExtractionService(extractors);

    expect(service.supports('json')).toBe(true);
    expect(service.supports('epub')).toBe(true);
    expect(service.supports('m4b')).toBe(true);

    const coverSourceHandlers = registrationFor(EXTRA_COVER_SOURCE_HANDLERS)?.useValue as CoverSourceHandler[];
    expect(coverSourceHandlers.map((handler) => handler.kind)).toEqual(['sidecar']);
  });

  it('registers the ABS bulk cover refresher behind the generic token', () => {
    expect(registrationFor(BULK_COVER_REFRESHER)?.useExisting).toBe(AudiobookshelfCoverRefreshService);
  });

  it('does not support json without the seam', () => {
    const service = new MetadataExtractionService();

    expect(service.supports('json')).toBe(false);
  });
});
