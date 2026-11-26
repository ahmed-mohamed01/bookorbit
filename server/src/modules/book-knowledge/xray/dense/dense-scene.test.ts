import { Logger } from '@nestjs/common';
import type { Sentence } from '../../core/model';
import { PassCast, type PassSlot } from '../pass/pass-cast';
import { PassState } from '../pass/pass-state';
import type { PassUnit } from '../pass/pass-units';
import { entity } from '../xray-fixtures.testing';
import { XrayPrivacy, XrayStepRun } from '../xray-runner';
import { SceneRelations, SceneSame } from './dense-scene';

const unit: PassUnit = { id: 'u1', index: 0, s: 0, ordinals: [1, 2, 3], sectionEnd: true };
const sentences: Sentence[] = [1, 2, 3].map((ordinal) => ({
  text: 'Viv, Fern and Pell talk.',
  ordinal,
  spineIndex: 0,
  paragraphIndex: ordinal,
  href: 'a.xhtml',
  structure: 'body',
  heading: false,
  emphasis: [],
}));

function applied(record: (relations: SceneRelations, a: PassSlot, b: PassSlot) => void) {
  const viv = entity('viv', 'character', [1, 2, 3]);
  const fern = entity('fern', 'character', [1, 2, 3]);
  const cast = new PassCast([viv, fern]);
  const [a, b] = cast.slots(unit);
  const relations = new SceneRelations();
  record(relations, a, b);
  const state = new PassState();
  const logger = new Logger('test');
  vi.spyOn(logger, 'log').mockImplementation(() => undefined);
  const step = new XrayStepRun('ties', 'fast', new XrayPrivacy(sentences), logger, 'runId=r');
  relations.apply(cast, state, step);
  return { ties: state.ties.map((tie) => [tie.value.type, tie.value.cite]), counts: step.record.counts };
}

describe('scene relations', () => {
  it('keeps every cited type of a pair in chunk order', () => {
    const { ties, counts } = applied((relations, a, b) => {
      relations.record(unit, [{ a, b, type: 'friend_of', sentence: 'Viv and Fern are friends.', cite: 1 }]);
      relations.record(unit, [{ a, b, type: 'enemy_of', sentence: 'Viv hates Fern.', cite: 2 }]);
      relations.record(unit, [{ a: b, b: a, type: 'friend_of', sentence: 'Fern and Viv are friends.', cite: 3 }]);
    });
    expect(ties).toEqual([
      ['friend_of', 1],
      ['enemy_of', 2],
      ['friend_of', 3],
    ]);
    expect(counts).toBeUndefined();
  });

  it('keeps a one-way type only in the direction more chunks gave', () => {
    const { ties, counts } = applied((relations, a, b) => {
      relations.record(unit, [{ a: b, b: a, type: 'parent_of', sentence: 'Fern raised Viv.', cite: 1 }]);
      relations.record(unit, [{ a, b, type: 'parent_of', sentence: 'Viv is the mother of Fern.', cite: 2 }]);
      relations.record(unit, [
        { a, b, type: 'parent_of', sentence: 'Viv bore Fern.', cite: 3 },
        { a, b, type: 'loves', sentence: 'Viv loves Fern.', cite: 3 },
        { a: b, b: a, type: 'loves', sentence: 'Fern loves Viv.', cite: 3 },
      ]);
    });
    expect(ties).toEqual([
      ['parent_of', 2],
      ['parent_of', 3],
      ['loves', 3],
      ['loves', 3],
    ]);
    expect(counts).toEqual({ 'ties:contradicted': 1 });
  });

  it('breaks an even split by the earlier cite', () => {
    const { ties } = applied((relations, a, b) => {
      relations.record(unit, [{ a: b, b: a, type: 'parent_of', sentence: 'Fern raised Viv.', cite: 1 }]);
      relations.record(unit, [{ a, b, type: 'parent_of', sentence: 'Viv is the mother of Fern.', cite: 2 }]);
    });
    expect(ties).toEqual([['parent_of', 1]]);
  });
});

