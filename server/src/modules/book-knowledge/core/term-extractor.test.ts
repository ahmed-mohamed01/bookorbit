import { describe, expect, it } from 'vitest';
import { extractAliasLinks, extractTerms } from './term-extractor';
import { visibleTerm } from './artifact';
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

describe('names the tagger misreads', () => {
  const visible = (texts: string[], key: string) => {
    const text = sentences(texts);
    const terms = extractTerms(text);
    const artifact = {
      sentences: text,
      terms,
      aliasLinks: [],
      seeds: [],
      fingerprint: 'invented',
      formatVersion: 1,
      textVersion: 1,
      termsVersion: 1,
    };
    return visibleTerm(artifact, key, Infinity);
  };

  it('keeps a name that is also a verb or an auxiliary when it is capitalised inside sentences', () => {
    const drew = visible(
      ['We met Drew at the gate.', 'Later, Drew smiled.', 'She drew a breath.', 'He drew the curtain.', 'They drew lots.'],
      'drew',
    );
    expect(drew?.mentions.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    expect(visible(['I never trusted Will.', 'Then Will nodded.', 'It will rain.', 'You will see.', 'We will go.'], 'will')?.count).toBe(2);
  });

  it('keeps a capitalised name whose last word reads as a verb', () => {
    const terms = extractTerms(sentences(['They joined the Night Watch at dusk.', 'The Night Watch rode out.', 'He left the Night Watch.']));
    expect(
      mentionsThrough(
        terms.find(({ key }) => key === 'night watch'),
        Infinity,
      ),
    ).toHaveLength(3);
  });

  it('keeps every possessive of a name after one before punctuation', () => {
    const terms = extractTerms(
      sentences(['Tessaly’s hand shook.', 'The blade was Tessaly’s.', 'He took Tessaly’s blade.', 'Tessaly’s voice broke.']),
    );
    expect(
      mentionsThrough(
        terms.find(({ key }) => key === 'tessaly'),
        Infinity,
      ).map(({ ordinal }) => ordinal),
    ).toEqual([1, 2, 3, 4]);
    const star = extractTerms(sentences(['Vega Lyrae rose.', 'The glow was Vega Lyrae’s.', 'Vega Lyrae’s light faded.']));
    expect(
      mentionsThrough(
        star.find(({ key }) => key === 'vega lyrae'),
        Infinity,
      ),
    ).toHaveLength(3);
    expect(
      mentionsThrough(
        star.find(({ key }) => key === 'vega'),
        Infinity,
      ).every(({ feature }) => feature.nested),
    ).toBe(true);
  });

  it('makes no term of a verb before a name', () => {
    const terms = extractTerms(sentences(Array<string>(4).fill('Then she asked Pellan about the road.')));
    expect(terms.map(({ key }) => key)).not.toContain('asked pellan');
    expect(
      mentionsThrough(
        terms.find(({ key }) => key === 'pellan'),
        Infinity,
      ),
    ).toHaveLength(4);
  });

  it('does not nest a name inside a sentence-opening word', () => {
    const terms = extractTerms(sentences(['And Corlan laughed.', 'But Corlan was gone.', '“When Corlan came back, he slept.”']));
    expect(terms.map(({ key }) => key)).not.toEqual(expect.arrayContaining(['and corlan']));
    expect(
      mentionsThrough(
        terms.find(({ key }) => key === 'corlan'),
        Infinity,
      ).map(({ feature }) => feature.nested),
    ).toEqual([false, false, false]);
  });

  it('takes a name holding "of the" whole', () => {
    const terms = extractTerms(sentences(['He joined the Order of the Black Lantern today.', 'The Order of the Black Lantern met at dusk.']));
    expect(
      mentionsThrough(
        terms.find(({ key }) => key === 'order of the black lantern'),
        Infinity,
      ),
    ).toHaveLength(2);
  });

  it('reads a speech verb before a name as a person cue only as a speaker tag', () => {
    const terms = extractTerms(sentences(['“Go,” said Varnis.', 'She said Varnis Reach was too far.']));
    expect(
      mentionsThrough(
        terms.find(({ key }) => key === 'varnis'),
        Infinity,
      )[0].feature.person,
    ).toBe(true);
    expect(
      mentionsThrough(
        terms.find(({ key }) => key === 'varnis reach'),
        Infinity,
      )[0].feature.person,
    ).toBe(false);
  });
});

describe('identity statements', () => {
  it('renames only the subject of "was called"', () => {
    const text = sentences(['Mirel smiled.', 'Tobrin waved.', 'The man beside Mirel was called Tobrin.', 'Mirel and Tobrin left.']);
    expect(extractAliasLinks(text, extractTerms(text)).filter(({ left, right }) => [left, right].includes('mirel'))).toEqual([]);
    const own = sentences(['Halder Voss smiled.', 'Corwen waved.', 'Halder Voss was also known as Corwen.']);
    expect(extractAliasLinks(own, extractTerms(own))).toContainEqual(expect.objectContaining({ left: 'halder voss', right: 'corwen' }));
  });
});
