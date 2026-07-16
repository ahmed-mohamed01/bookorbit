export const AUDIOBOOKSHELF_REQUEST_TIMEOUT_MS = 15_000;
export const AUDIOBOOKSHELF_SESSIONS_PAGE_SIZE = 500;
export const AUDIOBOOKSHELF_USER_AGENT = 'BookOrbit Audiobookshelf Sync (https://bookorbit.app)';
export const AUDIOBOOKSHELF_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// Max allowed drift between BookOrbit's summed audio-file duration and ABS's item duration
// before a position write is skipped. Guards against file-ordering/track-count mismatches.
export const AUDIOBOOKSHELF_DURATION_TOLERANCE_SECONDS = 5;