describe('scene same cites and guards', () => {
  const book = (texts: Record<number, string>, length: number): Sentence[] =>
    Array.from({ length }, (_, index) => ({
      ...sentences[0],
      ordinal: index + 1,
      paragraphIndex: index + 1,
      text: texts[index + 1] ?? 'Rain fell.',
    }));
  const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const chunkOf = (ordinals: number[]): PassUnit => ({ id: 'c', index: 0, s: 0, ordinals, sectionEnd: true });

  /** Two votes, one per chunk, each citing the given sentence of its chunk. */
  function voted(entities: ReturnType<typeof entity>[], text: Record<number, string>, votes: [number[], number | null][]) {
    const cast = new PassCast(entities);
    const all = book(text, 60);
    const [a, b] = cast.slots(chunkOf(span(1, 60)));
    const same = new SceneSame();
    const counts = votes.map(([ordinals, cite]) => same.apply(cast, chunkOf(ordinals), [{ a, b, cite }], all));
    return { cast, counts };
  }

  it('keeps two named characters apart when both have 20 mentions by the chunk, even with few inside it', () => {
    const viv = entity('viv', 'character', [...span(1, 25), 41], { name: 'Viv' });
    const emeric = entity('emeric', 'character', [...span(1, 25), 41, 51], { name: 'Emeric' });
    const said = { 41: 'Viv was Emeric all along.', 51: 'Emeric, also Viv, nodded.' };
    const { cast, counts } = voted([viv, emeric], said, [
      [span(40, 45), 41],
      [span(50, 55), 51],
    ]);
    expect(counts.at(-1)).toEqual({ 'scene:same-guard': 1 });
    expect(cast.merges).toEqual([]);
  });

  it('drops a vote whose cited sentence names one side only, or that has no cite', () => {
    const viv = entity('viv', 'character', [2, 3, 12], { name: 'Viv' });
    const grace = entity('grace', 'character', [3, 12], { name: 'Grace' });
    const said = { 2: 'Viv is tired.', 3: 'Viv, known as Grace, sat.', 12: 'Grace was Viv.' };
    const { cast, counts } = voted([viv, grace], said, [
      [span(1, 5), 2],
      [span(10, 14), null],
      [span(20, 24), 3],
    ]);
    expect(counts).toEqual([{ 'scene:same-not-stated': 1 }, { 'scene:same-not-stated': 1 }, { 'scene:same-not-stated': 1 }]);
    expect(cast.merges).toEqual([]);
  });

  it.each([
    ['a lowercase plural', 'character', 'citizens'],
    ['a collective name', 'character', 'Imperial Family'],
    ['an entry of another kind', 'group', 'Guild'],
  ] as const)('never merges %s into a person', (_, kind, name) => {
    const viv = entity('viv', 'character', [2, 12], { name: 'Viv' });
    const group = entity('group', kind, [2, 12], { name });
    const said = { 2: `Viv was ${name}.`, 12: `${name} were Viv.` };
    const { cast, counts } = voted([viv, group], said, [
      [span(1, 5), 2],
      [span(10, 14), 12],
    ]);
    expect(counts).toEqual([{}, { 'scene:same-kind': 1 }]);
    expect(cast.merges).toEqual([]);
  });

  it.each(['Grace', 'the Black Hedge Witch'])('merges the nickname %s cited twice in a sentence naming both', (name) => {
    const viv = entity('viv', 'character', [1, 2, 3, 12], { name: 'Viv' });
    const nick = entity('nick', 'character', [2, 12], { name });
    const said = { 2: `Viv, known as ${name}, sat.`, 12: `${name} is Viv.` };
    const { cast, counts } = voted([viv, nick], said, [
      [span(1, 5), 2],
      [span(10, 14), 12],
    ]);
    expect(counts).toEqual([{}, { 'scene:same-merge': 1 }]);
    expect(cast.merges).toEqual([{ head: viv, member: nick, ordinal: 14, rule: 'alias', reason: 'scene-same' }]);
  });

  it('merges a nonfiction term into the one a cited sentence names it as', () => {
    const term = entity('term', 'idea', [2, 3, 12, 13], { name: 'superintelligence' });
    const ai = entity('ai', 'idea', [2, 12], { name: 'superintelligent AI' });
    const said = { 2: 'Superintelligence, or superintelligent AI, is the goal.', 12: 'A superintelligent AI is a superintelligence.' };
    const { cast, counts } = voted([term, ai], said, [
      [span(1, 5), 2],
      [span(10, 14), 12],
    ]);
    expect(counts).toEqual([{}, { 'scene:same-merge': 1 }]);
    expect(cast.merges[0]).toMatchObject({ head: term, member: ai });
  });
});
