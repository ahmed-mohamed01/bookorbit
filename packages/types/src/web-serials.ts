// Web Serials contract shared by the server API and the client. Two instance-level download engines
// (Suwayomi for manga, lightnovel-crawler for web novels) sit behind one feature; users only ever see
// the series, never the engine.

export type WebSerialKind = "manga" | "novel";
export type WebSerialNovelEngine = "lnreader" | "lncrawl";

export const WEB_SERIAL_KINDS: readonly WebSerialKind[] = ["manga", "novel"];

/**
 * `errorCode` values the Web Serials API sends next to its English `message`; the client translates them. Scalar
 * details a translation needs travel in `errorMeta`: `engine`, `source` and `service` names, a `limit` or a `format`.
 */
export const WebSerialErrorCode = {
  LinksNovelOnly: "WEB_SERIAL_LINKS_NOVEL_ONLY",
  KindUnavailable: "WEB_SERIAL_KIND_UNAVAILABLE",
  NovelSourcesAllDisabled: "WEB_SERIAL_NOVEL_SOURCES_ALL_DISABLED",
  NovelSourceUnsupported: "WEB_SERIAL_NOVEL_SOURCE_UNSUPPORTED",
  EngineUnreachable: "WEB_SERIAL_ENGINE_UNREACHABLE",
  EngineTimeout: "WEB_SERIAL_ENGINE_TIMEOUT",
  EngineError: "WEB_SERIAL_ENGINE_ERROR",
  EngineCredentialsRejected: "WEB_SERIAL_ENGINE_CREDENTIALS_REJECTED",
  EngineNotConfigured: "WEB_SERIAL_ENGINE_NOT_CONFIGURED",
  EngineUrlInvalid: "WEB_SERIAL_ENGINE_URL_INVALID",
  SourceFailed: "WEB_SERIAL_SOURCE_FAILED",
  LookupFailed: "WEB_SERIAL_LOOKUP_FAILED",
  SearchUnavailable: "WEB_SERIAL_SEARCH_UNAVAILABLE",
  SearchNotConfigured: "WEB_SERIAL_SEARCH_NOT_CONFIGURED",
  SeriesUnavailable: "WEB_SERIAL_SERIES_UNAVAILABLE",
  SeriesNotFound: "WEB_SERIAL_SERIES_NOT_FOUND",
  SeriesSourceDisabled: "WEB_SERIAL_SERIES_SOURCE_DISABLED",
  LinkInvalid: "WEB_SERIAL_LINK_INVALID",
  LinkUnavailable: "WEB_SERIAL_LINK_UNAVAILABLE",
  JobNotFound: "WEB_SERIAL_JOB_NOT_FOUND",
  JobForbidden: "WEB_SERIAL_JOB_FORBIDDEN",
  AdminOnly: "WEB_SERIAL_ADMIN_ONLY",
  JobRetryNotAllowed: "WEB_SERIAL_JOB_RETRY_NOT_ALLOWED",
  JobPauseNotAllowed: "WEB_SERIAL_JOB_PAUSE_NOT_ALLOWED",
  JobResumeNotAllowed: "WEB_SERIAL_JOB_RESUME_NOT_ALLOWED",
  JobMoveUpNotAllowed: "WEB_SERIAL_JOB_MOVE_UP_NOT_ALLOWED",
  JobCancelFirst: "WEB_SERIAL_JOB_CANCEL_FIRST",
  JobCancelled: "WEB_SERIAL_JOB_CANCELLED",
  ItemRetryNotAllowed: "WEB_SERIAL_ITEM_RETRY_NOT_ALLOWED",
  TooManyJobs: "WEB_SERIAL_TOO_MANY_JOBS",
  PackagingUnavailable: "WEB_SERIAL_PACKAGING_UNAVAILABLE",
  RangeNeedsVolumes: "WEB_SERIAL_RANGE_NEEDS_VOLUMES",
  NothingToDownload: "WEB_SERIAL_NOTHING_TO_DOWNLOAD",
  VolumesUnavailable: "WEB_SERIAL_VOLUMES_UNAVAILABLE",
  SelectionInvalid: "WEB_SERIAL_SELECTION_INVALID",
  LibraryNotFound: "WEB_SERIAL_LIBRARY_NOT_FOUND",
  LibraryFormatRefused: "WEB_SERIAL_LIBRARY_FORMAT_REFUSED",
  FolderNotInLibrary: "WEB_SERIAL_FOLDER_NOT_IN_LIBRARY",
  LibraryHasNoFolder: "WEB_SERIAL_LIBRARY_HAS_NO_FOLDER",
  TargetFolderNeedsLibrary: "WEB_SERIAL_TARGET_FOLDER_NEEDS_LIBRARY",
  MoveNothingLeft: "WEB_SERIAL_MOVE_NOTHING_LEFT",
  MoveBusy: "WEB_SERIAL_MOVE_BUSY",
  MoveChanged: "WEB_SERIAL_MOVE_CHANGED",
  MoveNoChapters: "WEB_SERIAL_MOVE_NO_CHAPTERS",
  MoveTargetNotManga: "WEB_SERIAL_MOVE_TARGET_NOT_MANGA",
  MoveSameSource: "WEB_SERIAL_MOVE_SAME_SOURCE",
  MoveNovelUnsupported: "WEB_SERIAL_MOVE_NOVEL_UNSUPPORTED",
  MoveTooMany: "WEB_SERIAL_MOVE_TOO_MANY",
  NovelIndexBusy: "WEB_SERIAL_NOVEL_INDEX_BUSY",
  NovelSourceNotInstalled: "WEB_SERIAL_NOVEL_SOURCE_NOT_INSTALLED",
  ExtensionRepoInvalid: "WEB_SERIAL_EXTENSION_REPO_INVALID",
  SeriesLoading: "WEB_SERIAL_SERIES_LOADING",
  SeriesKeyTooLong: "WEB_SERIAL_SERIES_KEY_TOO_LONG",
  SourceDisabled: "WEB_SERIAL_SOURCE_DISABLED",
  FileIndexNotFound: "WEB_SERIAL_FILE_INDEX_NOT_FOUND",
  FileIndexBusy: "WEB_SERIAL_FILE_INDEX_BUSY",
  FileIndexUnreadable: "WEB_SERIAL_FILE_INDEX_UNREADABLE",
} as const;

