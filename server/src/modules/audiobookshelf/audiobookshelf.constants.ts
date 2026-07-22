export const AUDIOBOOKSHELF_REQUEST_TIMEOUT_MS = 15_000;
export const AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE = 500;
// Trailing window re-scanned on every incremental sync. ABS mutates open sessions in place under a
// stable id, so a session that grew after our last watermark can sort just behind it; the overlap
// re-captures those (and late offline-synced sessions whose updatedAt is only slightly behind).
export const AUDIOBOOKSHELF_SESSION_OVERLAP_MS = 24 * 60 * 60 * 1000;
// Sessions written per ingest transaction. Bounds memory and lock duration during a first-ever
// backfill that can span years of listening history.
export const AUDIOBOOKSHELF_SESSIONS_INGEST_CHUNK = 200;
// Above this many newly inserted sessions in a single run we emit one backfill achievement event
// instead of one event per session (mirrors the KOReader page-stats threshold).
export const AUDIOBOOKSHELF_BACKFILL_EVENT_THRESHOLD = 20;
export const AUDIOBOOKSHELF_USER_AGENT = 'BookOrbit Audiobookshelf Sync (https://bookorbit.app)';
export const AUDIOBOOKSHELF_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// Tolerance for the summed-duration guard before writing an audio position. Per-file durations are
// stored as integer seconds, so rounding drift accumulates with track count and a fixed allowance
// wrongly rejects valid many-file audiobooks. Effective tolerance =
//   max(base, perFile * fileCount) + relative * totalDuration.
export const AUDIOBOOKSHELF_DURATION_TOLERANCE_BASE_SECONDS = 5;
export const AUDIOBOOKSHELF_DURATION_TOLERANCE_PER_FILE_SECONDS = 1;
export const AUDIOBOOKSHELF_DURATION_TOLERANCE_RELATIVE = 0.01;
// Cron cadence for the full scheduled sync (every 15 minutes): matching-if-fresh, all progress, sessions.
export const AUDIOBOOKSHELF_SCHEDULER_CRON = '*/15 * * * *';
// Cron cadence for the hot tier (every 30 seconds): near-live position for in-progress books only.
export const AUDIOBOOKSHELF_HOT_SCHEDULER_CRON = '*/30 * * * * *';
// Debounce for the catalog-changed auto-match: a full scan emits many events, so wait for the burst
// to settle before running one reconcile.
export const AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS = 30 * 1000;
// Users synced concurrently per scheduler tick. Small, bounded global parallelism: each user's
// pipeline runs sequentially, and only this many users run at once so a slow ABS server cannot fan
// out into unbounded outbound load.
export const AUDIOBOOKSHELF_SCHEDULER_CONCURRENCY = 3;
// Keyset page size for iterating enabled+configured users. Never load all users unbounded.
export const AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE = 100;
// Max span (in days) of session history loaded into memory per daily-stats recompute query. Affected
// days are grouped into windows no wider than this, so recomputing far-apart days never loads a
// multi-year range at once during a backfill.
export const AUDIOBOOKSHELF_DAILY_STATS_RECOMPUTE_SPAN_DAYS = 31;
