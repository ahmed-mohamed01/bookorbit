import type { ReleaseSearchResult } from "./indexer";
import type { BookRequestStatus } from "./book-request";

export const MONITORED_FORMATS = ["ebook", "audiobook"] as const;
export type MonitoredFormat = (typeof MONITORED_FORMATS)[number];

export const MONITOR_MODES = ["notify", "auto-upcoming", "auto-all", "off"] as const;
export type MonitorMode = (typeof MONITOR_MODES)[number];

export const MONITORED_WORK_VERDICTS = ["verified", "probable", "suspect"] as const;
export type MonitoredWorkVerdict = (typeof MONITORED_WORK_VERDICTS)[number];

export const MONITORED_WORK_FLAGS = ["compilation", "placeholder", "adaptation_split", "foreign_language", "wrong_contributor"] as const;
export type MonitoredWorkFlag = (typeof MONITORED_WORK_FLAGS)[number];

/**
 * Why a work sits in the review tray, in the terms the tray shows. Only slot resolution and
 * duplicate demotion set one: a work that is merely unverified carries no kind, because nothing
 * about its shape is known - it just failed to earn the default list.
 */
export const MONITORED_WORK_KINDS = ["collection", "anthology", "graphic_novel", "format_variant", "duplicate"] as const;
export type MonitoredWorkKind = (typeof MONITORED_WORK_KINDS)[number];

export const MONITORED_WORK_STATES = ["monitoring", "paused", "stopped"] as const;
export type MonitoredWorkState = (typeof MONITORED_WORK_STATES)[number];

export const MONITORED_RELEASE_STATUSES = ["upcoming", "available", "queued", "downloading", "moving", "needs_review", "grabbed"] as const;
export type MonitoredReleaseStatus = (typeof MONITORED_RELEASE_STATUSES)[number];

export const MONITORED_ACQUISITION_STATES = ["queued", "downloading", "moving", "needs_review"] as const;
export type MonitoredAcquisitionState = (typeof MONITORED_ACQUISITION_STATES)[number];

/**
 * How far along a book request is, in the terms monitoring shows. Null means the request has no
 * acquisition work left, so the format it belongs to reads from the library instead: a request id
 * is history once it settles, never proof that a download is still coming.
 *
 * Every request status is spelled out on purpose. A new one must state its monitoring phase here
 * rather than falling through to "nothing is happening", which would re-open the request button on
 * a work the fulfilment pipeline is still working on.
 */
export const MONITORED_ACQUISITION_STATE_BY_REQUEST_STATUS: Record<BookRequestStatus, MonitoredAcquisitionState | null> = {
  pending: "queued",
  approved: "queued",
  searching: "queued",
  grabbed: "queued",
  downloading: "downloading",
  importing: "moving",
  needs_review: "needs_review",
  available: null,
  failed: null,
  cancelled: null,
  rejected: null,
};

export function monitoredAcquisitionState(status: BookRequestStatus | null | undefined): MonitoredAcquisitionState | null {
  return status ? MONITORED_ACQUISITION_STATE_BY_REQUEST_STATUS[status] : null;
}

/**
 * The one thing a format of a work is doing, as every monitored surface states it. Ordered by
 * precedence: the first that applies wins, so an owned format never also reads as missing and a
 * format the owner switched off never reads as missing either.
 */
export const MONITORED_FORMAT_STATUSES = [
  "owned",
  "downloading",
  "importing",
  "queued",
  "needs_choice",
  "failed",
  "not_watching",
  "missing",
  "upcoming",
  "unannounced",
] as const;
export type MonitoredFormatStatus = (typeof MONITORED_FORMAT_STATUSES)[number];

const PARTIAL_RELEASE_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * Whether a release window has opened on the given UTC day. Year and month precision open on their
 * first day; a value shorter than its stated precision claims more than it carries and never opens.
 */
