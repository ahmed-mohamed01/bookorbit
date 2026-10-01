import { Global, Module } from '@nestjs/common';

import { READ_ALONG_PROVENANCE_SOURCE } from '../book/read-along-provenance-source';
import { READ_ALONG_OUTPUT_SOURCE } from '../edition-link/read-along-output-source';
import { StorytellerReadAlongOutputService } from './storyteller-read-along-output.service';
import { StorytellerRepository } from './storyteller.repository';

// Global so EditionLinkModule and BookModule can ask which books are generated read-alongs, and from what,
// without importing StorytellerModule, which already imports both. Imports nothing, so registering it cannot form a cycle.
@Global()
@Module({
  providers: [
    StorytellerRepository,
    StorytellerReadAlongOutputService,
    { provide: READ_ALONG_OUTPUT_SOURCE, useExisting: StorytellerReadAlongOutputService },
    { provide: READ_ALONG_PROVENANCE_SOURCE, useExisting: StorytellerReadAlongOutputService },
  ],
  exports: [READ_ALONG_OUTPUT_SOURCE, READ_ALONG_PROVENANCE_SOURCE],
})
export class StorytellerReadAlongOutputModule {}
