import type { Sentence } from '../../core/model';
import { entity } from '../xray-fixtures.testing';
import { xrayPayload } from '../xray-payload';
import { PassCast, patternMerges } from './pass-cast';
import type { PassUnit } from './pass-units';

const span = (from: number, to: number): PassUnit => ({
  id: 'u',
  index: 0,
  s: 0,
  ordinals: Array.from({ length: to - from + 1 }, (_, index) => from + index),
  sectionEnd: true,
});
const person = (id: string, name: string, ordinals: number[]) =>
  entity(id, 'character', ordinals, { name, names: [{ text: name, ordinal: ordinals[0] }] });

describe('join chains', () => {
  it('joins a merge onto a name already joined later only from that later join', () => {
    const varn = person('v', 'Varn', [8990, 9000]);
    const stranger = person('s', 'the stranger', [100, 1500, 9000]);
    const hooded = person('h', 'the hooded man', [1990, 2000]);
    const cast = new PassCast([varn, stranger, hooded]);
    cast.merge({ member: stranger, head: varn, ordinal: 9000, rule: 'alias' });
    cast.merge({ member: hooded, head: stranger, ordinal: 2000, rule: 'model' });
    expect(cast.headOf(hooded, 2500)).toBe(hooded);
    expect(cast.headOf(hooded, 9000)).toBe(varn);
    expect(varn.joins.map((join) => [join.name, join.ordinal])).toEqual([
      ['the stranger', 9000],
      ['the hooded man', 9000],
    ]);
    const slots = cast.slots(span(1990, 2100));
    expect(slots.find((slot) => slot.id === 'v')).toBeUndefined();
    expect(slots.map((slot) => [slot.id, slot.member?.id])).toEqual([['h', 'h']]);
  });

  it("files a member under the member it joined first until that member's own join", () => {
    const cora = person('c', 'Cora', [400, 500]);
    const bee = person('b', 'Bee', [50, 100, 500]);
    const emmy = person('m', 'Emmy', [90, 100, 250]);
    const cast = new PassCast([cora, bee, emmy]);
    cast.merge({ member: emmy, head: bee, ordinal: 100, rule: 'alias' });
    cast.merge({ member: bee, head: cora, ordinal: 500, rule: 'alias' });
    const unit = span(201, 300);
    const slots = cast.slots(unit);
    expect(slots.map((slot) => [slot.id, slot.member?.id ?? null, slot.aliases, slot.mentions])).toEqual([['b', 'b', ['Emmy'], 1]]);
    expect(cast.mentionsOf(slots[0], unit)).toEqual([50, 90, 100, 250]);
    const head = { id: 'c', head: cora, member: null, name: 'Cora', aliases: [], kind: 'character' as const, mentions: 0 };
    expect(cast.mentionsOf(head, unit)).toEqual([]);
    expect(cast.mentionsOf(head, span(450, 520))).toEqual([50, 90, 100, 250, 400, 500]);
  });

  it("ships the reveal as the payload's join point in either merge order", () => {
    for (const order of [0, 1]) {
      const varn = person('v', 'Varn', [9000]);
      const stranger = person('s', 'the stranger', [100, 9000]);
      const hooded = person('h', 'the hooded man', [2000]);
      const cast = new PassCast([varn, stranger, hooded]);
      const merges = [
        { member: stranger, head: varn, ordinal: 9000, rule: 'alias' as const },
        { member: hooded, head: stranger, ordinal: 2000, rule: 'alias' as const },
      ];
      for (const merge of order ? [...merges].reverse() : merges) cast.merge(merge);
      const payload = xrayPayload(
        {
          fingerprint: 'f',
          builtAt: 'b',
          language: 'en',
          models: {},
          coverage: 1,
          sections: [],
          entities: [varn],
          ties: [],
          lines: [],
          facts: [],
          summaries: [],
          links: [],
        },
        (n) => ({ s: 0, n, o: n, q: '' }),
      );
      expect(payload.entities[0].joins.map((join) => [join.name, 'o' in join.at ? join.at.o : null])).toEqual(
        expect.arrayContaining([
          ['the stranger', 9000],
          ['the hooded man', 9000],
        ]),
      );
    }
  });

  it('tells from where a sentence names an entry through its members', () => {
    const varn = person('v', 'Varn', [9000]);
    const stranger = person('s', 'the stranger', [2000, 9000]);
    const cast = new PassCast([varn, stranger]);
    cast.merge({ member: stranger, head: varn, ordinal: 9000, rule: 'alias' });
    expect(cast.namedFrom(varn, 2000)).toBe(9000);
    expect(cast.namedFrom(stranger, 2000)).toBe(2000);
    expect(cast.namedFrom(varn, 9000)).toBe(9000);
    expect(cast.namedFrom(varn, 1234)).toBe(Infinity);
  });
});

describe('short-name pattern merges', () => {
  const book = (paragraphs: number[]): Sentence[] =>
    paragraphs.map((paragraphIndex, index) => ({
      ordinal: index + 1,
      spineIndex: 0,
      paragraphIndex,
      href: 'x.xhtml',
      text: `Line ${index + 1}.`,
      structure: 'body' as const,
      heading: false,
      emphasis: [],
    }));

  it('joins a short form given once beside its full name, not two people who share their scenes', () => {
    const sentences = book([1, 2, 3, 4, 5, 6, 7, 8]);
    const viv = person('viv', 'Viv', [1, 3, 5, 7]);
    const viviane = person('viviane', 'Viviane', [1, 8]);
    expect(patternMerges([viv, viviane], sentences).map((merge) => merge.rule)).toEqual(['short-name']);
    const rob = person('rob', 'Rob', [1, 2, 3, 4]);
    const robert = person('robert', 'Robert', [1, 2, 3, 8]);
    expect(patternMerges([rob, robert], sentences)).toEqual([]);
  });
});
