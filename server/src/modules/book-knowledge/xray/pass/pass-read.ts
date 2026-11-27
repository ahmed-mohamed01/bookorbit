import { WORD_EDGE } from '../../../story-guides/pipeline/name-text';
import type { StoryGuideChronicleAbilityGroup } from '@bookorbit/types';
import type { PassSlot } from './pass-cast';

export const NARRATOR_PHRASE = new RegExp(`${WORD_EDGE}the narrator${WORD_EDGE}`, 'iu');

/** A fact that says nothing: "Viv is a character." */
export const EMPTY_FACT = /^[^.]{0,40}\b(?:is|was) an? (?:character|person|name|entity|term|concept)\.?$/i;
/** A line that opens by naming its own category ("An idea describing", "A character named") instead of saying what it is. */
export const SELF_LABEL =
  /^(?:an?\s+)?(?:idea|concept|notion|term|character|entity)\s+(?:named|called|describing|indicating|expressing|expressed|representing|referring|related|relating|that|which|of)\b/i;

/** Upstream's hedge check looks for "or"; the brief adds these. */
export const HEDGES = /\b(?:possibly|perhaps|likely|may be|seems?|seemingly|apparently)\b/i;

export interface PassNote {
  slot: PassSlot;
  note: string | null;
  /** The sentence it happens in, or null to point at the unit's start. */
  at: number | null;
}
export interface PassFact {
  slot: PassSlot;
  text: string;
  cite: number;
  /** A standing that changes (where they live, who they serve, what they are now): feeds `now`, not `about`. */
  status?: boolean;
}
export interface PassAbility {
  slot: PassSlot;
  change: 'gained' | 'changed' | 'lost';
  group: StoryGuideChronicleAbilityGroup;
  name: string;
  detail: string | null;
  cite: number;
}
export interface PassTie {
  a: PassSlot;
  b: PassSlot;
  type: string;
  sentence: string;
  cite: number;
}
export interface PassMergeProposal {
  a: PassSlot;
  b: PassSlot;
  cite: number;
}
export interface PassFailure {
  field: 'notes' | 'identity' | 'ties' | 'summary';
  id: string;
  text: string;
  detail: string;
}
export interface PassAnswer {
  notes: PassNote[];
  facts: PassFact[];
  abilities: PassAbility[];
  ties: PassTie[];
  merges: PassMergeProposal[];
  /** null when the summary failed a check. */
  summary: string | null;
  failed: PassFailure[];
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item): Record<string, unknown>[] => {
        const found = record(item);
        return found ? [found] : [];
      })
    : [];
}

/** A model writing "no answer" as text instead of JSON null: "Null", "None", "N/A". */
const NO_ANSWER = /^(?:null|none|nil|n\/a|undefined)\.?$/i;

export const noAnswer = (value: string): boolean => NO_ANSWER.test(value.trim());

/** A model's text field, flattened; a written-out null is no text. */
export function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return noAnswer(flat) ? '' : flat;
}

export const words = (value: string) => value.split(/\s+/).filter(Boolean).length;
