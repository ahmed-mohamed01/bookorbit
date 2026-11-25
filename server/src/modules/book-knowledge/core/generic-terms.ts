import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import { wordRarity } from './common-words';

/** Closed-class and all-purpose words the term ranking can surface in lowercase; never an entity of their own. */
const GENERIC_WORDS = new Set(
  (
    'one two three four five six seven eight nine ten hundred thousand million billion first second third last next such many much ' +
    'other another same own each every few several most more less all any some none both either neither may might must can could would ' +
    'should shall will yes not very just also still even well way thing things something anything nothing everything someone anyone ' +
    'everyone find want get make take give know think see say go come possible better best good great new old example case point reason ' +
    'part kind sort lot form fact sense level number time times place use'
  ).split(' '),
);

/** Swearing and interjections a novel's dialogue repeats; never an entry. */
const FICTION_EXCLAMATIONS = new Set('fuck fucking fucked shit shitty damn damned crap hell bloody ugh huh hmm wow'.split(' '));

/** SCOWL level 35 and commoner: an everyday noun ("tent", "cloak") that a novel may use but a reader rarely looks up. */
const FICTION_EVERYDAY_RARITY = 0.35;

/** Whether a novel's lowercase one-word term is an everyday noun, ranked after the book's own things. */
export function isEverydayTerm(name: string, mode: BookKnowledgeXrayMode): boolean {
  return mode === 'fiction' && name === name.toLowerCase() && !/[\s-]/.test(name) && wordRarity(name) <= FICTION_EVERYDAY_RARITY;
}

/** SCOWL levels 10 and 20, about a zipf of 4 and up: everyday English, never a novel's own thing in lowercase. */
const FICTION_COMMON_RARITY = 0.1;

/**
 * A lowercase term that is no name. Closed-class and all-purpose words always are. In a novel, so is a
 * term every word of which is common English ("world", "front door"), while coined words ("necrarchs",
 * "skinsuit") stay. In nonfiction, where a concept is often a common word, only a single word among the
 * most common counts. Capitalised names never do.
 */
export function isGenericTerm(name: string, mode: BookKnowledgeXrayMode): boolean {
  if (name !== name.toLowerCase()) return false;
  if (mode === 'fiction' && FICTION_EXCLAMATIONS.has(name)) return true;
  if (mode === 'fiction') return name.split(/[\s-]+/).every((word) => GENERIC_WORDS.has(word) || wordRarity(word) <= FICTION_COMMON_RARITY);
  if (name.includes(' ')) return false;
  return GENERIC_WORDS.has(name) || wordRarity(name) === 0;
}