export type WebSerialErrorCode = (typeof WebSerialErrorCode)[keyof typeof WebSerialErrorCode];

/**
 * chapter: one book per chapter (manga). volume: one book per volume (novels; manga when the volume is known).
 * series: one book for the whole selection (novels: every selected volume; manga: every selected chapter).
 */
export type WebSerialPackaging = "chapter" | "volume" | "series";

export type WebSerialSeriesStatus = "ongoing" | "completed" | "hiatus" | "cancelled" | "unknown";

export interface WebSerialEngineConnection {
  url: string | null;
  username: string | null;
  passwordConfigured: boolean;
}

export interface WebSerialEngineHealth {
  ok: boolean;
  checkedAt: string;
  version: string | null;
  /** Sources BookOrbit will search (manga: installed sources in the allowed languages; novel: enabled search domains). */
  searchableSources: number;
  /** LNReader only: the service has a Cloudflare solver, so slow sources are worth waiting for. */
  solver?: boolean;
  error: string | null;
}

export interface WebSerialSettings {
  manga: WebSerialEngineConnection & {
    lastCheck: WebSerialEngineHealth | null;
    /**
     * Installed Suwayomi source ids that search uses. Null until the admin picks sources: then every installed
     * source in `languages` is used (the behaviour before per-source selection existed).
     */
    sourceIds: string[] | null;
    /** Only used while `sourceIds` is null. */
    languages: string[];
    targetLibraryId: number | null;
    targetFolderId: number | null;
  };
  novel: WebSerialEngineConnection & {
    engine: WebSerialNovelEngine;
    lastCheck: WebSerialEngineHealth | null;
    /** lightnovel-crawler domains searched by title. Links from any supported site work regardless. */
    searchDomains: string[];
    /** Installed LNReader source ids enabled by the administrator. */
    sourceIds: string[];
    targetLibraryId: number | null;
    targetFolderId: number | null;
    defaultPackaging: Extract<WebSerialPackaging, "volume" | "series">;
    /** Browse pages the light novel index may request from each source per day. */
    indexDailyBudget: number;
  };
  /** Jobs that may run at once across all users. */
  maxConcurrentJobs: number;
  /** Series details lookup (MangaBaka): authors, artists, canonical title, status. */
  lookup: { enabled: boolean; lastCheck: WebSerialLookupHealth | null };
}

export interface WebSerialLookupHealth {
  ok: boolean;
  checkedAt: string;
  /** Plain-language reason when not ok. */
  error: string | null;
  /** Set while lookups are paused after repeated failures. */
  pausedUntil: string | null;
}

export interface WebSerialEngineConnectionInput {
  url?: string | null;
  username?: string | null;
  /** Omit to keep the stored password, null or "" to clear it. */
  password?: string | null;
}

