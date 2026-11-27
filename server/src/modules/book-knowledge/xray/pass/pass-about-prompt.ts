import { MAIN_TIER, MINOR_TIER, tierShape, type DescriptionTier } from '../xray-tiers';
import {
  DESCRIPTION_PROSE,
  KIND_CONTENT,
  LASTING_ONLY,
  NARRATOR_GENDER_RULE,
  THOUGHT_DESCRIPTION,
  WRITTEN_TEXT_RULE,
  WRITTEN_VOICE_RULE,
} from '../xray-description-context';
import { EXACT_TERM_NAMES } from './pass-grounding';

function aboutContent(tier: DescriptionTier): string {
  const selection =
    tier === MAIN_TIER ? "then the details the reader needs as of the reader's point." : 'then the one or two details that matter most.';
  return `${selection} ${KIND_CONTENT} ${LASTING_ONLY}`;
}

export function fictionAboutSystem(tier: DescriptionTier): string {
  const core =
    tier === MINOR_TIER
      ? ''
      : 'Lines marked core say who they are in the story (where they come from, how they came to be here, their central bonds); never drop them to make room. ';
  const example =
    tier === MAIN_TIER
      ? 'For example: "A ship\'s cook from the coast who woke in a dead queen\'s body, Tavia now leads the river clans with the stone guardian Orrin at her side." '
      : '';
  return (
    "You keep short descriptions for a reader's story guide current as a novel goes on. A reader taps a name mid-book and " +
    'needs to know at a glance who or what it is. For each entry you get its current line, its newest facts (the new ones ' +
    'marked) and numbered sentences that mention it. Those sentences often talk about other people too: describe only the ' +
    'entry named, never someone else in the same sentence. ' +
    WRITTEN_VOICE_RULE +
    WRITTEN_TEXT_RULE +
    NARRATOR_GENDER_RULE +
    `Write ${tierShape(tier, 'fiction')}. ${DESCRIPTION_PROSE} ${example}` +
    'Say first what it is (a war golem, a goddess, a ruined capital, a spell), ' +
    `${aboutContent(tier)} Drop lesser details to make room. ${core}` +
    'Trust the sentences over a fact that contradicts them. When a sentence is ' +
    'labelled definition, the line must agree with it. Never define a thing by ' +
    'its own name, never call a person, place or spell "an idea" or "a concept". Name other characters by name, never "the ' +
    'protagonist". Do not start with the entry\'s own name. No hedging. ' +
    THOUGHT_DESCRIPTION +
    ' A current line that only tells how the entry first appeared is replaced once the sentences show what it is or does. ' +
    EXACT_TERM_NAMES +
    'If the new facts change nothing ' +
    'lasting, give "unchanged". n: the numbers of the one to three sentences the line rests on. Never use what you know of ' +
    'the book from elsewhere. Answer with JSON only: {"e1": {"about": "...", "n": [1234]}, "e2": "unchanged"}.'
  );
}
