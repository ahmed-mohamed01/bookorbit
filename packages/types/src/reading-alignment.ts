export type AlignmentStatus = "none" | "pending" | "building" | "ready" | "failed" | "unalignable";

export type AlignmentBuildBlockReason = "disabled" | "unavailable" | "busy";

// A 'none' payload carries only `status`, so every other field is optional. `stale` is true when a
// ready alignment no longer matches the pair's current files and needs a rebuild.
export interface AlignmentStatusResponse {
  status: string;
  samplesDone?: number;
  samplesTotal?: number | null;
  anchorCount?: number;
  builtAt?: string | null;
  error?: string | null;
  stale?: boolean;
}

// `status` is an AlignmentStatus when a build starts, or an AlignmentBuildBlockReason when it cannot.
export interface AlignmentBuildResponse {
  status: string;
}
