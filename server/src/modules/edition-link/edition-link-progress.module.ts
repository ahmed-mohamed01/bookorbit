import { Global, Module } from '@nestjs/common';

import { EXTRA_PROGRESS_SOURCE } from '../book/extra-progress-source';
import { READ_ALONG_LINK_SOURCE } from '../book/read-along-link-source';
import { READ_ALONG_OFFSETS_STORE } from '../book/read-along-offsets-store';
import { EditionLinkProgressService } from './edition-link-progress.service';
import { EditionLinkReadAlongOffsetsService } from './edition-link-read-along-offsets.service';

// Global so the card-progress, read-along link and narration offsets seams resolve inside BookModule without either module importing the
// other. Deliberately imports nothing, so registering it can never create a module cycle.
@Global()
@Module({
  providers: [
    EditionLinkProgressService,
    { provide: EXTRA_PROGRESS_SOURCE, useExisting: EditionLinkProgressService },
    { provide: READ_ALONG_LINK_SOURCE, useExisting: EditionLinkProgressService },
    EditionLinkReadAlongOffsetsService,
    { provide: READ_ALONG_OFFSETS_STORE, useExisting: EditionLinkReadAlongOffsetsService },
  ],
  exports: [EXTRA_PROGRESS_SOURCE, READ_ALONG_LINK_SOURCE, READ_ALONG_OFFSETS_STORE],
})
export class EditionLinkProgressModule {}
