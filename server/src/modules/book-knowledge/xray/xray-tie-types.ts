import { storyGuideTieType, type BookKnowledgeXrayMode, type StoryGuideEntityKind, type StoryGuideTieTypeInfo } from '@bookorbit/types';

/** What the checks and prompts need of a tie type, upstream's or the fork's. */
export type XrayTieType = Pick<StoryGuideTieTypeInfo, 'type' | 'symmetric' | 'from' | 'to' | 'label'>;

const CONCEPT: readonly StoryGuideEntityKind[] = ['idea', 'object', 'group', 'event'];
const ANY: readonly StoryGuideEntityKind[] = ['character', 'place', 'group', 'event', 'object', 'idea'];

/**
 * Tie types between a nonfiction book's terms, fork-owned: upstream's registry stays for fiction and
 * clients that do not know these show the label.
 */
export const CONCEPT_TIE_TYPES: readonly XrayTieType[] = [
  { type: 'part_of', symmetric: false, from: CONCEPT, to: CONCEPT, label: 'part of' },
  { type: 'example_of', symmetric: false, from: ANY, to: CONCEPT, label: 'an example of' },
  { type: 'kind_of', symmetric: false, from: CONCEPT, to: CONCEPT, label: 'a kind of' },
  { type: 'proposed_by', symmetric: false, from: CONCEPT, to: ['character', 'group'], label: 'proposed by' },
  { type: 'leads_to', symmetric: false, from: CONCEPT, to: CONCEPT, label: 'leads to' },
  { type: 'contrasts_with', symmetric: true, from: CONCEPT, to: CONCEPT, label: 'contrasts with' },
  { type: 'method_for', symmetric: false, from: CONCEPT, to: CONCEPT, label: 'a method for' },
];

const CONCEPT_BY_NAME = new Map(CONCEPT_TIE_TYPES.map((info) => [info.type, info]));

/** The tie type lookup for a mode: upstream's 19 for fiction, the concept types for nonfiction. */
export function tieTypes(mode: BookKnowledgeXrayMode): (type: string) => XrayTieType | undefined {
  return mode === 'nonfiction' ? (type) => CONCEPT_BY_NAME.get(type) : storyGuideTieType;
}

/** Either registry's entry, for labels on ties already checked. */
export function anyTieType(type: string): XrayTieType | undefined {
  return storyGuideTieType(type) ?? CONCEPT_BY_NAME.get(type);
}