export interface UpdateWebSerialSettingsInput {
  manga?: WebSerialEngineConnectionInput & {
    sourceIds?: string[];
    languages?: string[];
    targetLibraryId?: number | null;
    targetFolderId?: number | null;
  };
  novel?: WebSerialEngineConnectionInput & {
    engine?: WebSerialNovelEngine;
    searchDomains?: string[];
    sourceIds?: string[];
    targetLibraryId?: number | null;
    targetFolderId?: number | null;
    defaultPackaging?: Extract<WebSerialPackaging, "volume" | "series">;
    indexDailyBudget?: number;
  };
  maxConcurrentJobs?: number;
  lookup?: { enabled?: boolean };
}

export interface TestWebSerialEngineInput extends WebSerialEngineConnectionInput {
  kind: WebSerialKind;
  /** Required only when testing an unsaved novel engine choice. */
  engine?: WebSerialNovelEngine;
}

export interface WebSerialNovelSourceEntry {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  iconUrl: string | null;
  installed: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
  /** Installed, but the plugin failed to load: it answers nothing until it is reinstalled or removed. */
  broken: boolean;
}

/** A novel site lightnovel-crawler knows, for the admin's search-domain picker. */
export interface WebSerialNovelSource {
  domain: string;
  language: string;
  canSearch: boolean;
  disabled: boolean;
}

/** An installed Suwayomi source, for the admin's per-language source picker. */
export interface WebSerialMangaSource {
  id: string;
  name: string;
  lang: string;
  nsfw: boolean;
}

/** What the user-facing pages need to know before rendering search. */
export interface WebSerialCapabilities {
  /** `defaultLibraryId`: the admin's target library for this kind, when the user can add books to it. `targetFolderId`: the admin's folder in that library, null when none is set or the library is not usable. */
  manga: { available: boolean; searchable: boolean; defaultLibraryId: number | null; targetFolderId: number | null };
  novel: { available: boolean; searchable: boolean; acceptsLinks: boolean; defaultLibraryId: number | null; targetFolderId: number | null };
}

/**
 * Opaque, URL-safe reference to one series on one engine. The server mints it; the client only
 * passes it back. Manga: `m:<suwayomiMangaId>`. Novel: `n:<lncrawlNovelId>`.
 */
export type WebSerialSeriesKey = string;

export interface WebSerialSearchHit {
  seriesKey: WebSerialSeriesKey | null;
  /** Set when the hit has no key yet (novel search results): resolving it goes through the URL. */
  url: string | null;
  kind: WebSerialKind;
  title: string;
  author: string | null;
  /** Same-origin BookOrbit URL, or null. Never an engine or third-party URL. */
  coverUrl: string | null;
  sourceName: string;
  chapterCount: number | null;
  status: WebSerialSeriesStatus;
  /** Higher is more relevant; comparable across kinds. Absent for a resolved link. */
  relevance?: number;
  /** Set when the title marks a machine translation (MTL); absent otherwise. */
  mtl?: boolean;
}

export interface WebSerialSearchResult {
  query: string;
  hits: WebSerialSearchHit[];
  /** Source names that failed or timed out, or a WebSerialKind when a whole engine failed; the rest of the results are still shown. */
  failedSources: string[];
  /** Set on a `phase=index` novel answer when some sources are not fully indexed yet: the full search still asks them live. */
  livePending?: boolean;
}

export interface WebSerialUnit {
  /** Chapter (manga) or volume (novel) key, stable across refreshes of the same series. */
  key: string;
  label: string;
  /** Series position written to the book, `^[0-9]+([.][0-9]+)?$`. */
  sequence: string;
  chapterCount: number;
  publishedAt: string | null;
  /** Manga only: the volume this chapter belongs to when the source's own chapter name says so (e.g. "Vol.3 Ch.25"). */
  volume?: string | null;
  /** Manga only: an extra whose sequence only places it; it never counts towards a volume's chapter range. */
  positional?: boolean;
}

export interface WebSerialSeriesDetail {
  seriesKey: WebSerialSeriesKey;
  kind: WebSerialKind;
  title: string;
  author: string | null;
  synopsis: string | null;
  tags: string[];
  coverUrl: string | null;
  sourceName: string;
  sourceUrl: string | null;
  status: WebSerialSeriesStatus;
  chapterCount: number;
  /** Manga: chapters, oldest first. Novel: volumes, first first. */
  units: WebSerialUnit[];
  packagingOptions: WebSerialPackaging[];
  defaultPackaging: WebSerialPackaging;
  /** Units this user already has in the library from earlier Web Serials jobs. */
  importedUnitKeys: string[];
  /**
   * Keys of the grouped books (manga volumes, one-book selections, whole-series novels) this user already has, as
   * built by `webSerialVolumeUnitKey`, `webSerialSelectionUnitKey` and `WEB_SERIAL_SERIES_UNIT_KEY`. Bounded by the
   * number of distinct books imported, not by the chapter count.
   */
  importedGroupKeys: string[];
}

