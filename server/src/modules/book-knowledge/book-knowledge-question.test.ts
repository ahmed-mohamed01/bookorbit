import type { Artifact, Term } from './core/model';
import { namedTerms, termQuestion } from './book-knowledge-question';

function term(key: string, alias = key, ordinal = 1): Term {
  return {
    key,
    rarity: 1,
    wordCount: 2,
    deltas: [ordinal],
    features: [
      {
        alias,
        definition: true,
        capitalized: false,
        person: false,
        place: false,
        nested: false,
        structural: false,
        noun: true,
      },
    ],
  };
}
function fixture(terms = [term('lumen lattice')]): Artifact {
  return { formatVersion: 1, textVersion: 1, termsVersion: 1, fingerprint: '', seeds: [], aliasLinks: [], terms, sentences: [] };
}
describe('single-term questions', () => {
  it.each([
    'who is',
    'who was',
    'who are',
    'who were',
    'whos',
    'who s',
    'what is',
    'what was',
    'what are',
    'what were',
    'whats',
    'what s',
    'tell me about',
    'what does',
    'what do',
    'explain',
    'define',
    'describe',
    'remind me who',
    'remind me what',
  ])('recognizes the %s prefix', (prefix) => {
    expect(termQuestion(fixture(), 1, `${prefix} Lumen lattice?`)).toBe('lumen lattice');
  });
  it.each(['mean', 'means', 'stand for', 'again', 'exactly', 'in this book', 'in the book'])('recognizes the %s suffix', (suffix) => {
    expect(termQuestion(fixture(), 1, `What is lumen lattice ${suffix}?`)).toBe('lumen lattice');
  });
  it.each(['the', 'a', 'an'])('strips the %s article', (article) => {
    expect(termQuestion(fixture(), 1, `Explain ${article} lumen lattice`)).toBe('lumen lattice');
  });
  it('uses token equality and strips forms in order', () => {
    expect(termQuestion(fixture(), 1, "What's the LUMEN-lattice again?")).toBe('lumen lattice');
    expect(termQuestion(fixture(), 1, 'what does lumen lattice mean again')).toBeNull();
    expect(termQuestion(fixture(), 1, 'lumen lattice')).toBe('lumen lattice');
    expect(termQuestion(fixture(), 1, 'why did lumen lattice leave')).toBeNull();
    expect(termQuestion(fixture(), 1, 'what is')).toBeNull();
  });
  it('rejects ambiguous aliases and future terms and aliases', () => {
    expect(termQuestion(fixture([term('lumen lattice', 'gleam net'), term('amber prism', 'gleam net')]), 1, 'Define gleam net')).toBeNull();
    const data = fixture([term('lumen lattice'), term('amber prism', 'amber prism', 3)]);
    expect(termQuestion(data, 2, 'Who is amber prism')).toBeNull();
    data.terms[0].deltas.push(2);
    data.terms[0].features.push({ ...data.terms[0].features[0], alias: 'gleam net' });
    expect(termQuestion(data, 2, 'Define gleam net')).toBeNull();
    expect(termQuestion(data, 3, 'Define gleam net')).toBe('lumen lattice');
  });
  it('matches visible mention aliases and keys', () => {
    const data = fixture([term('lumen lattice', 'Gleam net')]);
    expect(termQuestion(data, 1, 'Define gleam net')).toBe('lumen lattice');
    expect(termQuestion(data, 1, 'Define lumen lattice')).toBe('lumen lattice');
  });
  it('preserves longest non-overlapping matches and their order without a three-term cap', () => {
    const data = fixture(['lumen lattice', 'lattice', 'amber prism', 'gleam net', 'violet mesh'].map((key) => term(key)));
    expect(namedTerms(data, 1, 'lumen lattice amber prism gleam net violet mesh').map((t) => t.key)).toEqual([
      'lumen lattice',
      'amber prism',
      'violet mesh',
      'gleam net',
    ]);
  });
});
