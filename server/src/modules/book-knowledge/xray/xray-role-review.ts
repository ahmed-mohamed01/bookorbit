import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import { escapeRegExp, WORD_EDGE } from '../../story-guides/pipeline/name-text';
import { parseReviewChoices, parseReviewJson, type KindReviewBatch } from '../core/kind-review';
import type { Artifact } from '../core/model';
import { NARRATOR_ID } from './pass/pass-cast';
import type { XrayEntity } from './xray-entities';

export const ROLE_REVIEW_LIMIT = 600;
/** The mean batch size: a batch closes after an entry whose key hashes to a boundary, so one changed entry moves only its own batch. */
export const ROLE_REVIEW_BATCH = 12;
/** A run of keys with no boundary is cut here, so a batch stays within the reply limit. */
export const ROLE_REVIEW_BATCH_MAX = ROLE_REVIEW_BATCH * 2;
/** More of the votes missing than this, after retries, and the build fails: the judge would otherwise be off without a word. */
export const ROLE_MISSING_VOTES_FLOOR = 1 / 3;
/** Names of other entries shown beside one batch, at most. */
const ROLE_RELATED_NAMES = 40;
export const ROLE_REVIEW_VOTES = 3;
/** Votes asked again for an entry left on the edge: two junk of three, or a character judged junk by all three. */
export const ROLE_ESCALATION_VOTES = 2;
/** The dry-run estimate's guess at the share of batches that hold an escalated entry. */
export const ROLE_ESCALATION_SHARE = 0.25;
const MINOR_VOTES = 2;
// The votes only differ when sampling varies; the bench that set the vote rules ran at 0.7.
export const ROLE_REVIEW_TEMPERATURE = 0.7;
export const ROLE_PASSAGES = 5;
export const ROLE_PASSAGE_CHARS = 320;
export const EVERYDAY_OBJECT_REVIEW_VERSION = 7;
export const NONFICTION_ROLE_REVIEW_VERSION = 1;

export const ROLE_ANSWERS = ['keep', 'minor', 'junk'] as const;
export type RoleAnswer = (typeof ROLE_ANSWERS)[number];

export const EVERYDAY_OBJECT_REVIEW_SYSTEM = `You decide which candidate entries belong in a reader's X-Ray for a novel: the list of people, places, groups, things and ideas a reader may want to look up.

Label each entry:
- "keep": a person or creature who appears, acts or is talked about as someone in the story, a group, ship, named place, or a thing or idea with a name or meaning particular to this story (an invented substance, a named device, a named project), or a real place, organisation or person that the story actually uses: something happens there, they act, or the plot depends on them.
- "minor": real and named, but barely used: a side character in one scene or one who is only talked about once or twice, a real place where a short scene happens, a real organisation that does one thing, a named but small item.
- "junk": an ordinary word in its ordinary sense: everyday gear, medical kit, a body part, an illness or condition, a unit, a common chemical used as itself, part of a room or vehicle, a console, screen or panel, a numbered tank or room, a common verb, adjective, sound or fragment, a bare generic noun, a generic phrase. Also junk:
  - a real place, brand, product, website or famous name only mentioned in talk, a comparison or a joke, where nothing happens and no one acts;
  - a name used only as an exclamation, oath or figure of speech, never as someone who appears or is talked about;
  - two different things fused into one entry ("A and B");
  - an author or front-matter name.

Judge by how the passages use the name, never by the words inside it: titles can be built from ordinary words. If one scene turns on an ordinary object, it is still junk unless the story gives it a name or meaning of its own. A word the story uses as part of its own system (a stat, skill, class, rank, spell or power) is keep, even when it is an ordinary word elsewhere. Another entry that names the same thing is not a reason for junk: label each entry on its own.

Invented examples: "the lamp" someone relights each night is junk; "the Ember Lamp" that wakes the dead is keep. A nurse checking "the ECG" is junk. "Bay Two" and "the helm screen" are junk. "Quill and Bram" as one entry is junk. "Focus" as a stat a character raises is keep; "focus" meaning to concentrate is junk. A character saying a plan is "like Venice" is junk; a chase through Venice is minor or keep. "Stars" said only as "Stars above, that hurt!" is junk; a goddess of the stars whom a priest prays to and fears is keep.

Answer with JSON only: {"<id>": "keep" | "minor" | "junk", ...} for every id given.`;

