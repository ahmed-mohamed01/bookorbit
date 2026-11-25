import type { StoryGuideAnchor, StoryGuideEntity, StoryGuidePayloadV1 } from "./story-guide-payload";
export type BookKnowledgeScope = "position" | "full";
export type BookKnowledgeTermType = "person" | "place" | "concept";
export type BookKnowledgeKind = "person" | "animal" | "place" | "group" | "object" | "idea" | "title";
export type BookKnowledgeKindSubtype = "animal" | "god" | "spirit";
export interface BookKnowledgeScopeInfo {
  scope: BookKnowledgeScope;
  cutoffOrdinal: number;
  noProgress: boolean;
}
export interface BookKnowledgeStatus extends BookKnowledgeScopeInfo {
  status: "none" | "queued" | "running" | "ready" | "failed" | "stale";
  progress: number;
  error: string | null;
  modelConfigured: boolean;
  /** The admin Enabled switch: when off, no build starts or queues. */
  enabled: boolean;
}
export interface BookKnowledgeTerm {
  key: string;
  displayName: string;
  aliases: string[];
  type: BookKnowledgeTermType;
  kind?: BookKnowledgeKind | null;
  kindSubtype?: BookKnowledgeKindSubtype | null;
  junk?: boolean;
  count: number;
  first: number;
  latest: number;
  score: number;
}
export interface BookKnowledgeTerms extends BookKnowledgeScopeInfo {
  items: BookKnowledgeTerm[];
  total: number;
  limit: number;
  offset: number;
}
export interface BookKnowledgePassage {
  number: number;
  text: string;
  ordinals: number[];
  spineIndex: number;
  paragraphIndex: number;
  href: string;
}
export interface BookKnowledgeTermDetail extends BookKnowledgeScopeInfo {
  cutoffSpineIndex: number | null;
  spineHrefs: { spineIndex: number; href: string }[];
  term: BookKnowledgeTerm;
  histogram: { spineIndex: number; count: number }[];
  related: { key: string; displayName: string; count: number; first: number; label: "often with" }[];
  passages: BookKnowledgePassage[];
}
export interface BookKnowledgePoint {
  text: string;
  quote: string;
  passage: number;
}
export interface BookKnowledgeCard {
  meaning: string;
  meaningQuote: string;
  meaningPassage: number;
  points: BookKnowledgePoint[];
  insufficient: boolean;
}
export interface BookKnowledgeChecks {
  meaningVerified: boolean;
  droppedPoints: number;
  unknownPassage: boolean;
}
export interface BookKnowledgeCardResponse extends BookKnowledgeScopeInfo {
  card: BookKnowledgeCard;
  checks: BookKnowledgeChecks;
  passages: BookKnowledgePassage[];
}
export interface BookKnowledgeAnswer {
  answer: string;
  points: BookKnowledgePoint[];
  notInBook: boolean;
}
export interface BookKnowledgeAskResponse extends BookKnowledgeScopeInfo {
  route: "term" | "search";
  answer: BookKnowledgeAnswer;
  checks: BookKnowledgeChecks;
  passages: BookKnowledgePassage[];
}
/** Model calls go through the server's AI settings (feature `book-knowledge`, fast and careful slots). */
export interface BookKnowledgeSettings {
  enabled: boolean;
}
export interface UpdateBookKnowledgeSettings {
  enabled?: boolean;
}
/** An upstream anchor plus `n`, the Book Knowledge sentence ordinal it was taken from. */
export type BookKnowledgeXrayAnchor = StoryGuideAnchor & { n?: number };
export type BookKnowledgeXraySub = "animal" | "god" | "spirit" | "title";
export interface BookKnowledgeXrayEntity extends StoryGuideEntity {
  sub?: BookKnowledgeXraySub;
  /** 1 for the main cast, 2 for the supporting cast, 3 for the rest; ranked by mentions (by the term ranking in nonfiction). */
  importance: 1 | 2 | 3;
  count: number;
}
/**
 * An untyped connection from co-occurrence and dialogue; typed ones are `ties`. It is ranked from the
 * text up to `at` only and holds until `until` (exclusive; absent when it holds to the end), so a
 * reader at a cut sees the records with `at` at or before the cut and `until` after it.
 */
