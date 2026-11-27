import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import { wordRarity } from './common-words';
import { normalizeLast, words } from './text-utils';

export function isDictionaryTerm(name: string): boolean {
  const parts = words(name).flatMap((word) => word.split('-'));
  return parts.length > 0 && parts.every((word) => wordRarity(word) < 1 || wordRarity(normalizeLast(word)) < 1);
}

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
const FICTION_EXCLAMATIONS = new Set(
  (
    'fuck fucking fucked fucker fuckers motherfucker motherfuckers shit shits shitty shithead shitheads bullshit damn damned goddamn ' +
    'goddamned crap hell bloody ugh huh hmm wow ass asses asshole assholes arse arsehole arseholes jackass dumbass bastard bastards ' +
    'bitch bitches bitching dick dicks dickhead dickheads prick pricks piss pissed cunt cunts wanker wankers bollocks twat twats ' +
    'alright okay yeah yep nope uh um erm dude bro dang darn heck whoa gosh geez jeez yikes oops phew'
  ).split(' '),
);

/**
 * A novel's swear word or interjection, written in lowercase: never an entry, whatever the kind review answered.
 * A capitalised one ("Dick", "the Bastard") may be a name, so it is left to the review.
 */
export function isExclamationTerm(name: string, mode: BookKnowledgeXrayMode): boolean {
  // A drawn-out sound ("errr", "aaah") is an interjection however it is spelled.
  return mode === 'fiction' && (FICTION_EXCLAMATIONS.has(name) || /^\p{Ll}*(\p{Ll})\1\1\p{Ll}*$/u.test(name));
}

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
  if (isExclamationTerm(name, mode)) return true;
  if (mode === 'fiction') return name.split(/[\s-]+/).every((word) => GENERIC_WORDS.has(word) || wordRarity(word) <= FICTION_COMMON_RARITY);
  if (name.includes(' ')) return false;
  return GENERIC_WORDS.has(name) || wordRarity(name) === 0;
}

/** Units of measure: a novel's numbers, never its things. */
const UNITS = new Set(
  (
    'millimeter centimeter meter kilometer millimetre centimetre metre kilometre inch foot feet yard mile gram milligram kilogram ' +
    'tonne ton pound ounce liter litre milliliter millilitre gallon second minute hour day week month year decade century ' +
    'millisecond microsecond nanosecond degree kelvin celsius fahrenheit percent newton joule watt kilowatt megawatt volt amp ampere ' +
    'hertz kilohertz megahertz gigahertz calorie kilocalorie lightyear parsec'
  ).split(' '),
);

/** Peoples and nationalities as a word ("Canadian", "the Russians"): a description of someone, never a cast entry of its own in a novel. */
const NATIONALITIES = new Set(
  (
    'american canadian mexican brazilian argentinian chilean peruvian colombian cuban british english scottish welsh irish french ' +
    'german dutch belgian swiss austrian italian spanish portuguese greek swedish norwegian danish finnish icelandic polish czech ' +
    'hungarian romanian bulgarian serbian croatian ukrainian russian belarusian turkish israeli arab arabian egyptian iranian iraqi ' +
    'saudi syrian lebanese afghan pakistani indian bangladeshi nepalese chinese japanese korean vietnamese thai filipino indonesian ' +
    'malaysian australian african nigerian kenyan ethiopian ghanaian european asian soviet'
  ).split(' '),
);

/** A lowercase unit of measure ("kilometers", "kilograms") in a novel. */
export function isUnitTerm(name: string, mode: BookKnowledgeXrayMode): boolean {
  if (mode !== 'fiction' || name !== name.toLowerCase() || /\s/.test(name)) return false;
  return UNITS.has(name) || UNITS.has(name.replace(/e?s$/, '')) || UNITS.has(name.replace(/s$/, ''));
}

/** A one-word nationality or people ("Canadian", "Russians") in a novel. */
export function isNationalityTerm(name: string, mode: BookKnowledgeXrayMode): boolean {
  if (mode !== 'fiction' || /\s/.test(name)) return false;
  const word = name.toLowerCase();
  return NATIONALITIES.has(word) || NATIONALITIES.has(word.replace(/s$/, ''));
}
