import { Global, Module } from '@nestjs/common';

import { EXTRA_PROGRESS_SOURCE } from '../book/extra-progress-source';
import { READ_ALONG_LINK_SOURCE } from '../book/read-along-link-source';
import { EditionLinkProgressService } from './edition-link-progress.service';

// Global so the card-progress and read-along link seams resolve inside BookModule without either module importing the
// other. Deliberately imports nothing, so registering it can never create a module cycle.
@Global()
@Module({
  providers: [
    EditionLinkProgressService,
    { provide: EXTRA_PROGRESS_SOURCE, useExisting: EditionLinkProgressService },
    { provide: READ_ALONG_LINK_SOURCE, useExisting: EditionLinkProgressService },
  ],
  exports: [EXTRA_PROGRESS_SOURCE, READ_ALONG_LINK_SOURCE],
})
export class EditionLinkProgressModule {}
