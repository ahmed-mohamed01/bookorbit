// Storyteller integration contract shared by the server API and the client. One instance-level
// connection (service account) drives read-along generation for every BookOrbit user.

export type StorytellerTransport = "auto" | "shared-paths" | "api-transfer";

export type StorytellerEffectiveTransport = Exclude<StorytellerTransport, "auto">;

/**
 * One prefix rewrite between the path BookOrbit sees and the path the Storyteller server sees for
 * the same location. Longest matching prefix wins, in both directions.
 */
export interface StorytellerPathMapping {
  localPrefix: string;
  remotePrefix: string;
}

export type StorytellerReadaloudLocationType = "SUFFIX" | "SIBLING_FOLDER" | "INTERNAL" | "CUSTOM_FOLDER";

export type StorytellerSetupProblem =
  | "server_unreachable"
  | "auth_failed"
  | "no_path_mappings"
  | "readaloud_location_not_custom_folder"
  | "readaloud_folder_not_mapped"
  | "target_library_missing"
  | "target_library_not_book_per_file"
  | "target_library_disallows_epub";

export interface StorytellerConnectionTestResult {
  ok: boolean;
  checkedAt: string;
  serverVersion: string | null;
  capabilities: string[];
  readaloudLocationType: StorytellerReadaloudLocationType | null;
  readaloudLocation: string | null;
  importMode: string | null;
  aligner: string | null;
  sharedPathsReady: boolean;
  effectiveTransport: StorytellerEffectiveTransport | null;
  problems: StorytellerSetupProblem[];
  error: string | null;
}

export interface StorytellerSettings {
  serverUrl: string | null;
  username: string | null;
  passwordConfigured: boolean;
  pathMappings: StorytellerPathMapping[];
  targetLibraryId: number | null;
  targetFolderId: number | null;
  transport: StorytellerTransport;
  deleteRemoteAfterImport: boolean;
  collectionName: string | null;
  lastCheckedAt: string | null;
  lastCheck: StorytellerConnectionTestResult | null;
}

/**
 * Connection details to test. Any omitted or empty field falls back to the stored one, so an
 * already-saved connection can be re-tested without retyping the password.
 */
export interface StorytellerConnectionTestPayload {
  serverUrl?: string;
  username?: string;
  password?: string;
}

/** Every field optional: omitted fields keep their stored value. An omitted password keeps the current one. */
export interface UpsertStorytellerSettingsPayload {
  serverUrl?: string;
  username?: string;
  password?: string;
  pathMappings?: StorytellerPathMapping[];
  targetLibraryId?: number | null;
  targetFolderId?: number | null;
  transport?: StorytellerTransport;
  deleteRemoteAfterImport?: boolean;
  collectionName?: string | null;
}

export const READ_ALONG_STATUSES = ["none", "building", "ready", "failed"] as const;
export type ReadAlongStatus = (typeof READ_ALONG_STATUSES)[number];

export const READ_ALONG_PHASES = ["prepare", "register", "process", "wait", "collect", "link"] as const;
export type ReadAlongPhase = (typeof READ_ALONG_PHASES)[number];

/**
 * Why a read-along cannot be built right now. Each reason names what the caller would have to
 * change, so two situations that need different changes never share one.
 *
 * The array is the single source: a consumer that maps or validates these derives its list from it
 * rather than hand-copying the union, so a reason added here cannot render as silence.
 */
export const READ_ALONG_BLOCK_REASONS = [
  "not_configured",
  "unreachable",
  "busy",
  "no_pair",
  "no_epub",
  "source_epub_unreadable",
  "no_audio",
  "no_target_library",
  "target_not_allowed",
  "format_not_allowed",
  "previous_output_not_deletable",
] as const;
export type ReadAlongBlockReason = (typeof READ_ALONG_BLOCK_REASONS)[number];

export interface ReadAlongBuildRequest {
  force?: boolean;
  targetLibraryId?: number;
  targetFolderId?: number;
  /** Reuse an aligned book that already exists in Storyteller instead of registering and processing a new one. */
  useExistingUuid?: string;
  /** Overrides the instance-wide `deleteRemoteAfterImport` for this build only. */
  cleanUpRemote?: boolean;
}

export interface ReadAlongBuildResponse {
  status: ReadAlongStatus;
  blocked: ReadAlongBlockReason | null;
}

export interface ReadAlongOutputBook {
  id: number;
  title: string | null;
}

export interface ReadAlongCopySizes {
  epub: number | null;
  audio: number | null;
  readAlong: number | null;
}

export interface ReadAlongStatusResponse {
  status: ReadAlongStatus;
  blocked: ReadAlongBlockReason | null;
  phase: ReadAlongPhase | null;
  transport: StorytellerEffectiveTransport | null;
  remoteTask: string | null;
  /** 0..1 as reported by Storyteller for the current task, when it reports one. */
  remoteProgress: number | null;
  outputBook: ReadAlongOutputBook | null;
  targetLibraryId: number | null;
  /** Name of the library the finished read-along lands in, when it is still resolvable. */
  targetLibraryName: string | null;
  /** Bytes a Storyteller copy would occupy, per member. Null where no size was recorded. */
  remoteCopyBytes: ReadAlongCopySizes;
  /** Instance default for keeping the Storyteller copy, which a build may override. */
  keepRemoteCopyByDefault: boolean;
  /**
   * Whether Storyteller would hold copies of its own that dropping them could reclaim.
   *
   * False over shared paths: Storyteller reads the library's files where they are and writes the
   * read-along into the library folder, so every file its book points at belongs to BookOrbit and
   * none of them may be deleted. There is nothing to keep or drop there but a processing cache, so
   * a per-book keep-copy choice has no effect and is not offered.
   */
  remoteCopyReclaimable: boolean;
  error: string | null;
  startedAt: string | null;
  builtAt: string | null;
}

export interface StorytellerExistingMatch {
  uuid: string;
  title: string;
  authors: string[];
  aligned: boolean;
  /** 0..100, same scale as edition-link candidate scores. */
  score: number;
}

export interface StorytellerExistingMatchesResponse {
  matches: StorytellerExistingMatch[];
}
