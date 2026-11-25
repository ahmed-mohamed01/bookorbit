import { expect, it } from 'vitest';
import type { Artifact } from './model';
import { selectEvidence } from './evidence';
import { retrieve } from '../book-knowledge-retrieval';
function fixture(): Artifact {
  return {
    formatVersion: 1,
    textVersion: 1,
    termsVersion: 1,
    fingerprint: '',
    seeds: [],
    sentences: [
      'The ember mesh is defined as follows:',
      'It catches sparks inside sealed jars.',
      'The spark net stores drifting sparks.',
      'The hidden net catches distant sparks.',
    ].map((text, index) => ({
      text,
      ordinal: index + 1,
      spineIndex: 0,
      paragraphIndex: index,
      href: 'invented.xhtml',
      structure: 'body',
      heading: false,
      emphasis: [],
    })),
    terms: ['ember mesh', 'spark net', 'hidden net'].map((key, index) => ({
      key,
      rarity: 1,
      wordCount: 2,
      deltas: [index === 0 ? 1 : index + 2],
      features: [{ alias: key, definition: true, capitalized: false, person: false, place: false, nested: false, structural: false }],
    })),
    aliasLinks: [
      { left: 'ember mesh', right: 'spark net', ordinal: 3 },
      { left: 'ember mesh', right: 'hidden net', ordinal: 4 },
    ],
  };
}
it('expands colon leads only within the cutoff and chapter', () => {
  const data = fixture();
  expect(selectEvidence(data, 'ember mesh', 1)[0].ordinals).toEqual([1]);
  expect(selectEvidence(data, 'ember mesh', 2)[0].ordinals).toEqual([1, 2]);
  data.sentences[1].spineIndex = 1;
  expect(selectEvidence(data, 'ember mesh', 2)[0].ordinals).toEqual([1]);
});
it('retrieves visible alias groups without activating future aliases', () => {
  const data = fixture();
  expect(selectEvidence(data, 'spark net', 3).flatMap((p) => p.ordinals)).toContain(1);
  expect(selectEvidence(data, 'ember mesh', 3).flatMap((p) => p.ordinals)).toContain(3);
  expect(selectEvidence(data, 'hidden net', 3)).toEqual([]);
  expect(selectEvidence(data, 'ember mesh', 3).every((p) => p.ordinals.every((ordinal) => ordinal <= 3))).toBe(true);
});
it('gives repeated passages only one slot', () => {
  const data = fixture();
  data.terms = [];
  data.aliasLinks = [];
  ['Sparks.', 'Sparks.', 'Sparks fill sealed jars.', 'Sparks.'].forEach((text, i) => {
    data.sentences[i].text = text;
    data.sentences[i].spineIndex = i;
  });
  const passages = retrieve(data, 4, 'sparks sealed jars');
  expect(passages.filter((p) => p.text === 'Sparks.')).toHaveLength(1);
  expect(passages.some((p) => p.text.includes('sealed jars'))).toBe(true);
});
it('reserves first and latest ahead of early definitions', () => {
  const data = fixture();
  data.aliasLinks = [];
  const base = data.sentences[0];
  data.sentences = Array.from({ length: 16 }, (_, i) => ({
    ...base,
    ordinal: i + 1,
    paragraphIndex: i,
    spineIndex: i < 15 ? 0 : 1,
    text: `The ember mesh is a vessel that holds quiet sparks inside a sealed chamber while the turning rings measure each pulse and keep the current steady at marker ${i}.`,
  }));
  const term = data.terms[0];
  data.terms = [
    { ...term, deltas: Array(16).fill(1), features: Array.from({ length: 16 }, (_, i) => ({ ...term.features[0], definition: i < 15 })) },
  ];
  const passages = selectEvidence(data, 'ember mesh', 16);
  expect(passages[0].ordinals).toContain(1);
  expect(passages.at(-1)!.ordinals).toContain(16);
  expect(selectEvidence(data, 'ember mesh', 15).flatMap((p) => p.ordinals)).not.toContain(16);
});
