import { COLLECTIVE } from './dense-collective';
import { CLASSIFY_TEMPERATURE } from '../../book-knowledge-model.service';
import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import { escapeRegExp } from '../../../story-guides/pipeline/name-text';
import type { Sentence } from '../../core/model';
import type { Rejections } from '../xray-checks';
import type { XrayEntity } from '../xray-entities';
import type { XrayStepRun } from '../xray-runner';
import { namedFirst, RANKS, type PassCast } from '../pass/pass-cast';
import { record } from '../pass/pass-read';
import type { Ask } from '../pass/pass-run';
import { citesIn } from './dense-chunks';
import { PLACE_NOUNS } from '../../core/kind-review';
import { stopListed, type IdentityEvidence } from './dense-identity';
import { isJoinedPart } from '../xray-name-fold';

export type AliasReason = 'token' | 'spelling' | 'epithet' | 'dialogue' | 'evidence';

export interface AliasCandidate {
  head: XrayEntity;
  member: XrayEntity;
  reason: AliasReason;
}

/** Groups (a head and its candidates) per alias call. */
export const ALIAS_GROUPS_PER_CALL = 15;
const ALIAS_SENTENCES = 3;
const ALIAS_MAX_OUTPUT_TOKENS = 2500;
const MAX_CANDIDATES = 150;
/** An epithet ("the golem") shares at least this share of its paragraphs with one name. */
const EPITHET_SHARE = 0.5;
/**
 * An epithet's paragraphs must hold its name this many times more often than the book's paragraphs do: a lead in
 * most paragraphs shares half of anyone's, which drew "dragonette" and "trio" to the protagonist.
 */
const EPITHET_LIFT = 2;
/** A name said mostly in dialogue (a nickname) is offered to the main names it shares paragraphs with. */
const DIALOGUE_SHARE = 0.6;
const DIALOGUE_PARTNERS = 2;

const words = (name: string) =>
  name
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);
const capitalised = (name: string) => /^\p{Lu}/u.test(name);
const POSSESSED_SHARE = 1 / 3;
const SPELLING_RATIO = 3;
/** Below this many mentions a one-letter slip or swapped pair is a misspelling however the two counts compare. */
const SLIP_MENTIONS = 10;
const NONFICTION_TOKEN_KINDS = new Set<XrayEntity['kind']>(['character', 'place', 'group']);
const SITE_NOUNS = new Set([...PLACE_NOUNS, 'airport', 'station', 'port', 'harbour', 'harbor', 'hall', 'house', 'castle', 'market', 'mine']);

const collective = (entity: XrayEntity) => entity.kind === 'group' || COLLECTIVE.test(entity.name);

