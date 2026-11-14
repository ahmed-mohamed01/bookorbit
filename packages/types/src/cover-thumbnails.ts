// Fork: cover thumbnail backfill. See FORK_MAINTENANCE.md.

export type CoverThumbnailBackfillTrigger = "startup" | "schedule" | "manual";

/** `stopped`: the switch was turned off, or the server shut down, before the run finished. */
export type CoverThumbnailBackfillOutcome = "completed" | "stopped" | "failed";

export interface CoverThumbnailBackfillCounts {
  scanned: number;
  missing: number;
  made: number;
  /** Missing thumbnails that could not be made, usually a cover file that cannot be read. */
  unresolved: number;
}

export interface CoverThumbnailBackfillRun extends CoverThumbnailBackfillCounts {
  trigger: CoverThumbnailBackfillTrigger;
  outcome: CoverThumbnailBackfillOutcome;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface CoverThumbnailBackfillState {
  /** Runs after start-up and daily. "Run now" works either way. */
  enabled: boolean;
  /** Counts so far while a run is going, otherwise null. */
  running: (CoverThumbnailBackfillCounts & { trigger: CoverThumbnailBackfillTrigger; startedAt: string }) | null;
  lastRun: CoverThumbnailBackfillRun | null;
}

export interface UpdateCoverThumbnailBackfillPayload {
  enabled: boolean;
}