export interface BookKnowledgeXrayLink {
  a: string;
  b: string;
  /** Normalised PMI in (0, 1] over shared paragraphs and exchanges up to `at`. */
  score: number;
  count: number;
  at: BookKnowledgeXrayAnchor;
  until?: BookKnowledgeXrayAnchor;
}
/** Text that holds from `through` on; the newest visible one wins. */
export interface StoryGuideChronicleVersioned {
  through: BookKnowledgeXrayAnchor;
  text: string;
}
export interface StoryGuideChronicleTimelineEntry {
  /** Its unit's end; hidden until the reader passes it. */
  through: BookKnowledgeXrayAnchor;
  /** null: the reader shows the section title of `through`. */
  chapter: string | null;
  /** null: nothing significant changed. At most 40 words, events of this unit only. */
  note: string | null;
  /** The quote where it happens, or the unit's first passage. */
  at: BookKnowledgeXrayAnchor;
}
export type StoryGuideChronicleAbilityGroup = "path" | "class" | "level" | "spell" | "skill" | "trait" | "stat" | "gear" | "other";
export interface StoryGuideChronicleAbilityItem {
  group: StoryGuideChronicleAbilityGroup;
  name: string;
  detail: string | null;
  /** Where it was first stated. */
  since: BookKnowledgeXrayAnchor;
}
export interface StoryGuideChronicleAbilitiesSnapshot {
  through: BookKnowledgeXrayAnchor;
  /** The full list as of `through`, not a diff. */
  items: StoryGuideChronicleAbilityItem[];
}
export interface StoryGuideChronicleEntity {
  /** "Who they are": rewritten only when a lasting fact changes, at most 60 words. */
  about: StoryGuideChronicleVersioned[];
  /** One entry per chapter unit the entity comes up in, in reading order. */
  timeline: StoryGuideChronicleTimelineEntry[];
  /** Snapshots written when the list changes; characters with stated stats only. */
  abilities?: StoryGuideChronicleAbilitiesSnapshot[];
  /** "Now": what has changed since the intro, at most 30 words; absent when nothing has. */
  now?: StoryGuideChronicleVersioned[];
}
/** The `chronicle` contract, version 1 (spec/constellations-chronicle-contract.md). */
export interface StoryGuideChronicle {
  version: 1;
  /** The payload's `builtAt`. */
  basis: string;
  /** By entity or join key of the payload. */
  entities: Record<string, StoryGuideChronicleEntity>;
  /** By the two keys in key order joined by "|": one description per pair. */
  pairs?: Record<string, StoryGuideChronicleVersioned[]>;
  /** By join key: when the join becomes visible, if earlier than the join's own `at`. */
  joins?: Record<string, BookKnowledgeXrayAnchor>;
  /** The end of the last unit written, for a build that stops before the book's end; absent when every unit was written. */
  covers?: BookKnowledgeXrayAnchor;
}
/** `StoryGuidePayloadV1` from the Book Knowledge pipeline, with the fork-only `links` and, from the one-pass build, `chronicle`. */
export interface BookKnowledgeXrayPayload extends Omit<StoryGuidePayloadV1, "entities"> {
  entities: BookKnowledgeXrayEntity[];
  links: BookKnowledgeXrayLink[];
  chronicle?: StoryGuideChronicle;
}
export type BookKnowledgeXrayMode = "fiction" | "nonfiction";
export type BookKnowledgeXrayStepId =
  "kinds" | "ties" | "lines" | "profiles" | "summaries" | "pass" | "about" | "notes" | "facts" | "noteMerge" | "now" | "alias" | "describe";
export interface BookKnowledgeXrayMerge {
  rule: string;
  member: string;
  head: string;
  /** The sentence that shows the join. */
  ordinal: number;
  /** The member's own mentions. */
  mentions: number;
  /** For an alias merge, why the pair was a candidate. */
  reason?: string;
}
/** What a step's calls used, from the replies themselves. */
export interface BookKnowledgeXrayUsage {
  input: number;
  output: number;
  reasoning: number;
  /** Dollars, as the client estimated them. */
  cost: number;
  /** Time spent waiting on calls, summed. */
  callMs: number;
}
export interface BookKnowledgeXrayPrivacy {
  calls: number;
  sentences: number;
  characters: number;
  /** Distinct sections the step's calls sent sentences from. */
  sections: number;
}
export interface BookKnowledgeXrayStep {
  step: BookKnowledgeXrayStepId;
  slot: "fast" | "careful";
  units: number;
  calls: number;
  /** Replies that could not be read; each is retried once. */
  invalid: number;
  /** Units left out after the retry. */
  skipped: number;
  /** Items the checks dropped, by reason. */
  rejected: Record<string, number>;
  privacy: BookKnowledgeXrayPrivacy;
  start: string;
  end: string | null;
  usage?: BookKnowledgeXrayUsage;
  /** Items sent back for a rewrite on the first try, by reason. */
  firstTry?: Record<string, number>;
  /** Required keys asked for, answered on the first try, and answered after the retry. */
  required?: { keys: number; first: number; retry: number };
  /** Near-miss tie types mapped to an allowed one, as "given->type". */
  mapped?: Record<string, number>;
  /** Replies cut short at the output cap. */
  cut?: number;
  /** Units left out after their tries, by id. */
  skippedUnits?: string[];
  /** A step's own counters, such as candidate pairs offered and ties returned. */
  counts?: Record<string, number>;
}
/** A dry run's forecast: calls and tokens per step, converted to minutes at the measured local rates. */
export interface BookKnowledgeXrayEstimate {
  steps: {
    step: BookKnowledgeXrayStepId;
    calls: number;
    promptTokens: number;
    outputTokens: number;
    /** At 855k tokens in 57.6 minutes, any kind of token. */
    minutes: number;
    /** At about 1,000 prompt and 66 output tokens a second. */
    splitMinutes: number;
  }[];
  calls: number;
  promptTokens: number;
  outputTokens: number;
  minutes: number;
  splitMinutes: number;
}
export interface BookKnowledgeXrayRun {
  runId: string;
  bookId: number;
  status: "running" | "done" | "failed";
  error: string | null;
  through: number;
  startedAt: string;
  finishedAt: string | null;
  steps: BookKnowledgeXrayStep[];
  privacy: {
    bookCharacters: number;
    bookSentences: number;
    sentCharacters: number;
    distinctSentences: number;
    distinctCharacters: number;
  };
  counts: Record<string, number> | null;
  /** Set by a dry run, which plans every call and sends none. */
  dryRun?: boolean;
  estimate?: BookKnowledgeXrayEstimate | null;
  /** Fiction or nonfiction, from the EPUB's subjects unless the run overrides it. */
  mode?: BookKnowledgeXrayMode;
  /** The ties step's passes over the same pairs, each tie as "a|type|b|cite", for stability checks. */
  tieVote?: { passes: string[][]; overlaps: number[]; agreed: number; single: number; kept: number } | null;
  /** The one-pass build's repeats over the same units, for stability checks: per repeat its items, and what each pair of repeats shares. */
  passRepeats?: { runs: Record<string, number>[]; overlaps: Record<string, { both: number; either: number }>[] } | null;
  /** The one pass's merges, each with the rule that made it and where the text shows it. */
  merges?: BookKnowledgeXrayMerge[] | null;
}
