import { Logger } from '@nestjs/common';
import type { Sentence } from '../../core/model';
import { PassCast, type PassSlot } from '../pass/pass-cast';
import { PassState } from '../pass/pass-state';
import type { PassUnit } from '../pass/pass-units';
import { entity } from '../xray-fixtures.testing';
import { XrayPrivacy, XrayStepRun } from '../xray-runner';
import { SceneRelations } from './dense-scene';

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