export function monitoredReleaseStarted(
  value: string | null | undefined,
  precision: MonitoredDatePrecision | null | undefined,
  todayUtc: string,
): boolean {
  const trimmed = value?.trim() ?? "";
  const match = PARTIAL_RELEASE_DATE.exec(trimmed);
  if (!match) return false;
  const effective: MonitoredDatePrecision = precision ?? (match[3] ? "day" : match[2] ? "month" : "year");
  if (effective === "day" && trimmed.length !== 10) return false;
  if (effective === "month" && trimmed.length < 7) return false;
  const start = effective === "year" ? `${trimmed.slice(0, 4)}-01-01` : effective === "month" ? `${trimmed.slice(0, 7)}-01` : trimmed;
  return start <= todayUtc;
}

export interface MonitoredFormatStatusOptions {
  /** False when the author does not monitor this format at all. */
  authorWatches?: boolean;
}

export function monitoredFormatStatus(
  work: MonitoredWork,
  format: MonitoredFormat,
  todayUtc: string,
  options: MonitoredFormatStatusOptions = {},
): MonitoredFormatStatus {
  if (work.ownedFormats.includes(format) || work.matchedBookIds?.[format] != null) return "owned";
  const requestStatus = work.requestStatuses?.[format];
  const acquisition = monitoredAcquisitionState(requestStatus);
  if (acquisition === "downloading") return "downloading";
  if (acquisition === "moving") return "importing";
  if (acquisition === "queued") return "queued";
  if (acquisition === "needs_review") return "needs_choice";
  if (requestStatus === "failed") return "failed";
  if (work.monitorFormats?.[format] === false || options.authorWatches === false) return "not_watching";
  const { date, precision } = monitoredFormatReleaseDate(work, format);
  if (!date || !PARTIAL_RELEASE_DATE.test(date.trim())) return "unannounced";
  return monitoredReleaseStarted(date, precision, todayUtc) ? "missing" : "upcoming";
}

/**
 * The date a format is expected on. The release probe speaks first: a source saying the format is
 * not listed beats a catalog date, and enrolment can move a date off the column onto the probe row.
 */
export function monitoredFormatReleaseDate(
  work: MonitoredWork,
  format: MonitoredFormat,
): { date: string | null; precision: MonitoredDatePrecision | null } {
  const probe = work.formatReleases?.[format];
  if (probe?.status === "unlisted") return { date: null, precision: null };
  if (probe?.releaseDate) return { date: probe.releaseDate, precision: probe.precision };
  return format === "ebook"
    ? { date: work.ebookReleaseDate, precision: work.ebookDatePrecision }
    : { date: work.audioReleaseDate, precision: work.audioDatePrecision };
}

/**
 * The status filter on monitored lists. `hidden` covers every work outside the default list: hidden
 * by the owner, or still in review. The others read a format's status.
 */
export const MONITORED_STATUS_FILTERS = ["missing", "in_progress", "needs_attention", "upcoming", "in_library", "not_watched", "hidden"] as const;
export type MonitoredStatusFilter = (typeof MONITORED_STATUS_FILTERS)[number];

export const DEFAULT_MONITORED_STATUS_FILTERS: readonly MonitoredStatusFilter[] = ["missing", "in_progress", "needs_attention", "upcoming"];

/** An unannounced format is grouped with upcoming: both are a book still to come. */
export const MONITORED_STATUS_FILTER_BY_FORMAT_STATUS: Record<MonitoredFormatStatus, Exclude<MonitoredStatusFilter, "hidden">> = {
  owned: "in_library",
  downloading: "in_progress",
  importing: "in_progress",
  queued: "in_progress",
  needs_choice: "needs_attention",
  failed: "needs_attention",
  not_watching: "not_watched",
  missing: "missing",
  upcoming: "upcoming",
  unannounced: "upcoming",
};

/** Known filters in canonical order; anything unrecognised is dropped rather than trusted. */
export function parseMonitoredStatusFilters(value: unknown): MonitoredStatusFilter[] | null {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!raw) return null;
  return MONITORED_STATUS_FILTERS.filter((filter) => raw.includes(filter));
}

