import { Global, Module } from '@nestjs/common';

import { EXTRA_PROGRESS_SOURCE } from '../book/extra-progress-source';
import { EditionLinkProgressService } from './edition-link-progress.service';

// Global so the card-progress seam resolves inside BookModule without either module importing the
// other. Deliberately imports nothing, so registering it can never create a module cycle.
@Global()
@Module({
  providers: [EditionLinkProgressService, { provide: EXTRA_PROGRESS_SOURCE, useExisting: EditionLinkProgressService }],
  exports: [EXTRA_PROGRESS_SOURCE],
})
export class EditionLinkProgressModule {}
