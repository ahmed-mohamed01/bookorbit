import type { ReleaseSearchResult } from "./indexer";
import type { BookRequestStatus } from "./book-request";

export const MONITORED_FORMATS = ["ebook", "audiobook"] as const;
export type MonitoredFormat = (typeof MONITORED_FORMATS)[number];

export const MONITOR_MODES = ["notify", "auto-upcoming", "auto-all", "off"] as const;
export type MonitorMode = (typeof MONITOR_MODES)[number];

export const MONITORED_WORK_VERDICTS = ["verified", "probable", "suspect"] as const;
export type MonitoredWorkVerdict = (typeof MONITORED_WORK_VERDICTS)[number];

export const MONITORED_WORK_FLAGS = ["placeholder", "foreign_language", "wrong_contributor"] as const;
export type MonitoredWorkFlag = (typeof MONITORED_WORK_FLAGS)[number];

/**
 * Why a work sits off the default list, in the terms the Filters menu shows. Only slot resolution
 * and duplicate demotion set one: a work that is merely unverified carries no kind, because
 * nothing about its shape is known - it just failed to earn the default list.
 */
export const MONITORED_WORK_KINDS = [
  "collection",
  "anthology",
  "graphic_novel",
  "supplemental",
  "format_variant",
  "duplicate",
  "dramatization",
  "split_part",
] as const;
export type MonitoredWorkKind = (typeof MONITORED_WORK_KINDS)[number];

/**
 * What the owner says a work is, overriding the reconciler's kind. `book` is a plain title in the
 * series and keeps the work in the list; every other mark keeps the work off the default list and
 * out of auto-requests, though it can still be requested by hand.
 */
export const MONITORED_MARK_KINDS = [
  "book",
  "collection",
  "split_part",
  "dramatization",
  "anthology",
  "graphic_novel",
  "supplemental",
  "format_variant",
  "duplicate",
] as const;
export type MonitoredMarkKind = (typeof MONITORED_MARK_KINDS)[number];
/** A kind that keeps a work off the default list: the reconciler's, or the owner's mark other than `book`. */
export type MonitoredReviewWorkKind = Exclude<MonitoredMarkKind, "book">;

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
 * The one date a work is listed, grouped and sorted by. The probe clears a format's date column once
 * it turns out to be a hint rather than a listing, so a work whose only known date is an unconfirmed
 * hint would otherwise fall back to January 1 of its release year and read as long past. The hints
 * are ranked below the columns and above the year so such a book still lands in Upcoming. A date the
 * owner set for a format they still want outranks both, so a store's stale listing for the other
 * format cannot pull the work back into the past.
 */
export function monitoredWorkReleaseDate(work: MonitoredWork): string | null {
  const releases = work.formatReleases ?? {};
  const ownDates = MONITORED_FORMATS.filter((format) => !work.ownedFormats.includes(format) && work.monitorFormats?.[format] !== false)
    .map((format) => releases[format])
    .filter((release) => release?.source === "user" && release.status === "dated")
    .map((release) => release?.releaseDate)
    .filter((value): value is string => Boolean(value))
    .sort();
  if (ownDates[0]) return ownDates[0];
  const dates = [work.ebookReleaseDate, work.audioReleaseDate].filter((value): value is string => Boolean(value)).sort();
  if (dates[0]) return dates[0];
  const hints = Object.values(releases)
    .filter((release) => release.status !== "unlisted")
    .map((release) => release.releaseDate)
    .filter((value): value is string => Boolean(value))
    .sort();
  return hints[0] ?? (work.releaseYear === null ? null : `${work.releaseYear}-01-01`);
}

/**
 * A request exists for the format and is not finished: it is being fetched, filed, or waiting on the
 * owner, so a new one is not offered. Wider than the server in_progress filter bucket, which leaves
 * out needs_choice.
 */
export const MONITORED_ACTIVE_REQUEST_STATUSES: ReadonlySet<MonitoredFormatStatus> = new Set(["downloading", "importing", "queued", "needs_choice"]);

/** The most works one bulk call takes, the same cap as bulk book requests. */
export const MONITORED_WORK_BULK_LIMIT = 100;

export const MONITORED_BULK_REQUEST_FORMATS = ["ebook", "audiobook", "both"] as const;
export type MonitoredBulkRequestFormat = (typeof MONITORED_BULK_REQUEST_FORMATS)[number];

