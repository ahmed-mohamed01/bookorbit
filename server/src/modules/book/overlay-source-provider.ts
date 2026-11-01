/**
 * Extension seam for the media-overlay source that ebook <-> audiobook progress sync maps through.
 *
 * Sync uses the book's read-along EPUB when it has one. A resolver may offer another source for a
 * book without one: a file whose zip holds the same SMIL and marked-up XHTML. With no resolver
 * registered sync behaves exactly as it does without this seam.
 */
export const OVERLAY_SOURCE_RESOLVER = Symbol('OVERLAY_SOURCE_RESOLVER');

/** The sync file shape `BookRepository.findAudioEbookProgressSyncFiles` returns. */
export interface OverlaySourceCandidate {
  id: number;
  absolutePath: string;
  format: string | null;
  role: string;
  sortOrder: number | null;
  durationSeconds: number | null;
  mediaOverlayAvailable: boolean;
  mediaOverlayDurationSeconds: number | null;
}

export interface OverlaySourceResolver {
  /** One of `files` to read the overlay from (returned with `mediaOverlayAvailable: true`), or null. */
  resolveOverlaySource<T extends OverlaySourceCandidate>(userId: number, bookId: number, files: readonly T[]): Promise<T | null>;
}
