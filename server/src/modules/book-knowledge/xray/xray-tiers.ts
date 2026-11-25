import type { BookKnowledgeXrayMode } from '@bookorbit/types';

/** Every description is held to one hard cap; the tier only sets how long the prompt asks it to be. */
export const DESCRIPTION_LIMIT = 100;

/** `aim`: the length the prompt asks for. `limit`: the cap the checks enforce and the output tokens leave room for. */
export interface DescriptionTier {
  name: 'main' | 'supporting' | 'minor';
  aim: number;
  limit: number;
  sentences: string;
}

export const MAIN_TIER: DescriptionTier = { name: 'main', aim: 50, limit: DESCRIPTION_LIMIT, sentences: 'two or three sentences' };
export const SUPPORTING_TIER: DescriptionTier = { name: 'supporting', aim: 30, limit: DESCRIPTION_LIMIT, sentences: 'one or two sentences' };
export const MINOR_TIER: DescriptionTier = { name: 'minor', aim: 20, limit: DESCRIPTION_LIMIT, sentences: 'one sentence' };
export const DESCRIPTION_TIERS: readonly DescriptionTier[] = [MAIN_TIER, SUPPORTING_TIER, MINOR_TIER];

/** Output tokens one description takes in a JSON reply: about two a word, plus its key and cites. */
export const descriptionTokens = (tier: DescriptionTier) => 2 * tier.limit + 20;

/** The tier for `rankImportance`'s importance; a nonfiction term outside the main ones still needs room for whose view it is. */
export function descriptionTier(importance: number, mode: BookKnowledgeXrayMode): DescriptionTier {
  if (importance <= 1) return MAIN_TIER;
  if (importance === 2 || mode === 'nonfiction') return SUPPORTING_TIER;
  return MINOR_TIER;
}

/** The length ask every description prompt carries. */
export function tierShape(tier: DescriptionTier): string {
  return (
    'just enough for a reader to know who or what this is and why it matters so far: short and succinct, ' +
    `usually about ${tier.aim} words (${tier.sentences}), never more than ${tier.limit}; no padding, no list of every event`
  );
}

/** A member not yet joined is described under its own name, so its own importance sets the tier. */
export function slotTier(
  slot: { head: { importance: number }; member: { importance: number } | null },
  mode: BookKnowledgeXrayMode,
): DescriptionTier {
  return descriptionTier((slot.member ?? slot.head).importance, mode);
}