export function monitoredBulkFormats(format: MonitoredBulkRequestFormat): MonitoredFormat[] {
  return format === "both" ? [...MONITORED_FORMATS] : [format];
}

/** Why a bulk request leaves one format of a work alone without trying it. */
export const MONITORED_BULK_SKIP_REASONS = ["owned", "requested", "no_ebook"] as const;
export type MonitoredBulkSkipReason = (typeof MONITORED_BULK_SKIP_REASONS)[number];

/**
 * The one rule both the selection bar's preview and the bulk endpoint apply, so the bar never
 * promises a request the server then skips. An audiobook-only work has no ebook to ask for, the
 * same refusal the single request endpoint makes.
 */
export function monitoredBulkSkipReason(work: MonitoredWork, format: MonitoredFormat, todayUtc: string): MonitoredBulkSkipReason | null {
  const status = monitoredFormatStatus(work, format, todayUtc);
  if (status === "owned") return "owned";
  if (MONITORED_ACTIVE_REQUEST_STATUSES.has(status)) return "requested";
  if (format === "ebook" && monitoredWorkIsAudiobookOnly(work)) return "no_ebook";
  return null;
}

/**
 * Only the audiobook has a date. Read through the probe like the panel does: enrolment moves an
 * ebook hint off the column, so the column alone would call a work with an expected ebook audio-only.
 */
export function monitoredWorkIsAudiobookOnly(work: MonitoredWork): boolean {
  return monitoredFormatReleaseDate(work, "ebook").date == null && monitoredFormatReleaseDate(work, "audiobook").date != null;
}

export interface MonitoredBulkRequestPayload {
  workIds: string[];
  format: MonitoredBulkRequestFormat;
  autoDownload?: boolean;
  /**
   * The sources automatic search may use, per format. An id list limits it to those sources;
   * null means every source. Either replaces the sources of a request that already exists for
   * the work. A format left out keeps whatever its request already has (every source when new).
   */
  sources?: Partial<Record<MonitoredFormat, number[] | null>>;
}

/** Why one (work, format) of a bulk request was not filed after being tried. */
export const MONITORED_BULK_FAILURE_REASONS = ["not_found", "forbidden", "destination", "error"] as const;
export type MonitoredBulkFailureReason = (typeof MONITORED_BULK_FAILURE_REASONS)[number];

export type MonitoredBulkRequestResult =
  | { workId: string; format: MonitoredFormat; outcome: "requested"; requestId: number }
  | { workId: string; format: MonitoredFormat; outcome: "skipped"; reason: MonitoredBulkSkipReason }
  | { workId: string; format: MonitoredFormat; outcome: "failed"; reason: MonitoredBulkFailureReason; message: string };

export interface MonitoredBulkRequestResponse {
  /** One entry per (work, format) asked for, in request order. */
  results: MonitoredBulkRequestResult[];
  /** The works that now carry a new request id, composed for the caller, so a page can apply them. */
  works: MonitoredWork[];
}

/** The subset of the per-work patch that applies to many works at once. */
export type MonitoredBulkWorkPatch = Pick<MonitoredWorkPatch, "monitorEbook" | "monitorAudiobook" | "hidden" | "automaticVisibility" | "kind">;

export interface MonitoredBulkUpdatePayload {
  workIds: string[];
  patch: MonitoredBulkWorkPatch;
}