export const MONITORED_GROUPINGS = ["none", "series", "year", "status"] as const;
export type MonitoredGrouping = (typeof MONITORED_GROUPINGS)[number];

export const MONITORED_SORTS = ["releaseDate", "title"] as const;
export type MonitoredSort = (typeof MONITORED_SORTS)[number];

export const MONITORED_LIST_ORDERS = ["asc", "desc"] as const;
export type MonitoredListOrder = (typeof MONITORED_LIST_ORDERS)[number];

export const MONITORED_AUTHOR_LIST_SORTS = ["name", "added", "books", "progress"] as const;
export type MonitoredAuthorListSort = (typeof MONITORED_AUTHOR_LIST_SORTS)[number];

export const MONITORED_BOOK_LIST_SORTS = ["added", "title", "author"] as const;
export type MonitoredBookListSort = (typeof MONITORED_BOOK_LIST_SORTS)[number];

export const MONITORED_RELEASE_LIST_SORTS = ["date", "title", "author"] as const;
export type MonitoredReleaseListSort = (typeof MONITORED_RELEASE_LIST_SORTS)[number];

export const MONITORED_RELEASE_FILTERS = ["all", "recent", "soon", "year"] as const;
export type MonitoredReleaseFilter = (typeof MONITORED_RELEASE_FILTERS)[number];

export type MonitoredDatePrecision = "day" | "month" | "year";

/**
 * What the release probe knows about one format of a work.
 * - pending: enrolled, not checked yet.
 * - expected: a date exists only as a hint (inherited from the book level or a placeholder edition);
 *   it never drives release detection or auto-requests.
 * - dated: a source listed this format with this date, or the owner chose it.
 * - unlisted: no source lists this format.
 */
export const MONITORED_RELEASE_PROBE_STATUSES = ["pending", "expected", "dated", "unlisted"] as const;
export type MonitoredReleaseProbeStatus = (typeof MONITORED_RELEASE_PROBE_STATUSES)[number];

/** `user` is a date the owner picked by hand; the probe never overrides it until it is cleared. */
export const MONITORED_RELEASE_DATE_SOURCES = ["hardcover_edition", "apple", "amazon", "amazon_search", "audible", "user"] as const;
export type MonitoredReleaseDateSource = (typeof MONITORED_RELEASE_DATE_SOURCES)[number];

export interface MonitoredFormatRelease {
  status: MonitoredReleaseProbeStatus;
  /** The confirmed date when dated, the unconfirmed hint when expected or pending, otherwise null. */
  releaseDate: string | null;
  precision: MonitoredDatePrecision | null;
  /** Null when the date is only inherited from the catalog, or when nothing lists the format. */
  source: MonitoredReleaseDateSource | null;
  checkedAt: string | null;
  /** When this format's date last took a new value: the first sighting, or the latest move. */
  dateChangedAt: string | null;
  /** The date it moved from, null while the first date seen is still the current one. */
  previousReleaseDate: string | null;
  previousPrecision: MonitoredDatePrecision | null;
  /**
   * Only on a date the owner chose: a listing the automatic check found, or saw change, after that
   * choice and that disagrees with it. Null once the owner sets or confirms a date again.
   */
  suggested: MonitoredSuggestedReleaseDate | null;
}

export interface MonitoredSuggestedReleaseDate {
  releaseDate: string;
  precision: MonitoredDatePrecision | null;
  source: MonitoredReleaseDateSource | null;
  /** When the automatic check first saw this value. */
  changedAt: string;
}

/** Providers the on-demand release date lookup can ask. */
export const MONITORED_RELEASE_LOOKUP_SOURCES = ["hardcover_edition", "apple", "audible", "audnexus", "librofm", "amazon"] as const;
export type MonitoredReleaseLookupSource = (typeof MONITORED_RELEASE_LOOKUP_SOURCES)[number];

