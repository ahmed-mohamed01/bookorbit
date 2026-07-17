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
// Max allowed drift between BookOrbit's summed audio-file duration and ABS's item duration
// before a position write is skipped. Guards against file-ordering/track-count mismatches.
export const AUDIOBOOKSHELF_DURATION_TOLERANCE_SECONDS = 5;