/** Edit distance with swaps of two neighbours counted once (Niyl and Nyil are one apart). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** Whether the sentence names `name` inside quotation marks. */
function quoted(text: string, name: string): boolean {
  const lower = name.toLowerCase();
  return [...text.matchAll(/[“"]([^”"]*)[”"]?/g)].some((match) => match[1].toLowerCase().includes(lower));
}

/** "her cloak", "his sword": a word the text mostly uses as someone's possession is a thing they have, not what others call them. */
function possessed(epithet: XrayEntity, sentences: readonly Sentence[]): boolean {
  const owned = new RegExp(`\\b(?:her|his|their|my|your|its|our)\\s+(?:\\p{L}+\\s+)?${escapeRegExp(epithet.name)}\\b`, 'iu');
  const shown = epithet.ordinals.filter((ordinal) => owned.test(sentences[ordinal - 1]?.text ?? '')).length;
  return shown >= POSSESSED_SHARE * epithet.ordinals.length;
}

/**
 * Pairs that may be one referent, found by code before the alias ask: one name's words inside the
 * other's ("Empire" and "Old Empire", "Mopti" and "Mopti Airport"), two capitalised spellings at most
 * two edits apart with the same first letter (Niyl and Nyil), a lowercase epithet that mostly sits in
 * one name's paragraphs ("the golem" and Solfis), and a name said mostly in dialogue offered to the main
 * names around it (a nickname). The one with more mentions heads each pair.
 */
export function aliasCandidates(
  cast: PassCast,
  sentences: readonly Sentence[],
  mode: BookKnowledgeXrayMode = 'fiction',
  evidence: readonly IdentityEvidence[] = [],
): AliasCandidate[] {
  const heads = cast.heads;
  const paragraphs = paragraphsOf(heads, sentences);
  const found = new Map<string, AliasCandidate>();
  const offer = (x: XrayEntity, y: XrayEntity, reason: AliasReason) => {
    if (collective(x) || collective(y)) return;
    // A misspelling's kind comes from few mentions, so it may disagree with the name it misspells; a sentence saying two names are one may too.
    // "fort" and Fort Stone: the review may type the bare word an idea; the alias ask decides.
    const bareWord = reason === 'token' && capitalised(x.name) !== capitalised(y.name);
    if (x === y || cast.headOf(x) === cast.headOf(y) || (!['epithet', 'spelling', 'evidence'].includes(reason) && !bareWord && x.kind !== y.kind))
      return;
    // A nonfiction term inside a longer one is a broader or narrower idea ("Revolution", "Industrial Revolution"), not another name.
    if (mode === 'nonfiction' && reason === 'token' && !NONFICTION_TOKEN_KINDS.has(x.kind)) return;
    let [member, head] = x.count < y.count || (x.count === y.count && x.first > y.first) ? [x, y] : [y, x];
    // "Necrarch millipede" is the name a reader looks up; "millipede" is how the text later calls it.
    if (reason === 'token' && !capitalised(head.name) && capitalised(member.name)) [member, head] = [head, member];
    const key = `${member.key}|${head.key}`;
    if (!found.has(key)) found.set(key, { head, member, reason });
  };
  for (const item of evidence) offer(cast.headOf(item.a), cast.headOf(item.b), 'evidence');
  /** Offers `a` and `b` when one name sits inside the other, or one misspells the other; true when it offered. */
  const offerByName = (a: XrayEntity, b: XrayEntity, aName: string, bName: string): boolean => {
    const before = found.size;
    if (isJoinedPart(aName, bName) || isJoinedPart(bName, aName)) return false;
    const [x, y] = [words(aName), words(bName)];
    const inside = (small: string[], big: string[]) => small.length < big.length && small.every((word) => big.includes(word) && word.length > 2);
    // "Mopti Airport" and "Cassian spring" are places at or named after the shorter name, not other names for it.
    const placeAt = (small: string[], big: string[]) => big.some((word) => !small.includes(word) && SITE_NOUNS.has(word));
    if ((capitalised(aName) || capitalised(bName)) && (inside(x, y) || inside(y, x))) {
      if (!placeAt(x.length < y.length ? x : y, x.length < y.length ? y : x)) offer(a, b, 'token');
    } else if (shortFor(a, b, aName, bName)) offer(a, b, 'token');
    else if (
      capitalised(aName) &&
      capitalised(bName) &&
      aName.length >= 4 &&
      bName.length >= 4 &&
      // Past six letters a first-letter slip is still one name (Bibiane, Viviane); the alias ask decides.
      (aName[0] === bName[0] || Math.min(aName.length, bName.length) >= 6) &&
      // A misspelling is rare beside the name it misspells; two names a letter or two apart used alike are two people.
      editDistance(aName.toLowerCase(), bName.toLowerCase()) <= 2 &&
      (Math.min(a.count, b.count) * SPELLING_RATIO <= Math.max(a.count, b.count) ||
        (Math.min(a.count, b.count) < SLIP_MENTIONS && slip(aName.toLowerCase(), bName.toLowerCase())) ||
        doubledLetter(aName.toLowerCase(), bName.toLowerCase()))
    )
      offer(a, b, 'spelling');
    return found.size > before;
  };
  // A name joined earlier still names its head: "Bob" is checked against Viv's "Princess Bob", "Bibiane" against her "Viviane".
  const namesOf = (entity: XrayEntity) => [entity.name, ...entity.joins.map((join) => join.name)];
  for (const [index, a] of heads.entries())
    for (const b of heads.slice(index + 1))
      if (!twoFullNames(a.name, b.name)) namesOf(a).some((aName) => namesOf(b).some((bName) => offerByName(a, b, aName, bName)));
  // Epithets and nicknames are a novel's; in nonfiction a capitalised hub ("AI") would draw every common word.
  if (mode === 'nonfiction') return capped(found);
  const named = heads.filter((entity) => capitalised(entity.name));
  for (const { epithet, matches } of epithetMatches(heads, paragraphs))
    if (!possessed(epithet, sentences)) offer(epithet, matches[0].name, 'epithet');
  const main = named.filter((entity) => entity.importance === 1 && entity.kind === 'character');
  // A name the book also gives in full ("Ryland Grace") is someone's own name, said in dialogue because a first-person narrator never says it.
  const fullName = (entity: XrayEntity) =>
    [entity.name, ...entity.joins.map((join) => join.name)].some((name) => words(name).length > 1 && /^\p{Lu}/u.test(name));
  for (const nickname of named.filter((entity) => entity.kind === 'character' && !fullName(entity))) {
    const said = nickname.ordinals.filter((ordinal) => quoted(sentences[ordinal - 1].text, nickname.name)).length;
    if (said < DIALOGUE_SHARE * nickname.ordinals.length) continue;
    const own = paragraphs.get(nickname)!;
    main
      .filter((other) => other !== nickname)
      .map((other) => ({ other, shared: [...own].filter((at) => paragraphs.get(other)!.has(at)).length }))
      .filter((pair) => pair.shared > 0)
      .sort((x, y) => y.shared - x.shared)
      .slice(0, DIALOGUE_PARTNERS)
      .forEach((pair) => offer(nickname, pair.other, 'dialogue'));
  }
  return capped(found);
}

/** The candidates within `MAX_CANDIDATES`: sentence evidence and misspellings first (rare by nature), then by member count. */
function capped(found: ReadonlyMap<string, AliasCandidate>): AliasCandidate[] {
  const first = (candidate: AliasCandidate) => (candidate.reason === 'evidence' || candidate.reason === 'spelling' ? 0 : 1);
  return [...found.values()].sort((x, y) => first(x) - first(y) || y.member.count - x.member.count).slice(0, MAX_CANDIDATES);
}

/** "Rob" and "Robert": one-word character names, one starting the other, which pattern merges left apart as a scene pair. */
function shortFor(a: XrayEntity, b: XrayEntity, aName: string, bName: string): boolean {
  if (a.kind !== 'character' || b.kind !== 'character' || !capitalised(aName) || !capitalised(bName)) return false;
  if (aName.includes(' ') || bName.includes(' ')) return false;
  const [short, long] = aName.length < bName.length ? [aName, bName] : [bName, aName];
  return short.length >= 3 && short !== long && long.startsWith(short);
}

/**
 * "John Marsh" and "Tavia Marsh": two full names sharing a word, each with a name word the other lacks, are two people
 * (a family), even once "Marsh" alone has joined one of them. A title word is no name word ("Lord Varn", "Varn Tallis").
 */
export function twoFullNames(a: string, b: string): boolean {
  const [x, y] = [a.split(/\s+/), b.split(/\s+/)];
  if (x.length < 2 || y.length < 2 || !x.some((word) => y.includes(word))) return false;
  const own = (mine: string[], theirs: string[]) =>
    mine.some((word) => capitalised(word) && !RANKS.has(word.toLowerCase()) && !theirs.includes(word));
  return own(x, y) && own(y, x);
}

function paragraphsOf(heads: readonly XrayEntity[], sentences: readonly Sentence[]): Map<XrayEntity, Set<string>> {
  const paragraph = (ordinal: number) => `${sentences[ordinal - 1].spineIndex}:${sentences[ordinal - 1].paragraphIndex}`;
  return new Map(heads.map((entity) => [entity, new Set(entity.ordinals.map(paragraph))]));
}

/** Each lowercase one-word epithet with the names it sits beside in at least half its paragraphs, well above chance; best lift first. */
function epithetMatches(heads: readonly XrayEntity[], paragraphs: ReadonlyMap<XrayEntity, Set<string>>) {
  const named = heads.filter((entity) => capitalised(entity.name));
  const total = new Set(heads.flatMap((entity) => [...paragraphs.get(entity)!])).size || 1;
  return heads
    .filter((entity) => !capitalised(entity.name) && !entity.name.includes(' ') && entity.kind !== 'idea')
    .map((epithet) => {
      const own = paragraphs.get(epithet)!;
      const matches = named
        .map((name) => {
          const shared = [...own].filter((at) => paragraphs.get(name)!.has(at)).length;
          return { name, shared, lift: shared / own.size / (paragraphs.get(name)!.size / total) };
        })
        .filter(({ shared, lift }) => shared >= EPITHET_SHARE * own.size && lift >= EPITHET_LIFT)
        .sort((x, y) => y.lift - x.lift);
      return { epithet, matches };
    })
    .filter(({ matches }) => matches.length > 0);
}

/**
 * Epithets code can fold without asking: "the dragonette" when exactly one named entity of its kind passes the epithet test.
 * A stop-listed noun or a possession ("her cloak") stays apart; more than one match goes to the alias ask. The fold takes
 * effect at a sentence that says the two are one when there is one, else where sharing paragraphs with the name becomes
 * the rule for good: an epithet that sits apart for chapters ("the assassin", unmasked later) folds after its last lone run.
 */
export function epithetFolds(
  cast: PassCast,
  sentences: readonly Sentence[],
  mode: BookKnowledgeXrayMode = 'fiction',
  evidence: readonly IdentityEvidence[] = [],
): AliasMerge[] {
  if (mode === 'nonfiction') return [];
  const folds: AliasMerge[] = [];
  const paragraphs = paragraphsOf(cast.heads, sentences);
  for (const { epithet, matches } of epithetMatches(cast.heads, paragraphs)) {
    const same = matches.filter(({ name }) => name.kind === epithet.kind);
    if (same.length !== 1 || collective(epithet) || collective(same[0].name) || stopListed(epithet) || possessed(epithet, sentences)) continue;
    const head = same[0].name;
    const stated = evidence
      .filter((item) => {
        const pair = new Set([cast.headOf(item.a), cast.headOf(item.b)]);
        return pair.size === 2 && pair.has(epithet) && pair.has(head);
      })
      .map((item) => item.ordinal);
    const ordinal = stated.length ? Math.min(...stated) : settledShare(epithet, head, sentences);
    folds.push({ member: epithet, head, ordinal: Math.max(ordinal, epithet.first), reason: 'epithet' });
  }
  return folds;
}

/** The sentence after which the epithet's running share of paragraphs with the name never again falls below `EPITHET_SHARE`. */
function settledShare(epithet: XrayEntity, head: XrayEntity, sentences: readonly Sentence[]): number {
  const paragraph = (ordinal: number) => `${sentences[ordinal - 1].spineIndex}:${sentences[ordinal - 1].paragraphIndex}`;
  const named = new Map<string, number>();
  for (const ordinal of head.ordinals) if (!named.has(paragraph(ordinal))) named.set(paragraph(ordinal), ordinal);
  const firsts = new Map<string, number>();
  for (const ordinal of epithet.ordinals) if (!firsts.has(paragraph(ordinal))) firsts.set(paragraph(ordinal), ordinal);
  let shared = 0;
  let from = Infinity;
  [...firsts].forEach(([key, ordinal], index) => {
    if (named.has(key)) shared++;
    if (shared < EPITHET_SHARE * (index + 1)) from = Infinity;
    else if (from === Infinity) from = Math.max(ordinal, named.get(key) ?? ordinal);
  });
  return from === Infinity ? epithet.ordinals.at(-1)! : from;
}

const ALIAS_SYSTEM: Record<BookKnowledgeXrayMode, string> = {
  fiction:
    'Below are groups of names from a novel. Each group has a name, then candidates that might be the same person, place or thing under ' +
    'another name: a short form, a misspelling, a title, an epithet such as "the golem", or a nickname others call them. Every name comes ' +
    'with a few numbered sentences that use it.\n' +
    'For each candidate say whether the sentences show it is the same as the group\'s name. "same" only when a sentence makes it plain ' +
    '(it names both as one, or uses the name for the same one in a way no one could doubt); a family, a place and its building, or a ' +
    'kind and one of its members are different. When unsure, say different. n: the number of the sentence that shows it.\n' +
    'Answer with JSON only: {"g1": {"e7": {"same": true, "n": 1234}, "e9": {"same": false}}}, one key for every candidate.',
  nonfiction:
    'Below are groups of terms and names from a nonfiction book. Each group has a term, then candidates that might be the same term or ' +
    'person under another name: a short form, a misspelling or an abbreviation. Every name comes with a few numbered sentences that use it.\n' +
    'For each candidate say whether the sentences show it is the same. "same" only when a sentence makes it plain; a broader or narrower ' +
    'idea is different. When unsure, say different. n: the number of the sentence that shows it.\n' +
    'Answer with JSON only: {"g1": {"e7": {"same": true, "n": 1234}, "e9": {"same": false}}}, one key for every candidate.',
};

export interface AliasMerge {
  member: XrayEntity;
  head: XrayEntity;
  ordinal: number;
  reason: AliasReason;
  /** The sentences the model was shown and the one it cited, so the join can wait until each counts for its side. */
  evidence?: { cite: number; shown: readonly number[] };
}

/**
 * The alias step: the candidates grouped by head, `ALIAS_GROUPS_PER_CALL` groups a low-effort call,
 * each name shown in up to three numbered sentences (those naming both first). A "same" with a cited
 * sentence from those shown merges the pair from the later of that sentence and the member's first
 * mention; anything else keeps them apart.
 */
export async function aliasMerges(
  candidates: readonly AliasCandidate[],
  sentences: readonly Sentence[],
  mode: BookKnowledgeXrayMode,
  ask: Ask,
  step: XrayStepRun,
  unitPrefix = 'alias',
): Promise<AliasMerge[]> {
  const groups = new Map<XrayEntity, AliasCandidate[]>();
  for (const candidate of candidates) groups.set(candidate.head, [...(groups.get(candidate.head) ?? []), candidate]);
  const wordsIn = (ordinal: number) => words(sentences[ordinal - 1].text).length;
  // A head's joined names are part of who it is: Viv is also "Princess Bob", which is what makes "Bob" her.
  const shown = (entity: XrayEntity, other: XrayEntity) => {
    const both = entity.ordinals.filter((ordinal) => other.ordinals.includes(ordinal));
    const joined = entity.joins.flatMap((join) => join.names.slice(0, 1).map(({ ordinal }) => ordinal));
    // A bare "Bob." in dialogue proves nothing; the fuller sentences ("Just call me Bob") carry the evidence.
    const fullest = [...entity.ordinals].sort((a, b) => wordsIn(b) - wordsIn(a) || a - b);
    return [...new Set([...both, ...joined, ...fullest])].slice(0, ALIAS_SENTENCES).sort((a, b) => a - b);
  };
  const named = (entity: XrayEntity) =>
    entity.joins.length ? `${entity.name} (also called ${[...new Set(entity.joins.map((join) => join.name))].join(', ')})` : entity.name;
  const line = (ordinal: number) => `  [${ordinal}] ${sentences[ordinal - 1].text.replace(/\s+/g, ' ').trim()}`;
  const list = [...groups];
  const batches: (typeof list)[] = [];
  for (let at = 0; at < list.length; at += ALIAS_GROUPS_PER_CALL) batches.push(list.slice(at, at + ALIAS_GROUPS_PER_CALL));
  // Per batch, so the merges come back in batch order however the calls finish: the cast depends on their order.
  const merges: AliasMerge[][] = batches.map(() => []);
  const rejected: Rejections = {};
  await Promise.all(
    batches.map(async (batch, index) => {
      const user = batch
        .map(([head, members], at) => {
          const own = members.flatMap((candidate) => shown(head, candidate.member));
          return [
            `g${at + 1}: ${head.id} ${named(head)}`,
            ...[...new Set(own)].slice(0, ALIAS_SENTENCES).map(line),
            ...members.flatMap((candidate) => [
              `  candidate ${candidate.member.id} ${candidate.member.name}`,
              ...shown(candidate.member, head).map(line),
            ]),
          ].join('\n');
        })
        .join('\n\n');
      const answer = await step.unit({
        id: `${unitPrefix}${index + 1}`,
        ordinals: batch.flatMap(([head, members]) => [
          ...members.flatMap((candidate) => shown(head, candidate.member)),
          ...members.flatMap((candidate) => shown(candidate.member, head)),
        ]),
        send: ask({
          system: ALIAS_SYSTEM[mode],
          user,
          maxOutputTokens: ALIAS_MAX_OUTPUT_TOKENS,
          effort: 'low',
          capped: true,
          temperature: CLASSIFY_TEMPERATURE,
        }),
        read: (raw) => {
          const found = record(raw);
          return found ? { items: found, rejected: {} } : null;
        },
      });
      batch.forEach(([head, members], at) => {
        const group = record(answer?.[`g${at + 1}`]);
        for (const candidate of members) {
          const said = record(group?.[candidate.member.id]);
          if (said?.same !== true) {
            rejected[said ? 'alias:different' : 'alias:unanswered'] = (rejected[said ? 'alias:different' : 'alias:unanswered'] ?? 0) + 1;
            continue;
          }
          const allowed = new Set([...shown(head, candidate.member), ...shown(candidate.member, head)]);
          const [cite] = citesIn(said.n, allowed).cites;
          if (cite === undefined) {
            rejected['alias:no-cite'] = (rejected['alias:no-cite'] ?? 0) + 1;
            continue;
          }
          // A cite naming only one side may rest on what the model knows of the book, so the join waits for the last sentence shown.
          const both = head.ordinals.includes(cite) && candidate.member.ordinals.includes(cite);
          const ordinal = both ? cite : Math.max(...allowed);
          merges[index].push({
            member: candidate.member,
            head,
            ordinal: Math.max(ordinal, candidate.member.first),
            reason: candidate.reason,
            evidence: { cite, shown: [...allowed] },
          });
        }
      });
    }),
  );
  step.reject(rejected);
  return merges.flat();
}

/**
 * Applies an alias merge; when an earlier merge already joined either side into a busier name, that name stays the head ("Viv", not a
 * title she is also called). A capitalised character heads a pair with anything else whatever the counts.
 */
export function joinAlias(cast: PassCast, merge: AliasMerge): void {
  const [head, member] = [cast.headOf(merge.head), cast.headOf(merge.member)];
  if (collective(head) || collective(member)) return;
  const [join] = namedFirst(member, head, () => (member.count > head.count ? [head, member] : [member, head]));
  // The names the evidence ties, not their heads: the cast then waits for each name's own join before the heads join.
  const [from, to] = join === member ? [merge.member, merge.head] : [merge.head, merge.member];
  cast.merge({ member: from, head: to, ordinal: revealAt(cast, merge), rule: 'alias', reason: merge.reason });
}

/**
 * Where an alias answer's evidence is plain to a reader: a head's merged sentences hold its members' from before their
 * joins, so a cited or shown sentence counts for a side only from where the name it uses has joined that side.
 */
function revealAt(cast: PassCast, merge: AliasMerge): number {
  if (!merge.evidence) return merge.ordinal;
  const { cite, shown } = merge.evidence;
  const both = Math.max(cast.namedFrom(merge.head, cite), cast.namedFrom(merge.member, cite));
  if (both !== Infinity) return Math.max(both, merge.member.first);
  const known = shown.map((ordinal) => {
    const from = Math.min(cast.namedFrom(merge.head, ordinal), cast.namedFrom(merge.member, ordinal));
    return from === Infinity ? ordinal : from;
  });
  return Math.max(merge.ordinal, ...known);
}

/** One letter changed, added or dropped, or two neighbours swapped: "Nyil" for "Niyl". */
/** One name with a doubled letter written single (Barran, Baran): a spelling the book uses both ways, however often; the alias ask decides. */
export function doubledLetter(a: string, b: string): boolean {
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (long.length !== short.length + 1) return false;
  for (let i = 1; i < long.length; i++) if (long[i] === long[i - 1] && long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

function slip(a: string, b: string): boolean {
  if (editDistance(a, b) <= 1) return true;
  if (a.length !== b.length) return false;
  const at = [...a].flatMap((letter, index) => (letter === b[index] ? [] : [index]));
  return at.length === 2 && at[1] === at[0] + 1 && a[at[0]] === b[at[1]] && a[at[1]] === b[at[0]];
}
