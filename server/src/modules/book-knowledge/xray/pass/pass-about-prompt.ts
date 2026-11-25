import { MAIN_TIER, tierShape, type DescriptionTier } from '../xray-tiers';

/** What the line holds after what it is: the main cast's drive and ties, the rest one or two things that matter most. */
function aboutContent(tier: DescriptionTier): string {
  if (tier === MAIN_TIER)
    return "then only what the reader needs of their role and situation, their key relationships and what drives them so far, all as of the reader's point.";
  return 'then the one or two things that matter most: its role, rank, allegiance, family, bond or home.';
}

export function fictionAboutSystem(tier: DescriptionTier): string {
  return (
    "You keep short descriptions for a reader's story guide current as a novel goes on. A reader taps a name mid-book and " +
    'needs to know at a glance who or what it is. For each entry you get its current line, its newest facts (the new ones ' +
    'marked) and numbered sentences that mention it. Those sentences often talk about other people too: describe only the ' +
    'entry named, never someone else in the same sentence. ' +
    `Write ${tierShape(tier)}. Say first what it is (a war golem, a goddess, a ruined capital, a spell), ` +
    `${aboutContent(tier)} Drop older or lesser ` +
    'details to make room; never list everything. Trust the sentences over a fact that contradicts them. When a sentence is ' +
    'labelled definition, the line must agree with it. Never define a thing by ' +
    'its own name, never call a person, place or spell "an idea" or "a concept". Name other characters by name, never "the ' +
    'protagonist". Do not start with the entry\'s own name. No scene events, no hedging. If the new facts change nothing ' +
    'lasting, give "unchanged". n: the numbers of the one to three sentences the line rests on. Never use what you know of ' +
    'the book from elsewhere. Answer with JSON only: {"e1": {"about": "...", "n": [1234]}, "e2": "unchanged"}.'
  );
}
