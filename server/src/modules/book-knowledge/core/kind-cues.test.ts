import { describe, expect, it } from 'vitest';
import { annotateKindCues, bodyText, CUE, locateAlias, mentionCues } from './kind-cues';
import type { Sentence, Term } from './model';

function sentence(ordinal: number, text: string, structure: Sentence['structure'] = 'body'): Sentence {
  return { ordinal, text, spineIndex: 0, paragraphIndex: ordinal, href: 'invented.xhtml', structure, heading: false, emphasis: [] };
}

describe('kind cues', () => {
  it('finds whole-word occurrences in order', () => {
    expect(locateAlias('Veyran met Veyra, then Veyra left.', 'Veyra', 0)).toBe(11);
    expect(locateAlias('Veyran met Veyra, then Veyra left.', 'Veyra', 1)).toBe(23);
    expect(locateAlias('Veyran met Veyra.', 'Veyra', 1)).toBe(-1);
  });

  it('reads class, plural and bracket cues from the mention sentence only', () => {
    const cues = (text: string, alias: string, key: string) => {
      const start = locateAlias(text, alias, 0);
      return mentionCues(text, start, start + alias.length, key);
    };
    expect(cues('She met a Warden at noon.', 'Warden', 'warden')).toBe(CUE.classDeterminer | CUE.indefinite);
    expect(cues('Several Wardens were there.', 'Wardens', 'warden')).toBe(CUE.classDeterminer | CUE.plural | CUE.pluralFollower);
    expect(cues('A sign read [Lost lamp] today.', 'Lost lamp', 'lost lamp')).toBe(CUE.bracket);
    expect(mentionCues('The Warden spoke.', 4, 10, 'warden')).toBe(0);
  });

  it('labels a mention with the span that contains it and the span availability', () => {
    const sentences = [sentence(1, 'Front matter.', 'front'), sentence(2, 'Veyra rode out.'), sentence(3, 'Then Veyra returned.')];
    const body = bodyText(sentences);
    expect(body.text).toBe('Veyra rode out.\nThen Veyra returned.');
    const terms: Term[] = [
      {
        key: 'veyra',
        rarity: 1,
        wordCount: 1,
        deltas: [2, 1],
        features: [
          { alias: 'Veyra', definition: false, capitalized: false, person: false, place: false, nested: false, structural: false },
          { alias: 'Veyra', definition: false, capitalized: true, person: false, place: false, nested: false, structural: false },
        ],
      },
    ];
    annotateKindCues(sentences, terms, [0, 5, 0, 2, 21, 26, 9, 3]);
    expect(terms[0].features.map((feature) => [feature.kindLabel, feature.kindAt])).toEqual([
      [0, 2],
      [9, 3],
    ]);
  });
});