/** Unit key of the single book a novel series download produces. */
export const WEB_SERIAL_SERIES_UNIT_KEY = "series";

/**
 * Unit key of the book that groups one manga volume. A volume that can still grow (the last one of an ongoing series)
 * carries the chapter range it holds (`vol:12:100-103`), so a later, longer copy is a book of its own.
 */
export function webSerialVolumeUnitKey(volume: string, chapterRange?: string | null): string {
  return chapterRange ? `vol:${volume}:${chapterRange}` : `vol:${volume}`;
}

export interface WebSerialChapterRange {
  from: number;
  to: number;
}

/** The volume and, for a still-growing volume, the chapter range a manga volume key carries; null for any other key. */
export function parseWebSerialVolumeUnitKey(key: string): { volume: string; range: WebSerialChapterRange | null } | null {
  const match = /^vol:([^:]+)(?::(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?))?$/.exec(key);
  if (!match) return null;
  return { volume: match[1]!, range: match[2] !== undefined ? { from: Number(match[2]), to: Number(match[3]) } : null };
}

/**
 * True when the owned ranges together hold every chapter of the wanted one. A range joins the ones before it when it
 * starts no later than the next whole chapter (10 then 11, 10.5 then 11), never across a missing whole chapter (10.5 then 11.5).
 */
export function webSerialRangesCover(owned: readonly WebSerialChapterRange[], wanted: WebSerialChapterRange): boolean {
  let reached: number | null = null;
  for (const range of [...owned].sort((left, right) => left.from - right.from)) {
    if (range.to < wanted.from) continue;
    if (reached === null) {
      if (range.from > wanted.from) return false;
    } else if (range.from > Math.floor(reached) + 1) return false;
    reached = reached === null ? range.to : Math.max(reached, range.to);
    if (reached >= wanted.to) return true;
  }
  return false;
}

/**
 * Whether the owned manga volume keys hold volume `volume`: a plain `vol:N` key owns it whatever it holds now; ranged
 * `vol:N:a-b` copies of the same volume own it when together they cover `wanted`. Another volume's keys never count,
 * since volumes that restart their numbering hold the same chapter numbers.
 */
export function webSerialMangaVolumeOwned(ownedKeys: readonly string[], volume: string, wanted: WebSerialChapterRange | null): boolean {
  const ranges: WebSerialChapterRange[] = [];
  for (const key of ownedKeys) {
    const parsed = parseWebSerialVolumeUnitKey(key);
    if (parsed?.volume !== volume) continue;
    if (parsed.range === null) return true;
    ranges.push(parsed.range);
  }
  return wanted !== null && webSerialRangesCover(ranges, wanted);
}

/** Unit key of the one book that covers a manga selection, built from its first and last chapter unit keys. */
export function webSerialSelectionUnitKey(firstUnitKey: string, lastUnitKey: string): string {
  return `sel:${firstUnitKey}-${lastUnitKey}`;
}

/** What the volume rule needs to know about one manga chapter. */
export interface WebSerialVolumePlanUnit {
  key: string;
  sequence: string;
  /** The volume from the source's own naming, else the volume database; null when the chapter is in no volume. */
  volume: string | null;
}

export type WebSerialVolumePlanSelection =
  { mode: "all" } | { mode: "range"; fromSequence: string; toSequence: string } | { mode: "keys"; keys: ReadonlySet<string> };

/** One book of a per-volume manga download, in series order. */
export type WebSerialVolumePlanEntry = { type: "volume"; volume: string; keys: string[] } | { type: "chapter"; key: string; volume: string | null };

export interface WebSerialPartialVolume {
  volume: string;
  /** Chapters of the volume that are selected; they download as separate chapters. */
  selected: number;
  total: number;
}

export interface WebSerialVolumePlan {
  /** In series order: whole volumes become one book, every other chapter its own book. */
  entries: WebSerialVolumePlanEntry[];
  /** Volumes only partly selected, whose selected chapters are filed as single chapters. */
  partialVolumes: WebSerialPartialVolume[];
  /** Set when a range was widened to cover whole volumes; null when it already did or is not a range. */
  snappedRange: { fromSequence: string; toSequence: string } | null;
}

