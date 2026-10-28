// Works: one book by an author with several variants (ebook, audiobook, read-along) that stay
// separate book records but share one reading state. The `book_edition_links` row is the work; its
// members are the variants. This file is the wire contract both the server and client build against.

export type WorkVariantRole = "text" | "audio" | "readAlong";

export type WorkPositionSync = "off" | "precise" | "rough";

export interface EditionLinkSettings {
  /** Master switch. Off means every book keeps its own state, as before works existed. */
  enabled: boolean;
  /** Status and reading attempts live on the work's canonical variant and show on every variant. */
  shareReadingState: boolean;
  /** EPUB + MOBI or M4B + MP3 of the same book join the same work as duplicate variants. */
  sameTypeAsOneWork: boolean;
  /** How far a position may travel between variants that have no precise mapping. */
  positionSync: WorkPositionSync;
  /** A match scan links its strong matches without review. */
  autoLinkStrong: boolean;
}

export interface WorkVariant {
  bookId: number;
  role: WorkVariantRole;
  /** The variant of its role that integrations use (Kobo for text, Audiobookshelf for audio). */
  isPrimary: boolean;
  /** The variant the page was opened from. */
  isThisBook: boolean;
  title: string | null;
  authorName: string | null;
  coverVersion: string | null;
  libraryId: number;
  libraryName: string;
  formats: string[];
  sizeBytes: number | null;
  durationSeconds: number | null;
  /** The requester's progress on this variant, 0-100, null when none is recorded. */
  progress: number | null;
  progressUpdatedAt: string | null;
  /** Where the latest progress on this variant came from, for the row's source line. */
  progressSource: "web_reader" | "kobo" | "koreader" | "audiobookshelf" | "mirror" | null;
}

export interface WorkForBook {
  /** Null when the book stands alone; the page then shows only its own row. */
  linkId: number | null;
  /** The variant that holds the work's attempts: primary audio, else primary text, else read-along. */
  canonicalBookId: number;
  variants: WorkVariant[];
  /** False when shared state is off in settings; the card then says so instead of "one work". */
  sharedState: boolean;
  /** Every variant's progress agrees with the work (within rounding). */
  inSync: boolean;
  /** An ebook and an audiobook are present and no read-along is: the card offers to generate one. */
  canGenerateReadAlong: boolean;
}

export type EditionLinkMatchBucket = "linked_ok" | "linked_suspect" | "conflict" | "strong" | "weak";

export type EditionLinkMatchAction = "link" | "relink" | "review" | "none";

export interface EditionLinkMatchBook {
  id: number;
  title: string | null;
  authorName: string | null;
  coverVersion: string | null;
  libraryId: number;
  libraryName: string;
  formats: string[];
  role: WorkVariantRole;
  seriesName: string | null;
  seriesIndex: string | null;
  isbn: string | null;
  /** The requester's status on this book, for the compare bench. */
  readStatus: string | null;
  progress: number | null;
}

export interface EditionLinkMatch {
  id: number;
  bucket: EditionLinkMatchBucket;
  /** Combined score 0-1 as the link panel's matcher gives it. */
  score: number;
  titleScore: number;
  authorScore: number;
  isbnMatch: boolean;
  /** One line explaining the bucket: "title 0.94 author 1", "also claimed by #812", "linked to #41 but #77 scores higher". */
  reason: string;
  source: EditionLinkMatchBook;
  target: EditionLinkMatchBook;
  /** 'duplicate' when source and target share a role. */
  targetRole: WorkVariantRole | "duplicate";
  /** The work the source already belongs to, null when unlinked. */
  linkId: number | null;
  proposedAction: EditionLinkMatchAction;
  /** Other books that also claim this target as a strong match (conflict bucket). */
  competingBookIds: number[];
}

export type EditionLinkScanState = "idle" | "running" | "done" | "failed";

export interface EditionLinkScanStatus {
  state: EditionLinkScanState;
  scanId: number | null;
  processed: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  counts: Record<EditionLinkMatchBucket, number>;
  dismissed: number;
  /** Strong matches auto-linked by this scan when the setting is on. */
  autoLinked: number;
}

export interface EditionLinkMatchListResponse {
  items: EditionLinkMatch[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EditionLinkMatchDismissal {
  bookIdA: number;
  bookIdB: number;
  createdAt: string;
  titleA: string | null;
  titleB: string | null;
}

export interface LinkAllStrongResult {
  linked: number;
  skipped: number;
}

export interface AbsHistoryRebuildSample {
  bookId: number;
  title: string | null;
  absEndedOn: string;
  replacedEndedOn: string[];
}

export interface AbsHistoryRebuildPreview {
  worksWithAbsFinish: number;
  attemptsToReplace: number;
  worksUntouched: number;
  booksReadThisYearBefore: number;
  booksReadThisYearAfter: number;
  samples: AbsHistoryRebuildSample[];
}

export interface AbsHistoryRebuildResult {
  worksRebuilt: number;
  attemptsReplaced: number;
}
