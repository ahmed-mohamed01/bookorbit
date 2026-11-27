import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import type { Sentence } from '../../core/model';
import type { XrayLinkSnapshot } from '../xray-links';
import type { XrayEntity } from '../xray-entities';
import type { PassCast } from '../pass/pass-cast';
import type { PassUnit } from '../pass/pass-units';

export const PAIR_WINDOW = 3;
export const EPISODE_GAP = 25;
export const LIFT_MIN = 3;
export const SHARE_MIN = 0.15;
export const SMALL_SIDE_EPISODES = 3;
export const SMALL_SIDE_SHARE = 0.5;
export const DENSE_SCENE_HITS = 3;
export const QUIET_SHARE_MAX = 0.3;
export const LINK_CAP = 15;
export const SINGLE_LINK_CAP = 3;

/** A status-screen label line: one to three capitalised words, then a colon ("[Power: your strength..."). */
export const STATUS_LABEL = /^\s*\[?\p{Lu}[\p{L}-]*(?:\s\p{Lu}[\p{L}-]*){0,2}\s*:/u;
export const SYSTEM_SKILL_NOTICE = /^(?:new skill|skill gained|skill)\s*:\s*(.+)$/i;
const SYSTEM_NUMBER_ROW =
  /^\p{L}[\p{L}\p{M}'’-]*(?:\s+[\p{L}\p{M}'’-]+){0,4}(?:\s*:\s*(?:(?:level|lv\.?)\s+)?|\s+(?:increased\s+to|(?:reached\s+)?(?:level|lv\.?))\s+)[+-]?\d+(?:\s*\([+-]\d+\))?[.!]?$/iu;
const BARE_NUMBER_ROW = /^\p{L}[\p{L}\p{M}'’-]*\s+[+-]?\d+[.!]?$/u;

export function statLine(text: string): boolean {
  const line = text.trim();
  const words = line.split(/\s+/).length;
  if (words <= 6 && (/[+-]\d/.test(line) || /\p{Lu}[\p{L}-]*\s+\d+$/u.test(line))) return true;
  return /^\p{Lu}[\p{L}-]*(?:\s\p{Lu}[\p{L}-]*)?$/u.test(line);
}

/** A line from a status screen or system message rather than prose: shouted, bracketed, a label, a stat change or a bare stat name. */
export function systemLine(text: string): boolean {
  const line = text.trim();
  if (STATUS_LABEL.test(line) || /^\[[^\]]*\]?$/u.test(line)) return true;
  if (statLine(line)) return true;
  if (SYSTEM_SKILL_NOTICE.test(line) || SYSTEM_NUMBER_ROW.test(line) || BARE_NUMBER_ROW.test(line)) return true;
  const letters = line.match(/\p{L}/gu)?.length ?? 0;
  const capitals = line.match(/\p{Lu}/gu)?.length ?? 0;
  return letters > 3 && capitals > letters * 0.6;
}

export function cardLine(text: string): boolean {
  return systemLine(text) && !statLine(text);
}

export interface SceneLinkPair {
  a: XrayEntity;
  b: XrayEntity;
  cite: number;
}

interface Episodes {
  count: number;
  last: number;
}

interface EntryMentions extends Episodes {
  total: number;
  quiet: number;
}

interface PairHits {
  count: number;
  last: number;
}

interface WindowPair extends Episodes {
  a: string;
  b: string;
  hitsA: PairHits;
  hitsB: PairHits;
  together: number;
  cards: number;
  first: number;
  firstCard: number;
  hitOrder: number;
  from: number;
}

function recordEpisode(episodes: Episodes, index: number): boolean {
  const separate = index - episodes.last >= EPISODE_GAP;
  episodes.last = index;
  if (separate) episodes.count++;
  return separate;
}

function statHeavy(mentions: EntryMentions): boolean {
  return mentions.total > 0 && mentions.quiet / mentions.total >= QUIET_SHARE_MAX;
}

