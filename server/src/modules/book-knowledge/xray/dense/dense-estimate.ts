import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import { KIND_REVIEW_SYSTEM, type KindReviewBatch } from '../../core/kind-review';
import type { Sentence } from '../../core/model';
import type { XrayEntity } from '../xray-entities';
import type { PlannedCall } from '../xray-plan';
import { cloned } from '../pass/pass-run';
import { PassCast, patternMerges } from '../pass/pass-cast';
import { type PassUnit } from '../pass/pass-units';
import { denseChunks, numberedText } from './dense-chunks';
import { aliasCandidates, ALIAS_GROUPS_PER_CALL } from './dense-alias';
import { sceneRoster } from './dense-scene';
import { DESCRIBE_BATCH, DESCRIBE_SENTENCES } from './dense-describe';
import { descriptionTier, DESCRIPTION_TIERS } from '../xray-tiers';
import { factsUser, notesUser, readSystem, sceneUser } from './dense-prompt';

/** A dry run's stand-ins for what only a real run has (retries left out), guesses until a run measures them. */
const PREVIOUS_CHARS = 600;
const ABOUT_CALLS_PER_UNIT = 0.5;
const ABOUT_PROMPT_CHARS = 4000;
/** A group shown to the alias ask: a head and about one candidate, three sentences each. */
const ALIAS_GROUP_CHARS = 1000;
const SENTENCE_CHARS = 120;

/** Every call a dense run would make, as prompt sizes, for the dry-run estimate. */
export function densePlannedCalls(
  reviews: readonly Pick<KindReviewBatch, 'user'>[],
  units: readonly PassUnit[],
  entities: readonly XrayEntity[],
  sentences: readonly Sentence[],
  mode: BookKnowledgeXrayMode,
): PlannedCall[] {
  const copies = cloned(entities);
  const cast = new PassCast(copies);
  for (const merge of patternMerges(copies, sentences, { guard: true })) cast.merge(merge);
  const calls: PlannedCall[] = reviews.map((batch) => ({ step: 'kinds', promptCharacters: KIND_REVIEW_SYSTEM.length + batch.user.length }));
  const empty = { about: new Map(), abilities: new Map(), previous: null };
  for (const unit of units)
    for (const chunk of denseChunks(sentences, unit)) {
      const slots = cast.slots(unit, chunk.ordinals);
      const text = numberedText(sentences, chunk.ordinals);
      const notes = readSystem(mode).length + notesUser(text, slots, empty, mode).length + PREVIOUS_CHARS;
      const facts = readSystem(mode).length + factsUser(text, slots, empty, mode).length;
      calls.push({ step: 'notes', promptCharacters: notes }, { step: 'facts', promptCharacters: facts });
      const roster = sceneRoster(cast, chunk, mode);
      calls.push({ step: 'ties', promptCharacters: readSystem(mode).length + sceneUser(text, roster, empty.about, mode).length });
    }
  const candidates = aliasCandidates(cast, sentences, mode);
  const groups = new Set(candidates.map((candidate) => candidate.head)).size;
  for (let index = 0; index < Math.ceil(groups / ALIAS_GROUPS_PER_CALL); index++)
    calls.push({ step: 'alias', promptCharacters: ALIAS_GROUPS_PER_CALL * ALIAS_GROUP_CHARS });
  // At most every head falls through to the describe step, batched within its tier; most get an `is` phrase or a gloss instead.
  for (const tier of DESCRIPTION_TIERS) {
    const heads = cast.heads.filter((head) => descriptionTier(head.importance, mode) === tier).length;
    for (let index = 0; index < Math.ceil(heads / DESCRIBE_BATCH); index++)
      calls.push({ step: 'describe', promptCharacters: DESCRIBE_BATCH * DESCRIBE_SENTENCES * SENTENCE_CHARS });
  }
  for (let index = 0; index < Math.round(units.length * ABOUT_CALLS_PER_UNIT); index++)
    calls.push({ step: 'about', promptCharacters: ABOUT_PROMPT_CHARS });
  return calls;
}
