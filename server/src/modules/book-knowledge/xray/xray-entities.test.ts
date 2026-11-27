import { describe, expect, it } from 'vitest';
import { annotateKindCues } from '../core/kind-cues';
import type { KindAnswer } from '../core/kind-review';
import type { Artifact, Sentence } from '../core/model';
import { extractAliasLinks, extractTerms } from '../core/term-extractor';
import { xrayEntities } from './xray-entities';

function book(texts: string[]): Artifact {
  const sentences: Sentence[] = texts.map((text, index) => ({
    ordinal: index + 1,
    spineIndex: Math.floor(index / 3),
    paragraphIndex: index,
    href: 'invented.xhtml',
    text,
    structure: 'body',
    heading: false,
    emphasis: [],
  }));
  const terms = extractTerms(sentences);
  annotateKindCues(sentences, terms);
  return {
    sentences,
    terms,
    aliasLinks: extractAliasLinks(sentences, terms),
    seeds: [],
    fingerprint: 'invented',
    formatVersion: 1,
    textVersion: 1,
    termsVersion: 1,
  };
}

function cast(texts: string[], answers: [string, KindAnswer][]) {
  const artifact = book(texts);
  return xrayEntities(artifact, texts.length, new Map(answers)).map(({ name, ordinals, names }) => ({
    name,
    ordinals,
    names: names.map(({ text, ordinal }) => `${text}@${ordinal}`),
  }));
}

const crew = ['Rellan tapped the hull.', 'Rellan hummed.', 'The lab was cold.', 'Rellan slept.'];

describe('xray entities from longer names', () => {
  it('keeps a shouted two-word name whole instead of its parts', () => {
    const names = cast(
      [...crew, '“Vega Lyrae!” he shouted at the screen.', 'The board read “Vega Lyrae,” “Sirrah,” and others.'],
      [
        ['vega', 'place'],
        ['lyrae', 'place'],
        ['rellan', 'person'],
      ],
    ).map(({ name }) => name);
    expect(names).toContain('Vega Lyrae');
    expect(names).not.toContain('Vega');
    expect(names).not.toContain('Lyrae');
  });

  it('keeps a typed shouted name whole instead of its parts', () => {
    const names = cast(
      [...crew, '“Vega Lyrae!” he shouted at the screen.', 'The board read “Vega Lyrae,” “Sirrah,” and others.'],
      [
        ['vega lyrae', 'place'],
        ['vega', 'place'],
        ['lyrae', 'place'],
        ['rellan', 'person'],
      ],
    ).map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining(['Vega Lyrae']));
    expect(names).not.toEqual(expect.arrayContaining(['Vega']));
  });

  it('still drops a shouted name when nothing inside it would stand alone', () => {
    const names = cast([...crew, '“Brannick Voss!” he shouted.', '“Brannick Voss,” she warned.'], [['rellan', 'person']]).map(({ name }) => name);
    expect(names).not.toContain('Brannick Voss');
  });

  it('takes the parts of a junk name with it', () => {
    const texts = [
      ...crew,
      'They flew to Vega Lyrae.',
      'Vega Lyrae burned.',
      'The crew saw Vega Lyrae.',
      'Vega Lyrae dimmed.',
      'Nobody reached Vega Lyrae.',
      'Vega Lyrae was far.',
    ];
    const names = cast(texts, [
      ['vega lyrae', 'junk'],
      ['rellan', 'person'],
    ]).map(({ name }) => name);
    expect(names).not.toContain('Vega');
    expect(names).not.toContain('Lyrae');
  });

  it('drops a part admitted only on the longer name’s sentences', () => {
    const texts = [
      ...crew,
      ...Array.from({ length: 6 }, (_, index) => `They flew to Vega Lyrae on day ${index + 1}.`),
      'The Lyrae run was cancelled.',
    ];
    const names = cast(texts, [
      ['vega lyrae', 'place'],
      ['rellan', 'person'],
    ]).map(({ name }) => name);
    expect(names).toContain('Vega Lyrae');
    expect(names).not.toContain('Lyrae');
  });
});

describe('xray entities that join two names', () => {
  it('drops a joined name before its parts are taken for fragments of it', () => {
    const texts = [...Array.from({ length: 5 }, (_, index) => `Quill and Bram walked to gate ${index + 1}.`), 'Quill laughed.', 'Quill slept.'];
    const names = cast(texts, [
      ['quill', 'person'],
      ['bram', 'person'],
    ]).map(({ name }) => name);
    expect(names).not.toContain('Quill and Bram');
    expect(names).toContain('Quill');
  });

  it('drops a joined name when one part is named too rarely to be an entry', () => {
    const texts = [
      ...Array.from({ length: 3 }, (_, index) => `Quill and Bram walked to gate ${index + 1}.`),
      'Quill laughed.',
      'Quill slept.',
      'Bram waved.',
    ];
    const names = cast(texts, [
      ['quill', 'person'],
      ['quill and bram', 'person'],
    ]).map(({ name }) => name);
    expect(names).not.toContain('Bram');
    expect(names).not.toContain('Quill and Bram');
  });
});

describe('xray entities beside a junk joined name', () => {
  it('keeps a person whose every mention sits inside a joined name the review called junk', () => {
    const texts = [...crew, ...Array.from({ length: 5 }, (_, index) => `Quill and Bram walked to gate ${index + 1}.`)];
    const names = cast(texts, [
      ['bram', 'person'],
      ['quill and bram', 'junk'],
      ['rellan', 'person'],
    ]).map(({ name }) => name);
    expect(names).toContain('Bram');
  });
});

describe('xray title holders', () => {
  it('does not give a title to the viewpoint character who is named everywhere', () => {
    const texts = [
      'Zoey woke early.',
      'Zoey ate.',
      'Zoey ran.',
      'Zoey saluted the Captain.',
      'Zoey glared at the Captain.',
      'The Captain ignored Zoey.',
      'The Captain sighed.',
      'Zoey slept.',
    ];
    const entries = cast(texts, [
      ['zoey', 'person'],
      ['captain', 'title'],
    ]);
    expect(entries.map(({ name }) => name)).toContain('Captain');
    expect(entries.find(({ name }) => name === 'Zoey')?.names).toEqual(['Zoey@1']);
  });

  it('gives a title to the one person it is said beside, from the sentence the share is reached', () => {
    const texts = [
      'Odran walked.',
      'Pella waved.',
      'The Warden watched.',
      'Pella laughed.',
      'Warden Edda spoke.',
      'Edda, the Warden, nodded.',
      'Odran ate.',
      'Pella slept.',
      'Odran sang.',
      'Edda left.',
    ];
    const entries = cast(texts, [
      ['edda', 'person'],
      ['odran', 'person'],
      ['pella', 'person'],
      ['warden', 'title'],
    ]);
    expect(entries.map(({ name }) => name)).not.toContain('Warden');
    expect(entries.find(({ name }) => name === 'Edda')?.names).toContain('Warden@6');
  });
});
