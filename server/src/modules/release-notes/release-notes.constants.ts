export const RELEASE_NOTES_ROUTE = 'release-notes';
export const RELEASE_NOTES_TIMEOUT_MS = 10_000;
export const RELEASE_NOTES_LIST_TTL_MS = 600_000;
export const RELEASE_NOTES_PER_PAGE = 30;

/** Max number of versions shown cumulatively in the popup. */
export const CUMULATIVE_VERSION_CAP = 4;

/** Max highlights parsed from a single release (abuse guard). */
export const MAX_HIGHLIGHTS_PER_RELEASE = 12;

/** Max media items rendered per highlight; extras are dropped (the lint warns). */
export const MAX_MEDIA_PER_HIGHLIGHT = 6;

/** Soft caps for highlight text. Over-cap text is line-clamped in the UI; the lint warns. */
export const MAX_TITLE_LENGTH = 120;
export const MAX_BODY_LENGTH = 400;

/** Max concurrent media content-type probes, so a media-heavy page doesn't fan out unbounded. */
export const MEDIA_PROBE_CONCURRENCY = 6;

/** Cap the in-memory caches so repeated paging or media-heavy bodies can't grow memory unbounded. */
export const PAGE_CACHE_MAX = 10;
export const MEDIA_TYPE_CACHE_MAX = 1000;

export const SEMVER_RE = /^v\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;