export interface MonitoredReleaseDateCandidate {
  source: MonitoredReleaseLookupSource;
  releaseDate: string;
  precision: MonitoredDatePrecision;
  /** How the provider describes the listing, for example "Kindle, Orbit" or the store title. */
  label: string | null;
  /** A placeholder-quality record: no identifiers and hardly any readers. Shown, but marked. */
  weak: boolean;
  url: string | null;
}

export interface MonitoredReleaseDateLookup {
  format: MonitoredFormat;
  candidates: MonitoredReleaseDateCandidate[];
  /** Providers that could not be asked, so an empty list is never read as "nothing exists". */
  unavailable: Array<{ source: MonitoredReleaseLookupSource; reason: "not_configured" | "throttled" | "failed" }>;
  /**
   * Providers that were asked and returned no dated match, so the owner can see who was checked. Some
   * upstream providers hide their own failures, so this means "no date came back", not "none exists".
   */
  empty: MonitoredReleaseLookupSource[];
}

/** A full YYYY-MM-DD date sets the owner's choice; null clears it and hands the format back to the probe. */
export interface SetMonitoredReleaseDatePayload {
  releaseDate: string | null;
}

export interface MonitorFormatConfig {
  mode: MonitorMode;
  libraryId: number | null;
  folderId: number | null;
}

export interface MonitoredAuthorProviderIds {
  hardcover?: string;
  goodreads?: string;
  /** Audible has no stable author id; this is the confirmed query name. */
  audible?: string;
}

export interface MonitoredAuthorConfig {
  id: string;
  ownerUserId: number;
  authorName: string;
  /** Link to the local authors table when the author exists in the library. */
  localAuthorId: number | null;
  providerIds: MonitoredAuthorProviderIds;
  formats: Record<MonitoredFormat, MonitorFormatConfig>;
  paused: boolean;
  addedAt: string;
  lastRefreshedAt: string | null;
}

export interface MonitoredSeriesMembership {
  name: string;
  index: string | null;
}

export interface MonitoredWork {
  id: string;
  title: string;
  subtitle: string | null;
  seriesName: string | null;
  seriesIndex: string | null;
  seriesMemberships: MonitoredSeriesMembership[];
  releaseYear: number | null;
  ebookReleaseDate: string | null;
  ebookDatePrecision: MonitoredDatePrecision | null;
  audioReleaseDate: string | null;
  audioDatePrecision: MonitoredDatePrecision | null;
  /** Per-format release probe results; absent for works outside the probe window. */
  formatReleases?: Partial<Record<MonitoredFormat, MonitoredFormatRelease>>;
  coverUrl: string | null;
  description: string | null;
  verdict: MonitoredWorkVerdict;
  flags: MonitoredWorkFlag[];
  /** What kind of thing kept this work out of the default list, when the reconciler could tell. */
  kind?: MonitoredWorkKind;
  sources: string[];
  providerWorkIds: { hardcover?: string; goodreads?: string; audible?: string };
  monitorState: MonitoredWorkState;
  matchedBookId: number | null;
  /**
   * The library book row backing each owned format. The ebook and the audiobook of one work are
   * separate rows in separate libraries, so one id cannot name both; the Files view needs each.
   */
  matchedBookIds?: Partial<Record<MonitoredFormat, number>>;
  ownedFormats: MonitoredFormat[];
  /** Per-work monitor toggles; a missing entry means monitoring is on for that format. */
  monitorFormats?: Partial<Record<MonitoredFormat, boolean>>;
  /**
   * User visibility override. Absent = the verdict decides (verified+unflagged shows, the rest sit
   * under review). 'hidden' forces a work out of the default list; 'visible' promotes a
   * review-hidden work into the default list and into monitoring.
   */
  userVisibility?: "hidden" | "visible";
  /** Book-request ids created from this work, per format. */
  requestIds: Partial<Record<MonitoredFormat, number>>;
  /** Current state of those requests. Request ids remain as history after a request settles. */
  requestStatuses?: Partial<Record<MonitoredFormat, BookRequestStatus>>;
}

