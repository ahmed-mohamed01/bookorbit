import type { BookKnowledgeXrayEntity, BookKnowledgeXrayLink, BookKnowledgeXrayMode, StoryGuideChronicle } from "./book-knowledge";
import type { StoryGuideEntity, StoryGuidePayloadV1 } from "./story-guide-payload";

export type ForkStoryGuidePayload = Omit<StoryGuidePayloadV1, "entities"> & {
  entities: (StoryGuideEntity & Partial<Pick<BookKnowledgeXrayEntity, "importance" | "count">>)[];
  links?: BookKnowledgeXrayLink[];
  chronicle?: StoryGuideChronicle;
  /** Absent on guides built before the mode was recorded; those read as fiction. */
  mode?: BookKnowledgeXrayMode;
};

export interface ForkStoryGuideCut {
  s: number;
  placedQuotes: string[];
}

export interface ForkStoryRecap {
  state: "ok" | "no-position";
  position?: { chapterIndex: number; percentage: number; cfi: string; chapterTitle: string | null };
  cut: ForkStoryGuideCut | null;
  previously: { s: number; title: string | null; text: string }[];
  stop: { state: "ok"; text: string; cached: boolean } | { state: "unplaced" | "skipped" | "off" | "budget" | "cap" | "failed"; code?: string };
}