function sequenceNumber(sequence: string): number {
  return Number.parseFloat(sequence);
}

/**
 * The one rule for per-volume manga packaging, shared by the server (what gets downloaded) and the preview (what
 * the user is told). A volume becomes a book only when every one of its chapters is selected; a range first widens
 * to the first and last chapter of each volume it touches; chapters outside any volume, and chapters of a volume
 * that is only partly selected, become single-chapter books. Units must be in series order.
 */
export function planWebSerialMangaVolumes(units: readonly WebSerialVolumePlanUnit[], selection: WebSerialVolumePlanSelection): WebSerialVolumePlan {
  const totals = new Map<string, number>();
  const bounds = new Map<string, { low: WebSerialVolumePlanUnit; high: WebSerialVolumePlanUnit }>();
  for (const unit of units) {
    if (unit.volume === null) continue;
    totals.set(unit.volume, (totals.get(unit.volume) ?? 0) + 1);
    const known = bounds.get(unit.volume);
    if (!known) bounds.set(unit.volume, { low: unit, high: unit });
    else {
      if (sequenceNumber(unit.sequence) < sequenceNumber(known.low.sequence)) known.low = unit;
      if (sequenceNumber(unit.sequence) > sequenceNumber(known.high.sequence)) known.high = unit;
    }
  }

  let selected: WebSerialVolumePlanUnit[];
  let snappedRange: WebSerialVolumePlan["snappedRange"] = null;
  if (selection.mode === "all") selected = [...units];
  else if (selection.mode === "keys") selected = units.filter((unit) => selection.keys.has(unit.key));
  else {
    let from = selection.fromSequence;
    let to = selection.toSequence;
    const within = () =>
      units.filter((unit) => sequenceNumber(unit.sequence) >= sequenceNumber(from) && sequenceNumber(unit.sequence) <= sequenceNumber(to));
    for (;;) {
      let widened = false;
      for (const unit of within()) {
        const volume = unit.volume === null ? undefined : bounds.get(unit.volume);
        if (!volume) continue;
        if (sequenceNumber(volume.low.sequence) < sequenceNumber(from)) {
          from = volume.low.sequence;
          widened = true;
        }
        if (sequenceNumber(volume.high.sequence) > sequenceNumber(to)) {
          to = volume.high.sequence;
          widened = true;
        }
      }
      if (!widened) break;
    }
    selected = within();
    if (from !== selection.fromSequence || to !== selection.toSequence) snappedRange = { fromSequence: from, toSequence: to };
  }

  const selectedCounts = new Map<string, number>();
  for (const unit of selected) if (unit.volume !== null) selectedCounts.set(unit.volume, (selectedCounts.get(unit.volume) ?? 0) + 1);

  const entries: WebSerialVolumePlanEntry[] = [];
  const books = new Map<string, Extract<WebSerialVolumePlanEntry, { type: "volume" }>>();
  const partialVolumes = new Map<string, WebSerialPartialVolume>();
  for (const unit of selected) {
    const volume = unit.volume;
    if (volume !== null && selectedCounts.get(volume) === totals.get(volume)) {
      const book = books.get(volume);
      if (book) book.keys.push(unit.key);
      else {
        const created: Extract<WebSerialVolumePlanEntry, { type: "volume" }> = { type: "volume", volume, keys: [unit.key] };
        books.set(volume, created);
        entries.push(created);
      }
      continue;
    }
    if (volume !== null) partialVolumes.set(volume, { volume, selected: selectedCounts.get(volume) ?? 0, total: totals.get(volume) ?? 0 });
    entries.push({ type: "chapter", key: unit.key, volume });
  }
  return { entries, partialVolumes: [...partialVolumes.values()], snappedRange };
}

/** One publisher the details service lists for a series. `type` is MangaBaka's label, such as "Original" or "English". */
export interface WebSerialPublisher {
  name: string;
  type: string | null;
  language: string | null;
}

/** Most published volume count a series offers to request, and the bound on a typed-in count. */
export const WEB_SERIAL_MAX_PUBLISHED_VOLUMES = 200;

/** What the details service knows about a series in print, which decides whether its volumes are offered as book requests. */
export interface WebSerialPublication {
  /** Licensed for an official release, by the service's own flag or an English publisher. */
  licensed: boolean;
  /** Last volume number of a finished print run, when known. */
  finalVolume: number | null;
  publishers: WebSerialPublisher[];
}

