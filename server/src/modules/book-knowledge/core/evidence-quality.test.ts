import { describe, expect, it } from 'vitest';
import { selectEvidence } from './evidence';
import { extractTerms } from './term-extractor';
import { retrievalTokens } from './text-utils';
import { answerCharacterBudget } from '../book-knowledge-prompts';
import { paragraphs, retrieve } from '../book-knowledge-retrieval';
import { visibleTerm, visibleTerms } from './artifact';
import type { Artifact, Sentence } from './model';
function fixture(paragraphs: string[][]): Artifact {
  const sentences: Sentence[] = paragraphs.flatMap((paragraph, index) =>
    paragraph.map((text) => ({
      text,
      ordinal: 0,
      spineIndex: 0,
      paragraphIndex: index,
      href: 'invented.xhtml',
      structure: 'body' as const,
      heading: false,
      emphasis: [],
    })),
  );
  sentences.forEach((s, i) => {
    s.ordinal = i + 1;
  });
  return { sentences, terms: extractTerms(sentences), seeds: [], aliasLinks: [], formatVersion: 1, textVersion: 1, termsVersion: 1, fingerprint: '' };
}
describe('evidence quality', () => {
  it('follows a heading through a colon lead-in to the definition, but never past the cutoff', () => {
    const a = fixture([
      ['Amber lattice'],
      ['Ona proposed the amber lattice, which she defines as follows:'],
      ['A mesh woven to catch drifting sparks at night.'],
      ['Unrelated closing remark about weather.'],
    ]);
    a.sentences[0].heading = true;
    a.terms = extractTerms(a.sentences);
    const texts = (cutoff: number) => selectEvidence(a, 'amber lattice', cutoff).map((p) => p.text);
    expect(texts(4).join(' ')).toContain('drifting sparks');
    expect(texts(4).join(' ')).not.toContain('weather');
    expect(texts(2).join(' ')).not.toContain('drifting sparks');
  });
  it('attaches headings and short lead-ins to following body within the cutoff', () => {
    const a = fixture([['Amber lattice'], ['It is a mesh for catching sparks.', 'It keeps the sparks in a sealed jar.']]);
    a.sentences[0].heading = true;
    a.terms = extractTerms(a.sentences);
    expect(selectEvidence(a, 'amber lattice', 1)).toEqual([]);
    expect(selectEvidence(a, 'amber lattice', 3)[0].text).toContain('It keeps the sparks');
    expect(selectEvidence(a, 'amber lattice', 2)[0].ordinals).toEqual([1, 2]);
    a.sentences[1].spineIndex = 1;
    expect(selectEvidence(a, 'amber lattice', 2)).toEqual([]);
    const b = fixture([['Consider the amber lattice.'], ['First, it catches sparks.', 'Second, it holds them in a jar.']]);
    expect(selectEvidence(b, 'amber lattice', 3)[0].ordinals).toEqual([1, 2, 3]);
  });
  it('prioritizes definitions and deduplicates paragraph text', () => {
    const definition =
      'The amber lattice is a folded mesh which catches sparks and stores them safely inside a sealed jar until the keeper opens its narrow mouth.';
    const a = fixture([['We saw the amber lattice.'], [definition], [definition]]);
    expect(selectEvidence(a, 'amber lattice', Infinity, { maxParagraphs: 1 })[0].text).toContain('is a folded mesh');
    const all = selectEvidence(a, 'amber lattice', Infinity);
    expect(new Set(all.map((p) => p.text.toLowerCase())).size).toBe(all.length);
  });
  it('preserves two following sentences and a contrast when trimming', () => {
    const a = fixture([
      [
        'One might think the amber lattice could keep every spark.',
        'The vessel holds only a few.',
        'Its walls are thin.',
        'However, this advantage is illusory.',
        ...Array<string>(20).fill('A quiet keeper waits nearby.'),
      ],
    ]);
    const p = selectEvidence(a, 'amber lattice', Infinity, { maxWords: 35 });
    expect(p[0].text).toContain('However, this advantage is illusory.');
    expect(p.flatMap((p) => p.text.split(/\s+/)).length).toBeLessThanOrEqual(35);
    expect(selectEvidence(a, 'amber lattice', Infinity, { maxWords: 5 })).toEqual([]);
    expect(selectEvidence(a, 'amber lattice', 3)[0].ordinals).toEqual([1, 2, 3]);
  });
  it('ignores common question words and supplies definitions for each named term', () => {
    const a = fixture([
      ['What why how is the.'],
      ['The amber lattice is a spark mesh.'],
      ['The violet prism is a light trap.'],
      ['The cobalt vessel is a sealed jar.'],
      ['A future beacon is a signal lamp.'],
    ]);
    const passages = retrieve(a, 4, 'What is the difference between amber lattice, violet prism and cobalt vessel?');
    expect(passages.some((p) => p.ordinals.includes(1))).toBe(false);
    for (const key of ['amber lattice', 'violet prism', 'cobalt vessel']) {
      const card = selectEvidence(a, key, 4, { maxParagraphs: 2, maxWords: 200 });
      expect(passages.some((p) => card.some((c) => p.text === c.text))).toBe(true);
    }
    expect(passages.every((p) => p.ordinals.every((o) => o <= 4))).toBe(true);
    expect(passages.length).toBeLessThanOrEqual(16);
    expect(passages.reduce((sum, p) => sum + JSON.stringify({ number: p.number, text: p.text }).length + 1, 0)).toBeLessThanOrEqual(
      answerCharacterBudget('What is the difference between amber lattice, violet prism and cobalt vessel?'),
    );
    expect(retrieve(a, 4, 'What why how is the')).not.toHaveLength(0);
  });
  it('matches inflections without changing evidence text', () => {
    expect(retrievalTokens('testing tests tested')).toEqual(['test', 'test', 'test']);
    expect(retrievalTokens('behaviour behave')).toEqual(['behav', 'behav']);
    const a = fixture([['The keeper tests the copper valve with care each morning.']]);
    expect(retrieve(a, 1, 'testing')[0].text).toBe(a.sentences[0].text);
  });
  it('includes a bounded continuation and preserves embedding paragraph rows', () => {
    const a = fixture([
      ['The amber lattice is a woven mesh which stores a tiny spark until the keeper arrives.'],
      ['This prevents the spark from fading before dawn.'],
      ['Thus the hidden ending changes everything.'],
    ]);
    expect(paragraphs(a, 2).map((p) => p.ordinals)).toEqual([[1], [2]]);
    const passages = selectEvidence(a, 'amber lattice', 2);
    expect(passages[0].ordinals).toEqual([1, 2]);
    expect(retrieve(a, 2, 'amber lattice')[0].text).toContain('prevents');
    const b = structuredClone(a);
    b.sentences[2].text = 'Testing the unseen cobalt beacon reveals a future secret.';
    b.terms = extractTerms(b.sentences);
    expect(JSON.stringify(retrieve(a, 2, 'amber lattice testing'))).toBe(JSON.stringify(retrieve(b, 2, 'amber lattice testing')));
    const prefix = { ...a, sentences: a.sentences.slice(0, 2) };
    for (const data of [b, prefix]) {
      expect(JSON.stringify(retrieve(a, 2, 'amber lattice testing', 'amber lattice'))).toBe(
        JSON.stringify(retrieve(data, 2, 'amber lattice testing', 'amber lattice')),
      );
    }
    expect(JSON.stringify(selectEvidence(a, 'amber lattice', 2))).toBe(JSON.stringify(selectEvidence(b, 'amber lattice', 2)));
    b.sentences[1].spineIndex = 1;
    expect(selectEvidence(b, 'amber lattice', 2)[0].ordinals).toEqual([1]);
  });
  it('skips oversized sentences and continues filling to sixteen passages', () => {
    const a = fixture([
      ['testing ' + 'enormous'.repeat(2000)],
      ...Array.from({ length: 20 }, (_, i) => [`A keeper tests valve ${i} carefully each morning near the gate.`]),
    ]);
    a.terms = [];
    const result = retrieve(a, Infinity, 'testing');
    expect(result).toHaveLength(16);
    expect(result.some((p) => p.ordinals.includes(1))).toBe(false);
    expect(result.reduce((sum, p) => sum + JSON.stringify({ number: p.number, text: p.text }).length + 1, 0)).toBeLessThanOrEqual(
      answerCharacterBudget('testing'),
    );
  });
  it('puts focused evidence first and fills search evidence within the focused budget and cap', () => {
    const a = fixture([
      ['An amber lattice is a mesh that gathers sparks near the gate.'],
      ...Array.from({ length: 25 }, (_, i) => [`A keeper tests valve ${i} carefully each morning near the gate.`]),
    ]);
    const question = 'testing';
    const budget = answerCharacterBudget(question, true);
    const focused = selectEvidence(a, 'amber lattice', Infinity, { maxCharacters: Math.floor(budget / 2) });
    expect(focused.length).toBeGreaterThan(0);
    const result = retrieve(a, Infinity, question, 'amber lattice');
    expect(result.slice(0, focused.length)).toEqual(focused);
    expect(result).toHaveLength(16);
    expect(new Set(result.flatMap((p) => p.ordinals)).size).toBe(result.flatMap((p) => p.ordinals).length);
    expect(result.reduce((sum, p) => sum + JSON.stringify({ number: p.number, text: p.text }).length + 1, 0)).toBeLessThanOrEqual(budget);
  });
  it('keeps a contiguous window around the best sentence including its contrast', () => {
    const a = fixture([
      [
        ...Array<string>(8).fill('Quiet keepers carry folded cloth across the courtyard every morning.'),
        'Testing valves prevents leaking sparks from escaping into the courtyard.',
        'However, cracked vessels still leak during the coldest winter nights.',
        ...Array<string>(8).fill('Silent workers gather beside the distant gate before returning home.'),
      ],
    ]);
    a.terms = [];
    const [p] = retrieve(a, Infinity, 'testing valves leaking sparks');
    expect(p.ordinals).toContain(9);
    expect(p.ordinals).toContain(10);
    expect(p.text.split(/\s+/).length).toBeLessThanOrEqual(150);
    expect(p.ordinals).toEqual(Array.from({ length: p.ordinals.length }, (_, i) => p.ordinals[0] + i));
    expect(p.text).toBe(
      a.sentences
        .filter((s) => p.ordinals.includes(s.ordinal))
        .map((s) => s.text)
        .join(' '),
    );
  });
  it('puts named evidence before a higher ranked pool passage', () => {
    const a = fixture([
      ['Workers test valves and test vessels and test jars every morning.'],
      ['The amber lattice is a woven mesh that holds sparks safely.'],
    ]);
    expect(retrieve(a, 2, 'amber lattice testing')[0].text).toContain('amber lattice');
  });
  it('prefers an explanation over incidental mentions with one passage available', () => {
    const a = fixture([
      ['The keeper carried the amber lattice across the courtyard beneath a bright sky while the other workers waited beside the gate.'],
      ['The amber lattice requires a sealed jar because sparks fade in air, so that stored light remains useful through the night.'],
      ['The keeper placed the amber lattice beside the window and left quietly while the workers began their evening meal in the courtyard.'],
    ]);
    expect(selectEvidence(a, 'amber lattice', 3, { maxParagraphs: 1 })[0].text).toContain('because');
  });
  it('uses prefix spellings, excludes display aliases and requires capitalized name evidence', () => {
    const a = fixture([
      ['The amber lattice is a mesh.'],
      ['We saw Amber Lattice.', 'We saw Amber Lattice.'],
      ['The amber lattice replied quietly.', 'The amber lattice replied quietly.'],
      ['Dr Neris Vale replied quietly.', 'Dr Neris Vale said hello.'],
      ['We stayed in Silver Bay.', 'We walked near Silver Bay.'],
    ]);
    expect(visibleTerm(a, 'amber lattice', 1)?.displayName).toBe('amber lattice');
    expect(visibleTerm(a, 'amber lattice', 3)?.displayName).toBe('Amber Lattice');
    expect(visibleTerm(a, 'amber lattice', Infinity)?.type).toBe('concept');
    expect(visibleTerm(a, 'neris vale', Infinity)?.type).toBe('person');
    expect(visibleTerm(a, 'silver bay', Infinity)?.type).toBe('place');
    for (const t of visibleTerms(a, Infinity)) expect(t.aliases.every((alias) => alias.toLowerCase() !== t.displayName.toLowerCase())).toBe(true);
    const b = fixture([['It is when we were here.', 'It is when we were here.']]);
    expect(visibleTerms(b, Infinity).some((t) => ['is', 'were', 'when'].includes(t.key))).toBe(false);
  });
});
