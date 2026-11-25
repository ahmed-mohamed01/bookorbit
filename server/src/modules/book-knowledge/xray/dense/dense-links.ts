import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import type { Sentence } from '../../core/model';
import type { XrayLinkSnapshot } from '../xray-links';
import type { XrayEntity } from '../xray-entities';
import type { PassCast } from '../pass/pass-cast';
import type { PassUnit } from '../pass/pass-units';

export const PAIR_WINDOW = 3;
export const LINK_WINDOW = 25;
export const LINK_CAP = 15;
/** Partners kept by how specific they are to an entity, so a frequent hub word cannot crowd out a concept's own partners. */
export const LINK_SPECIFIC_CAP = 8;
export const LINK_MIN_WINDOWS = 2;

export interface SceneLinkPair {
  a: XrayEntity;
  b: XrayEntity;
  cite: number;
}

interface WindowPair {
  a: string;
  b: string;
  count: number;
  first: number;
  from: number;
}

/**
 * A nonfiction chapter's outline: what its title names is tied to what each of its section headings names,
 * cited at that section heading. A chapter is one spine item; its first heading is the title.
 */
/** A heading this many sentences or fewer before the next one introduces the sections that follow. */
const INTRO_SENTENCES = 12;

export function headingPairs(
  cast: PassCast,
  sentences: readonly Sentence[],
  units: readonly PassUnit[],
  mode: BookKnowledgeXrayMode,
): SceneLinkPair[] {
  if (mode !== 'nonfiction') return [];
  // Units hold body text only, so a heading counts as read once a later unit sentence is.
  const through = Math.max(0, ...units.map((unit) => unit.ordinals.at(-1) ?? 0));
  const named = new Map<number, XrayEntity[]>();
  for (const [head, ordinals] of cast.headMentions())
    for (const ordinal of ordinals) {
      if (ordinal > through || !sentences[ordinal - 1]?.heading) continue;
      const list = named.get(ordinal);
      if (list) list.push(head);
      else named.set(ordinal, [head]);
    }
  const titles = new Map<number, number>();
  const parents = new Map<number, number>();
  const headings = sentences.filter((sentence) => sentence.heading && sentence.structure === 'body');
  let parent: number | undefined;
  for (const [index, sentence] of headings.entries()) {
    if (!titles.has(sentence.spineIndex)) {
      titles.set(sentence.spineIndex, sentence.ordinal);
      parent = undefined;
      continue;
    }
    const next = headings[index + 1];
    // A heading the next one follows within a few sentences introduces the sections after it ("Capability control methods" > "Boxing methods").
    // The first section after an introduction belongs to it, however short.
    const first = parent !== undefined && headings[index - 1].ordinal === parent;
    if (!first && next && next.spineIndex === sentence.spineIndex && next.ordinal - sentence.ordinal <= INTRO_SENTENCES) parent = sentence.ordinal;
    else if (parent !== undefined) parents.set(sentence.ordinal, parent);
  }
  const pairs: SceneLinkPair[] = [];
  for (const [ordinal, heads] of named) {
    const title = titles.get(sentences[ordinal - 1].spineIndex);
    if (title === undefined || title === ordinal) continue;
    for (const above of [title, parents.get(ordinal)])
      for (const a of above === undefined ? [] : (named.get(above) ?? [])) for (const b of heads) if (a !== b) pairs.push({ a, b, cite: ordinal });
  }
  return pairs;
}

export function windowLinks(cast: PassCast, units: readonly PassUnit[], relations: readonly SceneLinkPair[] = []): XrayLinkSnapshot[] {
  const at = new Map<number, string[]>();
  const heads = new Set(cast.heads);
  const mentions = new Map<string, number>();
  for (const [head, ordinals] of cast.headMentions())
    for (const ordinal of ordinals) {
      const keys = at.get(ordinal);
      if (keys) keys.push(head.key);
      else at.set(ordinal, [head.key]);
    }

  const pairs = new Map<string, WindowPair>();
  const partners = new Map<string, WindowPair[]>();
  const top = new Map<string, number>();
  const pairOf = (x: string, y: string) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    const id = `${a}|${b}`;
    let pair = pairs.get(id);
    if (!pair) {
      pair = { a, b, count: 0, first: Infinity, from: Infinity };
      pairs.set(id, pair);
      for (const key of [a, b]) {
        const list = partners.get(key);
        if (list) list.push(pair);
        else partners.set(key, [pair]);
      }
    }
    return pair;
  };

  const recent = new Map<string, number>();
  let index = 0;
  for (const unit of units) {
    const changed = new Set<string>();
    for (const ordinal of unit.ordinals) {
      const start = Math.max(0, index - LINK_WINDOW + 1);
      for (const [key, last] of recent) if (last < start) recent.delete(key);
      const named = at.get(ordinal) ?? [];
      const current = new Set(named);
      for (const key of named) {
        for (const [other, last] of recent) {
          if (other === key || current.has(other)) continue;
          // A start that already held both ends before this sentence must not be counted again.
          const firstNew = Math.max(start, (recent.get(key) ?? -1) + 1);
          if (firstNew > last) continue;
          const pair = pairOf(key, other);
          pair.count += last - firstNew + 1;
          pair.first = Math.min(pair.first, ordinal);
          changed.add(key);
          changed.add(other);
        }
      }
      for (const [i, key] of named.entries())
        for (const other of named.slice(i + 1)) {
          const firstNew = Math.max(start, Math.min(recent.get(key) ?? -1, recent.get(other) ?? -1) + 1);
          const pair = pairOf(key, other);
          pair.count += index - firstNew + 1;
          pair.first = Math.min(pair.first, ordinal);
          changed.add(key);
          changed.add(other);
        }
      for (const key of named) {
        recent.set(key, index);
        mentions.set(key, (mentions.get(key) ?? 0) + 1);
      }
      index++;
    }

    const end = unit.ordinals.at(-1)!;
    for (const key of changed) {
      const ranked = partners.get(key)!.sort((x, y) => y.count - x.count || x.first - y.first);
      top.set(key, ranked[0].count);
      const specific = (pair: WindowPair) => pair.count / Math.sqrt(mentions.get(pair.a === key ? pair.b : pair.a) ?? 1);
      const distinct = [...ranked].sort((x, y) => specific(y) - specific(x) || x.first - y.first).slice(0, LINK_SPECIFIC_CAP);
      for (const pair of [...ranked.slice(0, LINK_CAP), ...distinct]) if (pair.count >= LINK_MIN_WINDOWS) pair.from = Math.min(pair.from, end);
    }
    if (unit.sectionEnd) {
      recent.clear();
      index = 0;
    }
  }

  for (const relation of relations) {
    const a = cast.headOf(relation.a, relation.cite);
    const b = cast.headOf(relation.b, relation.cite);
    if (a === b || !heads.has(a) || !heads.has(b)) continue;
    const pair = pairOf(a.key, b.key);
    pair.from = Math.min(pair.from, relation.cite);
  }

  return [...pairs.values()]
    .filter((pair) => Number.isFinite(pair.from))
    .map(({ a, b, count, from }) => ({
      a,
      b,
      score: Math.round((count / Math.max(top.get(a) ?? 0, top.get(b) ?? 0, 1)) * 1000) / 1000,
      count,
      from,
      until: null,
    }))
    .sort((x, y) => x.from - y.from);
}
