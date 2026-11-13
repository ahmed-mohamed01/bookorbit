export interface EpubManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string[];
  mediaOverlay?: string;
  size: number;
}

export interface EpubSpineItem {
  idref: string;
  href: string;
  mediaType: string;
  linear: boolean;
}

export interface EpubTocItem {
  label: string;
  href?: string;
  children?: EpubTocItem[];
}

export interface EpubBookInfo {
  containerPath: string;
  rootPath: string;
  spine: EpubSpineItem[];
  manifest: EpubManifestItem[];
  optionalFiles?: string[];
  toc: EpubTocItem | null;
  metadata: Record<string, unknown>;
  coverPath: string | null;
  /**
   * Fork: this plain EPUB has no narration of its own, but the book's edition sync timing index
   * reads it along with the audiobook, so its media-overlay playlist comes from the index.
   */
  timingIndexNarration?: boolean;
}

export interface EpubMediaOverlayCapability {
  available: boolean;
  durationSeconds: number | null;
}

export interface EpubMediaOverlayPlaylistItem {
  index: number;
  sectionIndex: number;
  smilHref: string;
  textHref: string;
  textFragment: string | null;
  audioHref: string;
  audioMimeType: string;
  clipBeginSeconds: number;
  clipEndSeconds: number | null;
  durationSeconds: number | null;
  label: string | null;
}

export interface EpubMediaOverlayPlaylistSection {
  index: number;
  href: string;
  label: string | null;
  smilHref: string;
  startSeconds: number;
  durationSeconds: number | null;
}

export interface EpubMediaOverlayPlaylistResource {
  href: string;
  mediaType: string;
  size: number;
}

/**
 * Fork: where a timing index's sentences sit in one chapter of the plain EPUB. The chapter carries
 * no sentence ids, so the reader finds each sentence by counting the characters before it that
 * are not whitespace (JS `\s`): the character data of every text and CDATA node under `<body>` in
 * order, nothing inside `<script>`, `<style>`, `<svg>` or `<math>`, entities decoded as HTML.
 * `length` and `hash` are the whole chapter's count and a 32-bit hash of those characters, so
 * text that differs from the index's is left unmarked rather than marked in the wrong place.
 */
export interface EpubMediaOverlayTextPositions {
  length: number;
  hash: number;
  ids: string[];
  starts: number[];
  ends: number[];
}

export interface EpubMediaOverlayPlaylist {
  bookId: number;
  fileId: number | null;
  durationSeconds: number | null;
  items: EpubMediaOverlayPlaylistItem[];
  sections: EpubMediaOverlayPlaylistSection[];
  resources: EpubMediaOverlayPlaylistResource[];
  /** Fork: `timing-index` when the narration is the book's audiobook, timed by its timing index. */
  source?: "epub" | "timing-index";
  /** Fork: with a timing index, where each sentence sits, by chapter (`textHref`). */
  textPositions?: Record<string, EpubMediaOverlayTextPositions>;
}
