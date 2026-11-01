import { EDITION_SYNC_INDEX_EXTENSION } from '@bookorbit/types';

/** `book_files.format` the scanner gives the index file (its extension), so it lands under Extras. */
export const EDITION_SYNC_INDEX_FORMAT = EDITION_SYNC_INDEX_EXTENSION;
/** Folder inside the index zip that holds the fork's own entries; stripped again on rebuild. */
export const EDITION_SYNC_INDEX_DIR = 'bookorbit-timings';
export const EDITION_SYNC_PROVENANCE_ENTRY = `${EDITION_SYNC_INDEX_DIR}/provenance.json`;
export const EDITION_SYNC_REPORT_ENTRY = `${EDITION_SYNC_INDEX_DIR}/report.json`;
/** Name the rebuild copies the index to inside the worker job folder. */
export const EDITION_SYNC_REBUILD_INDEX_ENTRY = 'index.epub';

/** Name the scheduler registers its cron job under in `SchedulerRegistry`. */
export const EDITION_SYNC_CRON_JOB_NAME = 'edition-sync-indexing';
export const EDITION_SYNC_FILES_CHANGED_PIN_BATCH_SIZE = 20;
export const EDITION_SYNC_FILE_CHANGE_REASONS: readonly string[] = ['epub_changed', 'audio_changed', 'file_missing', 'files_changed'];
export const EDITION_SYNC_FILES_SETTLE_MS = 10 * 60_000;
/** How often pinned books (toggle on, run now, retry) are picked up outside a run. */
export const EDITION_SYNC_POKE_INTERVAL_MS = 15_000;
/** Wait between checks while the worker is busy with an upstream read-aloud job. */
export const EDITION_SYNC_UPSTREAM_WAIT_MS = 30_000;
/** Minimum gap between progress writes to the index row. */
export const EDITION_SYNC_PROGRESS_WRITE_MS = 5_000;
/** Same retry window as upstream's `READ_ALOUD_FAILED_WORK_TTL_MS`. */
export const EDITION_SYNC_FAILED_WORK_TTL_MS = 7 * 24 * 60 * 60_000;
export const EDITION_SYNC_SWEEP_INTERVAL_MS = 60 * 60_000;
/** Transient worker loss retries before a book is marked failed. */
export const EDITION_SYNC_MAX_ATTEMPTS = 4;
/** Per-user per-book cache of the overlay resolver's decision. */
export const EDITION_SYNC_RESOLVER_CACHE_MS = 30_000;
/** Rows handled per transaction by Clear unused. */
export const EDITION_SYNC_CLEAR_BATCH_SIZE = 200;
