import { Test } from '@nestjs/testing';

import { MetadataExtractionService } from '../metadata/metadata-extraction.service';
import { AudiobookshelfMetadataModule } from './audiobookshelf-metadata.module';

describe('AudiobookshelfMetadataModule seam', () => {
  it('registers the JSON sidecar extractor into MetadataExtractionService via DI', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AudiobookshelfMetadataModule],
      providers: [MetadataExtractionService],
    }).compile();

    const service = moduleRef.get(MetadataExtractionService);
    expect(service.supports('json')).toBe(true);
    // built-in extractors remain intact alongside the injected one
    expect(service.supports('epub')).toBe(true);
    expect(service.supports('m4b')).toBe(true);
  });

  it('does not support json without the seam (proves the module supplies it)', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [MetadataExtractionService],
    }).compile();

    expect(moduleRef.get(MetadataExtractionService).supports('json')).toBe(false);
  });
});
