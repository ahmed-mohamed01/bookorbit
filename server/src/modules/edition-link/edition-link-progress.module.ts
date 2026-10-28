import { Global, Module } from '@nestjs/common';

import { EXTRA_PROGRESS_SOURCE } from '../book/extra-progress-source';
import { READ_ALONG_LINK_SOURCE } from '../book/read-along-link-source';
import { READ_ALONG_OFFSETS_STORE } from '../book/read-along-offsets-store';
import { CURRENTLY_READING_GROUP_SOURCE } from '../dashboard/currently-reading-group-source';
import { KOBO_SHELF_FILTER_SOURCE } from '../kobo/kobo-shelf-filter-source';
import { READING_SESSION_SCOPE_SOURCE } from '../reading-session/reading-session-scope-source';
import { READING_STATE_SCOPE_SOURCE } from '../user-book-status/reading-state-scope-source';
import { EditionLinkProgressService } from './edition-link-progress.service';
import { EditionLinkReadAlongOffsetsService } from './edition-link-read-along-offsets.service';
import { EditionLinkSettingsService } from './edition-link-settings.service';
import { WorkScopeService } from './work-scope.service';

// Global so the card-progress, read-along link, narration offsets, reading-log scope, currently-reading group, shared reading state and Kobo shelf seams resolve in their upstream modules
// without either side importing the other. Deliberately imports nothing, so registering it can never create a module cycle.
@Global()
@Module({
  providers: [
    EditionLinkProgressService,
    { provide: EXTRA_PROGRESS_SOURCE, useExisting: EditionLinkProgressService },
    { provide: READ_ALONG_LINK_SOURCE, useExisting: EditionLinkProgressService },
    { provide: READING_SESSION_SCOPE_SOURCE, useExisting: EditionLinkProgressService },
    { provide: CURRENTLY_READING_GROUP_SOURCE, useExisting: EditionLinkProgressService },
    EditionLinkReadAlongOffsetsService,
    { provide: READ_ALONG_OFFSETS_STORE, useExisting: EditionLinkReadAlongOffsetsService },
    EditionLinkSettingsService,
    WorkScopeService,
    { provide: READING_STATE_SCOPE_SOURCE, useExisting: WorkScopeService },
    { provide: KOBO_SHELF_FILTER_SOURCE, useExisting: WorkScopeService },
  ],
  exports: [
    EXTRA_PROGRESS_SOURCE,
    READ_ALONG_LINK_SOURCE,
    READ_ALONG_OFFSETS_STORE,
    READING_SESSION_SCOPE_SOURCE,
    CURRENTLY_READING_GROUP_SOURCE,
    READING_STATE_SCOPE_SOURCE,
    KOBO_SHELF_FILTER_SOURCE,
    EditionLinkSettingsService,
    WorkScopeService,
  ],
})
export class EditionLinkProgressModule {}
