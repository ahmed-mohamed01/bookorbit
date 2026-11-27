import { escapeRegExp, WORD_EDGE } from '../../story-guides/pipeline/name-text';
import { wordRarity } from '../core/common-words';
import type { BookKnowledgeKind, BookKnowledgeXrayMode, BookKnowledgeXraySub, StoryGuideEntityKind } from '@bookorbit/types';
import { mentionsAt, visibleTerm } from '../core/artifact';
import { termFragments } from '../core/term-fragments';
import { words } from '../core/text-utils';
import { isDictionaryTerm, isExclamationTerm, isGenericTerm, isNationalityTerm, isUnitTerm } from '../core/generic-terms';
import { ADMITTED_UNTYPED, PLACE_NOUNS, type KindAnswer } from '../core/kind-review';
import { termKinds } from '../core/kinds';
import type { Artifact, Sentence, VisibleTerm } from '../core/model';
import { rankTerms, type RankedTerm } from '../core/term-ranking';
import { bareLabel, glossOf } from './dense/dense-definition';
import { descriptiveEntries, fictionNameCheck } from './xray-fiction-entries';
import { foldSpellings, fusedEntries, joinedParts } from './xray-name-fold';
import { STATUS_LABEL } from './dense/dense-links';

/** The X-Ray spec caps a payload at 400 entities. */
export const XRAY_ENTITY_LIMIT = 400;
/** A nonfiction book's many small named concepts (two to four sentences each) need more room than a novel's cast. */
export const XRAY_NONFICTION_ENTITY_LIMIT = 600;
const NONFICTION_PHRASE_WEIGHT = 3;
/** A cast member is named in at least this many body sentences up to the cut. */
export const CAST_MIN_SENTENCES = 2;
const MAIN_CAST = 12;
/** At or below this rarity (SCOWL level 35 and under) a lowercase non-character name is an everyday noun that never leads the cast. */
const EVERYDAY_RARITY = 0.35;
const MAIN_CAST_MIN_SCORE = 6;
const SUPPORTING_CAST = 48;
const SUPPORTING_CAST_MIN_SCORE = 2;
/** A title goes to one holder when that person is in this share of the sentences naming it, at least twice. */
const TITLE_HOLDER_SHARE = 0.6;
const TITLE_HOLDER_MIN = 2;
/**
 * The holder must be in the title's sentences this many times more often than in the book's: a viewpoint character is
 * named beside every title the narration mentions ("Zoey saluted the Captain"), so share alone hands it the title.
 */
const TITLE_HOLDER_LIFT = 3;

export { isGenericTerm } from '../core/generic-terms';
export { ADMITTED_UNTYPED as UNTYPED_MIN_SENTENCES } from '../core/kind-review';

export interface XrayName {
  text: string;
  ordinal: number;
}

export interface XrayJoin {
  key: string;
  name: string;
  names: XrayName[];
  ordinal: number;
}

export interface XrayEntity {
  /** Short id used in prompts. */
  id: string;
  /** Book Knowledge root term key. */
  key: string;
  name: string;
  kind: StoryGuideEntityKind;
  sub: BookKnowledgeXraySub | null;
  importance: 1 | 2 | 3;
  /** Position in Book Knowledge's term ranking at the cut, 0 first. */
  rank: number;
  count: number;
  first: number;
  /** Distinct body sentences that mention it, in reading order. */
  ordinals: number[];
  /** Sentences whose mention is a definition or introduction. */
  defining: Set<number>;
  names: XrayName[];
  joins: XrayJoin[];
}

/** Book Knowledge kinds onto upstream's: animals are characters, titles are settled by their holders. */
export function storyKind(
  kind: BookKnowledgeKind | null,
  fallback: VisibleTerm['type'],
): { kind: StoryGuideEntityKind; sub: BookKnowledgeXraySub | null } {
  switch (kind) {
    case 'person':
      return { kind: 'character', sub: null };
    case 'animal':
      return { kind: 'character', sub: 'animal' };
    case 'title':
      return { kind: 'idea', sub: 'title' };
    case 'place':
    case 'group':
    case 'object':
    case 'idea':
      return { kind, sub: null };
    default:
      return { kind: fallback === 'person' ? 'character' : fallback === 'place' ? 'place' : 'idea', sub: null };
  }
}