export function isWorkVisible(work: MonitoredWork): boolean {
  if (work.userVisibility === "hidden") return false;
  if (work.userVisibility === "visible") return true;
  return work.verdict === "verified" && work.flags.length === 0;
}

export interface MonitoredBookEntry {
  id: string;
  ownerUserId: number;
  monitorAuthorId: string;
  workId: string;
  formats: MonitoredFormat[];
  paused: boolean;
  addedAt: string;
}

export interface MonitoredAuthorCounts {
  total: number;
  ebookOwned: number;
  audioOwned: number;
  hidden: number;
}

export interface MonitoredAuthorItem extends MonitoredAuthorConfig {
  isOwner: boolean;
  counts: MonitoredAuthorCounts;
  nextReleaseAt: string | null;
  portraitAuthorId: number | null;
  description: string | null;
  website: string | null;
  genres: string[];
}

export interface MonitoredAuthorDetail {
  author: MonitoredAuthorItem;
  works: MonitoredWork[];
}

export interface MonitoredBookItem extends MonitoredBookEntry {
  isOwner: boolean;
  authorName: string;
  work: MonitoredWork;
}

export interface MonitoredReleaseItem {
  workId: string;
  /** The full catalog work, so release surfaces can reuse the system work card and book panel. */
  work: MonitoredWork;
  monitorAuthorId: string;
  isOwner: boolean;
  title: string;
  authorName: string;
  coverUrl: string | null;
  format: MonitoredFormat;
  releaseDate: string;
  status: MonitoredReleaseStatus;
  requestId: number | null;
  /** The author's mode per format, so a surface can say whether a release is grabbed or only announced. */
  authorModes?: Record<MonitoredFormat, MonitorMode>;
}

/** The watchlist entry behind a library book: the work, its monitor and how the author handles each format. */
export interface MonitoredBookWork {
  work: MonitoredWork;
  monitorAuthorId: string;
  authorModes: Record<MonitoredFormat, MonitorMode>;
}

/**
 * How many cards the release cards view draws. It merges a work's ebook and audiobook into one card,
 * once per Released/Upcoming section when grouped by status and once overall when ungrouped.
 */
export interface MonitoredReleaseCardCounts {
  byStatus: number;
  byWork: number;
}

export interface MonitoredSummary {
  authors: number;
  books: number;
  releases: number;
  releaseCards: MonitoredReleaseCardCounts;
  hardcoverConfigured: boolean;
  audibleConfigured: boolean;
}

export interface MonitoredPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface MonitoredReleasePage extends MonitoredPage<MonitoredReleaseItem> {
  cards: MonitoredReleaseCardCounts;
}

export interface MonitoredAuthorSearchResult {
  name: string;
  providerIds: MonitoredAuthorProviderIds;
  localAuthorId: number | null;
  bookCount: number | null;
  imageUrl: string | null;
  genres: string[];
  alreadyMonitoredId: string | null;
}

export interface MonitorAuthorRequest {
  authorName: string;
  localAuthorId?: number;
  providerIds?: MonitoredAuthorProviderIds;
  formats: Partial<Record<MonitoredFormat, MonitorFormatConfig>>;
}

export interface UpdateMonitoredAuthorRequest {
  formats?: Partial<Record<MonitoredFormat, MonitorFormatConfig>>;
  paused?: boolean;
}

export interface RequestFromWorkPayload {
  format: MonitoredFormat;
  autoDownload?: boolean;
}

/** Per-work monitor/visibility toggles accepted by PATCH /monitored/works/:workId. */
export interface MonitoredWorkPatch {
  monitorEbook?: boolean;
  monitorAudiobook?: boolean;
  hidden?: boolean;
  /** True hands visibility back to the verdict, dropping a hidden or kept choice. Never sent with `hidden`. */
  automaticVisibility?: true;
}

/**
 * The fulfilment pipeline's release list. Searches are stateless: no book request is created or
 * named until a grab commits to a download, so exploratory searches never populate Requests.
 */
export type MonitoredWorkReleasesResponse = ReleaseSearchResult;