/** A series matched in the details service. Shown in the preview and applied on import. */
export interface WebSerialSeriesMatch {
  provider: "mangabaka";
  id: string;
  title: string;
  url: string;
  year: number | null;
  authors: string[];
  artists: string[];
  status: WebSerialSeriesStatus;
  genres: string[];
  /** Absent on matches stored before it was looked up. */
  publication?: WebSerialPublication;
  /** part: the source carries the whole series and this is the first of the parts the database files separately. Absent means series. */
  scope?: "series" | "part";
}

export type WebSerialLookupState = "matched" | "no_match" | "unavailable" | "disabled";

/** `GET web-serials/series/:seriesKey/lookup`. Never an error response: failures come back as `unavailable`. */
export interface WebSerialSeriesLookup {
  state: WebSerialLookupState;
  match: WebSerialSeriesMatch | null;
  /** Plain-language reason for `unavailable`. */
  message: string | null;
  /**
   * Manga only: chapter unit key to volume number from the volume database (MangaDex), when the series could be
   * found there. Chapters missing here have no known volume. Null when no mapping is available.
   */
  chapterVolumes: Record<string, string> | null;
}

/** What the user confirmed in the preview; applied to every book the job imports. */
export interface WebSerialMetadataOverride {
  /** Details-service match the user kept, or null when they rejected it. */
  matchId?: string | null;
  authors?: string[];
  artists?: string[];
}

export interface ResolveWebSerialUrlInput {
  url: string;
}

export type WebSerialSelection =
  | { mode: "all" }
  | { mode: "range"; fromSequence: string; toSequence: string }
  /** Exact chapters by sequence; used when a download moves to another source. */
  | { mode: "list"; sequences: string[] };

export interface CreateWebSerialJobInput {
  seriesKey: WebSerialSeriesKey;
  packaging: WebSerialPackaging;
  selection: WebSerialSelection;
  /** Skip units already imported for this user. Defaults to true. */
  skipImported?: boolean;
  libraryId: number;
  folderId?: number | null;
  metadata?: WebSerialMetadataOverride;
}

export type WebSerialJobStatus = "queued" | "paused" | "running" | "importing" | "completed" | "completed_with_gaps" | "failed" | "cancelled";

export const ACTIVE_WEB_SERIAL_JOB_STATUSES: readonly WebSerialJobStatus[] = ["queued", "running", "importing"];

export type WebSerialJobItemStatus = "pending" | "fetching" | "importing" | "imported" | "skipped" | "failed";

