import { describe, expect, it } from 'vitest';
import { extractTerms } from './term-extractor';
import type { Sentence, Term } from './model';

function sentence(ordinal: number, text: string): Sentence {
  return { ordinal, spineIndex: 1, paragraphIndex: ordinal, href: 'a.xhtml', text, structure: 'body', heading: false, emphasis: [] };
}
function sentences(texts: string[], first = 1): Sentence[] {
  return texts.map((text, index) => sentence(first + index, text));
}
function mentionsThrough(term: Term | undefined, cutoff: number): { ordinal: number; feature: Term['features'][number] }[] {
  let ordinal = 0;
  return (term?.deltas ?? [])
    .map((delta, index) => ({ ordinal: (ordinal += delta), feature: term!.features[index] }))
    .filter((mention) => mention.ordinal <= cutoff);
}
const filler = (count: number) =>
  Array.from({ length: count }, (_, index) => `The tide rose ${index % 2 ? 'slowly' : 'quickly'} near harbor wall ${index + 1}.`);

// A possessive followed by punctuation ("It was Name’s.") used to enter the shared lexicon unsplit, after which
// every later "Name’s" stayed one token and the name lost those mentions.
describe('term extraction state', () => {
  it('gives the same terms for a text after an unrelated long text', () => {
    const short = sentences(['Zorvek’s lantern glowed over the quiet harbor.', 'Zorvek’s lantern guided the boats home.']);
    const first = extractTerms(short);
    expect(first.find((term) => term.key === 'zorvek')?.deltas).toEqual([1, 1]);
    extractTerms(sentences([...filler(200), 'It was Zorvek’s.', 'A Quessan wardstone hummed.']));
    expect(extractTerms(short)).toEqual(first);
  });

  it('gives the same prefix terms after the full text was extracted', () => {
    const prefix = sentences(['Brannoc’s banner hung above the gate.', 'Brannoc’s banner snapped in the wind.']);
    const alone = extractTerms(prefix);
    extractTerms([...prefix, ...sentences([...filler(50), '“Brannoc’s,” she said.'], 3)]);
    expect(extractTerms(prefix)).toEqual(alone);
  });

  it('keeps later text from changing mentions at or before the cutoff within one extraction', () => {
    const prefix = sentences(['Ilsevar’s compass pointed north.', 'Ilsevar’s compass never failed.']);
    const full = [...prefix, ...sentences([...filler(20), 'The compass was Ilsevar’s.'], 3)];
    const key = 'ilsevar';
    const fromPrefix = mentionsThrough(
      extractTerms(prefix).find((term) => term.key === key),
      2,
    );
    expect(fromPrefix.map((mention) => mention.ordinal)).toEqual([1, 2]);
    expect(
      mentionsThrough(
        extractTerms(full).find((term) => term.key === key),
        2,
      ),
    ).toEqual(fromPrefix);
  });

  it('treats an en dash inside a word like a hyphen, but not a spaced en dash', () => {
    const terms = extractTerms(
      sentences(['The brain\u2013computer interfaces failed.', 'A brain-computer interface worked.', 'The harbor \u2013 quiet now \u2013 slept.']),
    );
    const term = terms.find((t) => t.key === 'brain-computer interface');
    expect(term?.features.map((m) => m.alias)).toEqual(['brain\u2013computer interfaces', 'brain-computer interface']);
    expect(terms.some((t) => t.key.includes('harbor-') || t.key.includes('-quiet'))).toBe(false);
  });
});

describe('candidate recall', () => {
  const keys = (texts: string[]) => extractTerms(sentences(texts)).map((term) => term.key);

  it('takes a capitalised name with an inner of, the or and, but not a connector at its edge', () => {
    const found = keys(['They reached the House of Many Gates at dusk.', 'The House of Many Gates was quiet.', 'Bob and the dog ran.']);
    expect(found).toContain('house of many gate');
    expect(found.some((key) => key.startsWith('bob and'))).toBe(false);
  });

  it('takes a lowercase phrase seen three times when its last word is an uncommon noun, and not one seen twice', () => {
    const text = ['She saw the deep-delve wyrmstone there.', 'Again the deep-delve wyrmstone came.', 'At dawn the deep-delve wyrmstone faded.'];
    expect(keys(text)).toContain('deep-delve wyrmstone');
    expect(keys(text.slice(0, 2))).not.toContain('deep-delve wyrmstone');
    expect(keys(text.map((line) => line.replace('deep-delve wyrmstone', 'dog asleep')))).not.toContain('dog asleep');
  });

  it('takes no repeated lowercase phrase that ends on a verb, an adverb or an adjective', () => {
    const repeated = (phrase: string) => keys([`She saw ${phrase} there.`, `Again ${phrase} came.`, `At dawn ${phrase} faded.`]);
    expect(repeated('the wyrmcraft unbound')).not.toContain('wyrmcraft unbound');
    expect(repeated('wyrmcraft skittered')).not.toContain('wyrmcraft skitter');
    expect(repeated('wyrmcraft skittered')).not.toContain('wyrmcraft skittered');
    expect(repeated('wyrmcraft unflinchingly')).not.toContain('wyrmcraft unflinchingly');
  });

  it('takes a named person’s relative as a person, and keeps the name’s own mention', () => {
    const terms = extractTerms(sentences(['Viv’s mother waved at Viv.', 'Viv walked.', 'The mother of the year waved.']));
    const mother = terms.find((term) => term.key === "viv's mother");
    expect(mother?.features.map((feature) => [feature.alias, feature.person])).toEqual([["Viv's mother", true]]);
    expect(terms.find((term) => term.key === 'viv')?.features.every((feature) => !feature.nested)).toBe(true);
    expect(terms.some((term) => term.key === "the's mother" || term.key === "year's mother")).toBe(false);
  });
});
