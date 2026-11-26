import { COLLECTIVE } from './dense-collective';
import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import type { PassTie } from '../pass/pass-read';
import type { PassState } from '../pass/pass-state';
import type { XrayStepRun } from '../xray-runner';
import type { Rejections } from '../xray-checks';
import { namedFirst, NARRATOR_ID, type PassCast, type PassSlot } from '../pass/pass-cast';
import type { PassUnit } from '../pass/pass-units';
import type { Sentence } from '../../core/model';
import { SAME, type SceneSamePair } from './dense-read';

const CUMULATIVE_ROSTER = 30;
const CHUNK_ROSTER = 25;
const NONFICTION_ROSTER = 40;
const MAIN_MENTIONS = 20;
/** The vote rests on a sentence of the chunk that names both entries and says they are one, as a facts merge does. */
function stated({ a, b, cite }: SceneSamePair, chunk: PassUnit, sentences: readonly Sentence[]): boolean {
  if (cite === null || !chunk.ordinals.includes(cite)) return false;
  const line = sentences[cite - 1].text.toLowerCase();
  const named = (slot: PassSlot) => [slot.name, ...slot.aliases].some((name) => line.includes(name.toLowerCase()));
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

export class SceneSame {
  // A null records a pair already decided on its second vote, even if a guard blocked the merge.
  private readonly votes = new Map<string, number | null>();

  apply(cast: PassCast, chunk: PassUnit, pairs: readonly SceneSamePair[], sentences: readonly Sentence[]): Rejections {
    const counts: Rejections = {};
    // The chunk's last sentence, since a reveal anywhere in it may be what the vote rests on.
    const ordinal = chunk.ordinals.at(-1)!;
    for (const pair of pairs) {
      const { a, b } = pair;
      const left = cast.headOf(a.member ?? a.head);
      const right = cast.headOf(b.member ?? b.head);
      if (left === right) continue;
      if (!stated(pair, chunk, sentences)) {
        counts['scene:same-not-stated'] = (counts['scene:same-not-stated'] ?? 0) + 1;
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
        counts['scene:same-kind'] = (counts['scene:same-kind'] ?? 0) + 1;
        continue;
      }
      const leftCount = cast.mentionsOf({ ...a, head: left, member: null }, chunk).length;
      const rightCount = cast.mentionsOf({ ...b, head: right, member: null }, chunk).length;
      const mainCharacters = left.kind === 'character' && right.kind === 'character' && leftCount >= MAIN_MENTIONS && rightCount >= MAIN_MENTIONS;
      if (mainCharacters) {
        counts['scene:same-guard'] = (counts['scene:same-guard'] ?? 0) + 1;
        continue;
      }
      const [member, head] = namedFirst(left, right, () =>
        leftCount < rightCount || (leftCount === rightCount && left.id > right.id) ? [left, right] : [right, left],
      );
      if (cast.merge({ member, head, ordinal, rule: 'alias', reason: 'scene-same' })) {
        counts['scene:same-merge'] = (counts['scene:same-merge'] ?? 0) + 1;
      }
    }
    return counts;
  }
}

// Asymmetric types that cannot also hold the other way round; `loves`, `teaches` or `leads_to` can.
const ONE_WAY = new Set(['parent_of', 'grandparent_of', 'aunt_or_uncle_of', 'part_of', 'kind_of', 'example_of']);

export class SceneRelations {
  private readonly chunks: { unit: PassUnit; ties: readonly PassTie[] }[] = [];

  record(unit: PassUnit, ties: readonly PassTie[]): void {
    if (ties.length) this.chunks.push({ unit, ties });
  }

  /**
   * Every cited type of a pair is kept, in chunk order. A vote of chunks only settles a one-way type
   * given both ways round: the direction fewer chunks gave, or the later-cited one on a tie, is dropped.
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
    let contradicted = 0;
    for (const { unit, ties } of this.chunks) {
      for (const tie of ties) {
        const [a, b] = [headKey(tie, 'a'), headKey(tie, 'b')];
        if (a === b) continue;
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
  }
}