function denseScene(pair: WindowPair): boolean {
  return Math.min(pair.hitsA.count, pair.hitsB.count) >= DENSE_SCENE_HITS;
}

function recordHits(hits: PairHits, indexes: readonly number[]): void {
  for (const index of indexes) {
    if (index <= hits.last) continue;
    hits.count++;
    hits.last = index;
  }
}

function admitPairs(pairs: ReadonlySet<WindowPair>, mentions: ReadonlyMap<string, EntryMentions>, totalEpisodes: number, end: number): void {
  const ranked: { pair: WindowPair; strength: number; lift: number; first: number }[] = [];
  for (const pair of pairs) {
    const a = mentions.get(pair.a)!;
    const b = mentions.get(pair.b)!;
    const lift = (pair.count * totalEpisodes) / (a.count * b.count);
    const share = Math.min(1, pair.count / Math.max(a.count, b.count));
    const smallerEpisodes = Math.min(a.count, b.count);
    const smallShare = Math.min(1, pair.count / smallerEpisodes);
    const repeated = pair.count >= 2 && (lift >= LIFT_MIN || share >= SHARE_MIN);
    const smallSide = pair.count >= SMALL_SIDE_EPISODES && smallShare >= SMALL_SIDE_SHARE;
    if (repeated || ((smallSide || denseScene(pair)) && !statHeavy(a) && !statHeavy(b))) {
      ranked.push({ pair, strength: Math.min(pair.count, pair.count ** 2 / smallerEpisodes), lift, first: pair.first });
    } else if (pair.cards > 0 || (pair.together > 0 && !statHeavy(a) && !statHeavy(b))) {
      const singleLift = (Math.max(1, pair.count) * totalEpisodes) / (Math.max(1, a.count) * Math.max(1, b.count));
      if (singleLift >= LIFT_MIN) ranked.push({ pair, strength: 0, lift: singleLift, first: Math.min(pair.first, pair.firstCard) });
    }
  }
  // Single links have zero strength. Preserve the original hit order for ties between stronger links.
  ranked.sort((x, y) => y.strength - x.strength || y.lift - x.lift || x.first - y.first || (x.strength ? x.pair.hitOrder - y.pair.hitOrder : 0));

  const ranks = new Map<string, number>();
  const singleRanks = new Map<string, number>();
  for (const { pair, strength } of ranked) {
    const aRank = (ranks.get(pair.a) ?? 0) + 1;
    const bRank = (ranks.get(pair.b) ?? 0) + 1;
    if (aRank > LINK_CAP || bRank > LINK_CAP) continue;
    if (strength === 0) {
      const aSingle = (singleRanks.get(pair.a) ?? 0) + 1;
      const bSingle = (singleRanks.get(pair.b) ?? 0) + 1;
      if (aSingle > SINGLE_LINK_CAP || bSingle > SINGLE_LINK_CAP) continue;
      singleRanks.set(pair.a, aSingle);
      singleRanks.set(pair.b, bSingle);
    }
    ranks.set(pair.a, aRank);
    ranks.set(pair.b, bRank);
    pair.from = Math.min(pair.from, end);
  }
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

export function windowLinks(
  cast: PassCast,
  units: readonly PassUnit[],
  relations: readonly SceneLinkPair[] = [],
  quiet: (ordinal: number) => boolean = () => false,
  card: (ordinal: number) => boolean = () => false,
): XrayLinkSnapshot[] {
  const at = new Map<number, string[]>();
  const heads = new Set(cast.heads);
  const mentions = new Map<string, EntryMentions>();
  // Sum of entry episodes, so an episode involving several entries contributes once per entry.
  let totalEpisodes = 0;
  for (const [head, ordinals] of cast.headMentions())
    for (const ordinal of ordinals) {
      const keys = at.get(ordinal);
      if (keys) keys.push(head.key);
      else at.set(ordinal, [head.key]);
    }

  const pairs = new Map<string, WindowPair>();
  const candidates = new Set<WindowPair>();
  let hitOrder = 0;
  const pairOf = (x: string, y: string) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    const id = `${a}|${b}`;
    let pair = pairs.get(id);
    if (!pair) {
      pair = {
        a,
        b,
        count: 0,
        last: -Infinity,
        hitsA: { count: 0, last: -Infinity },
        hitsB: { count: 0, last: -Infinity },
        together: 0,
        cards: 0,
        first: Infinity,
        firstCard: Infinity,
        hitOrder: 0,
        from: Infinity,
      };
      pairs.set(id, pair);
    }
    return pair;
  };

  const recent = new Map<string, number[]>();
  let index = 0;
  for (const unit of units) {
    const previousTotal = totalEpisodes;
    let admissionChanged = false;
    for (const ordinal of unit.ordinals) {
      index++;
      for (const [key, indexes] of recent) {
        if (index - indexes[0] > PAIR_WINDOW) indexes.shift();
        if (indexes.length === 0) recent.delete(key);
      }
      const named = at.get(ordinal);
      if (!named) continue;
      const quietLine = quiet(ordinal);

      for (const key of named) {
        let episodes = mentions.get(key);
        if (!episodes) {
          episodes = { count: 0, last: -Infinity, total: 0, quiet: 0 };
          mentions.set(key, episodes);
        }
        const wasStatHeavy = statHeavy(episodes);
        episodes.total++;
        if (quietLine) episodes.quiet++;
        if (wasStatHeavy !== statHeavy(episodes)) admissionChanged = true;
        if (quietLine) continue;

        if (recordEpisode(episodes, index)) totalEpisodes++;
        const indexes = recent.get(key);
        if (indexes) indexes.push(index);
        else recent.set(key, [index]);
      }
      if (quietLine) {
        if (named.length >= 2 && card(ordinal)) {
          for (const [i, key] of named.entries()) {
            for (let j = i + 1; j < named.length; j++) {
              const pair = pairOf(key, named[j]);
              if (++pair.cards === 1) {
                pair.firstCard = ordinal;
                candidates.add(pair);
                admissionChanged = true;
              }
            }
          }
        }
        continue;
      }

      for (const key of named) {
        const currentIndexes = recent.get(key)!;
        for (const [other, indexes] of recent) {
          const together = indexes.at(-1) === index;
          if (key === other || (together && key > other)) continue;
          const pair = pairOf(key, other);
          if (together && ++pair.together === 1) {
            candidates.add(pair);
            admissionChanged = true;
          }
          const wasDense = denseScene(pair);
          if (pair.count === 0) pair.first = ordinal;
          if (recordEpisode(pair, index) && pair.count >= 2) admissionChanged = true;
          const [hits, otherHits] = key === pair.a ? [pair.hitsA, pair.hitsB] : [pair.hitsB, pair.hitsA];
          // A new mention can give several earlier sentences their first hit.
          recordHits(hits, currentIndexes);
          recordHits(otherHits, indexes);
          if (pair.hitOrder === 0 && Math.max(pair.hitsA.count, pair.hitsB.count) >= 2) {
            pair.hitOrder = ++hitOrder;
            candidates.add(pair);
          }
          if (!wasDense && denseScene(pair)) admissionChanged = true;
        }
      }
    }

    const end = unit.ordinals.at(-1)!;
    if (admissionChanged || totalEpisodes !== previousTotal) admitPairs(candidates, mentions, totalEpisodes, end);
    if (unit.sectionEnd) recent.clear();
  }

  for (const relation of relations) {
    const a = cast.headOf(relation.a, relation.cite);
    const b = cast.headOf(relation.b, relation.cite);
    if (a === b || !heads.has(a) || !heads.has(b)) continue;
    const pair = pairOf(a.key, b.key);
    pair.from = Math.min(pair.from, relation.cite);
  }

  const top = new Map<string, number>();
  for (const { a, b, count } of pairs.values()) {
    top.set(a, Math.max(top.get(a) ?? 0, count));
    top.set(b, Math.max(top.get(b) ?? 0, count));
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
