import type { StoryLineDropReason } from '../../story-guides/pipeline/story-guide.types';
import type { XrayEntity } from './xray-entities';

export type Rejections = Record<string, number>;

export interface CheckedTie {
  a: XrayEntity;
  type: string;
  b: XrayEntity;
  cite: number;
}

export interface CheckedLine {
  entity: XrayEntity;
  text: string;
  cites: number[];
  /** The last sentence the line was written from, where it becomes visible. */
  through: number;
  /** Set when the line broke a line rule; it gets one rewrite before it is dropped. */
  problem?: { reason: StoryLineDropReason; detail: string };
}

/** A line rule check: why a line fails, or null. */
export type LineCheck = (line: string) => { reason: StoryLineDropReason; detail: string } | null;

export interface CheckedFact {
  entity: XrayEntity;
  text: string;
  cite: number;
}

/** A unit's checked items, or null when the reply has no list to read (the unit is then retried). */
export type Read<T> = (answer: unknown) => { items: T; rejected: Rejections } | null;

const MALE = /\b(?:he|him|his|himself|man|men|boy|male|son|brother|father|husband|king|lord|sir|mr|nephew|uncle|grandfather|prince)\b/i;
const FEMALE =
  /\b(?:she|her|hers|herself|woman|women|girl|female|daughter|sister|mother|wife|queen|lady|mrs|ms|miss|niece|aunt|grandmother|princess)\b/i;

/** Whether `text` gives a gender that none of the sentences it was written from gives: a guess from a name. */
export function guessesGender(text: string, sources: readonly string[]): boolean {
  const said = sources.join(' ');
  return (MALE.test(text) && !MALE.test(said)) || (FEMALE.test(text) && !FEMALE.test(said));
}