export function importanceOf(rank: number, score: number, character = true): 1 | 2 | 3 {
  if (character && rank < MAIN_CAST && score >= MAIN_CAST_MIN_SCORE) return 1;
  if (rank < SUPPORTING_CAST && score >= SUPPORTING_CAST_MIN_SCORE) return 2;
  return 3;
}

export function rankImportance(
  entities: readonly XrayEntity[],
  sentences: readonly Sentence[],
  degrees: ReadonlyMap<XrayEntity, number> = new Map(),
  mentions: (entity: XrayEntity) => readonly number[] = (entity) => entity.ordinals,
  aliases: (entity: XrayEntity) => readonly string[] = (entity) => entity.names.map(({ text }) => text),
): void {
  const ranked = entities.flatMap((entity) => {
    if (entity.kind !== 'character' && entity.name === entity.name.toLowerCase() && wordRarity(entity.name) <= EVERYDAY_RARITY) {
      entity.importance = 3;
      return [];
    }
    const chapters = new Set<number>();
    const speaking = new Set<number>();
    const names = [...new Set([entity.name, ...aliases(entity)])].map(escapeRegExp).join('|');
    const mention = new RegExp(`${WORD_EDGE}(?:${names})${WORD_EDGE}`, 'iu');
    const say = '(?:said|asked|replied|whispered|shouted|answered|told|muttered)';
    const speaker = new RegExp(`${WORD_EDGE}(?:(?:${names})\\s+${say}|${say}\\s+(?:${names}))${WORD_EDGE}`, 'iu');
    for (const ordinal of mentions(entity)) {
      const sentence = sentences[ordinal - 1];
      if (!sentence) continue;
      chapters.add(sentence.spineIndex);
      if (speaker.test(sentence.text) || [...sentence.text.matchAll(/“[^”]*”|"[^"]*"/g)].some(([quote]) => mention.test(quote)))
        speaking.add(sentence.spineIndex);
    }
    return [{ entity, score: chapters.size + 2 * speaking.size + Math.min(degrees.get(entity) ?? 0, 6) }];
  });
  ranked.sort((a, b) => b.score - a.score || a.entity.first - b.entity.first);
  let leads = 0;
  ranked.forEach(({ entity, score }, rank) => {
    const character = entity.kind === 'character';
    entity.importance = importanceOf(rank < SUPPORTING_CAST && leads < MAIN_CAST && character ? leads : Math.max(rank, MAIN_CAST), score, character);
    if (entity.importance === 1) leads++;
  });
}

function bodyOrdinals(artifact: Artifact, term: VisibleTerm, inside: ReadonlySet<number> = new Set()): number[] {
  const ordinals = new Set<number>();
  for (const mention of term.mentions)
    if (artifact.sentences[mention.ordinal - 1]?.structure === 'body' && (!mention.nested || !inside.has(mention.ordinal)))
      ordinals.add(mention.ordinal);
  return [...ordinals].sort((a, b) => a - b);
}

/** For each term, the sentences that name a longer chosen term containing it ("Old Empire" for "Empire"). */
function containedIn(terms: readonly VisibleTerm[]): Map<string, Set<number>> {
  const parts = new Map(terms.map((term) => [term.key, words(term.displayName)]));
  const inside = new Map<string, Set<number>>();
  for (const longer of terms) {
    const big = parts.get(longer.key)!;
    for (const term of terms) {
      const small = parts.get(term.key)!;
      if (!small.length || small.length >= big.length || !big.some((_, at) => small.every((word, offset) => big[at + offset] === word))) continue;
      const own = inside.get(term.key) ?? new Set<number>();
      for (const mention of longer.mentions) own.add(mention.ordinal);
      inside.set(term.key, own);
    }
  }
  return inside;
}

function sharesWord(part: VisibleTerm, whole: VisibleTerm): boolean {
  const own = new Set(words(whole.displayName));
  return part.key !== whole.key && words(part.displayName).some((word) => own.has(word));
}

function firstNames(mentions: readonly { alias: string; ordinal: number }[]): XrayName[] {
  const names = new Map<string, XrayName>();
  for (const mention of mentions) {
    const folded = mention.alias.toLowerCase();
    if (!names.has(folded)) names.set(folded, { text: mention.alias, ordinal: mention.ordinal });
  }
  return [...names.values()];
}

/** Per group key, the members merged into it by an alias link that comes after the member was first met. */
function joinsByGroup(artifact: Artifact, groups: ReadonlyMap<string, VisibleTerm>, through: number): Map<string, XrayJoin[]> {
  const terms = new Map(artifact.terms.map((term) => [term.key, term]));
  const groupOf = new Map<string, string | undefined>();
  const joins = new Map<string, Map<string, XrayJoin>>();
  for (const link of artifact.aliasLinks) {
    if (
      artifact.sentences[link.ordinal - 1]?.structure !== 'body' ||
      link.ordinal > through ||
      (link.untilOrdinal !== undefined && link.untilOrdinal <= through)
    )
      continue;
    for (const side of [link.left, link.right]) {
      if (!groupOf.has(side)) groupOf.set(side, visibleTerm(artifact, side, through, true)?.key);
      const group = groups.get(groupOf.get(side) ?? '');
      if (!group || side === group.key || joins.get(group.key)?.has(side)) continue;
      const term = terms.get(side);
      const mentions = term ? mentionsAt(term, through).filter(({ ordinal }) => artifact.sentences[ordinal - 1]?.structure === 'body') : [];
      if (!mentions.length || mentions[0].ordinal >= link.ordinal) continue;
      const names = firstNames(mentions.filter((mention) => group.aliases.includes(mention.alias) || mention.alias === group.displayName));
      if (!names.length) continue;
      if (!joins.has(group.key)) joins.set(group.key, new Map());
      joins.get(group.key)!.set(side, { key: side, name: names[0].text, names, ordinal: link.ordinal });
    }
  }
  return new Map([...joins].map(([key, members]) => [key, [...members.values()]]));
}

/** "Captain Zoey" or "Zoey, the Captain": a sentence that puts the title right against the holder's name. */
function titleBeside(title: XrayEntity, holder: XrayEntity, sentences: readonly Sentence[]): boolean {
  const alternatives = (entity: XrayEntity) => [...new Set(entity.names.map(({ text }) => escapeRegExp(text)))].join('|');
  const titles = alternatives(title);
  const names = alternatives(holder);
  const beside = new RegExp(`${WORD_EDGE}(?:(?:${titles})\\s+(?:${names})|(?:${names}),\\s+(?:the\\s+)?(?:${titles}))${WORD_EDGE}`, 'u');
  return title.ordinals.some((ordinal) => beside.test(sentences[ordinal - 1]?.text ?? ''));
}

/**
 * Each title's single holder, if it has one: the person in most of the sentences that name the title, far more than in
 * the rest of the book or named right beside it. The title becomes theirs at the sentence where that share is first reached.
 */
function titleHolders(
  titles: readonly XrayEntity[],
  people: readonly XrayEntity[],
  sentences: readonly Sentence[],
  through: number,
): Map<string, { holder: XrayEntity; ordinal: number }> {
  const bySentence = new Map<number, XrayEntity[]>();
  for (const person of people) for (const ordinal of person.ordinals) bySentence.set(ordinal, [...(bySentence.get(ordinal) ?? []), person]);
  const holders = new Map<string, { holder: XrayEntity; ordinal: number }>();
  if (!titles.length) return holders;
  let body = 0;
  for (const sentence of sentences) if (sentence.ordinal <= through && sentence.structure === 'body') body++;
  for (const title of titles) {
    const counts = new Map<XrayEntity, number>();
    for (const ordinal of title.ordinals)
      for (const person of new Set(bySentence.get(ordinal) ?? [])) counts.set(person, (counts.get(person) ?? 0) + 1);
    const [best, second] = [...counts].sort((a, b) => b[1] - a[1]);
    if (!best || best[1] < TITLE_HOLDER_MIN || best[1] < TITLE_HOLDER_SHARE * title.ordinals.length) continue;
    if (second && second[1] === best[1]) continue;
    const [holder, count] = best;
    const lift = count / title.ordinals.length / (holder.ordinals.length / Math.max(body, 1));
    if (lift < TITLE_HOLDER_LIFT && !titleBeside(title, holder, sentences)) continue;
    let shared = 0;
    let ordinal = title.ordinals.at(-1)!;
    for (const [index, at] of title.ordinals.entries()) {
      if (bySentence.get(at)?.includes(holder)) shared++;
      if (shared >= TITLE_HOLDER_MIN && shared >= TITLE_HOLDER_SHARE * (index + 1)) {
        ordinal = at;
        break;
      }
    }
    holders.set(title.key, { holder, ordinal });
  }
  return holders;
}

/** Whether a term with this many body sentences up to a cut is in the cast, given its kind (null when untyped). */
export function inCast(sentences: number, typed: boolean): boolean {
  return sentences >= (typed ? CAST_MIN_SENTENCES : ADMITTED_UNTYPED);
}

/**
 * The X-Ray's cast from the Book Knowledge index as of `through`: the term ranking with junk removed
 * (rules, GLiNER votes and the kind review's answers), kept when named in enough body sentences, with
 * names and joins. No model is called here.
 */
/**
 * A novel's lowercase dictionary word needs this ranking score to be an entry: in The Calamitous Bob it keeps
 * willpower (12.6) and endurance (10.1) and drops armor (5.7), shield (4.4) and cloak (3.5). Coined words skip it.
 */
export const DICTIONARY_TERM_MIN_SCORE = 8;

/** Whether a novel's lowercase term is a plain word too weak to stand alone; one inside a name waits for the alias step. */
export function weakDictionaryTerm(name: string, score: number, inNames: ReadonlySet<string>): boolean {
  return isDictionaryTerm(name) && score < DICTIONARY_TERM_MIN_SCORE && !inNames.has(name);
}

/**
 * Place words ("fort", "palace", "city") that open or close the name of one of the book's named places. `single`: in
 * exactly one (Fort Stone), so the bare word is kept for the alias step to fold into it. `shared`: in two or more
 * (Fort Stone, Fort Sky), so the bare word means any of them and is no entry. Other words face the score floor.
 */
export function nameWords(ranked: readonly RankedTerm[], isPlace: (key: string) => boolean): { single: Set<string>; shared: Set<string> } {
  const seen = new Map<string, number>();
  for (const term of ranked) {
    const parts = words(term.displayName);
    if (!/^\p{Lu}/u.test(term.displayName) || parts.length < 2 || !isPlace(term.key)) continue;
    for (const word of new Set([parts[0], parts.at(-1)!])) if (PLACE_NOUNS.has(word)) seen.set(word, (seen.get(word) ?? 0) + 1);
  }
  const single = new Set<string>();
  const shared = new Set<string>();
  for (const [word, names] of seen) (names === 1 ? single : shared).add(word);
  return { single, shared };
}

const CAST_KINDS = new Set<BookKnowledgeKind | 'junk' | null>(['person', 'animal', 'group', 'place']);

const HONORIFIC_SHARE = 0.5;

/** "Grace" said mostly as "your Grace" or "her Grace" is a form of address, not someone's name. */
export function honorific(name: string, ordinals: readonly number[], sentences: readonly Sentence[]): boolean {
  if (/\s/.test(name)) return false;
  const address = new RegExp(`\\b(?:your|his|her|their)\\s+${escapeRegExp(name)}\\b`, 'iu');
  return ordinals.filter((ordinal) => address.test(sentences[ordinal - 1].text)).length >= ordinals.length * HONORIFIC_SHARE;
}

export function xrayEntities(
  artifact: Artifact,
  through: number,
  answers: ReadonlyMap<string, KindAnswer> = new Map(),
  mode: BookKnowledgeXrayMode = 'fiction',
  limit = mode === 'nonfiction' ? XRAY_NONFICTION_ENTITY_LIMIT : XRAY_ENTITY_LIMIT,
  dropped: { generic: number; fragment: number } = { generic: 0, fragment: 0 },
): XrayEntity[] {
  const ranked = rankTerms(artifact, through, true);
  const decided = termKinds(artifact, ranked, through);
  /** A name kept for its parts takes their kind when it has none of its own. */
  const inherited = new Map<string, BookKnowledgeKind | 'junk' | null>();
  const kindOf = (key: string): BookKnowledgeKind | 'junk' | null => answers.get(key) ?? decided.get(key)?.kind ?? inherited.get(key) ?? null;
  /** `admits` re-applies the cast floor once the sentences a longer name owns are taken away. */
  type Eligible = { term: VisibleTerm; sentences: number; rank: number; admits: (sentences: number) => boolean };
  let eligible: Eligible[] = [];
  const unreal: (Eligible & { failedName: boolean })[] = [];
  const realName = fictionNameCheck(artifact.sentences);
  const inNames = nameWords(ranked, (key) => kindOf(key) === 'place');
  for (const [rank, rankedTerm] of ranked.entries()) {
    let term: VisibleTerm = rankedTerm;
    const kind = kindOf(term.key);
    if (
      kind === 'junk' ||
      isExclamationTerm(term.displayName, mode) ||
      isUnitTerm(term.displayName, mode) ||
      isNationalityTerm(term.displayName, mode)
    )
      continue;
    if (
      mode === 'fiction' &&
      (kind === 'person' || kind === 'animal' || kind === 'place') &&
      term.displayName === term.displayName.toLowerCase() &&
      term.mentions.every(({ alias }) => /^\p{Lu}/u.test(alias))
    )
      term = { ...term, displayName: term.mentions[0].alias };
    // A capitalised everyday word (an inn called the Feather) is a name only where it is written that way; "feathers" is the word.
    if (mode === 'fiction' && /^\p{Lu}/u.test(term.displayName) && isDictionaryTerm(term.displayName.toLowerCase())) {
      const named = term.mentions.filter(({ alias }) => /^\p{Lu}/u.test(alias));
      if (named.length && named.length < term.mentions.length) term = { ...term, mentions: named, count: named.length };
    }
    const ordinals = bodyOrdinals(artifact, term);
    const sentences = ordinals.length;
    if (!sentences) continue;
    const lowercase = mode === 'fiction' && term.displayName === term.displayName.toLowerCase();
    const clutter =
      lowercase &&
      (weakDictionaryTerm(term.displayName, rankedTerm.score, inNames.single) ||
        inNames.shared.has(term.displayName) ||
        // A prop seen in one chapter (orb) is scenery; someone or somewhere met there is cast from the start (Yoink, the revenants).
        (!CAST_KINDS.has(kind) &&
          ordinals.every((ordinal) => artifact.sentences[ordinal - 1].spineIndex === artifact.sentences[ordinals[0] - 1].spineIndex)));
    const generic = (mode === 'fiction' || !answers.has(term.key)) && isGenericTerm(term.displayName, mode);
    // Clutter and everyday words need an outright gloss; the extractor's definition flag fires on plain narration for them.
    const glossAt = lowercase && (clutter || generic) ? glossOf(ordinals, artifact.sentences, [term.displayName, ...term.aliases]) : null;
    const explicit = lowercase && (clutter || generic ? glossAt !== null : term.mentions.some((mention) => mention.explicitDefinition));
    if (!explicit && (clutter || generic)) {
      dropped.generic++;
      continue;
    }
    const named = mode === 'fiction' && /^\p{Lu}/u.test(term.displayName);
    if (named && honorific(term.displayName, ordinals, artifact.sentences)) {
      dropped.generic++;
      continue;
    }
    // A nonfiction term the book defines outright, or defines under its own heading, is a concept whatever its kind.
    const defined =
      mode === 'nonfiction' && term.mentions.some((mention) => mention.explicitDefinition || (mention.definition && mention.structural));
    const admits = (count: number) => count > 0 && (inCast(count, kind !== null || defined) || explicit || (named && kind !== null));
    if (!admits(sentences)) {
      if (named) unreal.push({ term, sentences, rank, admits, failedName: false });
      continue;
    }
    if (named && !realName(term)) {
      unreal.push({ term, sentences, rank, admits, failedName: true });
      continue;
    }
    // A stat a status screen defines ("[Power: your strength...") is that capitalised word; "a seat of power" in prose is not it.
    // A coined word (mana) means the same in prose, so only dictionary words narrow.
    const statAt =
      lowercase && isDictionaryTerm(term.displayName)
        ? (glossAt ?? glossOf(ordinals, artifact.sentences, [term.displayName, ...term.aliases]))
        : null;
    if (statAt !== null && STATUS_LABEL.test(artifact.sentences[statAt - 1].text)) {
      const stat = term.mentions.filter((mention) => mention.capitalized);
      const statSentences = bodyOrdinals(artifact, { ...term, mentions: stat }).length;
      if (statSentences) {
        eligible.push({ term: { ...term, mentions: stat, count: stat.length }, sentences: statSentences, rank, admits });
        continue;
      }
    }
    eligible.push({ term, sentences, rank, admits });
  }
  // "Vega Lyrae!" only ever shouted, or named too few times, fails while "Vega" and "Lyrae" inside it pass: the whole is the name.
  const revived: Eligible[] = [];
  for (const entry of unreal) {
    const parts = eligible.filter(({ term }) => sharesWord(term, entry.term));
    const fragments = parts.length
      ? termFragments(
          parts.map(({ term }) => term),
          [entry.term],
        )
      : new Set<string>();
    const part = parts.find(({ term }) => fragments.has(term.key));
    if (!part) continue;
    if (kindOf(entry.term.key) === null) inherited.set(entry.term.key, kindOf(part.term.key));
    revived.push({ term: entry.term, sentences: entry.sentences, rank: entry.rank, admits: (count) => count > 0 });
  }
  const revivedKeys = new Set(revived.map(({ term }) => term.key));
  dropped.generic += unreal.filter(({ failedName, term }) => failedName && !revivedKeys.has(term.key)).length;
  if (revived.length) eligible = [...eligible, ...revived].sort((a, b) => a.rank - b.rank);
  if (mode === 'fiction') {
    const descriptive = descriptiveEntries(eligible.map(({ term }) => term));
    dropped.fragment += descriptive.size;
    eligible = eligible.filter(({ term }) => !descriptive.has(term.key));
  }
  // Over the cap, the thinnest entries go first, so a late-ranked but much-discussed concept is kept.
  // In nonfiction a coined phrase used three times outweighs an everyday word used five times.
  const weight = ({ term, sentences }: (typeof eligible)[number]) =>
    mode === 'nonfiction' && /\s/.test(term.displayName.trim()) ? sentences * NONFICTION_PHRASE_WEIGHT : sentences;
  const cut = new Set(
    [...eligible]
      .sort((a, b) => weight(b) - weight(a))
      .slice(limit)
      .map(({ term }) => term.key),
  );
  const chosenEntries = eligible.filter(({ term }) => !cut.has(term.key));
  const chosen = chosenEntries.map(({ term }) => term);
  const asEntry = (term: VisibleTerm) => {
    const kind = kindOf(term.key);
    return { key: term.key, names: [term.displayName, ...term.aliases], kind: storyKind(kind === 'junk' ? null : kind, term.type).kind };
  };
  // "Moe and Shemp" goes before the fragment test, so Shemp is not taken as part of it; a rarely named Shemp still owns his name.
  const fused = fusedEntries(chosen.map(asEntry), ranked.filter(({ key }) => kindOf(key) !== 'junk').map(asEntry));
  const unfused = chosen.filter(({ key }) => !fused.has(key));
  const chosenKeys = new Set(chosen.map(({ key }) => key));
  // Parts of a name that is no entry (junk, cut, or not a real name) go with it rather than standing alone; a joined
  // name that is no entry is no evidence that Bram belongs to "Quill and Bram".
  const fragments = termFragments(unfused, [
    ...unfused,
    ...ranked.filter(({ key, displayName }) => !chosenKeys.has(key) && !joinedParts(displayName).length),
  ]);
  dropped.fragment += fragments.size + fused.size;
  const complete = chosen.filter((term) => !fused.has(term.key) && !fragments.has(term.key));
  const admitsOf = new Map(chosenEntries.map((entry) => [entry.term.key, entry.admits]));
  const joinsOf = joinsByGroup(artifact, new Map(complete.map((term) => [term.key, term])), through);
  // "Empire" inside "Old Empire" is the longer name's mention; counting it would hand the short form the longer one's sentences.
  const inside = containedIn(complete);
  const kept: XrayEntity[] = [];
  for (const [rank, term] of complete.entries()) {
    const answered = answers.has(term.key);
    const decision = answered ? undefined : decided.get(term.key);
    const kind = kindOf(term.key);
    const within = inside.get(term.key);
    const ordinals = bodyOrdinals(artifact, term, within);
    // An entry admitted on sentences that belong to a longer name ("the Centauri run" beside Alpha Centauri) is not one.
    if (within && !admitsOf.get(term.key)!(ordinals.length)) {
      dropped.fragment++;
      continue;
    }
    const borrowed = within ? term.mentions.filter((mention) => mention.nested && within.has(mention.ordinal)).length : 0;
    const mapped = storyKind(kind === 'junk' ? null : kind, term.type);
    const joins = joinsOf.get(term.key) ?? [];
    const joined = new Set(joins.flatMap((join) => join.names.map((name) => name.text.toLowerCase())));
    kept.push({
      id: '',
      key: term.key,
      name: term.displayName,
      kind: mapped.kind,
      sub: mapped.sub ?? (decision?.kind === 'person' && decision.subtype && decision.subtype !== 'animal' ? decision.subtype : null),
      importance: 3,
      rank,
      count: Math.max(1, term.count - borrowed),
      first: term.first,
      ordinals,
      defining: new Set(
        term.mentions
          .filter(
            (mention) =>
              (mention.definition || mention.introduced) &&
              !bareLabel(artifact.sentences[mention.ordinal - 1]?.text ?? '', [mention.alias, term.displayName]),
          )
          .map((mention) => mention.ordinal),
      ),
      names: firstNames(term.mentions).filter((name) => !joined.has(name.text.toLowerCase()) || name.text === term.displayName),
      joins,
    });
  }
  const spelled = foldSpellings(kept);
  const titles = spelled.filter((entity) => entity.sub === 'title');
  const holders = titleHolders(
    titles,
    spelled.filter((entity) => entity.kind === 'character' && entity.sub !== 'title'),
    artifact.sentences,
    through,
  );
  const entities = spelled.filter((entity) => {
    const held = holders.get(entity.key);
    if (!held) return true;
    for (const name of entity.names)
      if (!held.holder.names.some((own) => own.text.toLowerCase() === name.text.toLowerCase()))
        held.holder.names.push({ text: name.text, ordinal: Math.max(name.ordinal, held.ordinal) });
    return false;
  });
  rankImportance(entities, artifact.sentences);
  // Ids come from the artifact's term order, which a later cutoff does not change, so an extended build sends earlier units the same prompts.
  const termIndex = new Map(artifact.terms.map((term, index) => [term.key, index]));
  entities.forEach((entity, index) => {
    entity.id = `e${termIndex.get(entity.key) ?? artifact.terms.length + index}`;
    entity.names.sort((a, b) => a.ordinal - b.ordinal);
  });
  return entities;
}

export function withoutNoRole(entities: XrayEntity[], noRole: ReadonlySet<string>, sentences: readonly Sentence[]): XrayEntity[] {
  if (!noRole.size) return entities;
  const rest = entities.filter(({ key }) => !noRole.has(key));
  rankImportance(rest, sentences);
  return rest;
}
