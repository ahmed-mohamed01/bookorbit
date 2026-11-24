import type { JobActionResult } from "./jobs";

export interface JobReorderRequest {
  id: string;
  targetId: string;
  place: "before" | "after";
}

export type JobReorderResult = Omit<JobActionResult, "id">;