export interface WebSerialJob {
  id: number;
  kind: WebSerialKind;
  seriesKey: WebSerialSeriesKey;
  title: string;
  author: string | null;
  coverUrl: string | null;
  sourceName: string;
  packaging: WebSerialPackaging;
  selection: WebSerialSelection;
  libraryId: number;
  libraryName: string | null;
  status: WebSerialJobStatus;
  unitsTotal: number;
  unitsDone: number;
  unitsFailed: number;
  unitsSkipped: number;
  /** Progress inside the book being worked on now (a volume or whole-series book can take a long time). */
  current: WebSerialJobCurrentUnit | null;
  /** Plain-language reason, safe to show to the user. */
  message: string | null;
  /** 1-based place among this queue's waiting jobs; null unless queued. */
  queuePosition: number | null;
  /** Set only in the admin view (scope=all). */
  owner: { id: number; name: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WebSerialJobCurrentUnit {
  label: string;
  stage: "fetching" | "building" | "importing";
  /** Chapters fetched so far and in total, when the engine reports them. */
  chaptersDone: number | null;
  chaptersTotal: number | null;
  /** 0..1 when known. */
  progress: number | null;
}

export interface WebSerialJobList {
  items: WebSerialJob[];
  activeCount: number;
  /** Jobs in scope, and how many of them are finished. */
  total: number;
  finishedCount: number;
  /** Instance-wide pause set by an admin: nothing new starts while true. */
  queuePaused: boolean;
}

export type WebSerialJobScope = "mine" | "all";

export interface WebSerialJobItem {
  id: number;
  label: string;
  sequence: string;
  status: WebSerialJobItemStatus;
  /** Plain-language reason for a failed item. */
  error: string | null;
  bookId: number | null;
  updatedAt: string;
}

export interface WebSerialJobDetail {
  job: WebSerialJob;
  items: WebSerialJobItem[];
}

export interface WebSerialClearFinishedResult {
  removed: number;
}

/** A manga extension in the configured Suwayomi repositories (admin catalogue). */
export interface WebSerialMangaExtension {
  pkgName: string;
  name: string;
  /** ISO code, or "all" for multi-language extensions. */
  lang: string;
  versionName: string;
  installed: boolean;
  hasUpdate: boolean;
  /** The extension carries an adult-content warning. */
  adult: boolean;
  /** Same-origin BookOrbit URL for the icon, or null. */
  iconUrl: string | null;
  repo: string | null;
}

export interface WebSerialMangaExtensionPage {
  items: WebSerialMangaExtension[];
  total: number;
  /** Languages present in the whole catalogue, for the language filter. */
  languages: string[];
}

export interface WebSerialMangaExtensionQuery {
  query?: string;
  lang?: string;
  installed?: boolean;
  adult?: boolean;
  limit?: number;
  offset?: number;
}

export interface WebSerialExtensionRepoInput {
  url: string;
}

/** Another source's copy of a job's series, for "Move to another source". */
export interface WebSerialMoveCandidate {
  seriesKey: WebSerialSeriesKey;
  title: string;
  sourceName: string;
  coverUrl: string | null;
  /** same_series: same series in the details database (MangaBaka); title_match: titles agree. */
  confidence: "same_series" | "title_match";
  /** How many of the job's remaining chapters this source has. */
  remainingAvailable: number;
  remainingTotal: number;
}

export interface WebSerialMoveCandidates {
  /** Chapters the move would carry over (pending or failed). */
  remainingTotal: number;
  candidates: WebSerialMoveCandidate[];
  /** Sources that could not be searched (down or timed out). */
  failedSources: string[];
}

export interface MoveWebSerialJobInput {
  seriesKey: WebSerialSeriesKey;
}

export interface MoveWebSerialJobResult {
  /** The original job, now stopped with its moved chapters marked. */
  from: WebSerialJob;
  /** The new job on the chosen source. */
  to: WebSerialJob;
}

/** One source's copy of a series, for the preview's "Download from" choice. */
export interface WebSerialSourceOption {
  seriesKey: WebSerialSeriesKey;
  sourceName: string;
  title: string;
  chapterCount: number;
  /** Newest chapter's upload date, when the source reports dates. */
  latestAt: string | null;
  /**
   * current: the series being previewed; same_series / title_match as for moves; whole_series: the source carries the
   * whole series while the details database files this part on its own (base titles and authors agree).
   */
  confidence: "current" | "same_series" | "title_match" | "whole_series";
  /** Highest chapter count among the options (ties: the current one). */
  mostComplete: boolean;
  /** Set when the source's title marks a machine translation (MTL); absent otherwise. */
  mtl?: boolean;
  /** Client only: the chapter count has not been loaded (yet), so `chapterCount` means nothing. */
  chaptersUnknown?: boolean;
}

/**
 * `GET web-serials/series/:seriesKey/sources` (manga only; novels return just the current source) and
 * `GET web-serials/discover/:kind/:matchId/sources` (both kinds; no `current` option, the most complete first).
 */
export interface WebSerialSourceOptions {
  options: WebSerialSourceOption[];
  failedSources: string[];
}

/** A series in the details database (MangaBaka), shown before any release source is searched. */
export interface WebSerialCatalogEntry {
  /** The MangaBaka series id. With `kind` it identifies the entry on every discover route. */
  matchId: string;
  kind: WebSerialKind;
  /** The database's official title. */
  title: string;
  authors: string[];
  artists: string[];
  year: number | null;
  status: WebSerialSeriesStatus;
  genres: string[];
  synopsis: string | null;
  /** Same-origin BookOrbit URL, or null. Never a third-party URL. */
  coverUrl: string | null;
  /** MangaBaka page for the series. */
  url: string;
  /** This user already has books from this series in the library, from any source. */
  inLibrary: boolean;
  /** Absent when the entry was not built from a details-service record, such as a novel index suggestion. */
  publication?: WebSerialPublication;
}

/** Why `GET web-serials/discover` sent no series: the client then runs the source search instead. */
export type WebSerialDiscoverFallback = "disabled" | "unavailable" | "empty";

/** `GET web-serials/discover`. `fallback` is set exactly when `results` is empty. */
export interface WebSerialDiscoverResult {
  results: WebSerialCatalogEntry[];
  fallback: WebSerialDiscoverFallback | null;
}

/** One light novel site the admin enabled for search, with this user's own on/off. */
export interface WebSerialNovelSearchProvider {
  domain: string;
  name: string;
  enabled: boolean;
}

/** A site the novel engine can download from when the user pastes a series link. */
export interface WebSerialNovelLinkSite {
  domain: string;
  name: string;
}

/** `GET web-serials/novel-providers`. Users can only switch off sites the admin enabled. */
export interface WebSerialNovelProviders {
  search: WebSerialNovelSearchProvider[];
  linkSites: WebSerialNovelLinkSite[];
  linkSitesTotal: number;
  /** The novel engine could not be reached, so `linkSites` is empty. */
  unavailable: boolean;
}

/** `PUT web-serials/novel-providers`. Domains the admin did not enable are ignored. */
export interface UpdateWebSerialNovelProvidersInput {
  disabledDomains: string[];
}

/** `POST web-serials/published-requests`: records a Book Request the client just created for one published volume. */
export interface RecordWebSerialPublishedRequestInput {
  kind: WebSerialKind;
  matchId: string;
  volume: string;
  bookRequestId: number;
}

/** One recorded Book Request for a volume of a series, from `GET web-serials/published-requests`. */
export interface WebSerialPublishedRequest {
  volume: string;
  bookRequestId: number;
}

/** Light novel index fill progress for one source: pending, filling page by page, done (top-ups only), or paused until tomorrow's budget. */
export type WebSerialNovelIndexFillState = "pending" | "filling" | "done" | "paused";

/** `GET web-serials/admin/novel-index`: one row per installed LNReader source. */
export interface WebSerialNovelIndexSource {
  sourceId: string;
  name: string;
  enabled: boolean;
  fillState: WebSerialNovelIndexFillState;
  nextPage: number;
  entries: number;
  filledAt: string | null;
  lastTopupAt: string | null;
  lastError: string | null;
  requestsToday: number;
  /** The filler is working on this source right now. */
  running: boolean;
}

export interface WebSerialNovelIndexStatus {
  dailyBudget: number;
  sources: WebSerialNovelIndexSource[];
  /** The novel sources service could not list its installed sources; `sources` then holds only what the index already knows. */
  unavailable: boolean;
}

export interface WebSerialSuggestionEntry {
  sourceId: string;
  /** The site's display name; the source id when it is no longer installed. */
  sourceName: string;
  /** This copy is a machine translation. */
  mtl: boolean;
  path: string;
  seriesKey: WebSerialSeriesKey;
}

/** One series in `GET web-serials/suggest`: the index entries of every enabled source that carries it. */
export interface WebSerialSuggestion {
  kind: "novel";
  title: string;
  /** Same-origin cover URL, or null. */
  cover: string | null;
  sourcesCount: number;
  /** Every copy the index knows is a machine translation. */
  mtlOnly: boolean;
  /** The MangaBaka series id, when the index has matched it. */
  matchId?: string;
  entries: WebSerialSuggestionEntry[];
}

export interface WebSerialSuggestResult {
  query: string;
  suggestions: WebSerialSuggestion[];
}

/** How a file index lists its files: a JSON tree, or HTML directory pages (nginx, Apache, h5ai). */
export type WebSerialFileIndexFormat = "json" | "html";

/** The JSON keys a listing uses for a folder's name, path, sub-folders and files; unset keys use the defaults. */
export interface WebSerialFileIndexKeyMap {
  name?: string;
  path?: string;
  folders?: string;
  files?: string;
  size?: string;
}

/** `GET web-serials/admin/file-indexes`: one admin-configured listing of downloadable books. */
export interface WebSerialFileIndex {
  id: number;
  name: string;
  listingUrl: string;
  baseUrl: string;
  format: WebSerialFileIndexFormat;
  keyMap: WebSerialFileIndexKeyMap;
  username: string | null;
  hasPassword: boolean;
  enabled: boolean;
  refreshHours: number;
  lastRefreshAt: string | null;
  series: number;
  files: number;
  lastError: string | null;
  /** The index is being refreshed right now. */
  running: boolean;
}

export interface WebSerialFileIndexInput {
  name?: string;
  listingUrl?: string;
  /** Defaults to the folder that holds the listing. */
  baseUrl?: string | null;
  format?: WebSerialFileIndexFormat;
  keyMap?: WebSerialFileIndexKeyMap;
  /** null or "" clears the stored value. */
  username?: string | null;
  password?: string | null;
  enabled?: boolean;
  refreshHours?: number;
}

export interface WebSerialFileIndexPreviewSeries {
  folderPath: string;
  title: string;
  volumes: Array<{ name: string; volume: number }>;
}

/** `POST web-serials/admin/file-indexes/test`: what a refresh would store, without storing it. */
export interface WebSerialFileIndexPreview {
  format: WebSerialFileIndexFormat;
  series: number;
  files: number;
  /** Book files the listing holds that are not EPUB; they are left out. */
  skippedFiles: number;
  /** EPUBs whose name states no volume number; they are left out too. */
  unnumberedFiles: number;
  truncated: boolean;
  sample: WebSerialFileIndexPreviewSeries[];
}