export interface MonitoredBulkUpdateResponse {
  works: MonitoredWork[];
  failed: Array<{ workId: string; reason: Extract<MonitoredBulkFailureReason, "not_found" | "forbidden"> }>;
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

export type MonitoredFetchState = "idle" | "queued" | "fetching" | "failed";
export type MonitoredFetchErrorKind = "timeout" | "rate_limited" | "unavailable" | "auth_failed" | "author_gone" | "not_configured";
export interface MonitoredFetchStatus {
  state: MonitoredFetchState;
  errorKind: MonitoredFetchErrorKind | null;
  errorAt: string | null;
  retryAt: string | null;
}

export interface MonitoredAuthorConfig {
  fetch: MonitoredFetchStatus;
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

export interface MonitoredWorkRating {
  source: "goodreads" | "audible" | "hardcover";
  average: number;
  count: number | null;
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
  /** What kind of thing keeps this work out of the default list: the owner's mark, else the reconciler's when it could tell. */
  kind?: MonitoredReviewWorkKind;
  /** The owner's mark, absent when the reconciler decides. Only sent to the owner. */
  userKind?: MonitoredMarkKind;
  sources: string[];
  providerWorkIds: { hardcover?: string; goodreads?: string; audible?: string };
  /** Community rating per source, as last seen by the catalog refresh; absent when no source reported one. */
  ratings?: MonitoredWorkRating[];
  monitorState: MonitoredWorkState;
  matchedBookId: number | null;
  /**
   * The library book row backing each owned format. The ebook and the audiobook of one work are
   * separate rows in separate libraries, so one id cannot name both; the Files view needs each.
   */
  matchedBookIds?: Partial<Record<MonitoredFormat, number>>;
  ownedFormats: MonitoredFormat[];
  /**
   * A library book per format with the work's title but disagreeing evidence, such as another series
   * number. Neither matched nor ignored: it waits for the owner to say whether it is the same book.
   */
  possibleMatches?: Partial<Record<MonitoredFormat, MonitoredPossibleMatch>>;
  /** Formats whose library book the owner linked by hand, which every refresh keeps. */
  linkedFormats?: MonitoredFormat[];
  /**
   * Formats the owner has answered about (a link or a rejection), whose stored match is final. Only
   * the matcher and the store use it; it is never sent to a client.
   */
  answeredFormats?: MonitoredFormat[];
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
  if (work.userKind) return work.userKind === "book";
  if (work.userVisibility === "visible") return true;
  return work.verdict === "verified" && work.flags.length === 0;
}

export function isWorkListed(work: MonitoredWork): boolean {
  return isWorkVisible(work) || (work.ownedFormats.length > 0 && work.userVisibility !== "hidden" && (!work.userKind || work.userKind === "book"));
}

export function workKindOf(work: MonitoredWork): MonitoredMarkKind | null {
  return work.userKind ?? (isWorkVisible(work) ? "book" : (work.kind ?? null));
}

export type MonitoredDisplayClass = "hidden" | "kind" | "placeholder" | "unconfirmed";
export interface MonitoredDisplayClassCounts {
  hidden: number;
  placeholder: number;
  unconfirmed: number;
  kinds: Record<MonitoredMarkKind, number>;
}

export function workDisplayClass(work: MonitoredWork): MonitoredDisplayClass {
  if (work.userVisibility === "hidden") return "hidden";
  // A placeholder the owner kept or marked Book is on the default list, so only an automatic one is a placeholder here.
  if (!isWorkVisible(work) && work.flags.includes("placeholder")) return "placeholder";
  return workKindOf(work) !== null ? "kind" : "unconfirmed";
}

export function isWorkUnconfirmed(work: MonitoredWork): boolean {
  return (
    work.userVisibility !== "hidden" &&
    !work.userKind &&
    work.userVisibility !== "visible" &&
    !work.flags.includes("placeholder") &&
    (work.verdict !== "verified" || work.flags.length > 0)
  );
}

export function countWorkClasses(works: MonitoredWork[]): MonitoredDisplayClassCounts {
  const counts: MonitoredDisplayClassCounts = {
    hidden: 0,
    placeholder: 0,
    unconfirmed: 0,
    kinds: Object.fromEntries(MONITORED_MARK_KINDS.map((kind) => [kind, 0])) as Record<MonitoredMarkKind, number>,
  };
  for (const work of works) {
    const category = workDisplayClass(work);
    if (category === "kind") {
      const kind = workKindOf(work)!;
      if (kind in counts.kinds) counts.kinds[kind] += 1;
    } else if (category !== "unconfirmed") counts[category] += 1;
    if (isWorkUnconfirmed(work)) counts.unconfirmed += 1;
  }
  return counts;
}

export const MONITORED_REVIEW_FLAGS = ["hidden", "placeholders", "unconfirmed"] as const;
export type MonitoredReviewFlag = (typeof MONITORED_REVIEW_FLAGS)[number];

export interface MonitoredClassSelection {
  kinds: MonitoredMarkKind[];
  more: MonitoredReviewFlag[];
}

export function workMatchesClassSelection(work: MonitoredWork, selection: MonitoredClassSelection): boolean {
  const displayClass = workDisplayClass(work);
  if (displayClass === "hidden") return selection.more.includes("hidden");
  if (displayClass === "placeholder") return selection.more.includes("placeholders");
  const kind = workKindOf(work);
  return (kind !== null && selection.kinds.includes(kind)) || (selection.more.includes("unconfirmed") && isWorkUnconfirmed(work));
}

export function isDefaultClassSelection(selection: MonitoredClassSelection): boolean {
  return selection.kinds.length === 1 && selection.kinds[0] === "book" && selection.more.length === 0;
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
  releaseDate: string | null;
  status: MonitoredReleaseStatus;
  requestId: number | null;
  /** The author's mode per format, so a surface can say whether a release is grabbed or only announced. */
  authorModes?: Record<MonitoredFormat, MonitorMode>;
  /** When the author's catalog and library matches were last refreshed, for the panel's "Checked" line. */
  authorLastRefreshedAt?: string | null;
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

/** Library author id to the id of the viewer's monitor for that author; authors not monitored are absent. */
export type MonitoredLocalAuthorLookup = Record<number, string>;

export interface MonitoredCatalogSearchHit {
  /** The full catalog work, so the palette can reuse the format-status helpers. */
  work: MonitoredWork;
  monitorAuthorId: string;
  authorName: string;
  /** The author's mode per format, so the palette knows which formats this author watches. */
  authorModes: Record<MonitoredFormat, MonitorMode>;
}

/** The Watchlist page search reads works in the viewer's watchlist only; shorter queries cannot use the title trigram index. */
export const MONITORED_WORK_SEARCH_MIN_LENGTH = 3;

export const MONITORED_WORK_SEARCH_PAGE_SIZE = 50;

/** A book the Watchlist page search found, owned formats included, with what its card and panel need. */
export interface MonitoredWorkSearchItem extends MonitoredCatalogSearchHit {
  isOwner: boolean;
  /** When the author's catalog and library matches were last refreshed, for the panel's "Checked" line. */
  authorLastRefreshedAt: string | null;
}

export type MonitoredWorkSearchPage = MonitoredPage<MonitoredWorkSearchItem>;

export interface HardcoverSearchBook {
  /** Hardcover slug, the same value book_metadata.hardcover_id stores. */
  slug: string;
  title: string;
  authorNames: string[];
  seriesName: string | null;
  coverUrl: string | null;
}

export interface HardcoverUniversalSearchResult {
  /** False when no Hardcover key resolves for this user; the palette then hides the Hardcover step. */
  available: boolean;
  books: HardcoverSearchBook[];
  authors: MonitoredAuthorSearchResult[];
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

/** The library book behind a possible match, as the owner needs to judge it. */
export interface MonitoredPossibleMatch {
  bookId: number;
  title: string | null;
  seriesName: string | null;
  seriesIndex: string | null;
}

/**
 * The owner's answer about one format's library book: `link` makes it the match, `reject` keeps it
 * from ever matching (a dismissed possible match, or an automatic match undone), and `automatic`
 * drops every answer for the format so the matcher decides again.
 */
export const MONITORED_MATCH_DECISIONS = ["link", "reject", "automatic"] as const;
export type MonitoredMatchDecision = (typeof MONITORED_MATCH_DECISIONS)[number];

export interface MonitoredWorkMatchPayload {
  decision: MonitoredMatchDecision;
  /** Required for `link` and `reject`, absent for `automatic`. */
  bookId?: number;
}

/** Another work of the same monitor that holds a library book for one format. */
export interface MonitoredMatchHolder {
  monitorId: string;
  workId: string;
  title: string;
  /** The owner linked it by hand rather than the matcher finding it. */
  linkedByHand: boolean;
}

/** Per-work monitor/visibility toggles accepted by PATCH /monitored/works/:workId. */
export interface MonitoredWorkPatch {
  monitorEbook?: boolean;
  monitorAudiobook?: boolean;
  hidden?: boolean;
  /** True hands visibility back to the verdict, dropping a hidden or kept choice. Never sent with `hidden`. */
  automaticVisibility?: true;
  /** The owner's mark; `automaticVisibility` drops it along with the hidden or kept choice. */
  kind?: MonitoredMarkKind;
}

/**
 * The fulfilment pipeline's release list. Searches are stateless: no book request is created or
 * named until a grab commits to a download, so exploratory searches never populate Requests.
 */
export type MonitoredWorkReleasesResponse = ReleaseSearchResult;
