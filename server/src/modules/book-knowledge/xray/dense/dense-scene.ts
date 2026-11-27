import { COLLECTIVE } from './dense-collective';
import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import type { PassTie } from '../pass/pass-read';
import type { PassState } from '../pass/pass-state';
import type { XrayStepRun } from '../xray-runner';
import type { Rejections } from '../xray-checks';
import { namedFirst, NARRATOR_ID, type PassCast, type PassSlot } from '../pass/pass-cast';
import type { PassUnit } from '../pass/pass-units';
import type { Sentence } from '../../core/model';
import { bounded, SAME, type SceneSamePair } from './dense-read';

const CUMULATIVE_ROSTER = 30;
const CHUNK_ROSTER = 25;
const NONFICTION_ROSTER = 40;
const MAIN_MENTIONS = 20;
/** The vote rests on a sentence of the chunk that names both entries as whole words and says they are one. */
function stated({ a, b, cite }: SceneSamePair, chunk: PassUnit, sentences: readonly Sentence[]): boolean {
  if (cite === null || !chunk.ordinals.includes(cite)) return false;
  const line = sentences[cite - 1].text;
  const named = (slot: PassSlot) => [slot.name, ...slot.aliases].some((name) => bounded(name, 'iu').test(line));
  return named(a) && named(b) && SAME.test(line);
}

export function sceneRoster(cast: PassCast, chunk: PassUnit, mode: BookKnowledgeXrayMode): PassSlot[] {
  const ranked = (slots: PassSlot[], limit: number) =>
    slots
      .filter((slot) => !slot.member && slot.id !== NARRATOR_ID)
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, limit);
  const chapter = ranked(cast.slots(chunk, [1, chunk.ordinals.at(-1)!]), mode === 'nonfiction' ? NONFICTION_ROSTER : CUMULATIVE_ROSTER);
  const local = ranked(cast.slots(chunk), mode === 'nonfiction' ? NONFICTION_ROSTER : CHUNK_ROSTER);
  return [...new Map([...chapter, ...local].map((slot) => [slot.id, slot])).values()];
}

/**
 * "Same" votes from the scene and facts asks: a pair joins on its second vote from another chunk, never two kinds, a
 * group, or two leads. Each vote's entries are passed as named, so a member whose own join is still ahead joins no earlier.
 */
export class SceneSame {
  // A null records a pair already decided on its second vote, even if a guard blocked the merge.
  private readonly votes = new Map<string, number | null>();

  apply(cast: PassCast, chunk: PassUnit, pairs: readonly SceneSamePair[], sentences: readonly Sentence[], source = 'scene'): Rejections {
    const counts: Rejections = {};
    const count = (reason: string) => (counts[`${source}:${reason}`] = (counts[`${source}:${reason}`] ?? 0) + 1);
    // The chunk's last sentence, since a reveal anywhere in it may be what the vote rests on.
    const ordinal = chunk.ordinals.at(-1)!;
    for (const pair of pairs) {
      const { a, b } = pair;
      const [ownA, ownB] = [a.member ?? a.head, b.member ?? b.head];
      const left = cast.headOf(ownA);
      const right = cast.headOf(ownB);
      if (left === right) continue;
      if (!stated(pair, chunk, sentences)) {
        count('same-not-stated');
        continue;
      }
      const key = JSON.stringify([left.id, right.id].sort());
      const first = this.votes.get(key);
      if (first === undefined) {
        this.votes.set(key, ordinal);
        continue;
      }
      if (first === ordinal || first === null) continue;
      this.votes.set(key, null);
      if (left.kind !== right.kind || [left, right, a, b].some(({ name }) => COLLECTIVE.test(name))) {
        count('same-kind');
        continue;
      }
      const leftCount = cast.mentionsOf({ ...a, head: left, member: null }, chunk).length;
      const rightCount = cast.mentionsOf({ ...b, head: right, member: null }, chunk).length;
      const mainCharacters = left.kind === 'character' && right.kind === 'character' && leftCount >= MAIN_MENTIONS && rightCount >= MAIN_MENTIONS;
      if (mainCharacters) {
        count('same-guard');
        continue;
      }
      const [member] = namedFirst(left, right, () =>
        leftCount < rightCount || (leftCount === rightCount && left.id > right.id) ? [left, right] : [right, left],
      );
      const [from, to] = member === left ? [ownA, ownB] : [ownB, ownA];
      if (cast.merge({ member: from, head: to, ordinal, rule: 'alias', reason: `${source}-same` })) count('same-merge');
    }
    return counts;
  }
}

// Asymmetric types that cannot also hold the other way round; `loves`, `teaches` or `leads_to` can.
const ONE_WAY = new Set(['parent_of', 'grandparent_of', 'aunt_or_uncle_of', 'part_of', 'kind_of', 'example_of']);
/** How two people feel about each other: one answer a pair, the one most chunks gave. */
const FEELINGS = new Set(['loves', 'bonded_to', 'friend_of', 'enemy_of', 'rival_of']);
/** A type one chunk gave is a stray guess once another type of the pair has this many chunks behind it. */
const SETTLED_CHUNKS = 3;

