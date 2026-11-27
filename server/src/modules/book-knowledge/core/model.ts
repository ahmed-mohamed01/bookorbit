export type Structure = 'body' | 'front' | 'contents' | 'notes' | 'bibliography' | 'index' | 'other';
export interface Sentence {
  ordinal: number;
  spineIndex: number;
  paragraphIndex: number;
  href: string;
  text: string;
  structure: Structure;
  heading: boolean;
  caption?: boolean;
  /** Set off from the narration around it: a quoted letter, log or message the book reproduces. */
  inset?: boolean;
  emphasis: string[];
}
export interface TextStage {
  sentences: Sentence[];
  seeds: string[];
  /** Uncompressed size of each spine item, zero when non-linear or missing: the weights of Foliate's reading percentage. */
  spineBytes?: number[];
}
export interface Mention {
  ordinal: number;
  alias: string;
  definition: boolean;
  introduced?: boolean;
  capitalized: boolean;
  person: boolean;
  place: boolean;
  nested: boolean;
  structural: boolean;
  noun?: boolean;
  proper?: boolean;
  functionWord?: boolean;
  modifier?: boolean;
  explicitDefinition?: boolean;
  forgiven?: boolean;
  determiner?: boolean;
  lowercase?: boolean;
  kindLabel?: number;
  kindAt?: number;
  cues?: number;
}
export interface Term {
  key: string;
  rarity: number;
  wordCount: number;
  candidateOrdinal?: number;
  // Ordinals live only in the delta array on disk, not duplicated in each feature row.
  deltas: number[];
  features: Omit<Mention, 'ordinal'>[];
}
export interface ModelVote {
  key: string;
  deltas: number[];
}
export interface Artifact extends TextStage {
  formatVersion: number;
  textVersion: number;
  termsVersion: number;
  fingerprint: string;
  terms: Term[];
  aliasLinks: AliasLink[];
  modelVotes?: ModelVote[];
  metadata?: BookMetadata;
}
export interface BookMetadata {
  titles: string[];
  authors: string[];
  /** dc:subject entries, the EPUB's own genre metadata. */
  subjects?: string[];
}
export interface VisibleTerm {
  key: string;
  displayName: string;
  aliases: string[];
  mentions: Mention[];
  first: number;
  latest: number;
  count: number;
  rarity: number;
  wordCount: number;
  type: 'person' | 'place' | 'concept';
}
export interface AliasLink {
  left: string;
  right: string;
  ordinal: number;
  untilOrdinal?: number;
}