export const NONFICTION_ROLE_REVIEW_SYSTEM = `You decide which candidate entries belong in a reader's X-Ray for a nonfiction book: the list of people, places, organisations, works, theories and ideas a reader may want to look up.

Label each entry:
- "keep": a term the book defines, explains, argues about or names as its own: a named theory, model, law, method or thought experiment, an organisation, project or event the book discusses, a person whose work or actions the book discusses, an invented or coined term, or a key concept the book is about.
- "minor": real and named, but used briefly: a person, place, organisation or work mentioned in passing, cited once or used as a quick example.
- "junk": an everyday word in its ordinary sense: a generic noun, verb or adjective (a goal, an outcome, a scenario, a method in general, a capacity), a unit, a number, a fragment of a phrase, a generic phrase. Also junk:
  - two different things fused into one entry ("A and B");
  - an author, publisher or front-matter name.

Judge by how the passages use the name, never by the words inside it: a theory or a coined term can be built from ordinary words. An ordinary word the book gives a special meaning of its own, defines or argues about is keep. Another entry that names the same thing is not a reason for junk: label each entry on its own.

Invented examples: "the Tidewater Paradox", which a chapter sets out and argues against, is keep. "Slow capital", a term the author coins and explains, is keep. "Kestrel Institute", whose studies the book discusses, is keep. A physicist quoted once in passing is minor. "Outcome" in "the outcome was better than expected" is junk. "Scenarios" in "in most scenarios this holds" is junk. "Marrow and Pike" as one entry is junk.

Answer with JSON only: {"<id>": "keep" | "minor" | "junk", ...} for every id given.`;

/** The judge's prompt for the build's mode. */
export function roleReviewSystem(mode: BookKnowledgeXrayMode): string {
  return mode === 'nonfiction' ? NONFICTION_ROLE_REVIEW_SYSTEM : EVERYDAY_OBJECT_REVIEW_SYSTEM;
}

export function roleReviewVersion(mode: BookKnowledgeXrayMode): number {
  return mode === 'nonfiction' ? NONFICTION_ROLE_REVIEW_VERSION : EVERYDAY_OBJECT_REVIEW_VERSION;
}

export interface RoleReviewCandidates {
  candidates: XrayEntity[];
  /** Candidates left out by the safety cap, the least mentioned first. */
  trimmed: number;
}

/**
 * Every entry but the narrator, capped by dropping the least mentioned; a character is removed only on unanimous junk.
 * Sorted by term key, which does not move when another entry comes or goes, unlike the positional prompt ids.
 */
export function roleReviewCandidates(entities: readonly XrayEntity[]): RoleReviewCandidates {
  const candidates = entities.filter(({ id }) => id !== NARRATOR_ID);
  const byKey = (a: XrayEntity, b: XrayEntity) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const trimmed = Math.max(0, candidates.length - ROLE_REVIEW_LIMIT);
  if (trimmed) {
    candidates.sort((a, b) => b.count - a.count || byKey(a, b));
    candidates.length = ROLE_REVIEW_LIMIT;
  }
  return { candidates: candidates.sort(byKey), trimmed };
}

/** Splits key-sorted candidates where a key hashes to a boundary, so adding or removing one entry changes one batch. */
export function roleReviewGroups<T extends { key: string }>(candidates: readonly T[]): T[][] {
  const groups: T[][] = [];
  let group: T[] = [];
  for (const candidate of candidates) {
    group.push(candidate);
    if (keyHash(candidate.key) % ROLE_REVIEW_BATCH === 0 || group.length >= ROLE_REVIEW_BATCH_MAX) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

/** FNV-1a: stable across runs and machines, which is all the batch boundaries need. */
function keyHash(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0;
  return hash;
}

/** The entry's body sentences through the cut, preferring those that name it, spread evenly over the book. */
export function rolePassageOrdinals(artifact: Artifact, entity: XrayEntity, through: number): number[] {
  const body = entity.ordinals.filter((ordinal) => ordinal <= through && artifact.sentences[ordinal - 1]?.structure === 'body');
  const pattern = namePattern(entity, through);
  const naming = body.filter((ordinal) => pattern.test(artifact.sentences[ordinal - 1].text));
  return spread(naming.length ? naming : body, ROLE_PASSAGES);
}

export function rolePassage(text: string, pattern: RegExp): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= ROLE_PASSAGE_CHARS) return flat;
  const window = ROLE_PASSAGE_CHARS - 6;
  const at = flat.search(pattern);
  const start = Math.max(0, Math.min(Math.max(0, at) - Math.floor(window / 3), flat.length - window));
  const end = start + window;
  return `${start > 0 ? '...' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '...' : ''}`;
}

