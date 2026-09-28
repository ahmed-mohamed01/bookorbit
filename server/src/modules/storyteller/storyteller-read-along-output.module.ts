import { Global, Module } from '@nestjs/common';

import { READ_ALONG_OUTPUT_SOURCE } from '../edition-link/read-along-output-source';
import { StorytellerReadAlongOutputService } from './storyteller-read-along-output.service';
import { StorytellerRepository } from './storyteller.repository';

// Global so EditionLinkModule can ask which books are generated read-alongs without importing
// StorytellerModule, which already imports it. Imports nothing, so registering it cannot form a cycle.
@Global()
@Module({
  providers: [
    StorytellerRepository,
    StorytellerReadAlongOutputService,
    { provide: READ_ALONG_OUTPUT_SOURCE, useExisting: StorytellerReadAlongOutputService },
  ],
  exports: [READ_ALONG_OUTPUT_SOURCE],
})
export class StorytellerReadAlongOutputModule {}
