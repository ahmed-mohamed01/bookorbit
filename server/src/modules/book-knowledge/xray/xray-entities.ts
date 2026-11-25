import { escapeRegExp, WORD_EDGE } from '../../story-guides/pipeline/name-text';
import { wordRarity } from '../core/common-words';
import type { BookKnowledgeKind, BookKnowledgeXrayMode, BookKnowledgeXraySub, StoryGuideEntityKind } from '@bookorbit/types';
import { mentionsAt, visibleTerm } from '../core/artifact';
import { termFragments } from '../core/term-fragments';
import { words } from '../core/text-utils';
import { isGenericTerm } from '../core/generic-terms';
import type { KindAnswer } from '../core/kind-review';
import { termKinds } from '../core/kinds';
import type { Artifact, Sentence, VisibleTerm } from '../core/model';
import { rankTerms } from '../core/term-ranking';
import { bareLabel } from './dense/dense-definition';

/** The X-Ray spec caps a payload at 400 entities. */
export const XRAY_ENTITY_LIMIT = 400;
/** A nonfiction book's many small named concepts (two to four sentences each) need more room than a novel's cast. */
export const XRAY_NONFICTION_ENTITY_LIMIT = 600;
const NONFICTION_PHRASE_WEIGHT = 3;
/** A cast member is named in at least this many body sentences up to the cut. */
export const CAST_MIN_SENTENCES = 2;
/** A term with no kind from the rules, GLiNER or the review needs this many to join the cast. */
export const UNTYPED_MIN_SENTENCES = 5;
const MAIN_CAST = 12;
/** At or below this rarity (SCOWL level 35 and under) a lowercase non-character name is an everyday noun that never leads the cast. */
const EVERYDAY_RARITY = 0.35;
const MAIN_CAST_MIN_SCORE = 6;
const SUPPORTING_CAST = 48;
const SUPPORTING_CAST_MIN_SCORE = 2;
/** A title goes to one holder when that person is in this share of the sentences naming it, at least twice. */
const TITLE_HOLDER_SHARE = 0.6;
const TITLE_HOLDER_MIN = 2;

export { isGenericTerm } from '../core/generic-terms';

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
    if (link.ordinal > through || (link.untilOrdinal !== undefined && link.untilOrdinal <= through)) continue;
    for (const side of [link.left, link.right]) {
      if (!groupOf.has(side)) groupOf.set(side, visibleTerm(artifact, side, through)?.key);
      const group = groups.get(groupOf.get(side) ?? '');
      if (!group || side === group.key || joins.get(group.key)?.has(side)) continue;
      const term = terms.get(side);
      const mentions = term ? mentionsAt(term, through) : [];
      if (!mentions.length || mentions[0].ordinal >= link.ordinal) continue;
      const names = firstNames(mentions.filter((mention) => group.aliases.includes(mention.alias) || mention.alias === group.displayName));
      if (!names.length) continue;
      if (!joins.has(group.key)) joins.set(group.key, new Map());
      joins.get(group.key)!.set(side, { key: side, name: names[0].text, names, ordinal: link.ordinal });
    }
  }
  return new Map([...joins].map(([key, members]) => [key, [...members.values()]]));
}

/** Each title's single holder, if it has one: the person in most of the sentences that name the title. */
function titleHolders(titles: readonly XrayEntity[], people: readonly XrayEntity[]): Map<string, { holder: XrayEntity; ordinal: number }> {
  const bySentence = new Map<number, XrayEntity[]>();
  for (const person of people) for (const ordinal of person.ordinals) bySentence.set(ordinal, [...(bySentence.get(ordinal) ?? []), person]);
  const holders = new Map<string, { holder: XrayEntity; ordinal: number }>();
  for (const title of titles) {
    const counts = new Map<XrayEntity, { count: number; first: number }>();
    for (const ordinal of title.ordinals)
      for (const person of new Set(bySentence.get(ordinal) ?? [])) {
        const seen = counts.get(person);
        if (seen) seen.count++;
        else counts.set(person, { count: 1, first: ordinal });
      }
    const [best, second] = [...counts].sort((a, b) => b[1].count - a[1].count);
    if (!best || best[1].count < TITLE_HOLDER_MIN || best[1].count < TITLE_HOLDER_SHARE * title.ordinals.length) continue;
    if (second && second[1].count === best[1].count) continue;
    holders.set(title.key, { holder: best[0], ordinal: best[1].first });
  }
  return holders;
}

/** Whether a term with this many body sentences up to a cut is in the cast, given its kind (null when untyped). */
export function inCast(sentences: number, typed: boolean): boolean {
  return sentences >= (typed ? CAST_MIN_SENTENCES : UNTYPED_MIN_SENTENCES);
}

/**
 * The X-Ray's cast from the Book Knowledge index as of `through`: the term ranking with junk removed
 * (rules, GLiNER votes and the kind review's answers), kept when named in enough body sentences, with
 * names and joins. No model is called here.
 */
export function xrayEntities(
  artifact: Artifact,
  through: number,
  answers: ReadonlyMap<string, KindAnswer> = new Map(),
  mode: BookKnowledgeXrayMode = 'fiction',
  limit = mode === 'nonfiction' ? XRAY_NONFICTION_ENTITY_LIMIT : XRAY_ENTITY_LIMIT,
  dropped: { generic: number; fragment: number } = { generic: 0, fragment: 0 },
): XrayEntity[] {
  const ranked = rankTerms(artifact, through);
  const decided = termKinds(artifact, ranked, through);
  const kindOf = (key: string): BookKnowledgeKind | 'junk' | null => answers.get(key) ?? decided.get(key)?.kind ?? null;
  const eligible: { term: VisibleTerm; sentences: number }[] = [];
  for (const term of ranked) {
    const kind = kindOf(term.key);
    if (kind === 'junk') continue;
    // The review typed it as a real entry, so the common-word rule no longer speaks for it.
    if (!answers.has(term.key) && isGenericTerm(term.displayName, mode)) {
      dropped.generic++;
      continue;
    }
    const sentences = bodyOrdinals(artifact, term).length;
    // A novel's named one-off (a typed, capitalised name) still gets an entry and a one-line description.
    const named = mode === 'fiction' && kind !== null && sentences >= 1 && /^\p{Lu}/u.test(term.displayName);
    // A nonfiction term the book defines outright, or defines under its own heading, is a concept whatever its kind.
    const defined =
      mode === 'nonfiction' && term.mentions.some((mention) => mention.explicitDefinition || (mention.definition && mention.structural));
    if (inCast(sentences, kind !== null || defined) || named) eligible.push({ term, sentences });
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
  const chosen = eligible.filter(({ term }) => !cut.has(term.key)).map(({ term }) => term);
  const fragments = termFragments(chosen, chosen);
  dropped.fragment += fragments.size;
  const complete = chosen.filter((term) => !fragments.has(term.key));
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
  const titles = kept.filter((entity) => entity.sub === 'title');
  const holders = titleHolders(
    titles,
    kept.filter((entity) => entity.kind === 'character' && entity.sub !== 'title'),
  );
  const entities = kept.filter((entity) => {
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