export function roleReviewBatches(
  artifact: Artifact,
  candidates: readonly XrayEntity[],
  cast: readonly XrayEntity[],
  through: number,
): KindReviewBatch[] {
  if (!candidates.length) return [];
  const castNames = [...new Set(cast.map(({ name }) => name))].map((name) => ({ name, words: nameWords(name) }));
  const batches: KindReviewBatch[] = [];
  for (const entries of roleReviewGroups(candidates)) {
    const related = relatedNames(entries, castNames);
    const header = related.length ? `Other entries whose name contains or is part of a candidate's: ${related.join('; ')}\n\n` : '';
    const ordinals = new Set<number>();
    const lines = entries.flatMap((entity, index) => {
      const pattern = namePattern(entity, through);
      const passages = rolePassageOrdinals(artifact, entity, through);
      for (const ordinal of passages) ordinals.add(ordinal);
      const mentions = entity.ordinals.filter((ordinal) => ordinal <= through).length;
      return [
        `id e${index + 1} | ${entity.name} | ${mentions} sentences`,
        ...passages.map((ordinal) => `  - ${rolePassage(artifact.sentences[ordinal - 1].text, pattern)}`),
      ];
    });
    batches.push({
      keys: entries.map(({ key }) => key),
      user: `${header}Candidates:\n${lines.join('\n')}`,
      ordinals: [...ordinals].sort((a, b) => a - b),
    });
  }
  return batches;
}

/**
 * Only the names that matter to a batch, those holding a candidate's name or held in it ("Quill" beside "Quill and
 * Bram"): a list of the whole cast would change every batch's prompt whenever one entry changed.
 */
function relatedNames(entries: readonly XrayEntity[], cast: readonly { name: string; words: string }[]): string[] {
  const own = new Set(entries.map(({ name }) => name));
  const words = entries.map(({ name }) => nameWords(name)).filter(Boolean);
  const related = cast
    .filter(({ name, words: other }) => other && !own.has(name) && words.some((mine) => other.includes(mine) || mine.includes(other)))
    .map(({ name }) => name);
  return related.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).slice(0, ROLE_RELATED_NAMES);
}

/** The name's words, lower case and space-padded, so `includes` matches whole words only. */
function nameWords(name: string): string {
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.length ? ` ${words.join(' ')} ` : '';
}

/** The share of votes asked that came back without an answer for their entry, over every sample of every batch. */
export function missingRoleVoteShare(
  rounds: readonly { keys: readonly string[]; samples: readonly (ReadonlyMap<string, RoleAnswer> | null)[] }[],
): number {
  let asked = 0;
  let missing = 0;
  for (const { keys, samples } of rounds)
    for (const sample of samples) {
      asked += keys.length;
      missing += keys.filter((key) => !sample?.has(key)).length;
    }
  return asked ? missing / asked : 0;
}

export function parseRoleAnswers(raw: string, keys: readonly string[]): Map<string, RoleAnswer> | undefined {
  return parseReviewChoices(parseRoleReply(raw), keys, ROLE_ANSWERS);
}

export function parseRoleReply(raw: string): Record<string, unknown> | undefined {
  return parseReviewJson(raw, false);
}

export interface RoleVotes {
  removed: Set<string>;
  minor: Set<string>;
  /** Entries left on the edge, decided once `ROLE_ESCALATION_VOTES` more votes are in. */
  escalate: Set<string>;
}

/**
 * Three junk of three removes an entry and two send it to `ROLE_ESCALATION_VOTES` more votes, after which it goes only
 * when those are junk too (four of five). A character (`strict`) goes only when every vote is junk: three of three
 * escalate it, and it goes at five of five. An answer that never came counts as keeping it.
 */
export function tallyRoleVotes(
  keys: readonly string[],
  samples: readonly (ReadonlyMap<string, RoleAnswer> | null)[],
  strict: ReadonlySet<string> = new Set(),
  extra: ReadonlyMap<string, readonly (ReadonlyMap<string, RoleAnswer> | null)[]> = new Map(),
): RoleVotes {
  const removed = new Set<string>();
  const minor = new Set<string>();
  const escalate = new Set<string>();
  for (const key of keys) {
    const more = extra.get(key);
    const votes = [...samples, ...(more ?? [])].map((sample) => sample?.get(key));
    const junk = votes.filter((vote) => vote === 'junk').length;
    const unanimous = strict.has(key);
    const edge = unanimous ? votes.length : votes.length - 1;
    if (junk && more && junk >= edge) removed.add(key);
    else if (junk && !more && !unanimous && junk === votes.length) removed.add(key);
    else if (junk && !more && junk >= edge) escalate.add(key);
    if (!removed.has(key) && !escalate.has(key) && votes.filter((vote) => vote === 'minor').length >= MINOR_VOTES) minor.add(key);
  }
  return { removed, minor, escalate };
}

function namePattern(entity: XrayEntity, through: number): RegExp {
  const names = [entity.name, ...entity.names.filter(({ ordinal }) => ordinal <= through).map(({ text }) => text)];
  const alternatives = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`${WORD_EDGE}(?:${alternatives.join('|')})${WORD_EDGE}`, 'iu');
}

function spread(ordinals: readonly number[], limit: number): number[] {
  if (ordinals.length <= limit) return [...ordinals];
  return Array.from({ length: limit }, (_, index) => ordinals[Math.round((index * (ordinals.length - 1)) / (limit - 1))]);
}