/** The pair's types the chunk vote throws out, as "type|a|b" keys with the pair's sides in sorted order. */
function outvoted(votes: ReadonlyMap<string, Map<string, { chunks: Set<number>; first: number; sides: string }>>): Set<string> {
  const out = new Set<string>();
  for (const [pair, types] of votes) {
    const ranked = [...types].sort(([, x], [, y]) => y.chunks.size - x.chunks.size || x.first - y.first);
    const strongest = ranked[0][1].chunks.size;
    const feeling = ranked.find(([type]) => FEELINGS.has(type))?.[0];
    for (const [type, vote] of ranked) {
      if ((vote.chunks.size === 1 && strongest >= SETTLED_CHUNKS) || (FEELINGS.has(type) && type !== feeling)) out.add(`${type}|${pair}`);
      // Serving a group one belongs to says no more than belonging to it.
      if (type === 'works_for' && types.get('member_of')?.sides === vote.sides) out.add(`${type}|${pair}`);
    }
  }
  return out;
}

export class SceneRelations {
  private readonly chunks: { unit: PassUnit; ties: readonly PassTie[] }[] = [];

  record(unit: PassUnit, ties: readonly PassTie[]): void {
    if (ties.length) this.chunks.push({ unit, ties });
  }

  /**
   * A pair's cited types are kept in chunk order, after a vote of chunks: a one-way type given both ways round keeps the
   * direction more chunks gave (the earlier cite on a tie), a pair keeps one feeling (friend, enemy, bond...), a type one
   * chunk gave goes once another has three, and serving a group goes when belonging to it is there.
   */
  apply(cast: PassCast, state: PassState, step: XrayStepRun): void {
    const headKey = (tie: PassTie, side: 'a' | 'b') => cast.headOf(tie[side].member ?? tie[side].head).key;
    const directions = new Map<string, Map<string, { chunks: Set<number>; cite: number }>>();
    this.chunks.forEach(({ ties }, index) => {
      for (const tie of ties) {
        if (!ONE_WAY.has(tie.type)) continue;
        const [a, b] = [headKey(tie, 'a'), headKey(tie, 'b')];
        if (a === b) continue;
        const key = JSON.stringify([tie.type, ...[a, b].sort()]);
        const sides = directions.get(key) ?? new Map<string, { chunks: Set<number>; cite: number }>();
        const side = sides.get(a) ?? { chunks: new Set<number>(), cite: tie.cite };
        side.chunks.add(index);
        side.cite = Math.min(side.cite, tie.cite);
        sides.set(a, side);
        directions.set(key, sides);
      }
    });
    const losers = new Set<string>();
    for (const [key, sides] of directions) {
      if (sides.size < 2) continue;
      const [, loser] = [...sides].sort(([, x], [, y]) => y.chunks.size - x.chunks.size || x.cite - y.cite);
      losers.add(JSON.stringify([key, loser[0]]));
    }
    const votes = new Map<string, Map<string, { chunks: Set<number>; first: number; sides: string }>>();
    this.chunks.forEach(({ ties }, index) => {
      for (const tie of ties) {
        const [a, b] = [headKey(tie, 'a'), headKey(tie, 'b')];
        if (a === b) continue;
        const pair = [a, b].sort().join('|');
        const types = votes.get(pair) ?? new Map<string, { chunks: Set<number>; first: number; sides: string }>();
        const vote = types.get(tie.type) ?? { chunks: new Set<number>(), first: index, sides: `${a}>${b}` };
        vote.chunks.add(index);
        types.set(tie.type, vote);
        votes.set(pair, types);
      }
    });
    const thrown = outvoted(votes);
    let contradicted = 0;
    let dropped = 0;
    for (const { unit, ties } of this.chunks) {
      for (const tie of ties) {
        const [a, b] = [headKey(tie, 'a'), headKey(tie, 'b')];
        if (a === b) continue;
        if (thrown.has(`${tie.type}|${[a, b].sort().join('|')}`)) {
          dropped++;
          continue;
        }
        if (ONE_WAY.has(tie.type) && losers.has(JSON.stringify([JSON.stringify([tie.type, ...[a, b].sort()]), a]))) {
          contradicted++;
          continue;
        }
        state.slots.set(tie.a.id, state.slots.get(tie.a.id) ?? tie.a);
        state.slots.set(tie.b.id, state.slots.get(tie.b.id) ?? tie.b);
        state.addTie(unit, tie);
      }
    }
    if (contradicted) step.tally('counts', { 'ties:contradicted': contradicted });
    if (dropped) step.tally('counts', { 'ties:outvoted': dropped });
  }
}
