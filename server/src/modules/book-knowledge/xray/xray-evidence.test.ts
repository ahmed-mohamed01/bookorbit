import { wordRarity } from '../core/common-words';
import type { Artifact, Mention, Sentence, Term } from '../core/model';
import { isEverydayTerm, isExclamationTerm, isNationalityTerm, isUnitTerm } from '../core/generic-terms';
import { termFragments } from '../core/term-fragments';
import { extractAliasLinks, extractTerms } from '../core/term-extractor';
import { termKey } from '../core/text-utils';
import { KIND_ANSWERS, type KindAnswer } from '../core/kind-review';
import {
  DICTIONARY_TERM_MIN_SCORE,
  honorific,
  importanceOf,
  isGenericTerm,
  nameWords,
  rankImportance,
  weakDictionaryTerm,
  xrayEntities,
} from './xray-entities';
import { rankTerms, type RankedTerm } from '../core/term-ranking';
import { inBatches, spread } from './xray-evidence';
import { entity } from './xray-fixtures.testing';

function sentences(count: number, spineOf: (ordinal: number) => number = () => 0): Sentence[] {
  return Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    spineIndex: spineOf(index + 1),
    paragraphIndex: index,
    href: 'x.xhtml',
    text: `Sentence number ${index + 1} has enough words to count as a line.`,
    structure: 'body' as const,
    heading: false,
    emphasis: [],
  }));
}

const NAMES = ['Arden', 'Brisa', 'Corvin', 'Delphine', 'Ezra', 'Fenwick', 'Galen', 'Hollis', 'Isolde', 'Jory'];

function artifact(text: Sentence[], terms: Term[] = extractTerms(text)): Artifact {
  return {
    sentences: text,
    terms,
    aliasLinks: extractAliasLinks(text, terms),
    seeds: [],
    fingerprint: 'invented',
    formatVersion: 1,
    textVersion: 2,
    termsVersion: 2,
  };
}

describe('batching', () => {
  it('splits units into fixed-size batches', () => {
    expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inBatches([], 8)).toEqual([]);
  });

  it('spreads a capped pick over the whole list', () => {
    expect(spread([1, 2, 3], 6)).toEqual([1, 2, 3]);
    const picked = spread(
      Array.from({ length: 20 }, (_, i) => i + 1),
      6,
    );
    expect(picked).toHaveLength(6);
    expect(picked.slice(0, 2)).toEqual([1, 2]);
    expect(picked.at(-1)).toBeGreaterThan(15);
  });
});

describe('X-Ray cast selection', () => {
  it('does not admit title-page names and starts later body names at their first body mention', () => {
    const text = sentences(6, (ordinal) => ordinal);
    const lines = [
      'The Brass Stairwell.',
      'Written by Nerith.',
      'Contents for Nerith.',
      'Index for Nerith.',
      'Bibliography for Nerith.',
      'Then Nerith walked.',
    ];
    text.forEach((sentence, index) => (sentence.text = lines[index]));
    (['front', 'front', 'contents', 'index', 'bibliography'] as const).forEach((structure, index) => (text[index].structure = structure));
    const book = artifact(text);
    const answers = new Map([
      ['brass stairwell', 'place'],
      ['nerith', 'person'],
    ] as const);
    expect(xrayEntities(book, 5, answers)).toEqual([]);
    expect(xrayEntities(book, 6, answers)).toMatchObject([
      { name: 'Nerith', first: 6, count: 1, importance: 3, ordinals: [6], names: [{ text: 'Nerith', ordinal: 6 }] },
    ]);
  });

  it('drops a chosen whole-word fragment only when all its mentions are covered', () => {
    const text = sentences(3);
    text[0].text = 'They entered Apex Palace, where Dame Nerith greeted them.';
    text[1].text = 'They left Apex Palace, and Dame Nerith shut the gate.';
    text[2].text = 'Later Nerith waved.';
    const answers = new Map([
      ['apex palace', 'place'],
      ['apex', 'place'],
      ['dame nerith', 'person'],
      ['nerith', 'person'],
    ] as const);
    const dropped = { generic: 0, fragment: 0 };
    const cast = xrayEntities(artifact(text), 3, answers, 'fiction', undefined, dropped);
    expect(cast.map(({ name }) => name)).toEqual(expect.arrayContaining(['Apex Palace', 'Dame Nerith', 'Nerith']));
    expect(cast.map(({ name }) => name)).not.toContain('Apex');
    expect(dropped.fragment).toBe(1);
  });

  const mention = (alias: string): Omit<Mention, 'ordinal'> => ({
    alias,
    definition: false,
    capitalized: alias !== alias.toLowerCase(),
    person: alias !== alias.toLowerCase(),
    place: false,
    nested: false,
    structural: false,
  });

  it('keeps a weak dictionary entry below the fiction score floor regardless of the kind answer', () => {
    const text = sentences(12, (ordinal) => (ordinal < 7 ? 0 : 1));
    text.forEach((sentence) => {
      sentence.text = sentence.ordinal === 1 || sentence.ordinal === 7 ? 'Glimmerstone glowed beside the lantern hook.' : 'Glimmerstone glowed.';
    });
    const book = artifact(text, [
      {
        key: 'lantern',
        rarity: wordRarity('lantern'),
        wordCount: 1,
        deltas: [1, 6],
        features: [1, 7].map(() => ({ ...mention('lantern'), modifier: true })),
      },
      {
        key: 'glimmerstone',
        rarity: 1,
        wordCount: 1,
        deltas: text.map(() => 1),
        features: text.map(() => mention('glimmerstone')),
      },
    ]);
    expect(rankTerms(book, text.length, true).find(({ key }) => key === 'lantern')?.score).toBeLessThan(DICTIONARY_TERM_MIN_SCORE);
    for (const answer of [undefined, ...KIND_ANSWERS]) {
      const answers = new Map<string, KindAnswer>(answer ? [['lantern', answer]] : []);
      expect(xrayEntities(book, text.length, answers).map(({ key }) => key)).not.toContain('lantern');
    }
  });

  it('admits a nonfiction concept with two body sentences after a typed review answer', () => {
    const text = sentences(3);
    text[0].text = 'The paper discusses anthropic capture.';
    text[1].text = 'The authors explore anthropic capture.';
    text[2].text = 'Anthropic capture.';
    text[2].structure = 'index';
    const name = 'anthropic capture';
    const book = artifact(text, [{ key: name, rarity: 1, wordCount: 2, deltas: [1, 1, 1], features: text.map(() => mention(name)) }]);
    expect(xrayEntities(book, 3, new Map(), 'nonfiction')).toEqual([]);
    expect(xrayEntities(book, 3, new Map([[name, 'junk']]), 'nonfiction')).toEqual([]);
    expect(xrayEntities(book, 3, new Map([[name, 'idea']]), 'nonfiction')).toMatchObject([{ key: name, kind: 'idea', ordinals: [1, 2] }]);
  });

  it('admits an untyped nonfiction term the book defines under its own heading', () => {
    const text = sentences(2);
    text[0].text = 'Emulation modulation.';
    text[1].text = 'The book weighs emulation modulation.';
    const name = 'emulation modulation';
    const features = [{ ...mention(name), definition: true, structural: true }, mention(name)];
    const book = artifact(text, [{ key: name, rarity: 1, wordCount: 2, deltas: [1, 1], features }]);
    expect(xrayEntities(book, 2, new Map(), 'nonfiction')).toMatchObject([{ key: name }]);
    expect(xrayEntities(book, 2, new Map([[name, 'junk']]), 'nonfiction')).toEqual([]);
    expect(xrayEntities(book, 2, new Map(), 'fiction')).toEqual([]);
  });

  it('leaves a short name the sentences where it only appears inside a longer cast name', () => {
    const text = sentences(8);
    const lines = [
      'Marta crossed the ruins of the Old Empire at dawn.',
      'The Old Empire had fallen long before Marta was born.',
      'Marta found a coin of the Old Empire in the sand.',
      'Scholars still argued over why the Old Empire collapsed.',
      'Marta said the Empire had left nothing but dust.',
      'Nobody in the village spoke of the Empire anymore.',
      'Marta slept under the stars that night.',
      'Marta woke to the sound of the river.',
    ];
    lines.forEach((line, index) => (text[index].text = line));
    const answers = new Map([
      ['old empire', 'place'],
      ['empire', 'place'],
      ['marta', 'person'],
    ] as const);
    const cast = xrayEntities(artifact(text), text.length, answers, 'fiction');
    const short = cast.find((entity) => entity.key === 'empire');
    const long = cast.find((entity) => entity.key === 'old empire');
    expect(long?.ordinals).toEqual([1, 2, 3, 4]);
    expect(short).toMatchObject({ ordinals: [5, 6], count: 2 });
  });

  it('keeps a capitalised everyday name to the mentions written as a name', () => {
    const text = sentences(8);
    const lines = [
      'Marta took a room at the Lantern for the night.',
      'Marta hung two lanterns over the door of the stable.',
      'The cook at the Lantern served Marta a bowl of stew.',
      'Marta trimmed the lanterns before the storm came in.',
      'Marta paid the keeper of the Lantern in silver.',
      'Marta lit the lanterns along the road home.',
      'Marta slept under the stars that night.',
      'Marta woke to the sound of the river.',
    ];
    lines.forEach((line, index) => (text[index].text = line));
    const answers = new Map([
      ['lantern', 'place'],
      ['marta', 'person'],
    ] as const);
    const inn = xrayEntities(artifact(text), text.length, answers, 'fiction').find((entity) => entity.key === 'lantern');
    expect(inn).toMatchObject({ name: 'Lantern', ordinals: [1, 3, 5] });
  });

  it("gives each entry an id from its term's place in the artifact, the same at any cutoff", () => {
    const text = sentences(8);
    ['Marta rode.', 'Marta slept.', 'Tomas rode.', 'Tomas slept.', 'Ilse rode.', 'Ilse slept.', 'Ilse woke.', 'Ilse ran.'].forEach(
      (line, index) => (text[index].text = line),
    );
    const answers = new Map([
      ['marta', 'person'],
      ['tomas', 'person'],
      ['ilse', 'person'],
    ] as const);
    const book = artifact(text);
    const ids = (cutoff: number) => new Map(xrayEntities(book, cutoff, answers, 'fiction').map((entry) => [entry.key, entry.id]));
    const early = ids(4);
    const late = ids(8);
    expect(early.has('marta')).toBe(true);
    expect(late.has('ilse')).toBe(true);
    for (const [key, id] of early) expect(late.get(key)).toBe(id);
    expect(late.get('ilse')).toBe(`e${book.terms.findIndex((term) => term.key === 'ilse')}`);
  });

  it('drops the thinnest entries first when the cast is over its cap', () => {
    const text = sentences(6);
    const names = ['alpha concept', 'beta concept', 'gamma concept'];
    const used = [[1], [1, 2], [1, 2, 3, 4, 5]];
    for (const sentence of text) sentence.text = 'The book weighs alpha concept, beta concept and gamma concept.';
    const terms: Term[] = names.map((name, index) => ({
      key: name,
      rarity: 1,
      wordCount: 2,
      deltas: [used[index][0], ...used[index].slice(1).map((ordinal, at) => ordinal - used[index][at])],
      features: used[index].map(() => mention(name)),
    }));
    const answers = new Map(names.map((name) => [name, 'idea'] as const));
    const cast = xrayEntities(artifact(text, terms), text.length, answers, 'nonfiction', 2);
    expect(cast.map(({ name }) => name).sort()).toEqual(['beta concept', 'gamma concept']);
  });

  it('keeps a nonfiction phrase over a more frequent single word at the cap', () => {
    const text = sentences(6);
    const names = ['alpha concept', 'gamma'];
    const used = [
      [1, 2],
      [1, 2, 3, 4, 5],
    ];
    for (const sentence of text) sentence.text = 'The book weighs alpha concept and gamma.';
    const terms: Term[] = names.map((name, index) => ({
      key: name,
      rarity: 1,
      wordCount: name.split(' ').length,
      deltas: [used[index][0], ...used[index].slice(1).map((ordinal, at) => ordinal - used[index][at])],
      features: used[index].map(() => mention(name)),
    }));
    const answers = new Map(names.map((name) => [name, 'idea'] as const));
    const cast = xrayEntities(artifact(text, terms), text.length, answers, 'nonfiction', 1);
    expect(cast.map(({ name }) => name)).toEqual(['alpha concept']);
  });

  it('keeps a more frequent everyday fiction term out of the cast even when the review types it', () => {
    const names = [...NAMES, 'Kelwin', 'Lysandra'];
    const text = sentences(names.length * 10);
    for (const [index, sentence] of text.entries()) {
      sentence.text = `That evening, ${names[index % names.length]} carried the tent.`;
      sentence.spineIndex = Math.floor(index / names.length);
    }
    const terms: Term[] = names.map((name, index) => ({
      key: name.toLowerCase(),
      rarity: 1,
      wordCount: 1,
      deltas: [index + 1, ...Array<number>(9).fill(names.length)],
      features: Array.from({ length: 10 }, () => mention(name)),
    }));
    terms.push({
      key: 'tent',
      rarity: 0.35,
      wordCount: 1,
      deltas: Array<number>(text.length).fill(1),
      features: text.map(() => mention('tent')),
    });
    const answers = new Map(names.map((name) => [name.toLowerCase(), 'person'] as const));
    const cast = xrayEntities(artifact(text, terms), text.length, new Map([...answers, ['tent', 'object'] as const]), 'fiction');
    // Named in every sentence of every chapter, it clears the central-word bar, but stays a minor entry.
    expect(cast.find(({ name }) => name === 'tent')).toMatchObject({ count: 120, importance: 3 });
    expect(cast.filter(({ name, importance }) => names.includes(name) && importance === 1)).toHaveLength(12);
  });

  it('drops dictionary words and lowercase exclamations even after kind review', () => {
    const names = [...NAMES, 'Kelwin', 'Lysandra'];
    const text = sentences(names.length * 10);
    for (const [index, sentence] of text.entries()) sentence.text = `That evening, ${names[index % names.length]} cast barrel.`;
    const terms: Term[] = names.map((name, index) => ({
      key: name.toLowerCase(),
      rarity: 1,
      wordCount: 1,
      deltas: [index + 1, ...Array<number>(9).fill(names.length)],
      features: Array.from({ length: 10 }, () => mention(name)),
    }));
    terms.push({
      key: 'barrel',
      rarity: 0.35,
      wordCount: 1,
      deltas: Array<number>(text.length).fill(1),
      features: text.map(() => mention('barrel')),
    });
    const answers = new Map(names.map((name) => [name.toLowerCase(), 'person'] as const));
    expect(xrayEntities(artifact(text, terms), text.length, answers, 'fiction').some(({ key }) => key === 'barrel')).toBe(false);
    const typed = xrayEntities(artifact(text, terms), text.length, new Map([...answers, ['barrel', 'object'] as const]), 'fiction');
    expect(typed.find(({ key }) => key === 'barrel')).toBeUndefined();
    terms.push({
      key: 'assholes',
      rarity: 0.4,
      wordCount: 1,
      deltas: Array<number>(text.length).fill(1),
      features: text.map(() => mention('assholes')),
    });
    const sworn = xrayEntities(artifact(text, terms), text.length, new Map([...answers, ['assholes', 'idea'] as const]), 'fiction');
    expect(sworn.some(({ key }) => key === 'assholes')).toBe(false);
  });

  function fixture(
    chapters: string[][],
    entries: [name: string, kind: KindAnswer, ordinals: number[], explicit?: boolean][],
  ): { book: Artifact; answers: Map<string, KindAnswer> } {
    const text = sentences(chapters.flat().length);
    let index = 0;
    chapters.forEach((chapter, spineIndex) => chapter.forEach((line) => Object.assign(text[index++], { text: line, spineIndex })));
    const terms = entries.map(([name, , ordinals, explicit]) => ({
      key: termKey(name),
      rarity: name.split(' ').reduce((sum, word) => sum + wordRarity(word), 0) / name.split(' ').length,
      wordCount: name.split(' ').length,
      deltas: ordinals.map((ordinal, at) => ordinal - (ordinals[at - 1] ?? 0)),
      features: ordinals.map((_, at) => ({ ...mention(name), explicitDefinition: at === 0 && explicit })),
    }));
    return { book: { ...artifact(text, terms), aliasLinks: [] }, answers: new Map(entries.map(([name, kind]) => [termKey(name), kind])) };
  }

  /** Long chapters with none of the terms, so a word met twice is neither dense nor spread through the book. */
  const FILLER_CHAPTERS = Array.from({ length: 4 }, () => [Array.from({ length: 600 }, () => 'quiet').join(' ') + '.']);

  it('drops dictionary-only terms regardless of review and retains coined words and defined dictionary terms', () => {
    const coined = ['necrarchs', 'skinsuit', 'revenants', 'golem', 'black mana', 'mana poisoning'];
    const { book, answers } = fixture(
      [
        [
          'She wore armor and packed the rucksacks.',
          `She dealt with ${coined.join(', ')}.`,
          'A cloak means a compact invisibility field.',
          'A saddle conceals the anchor in its lining.',
        ],
        [
          'The armor was dented, and the rucksacks were heavy.',
          `He hid from ${coined.join(', ')}.`,
          'She switched on the cloak.',
          'She retrieved the saddle.',
        ],
        ...FILLER_CHAPTERS,
      ],
      [
        ['armor', 'idea', [1, 5]],
        ['rucksacks', 'object', [1, 5]],
        ...coined.map((name): [string, KindAnswer, number[]] => [name, name === 'necrarchs' ? 'group' : 'idea', [2, 6]]),
        ['cloak', 'object', [3, 7]],
        ['saddle', 'object', [4, 8], true],
      ],
    );
    const dropped = { generic: 0, fragment: 0 };
    const cast = xrayEntities(book, 8, answers, 'fiction', undefined, dropped);
    expect(cast.map(({ name }) => name)).toEqual(expect.arrayContaining([...coined, 'cloak', 'saddle']));
    expect(cast.find(({ name }) => name === 'necrarchs')?.kind).toBe('group');
  });

  it('spares a place word in one named place, drops one that several places share, and ignores other words in names', () => {
    const term = (displayName: string) => ({ key: displayName.toLowerCase(), displayName }) as RankedTerm;
    const ranked = [term('Fort Stone'), term('Fort Sky'), term('Apex Palace'), term('City of Gods'), term('The Other Side'), term('First Revenant')];
    const { single, shared } = nameWords(ranked, (key) => key !== 'first revenant');
    expect([...single].sort()).toEqual(['city', 'palace']);
    expect([...shared]).toEqual(['fort']);
  });

  it('drops a plain word below the score floor unless a name holds it', () => {
    const inNames = new Set(['fort']);
    expect(weakDictionaryTerm('shield', 4.4, inNames)).toBe(true);
    expect(weakDictionaryTerm('willpower', 12.6, inNames)).toBe(false);
    expect(weakDictionaryTerm('fort', 8.7, inNames) || weakDictionaryTerm('fort', 2, inNames)).toBe(false);
    expect(weakDictionaryTerm('skinsuit', 1, inNames)).toBe(false);
  });

  it('folds descriptive prefixes and a generic creature head into retained entries', () => {
    const descriptions = ['dangerous undead creature', 'powerful undead', 'more mana', 'first revenant', 'armored revenants'];
    const { book, answers } = fixture(
      [
        ['They fought the undead and the revenant and collected mana.', `They saw ${descriptions.join(', ')}.`],
        ['They hid from the undead and the revenant and stored mana.', `They fled ${descriptions.join(', ')}.`],
        [
          'The undead, the revenant and mana again.',
          'The undead and the revenant spent mana.',
          'Undead, a revenant, mana.',
          'The undead met the revenant over mana.',
        ],
      ],
      [
        ['undead', 'group', [1, 3, 5, 6, 7, 8]],
        ['revenant', 'group', [1, 3, 5, 6, 7, 8]],
        ['mana', 'idea', [1, 3, 5, 6, 7, 8]],
        ...descriptions.map((name): [string, KindAnswer, number[]] => [name, 'idea', [2, 4]]),
      ],
    );
    const dropped = { generic: 0, fragment: 0 };
    expect(
      xrayEntities(book, 8, answers, 'fiction', undefined, dropped)
        .map(({ name }) => name)
        .sort(),
    ).toEqual(['mana', 'revenant', 'undead']);
    expect(dropped).toEqual({ generic: 0, fragment: 5 });
  });

  it('keeps a compound that makes up a large share of its last word as its own entry', () => {
    const { book, answers } = fixture(
      [
        ['They fed him coma slurry.', 'The coma slurry was thick.', 'More slurry spilled.'],
        ['The coma slurry ran out.', 'Fuel slurry hissed.'],
      ],
      [
        ['coma slurry', 'object', [1, 2, 4]],
        ['slurry', 'object', [1, 2, 3, 4, 5]],
      ],
    );
    expect(
      xrayEntities(book, 5, answers, 'fiction')
        .map(({ name }) => name)
        .sort(),
    ).toEqual(['coma slurry', 'slurry']);
  });

  it('drops an undefined prop confined to one chapter and allows it once it spans sections', () => {
    const { book, answers } = fixture([['She picked up the orb.', 'The orb glowed.'], ['She broke the orb.']], [['orb', 'object', [1, 2, 3]]]);
    const dropped = { generic: 0, fragment: 0 };
    expect(xrayEntities(book, 2, answers, 'fiction', undefined, dropped)).toEqual([]);
    expect(dropped).toEqual({ generic: 1, fragment: 0 });
    expect(xrayEntities(book, 2, answers, 'nonfiction')).toMatchObject([{ name: 'orb' }]);
    expect(xrayEntities(book, 3, answers)).toMatchObject([{ name: 'orb' }]);
  });

  it('counts a status-screen stat only where the capitalised stat is meant', () => {
    const { book, answers } = fixture(
      [
        ['[Stamina: your reserves, how long you can keep going.', 'Her Stamina rose by one.', 'The horses had little stamina left.'],
        ['Great stamina helped the guards.', 'Nerith felt her Stamina swell.', 'His stamina faded in the dark.'],
      ],
      [['stamina', 'idea', [1, 2, 3, 4, 5, 6]]],
    );
    const stat = new Set([2, 5]);
    const [term] = book.terms;
    book.terms = [
      {
        ...term,
        features: term.features.map((feature, index) => ({
          ...feature,
          alias: index === 0 || stat.has(index + 1) ? 'Acuity' : 'stamina',
          capitalized: stat.has(index + 1),
        })),
      },
    ];
    const [stamina] = xrayEntities(book, 6, answers, 'fiction');
    expect(stamina.ordinals).toEqual([2, 5]);
  });

  it('keeps a creature or group met in the one chapter read so far', () => {
    const { book, answers } = fixture([['The zorblats circled.', 'A zorblat hissed.'], ['Later.']], [['zorblats', 'group', [1, 2]]]);
    expect(xrayEntities(book, 2, answers, 'fiction')).toMatchObject([{ name: 'zorblats' }]);
  });

  it('drops comparison and vocative names, but keeps a one-off acting or speaking in narration', () => {
    const { book, answers } = fixture(
      [
        [
          'She moved like a Xenomorph.',
          'It sounded as if a Neral had attacked.',
          'A Neral-like screech rang out.',
          'That was some kind of Neral.',
          'It looked like a real Neral.',
          '“Wake up, Cinderella!”',
          '“Cinderella, get moving.”',
          'Kestrel unlocked the cellar.',
          '“Get inside,” said Lark.',
          'They saw Wren running for the gate.',
          'Piper and Lark like Finch.',
          'The others like Finch too.',
          'Starling, the night porter, unlocked the cellar.',
        ],
      ],
      [
        ['Xenomorph', 'person', [1]],
        ['Neral', 'person', [2, 3, 4, 5]],
        ['Cinderella', 'person', [6, 7]],
        ['Kestrel', 'person', [8]],
        ['Lark', 'person', [9]],
        ['Wren', 'person', [10]],
        ['Finch', 'person', [11, 12]],
        ['Starling', 'person', [13]],
      ],
    );
    const dropped = { generic: 0, fragment: 0 };
    expect(
      xrayEntities(book, 13, answers, 'fiction', undefined, dropped)
        .map(({ name }) => name)
        .sort(),
    ).toEqual(['Finch', 'Kestrel', 'Lark', 'Starling']);
    expect(dropped).toEqual({ generic: 4, fragment: 0 });
    expect(xrayEntities(book, 6, answers, 'fiction').some(({ name }) => name === 'Cinderella')).toBe(false);
  });

  it('keeps a name whose mentions all fall inside a lowercase role and name', () => {
    const term = (displayName: string) => ({
      key: displayName.toLowerCase(),
      displayName,
      mentions: [1, 2].map((ordinal) => ({ ...mention(displayName), ordinal })),
    });
    const damien = term('Damien');
    expect(termFragments([damien], [term('brother Damien')])).toEqual(new Set());
    expect(termFragments([damien], [term('Brother Damien')])).toEqual(new Set(['damien']));
    const capture = term('anthropic capture');
    const longer = term('recursive anthropic capture');
    expect(termFragments([capture], [longer])).toEqual(new Set());
    expect(termFragments([capture], [longer], false)).toEqual(new Set(['anthropic capture']));
    expect(termFragments([capture], [{ ...longer, mentions: longer.mentions.slice(0, 1) }], false)).toEqual(new Set());
  });
});

describe('importance from spread', () => {
  it('ranks by chapters reached and dialogue over raw mentions, and keeps an everyday noun at tier 3', () => {
    const text = sentences(40, (ordinal) => Math.floor((ordinal - 1) / 4));
    text[0].text = '"Come here, Bree," said Ash.';
    const busy = entity('busy', 'character', [1, 2, 3, 4, 5, 6, 7, 8], { name: 'Busy' });
    const bree = entity('bree', 'character', [1, 5, 9, 13, 17, 21], { name: 'Bree' });
    const sword = entity('world', 'object', [1, 5, 9, 13, 17, 21, 25, 29, 33, 37], { name: 'world' });
    const ward = entity('ward', 'idea', [1, 5, 9, 13, 17, 21, 25, 29, 33, 37], { name: 'Mana Ward' });
    rankImportance([busy, bree, sword, ward], text);
    expect([busy, bree, sword, ward].map((entry) => entry.importance)).toEqual([2, 1, 3, 2]);
  });
});

describe('importanceOf', () => {
  it('ranks the main cast, the supporting cast and the rest', () => {
    expect(importanceOf(0, 50)).toBe(1);
    expect(importanceOf(11, 10)).toBe(1);
    expect(importanceOf(12, 50)).toBe(2);
    expect(importanceOf(3, 5)).toBe(2);
    expect(importanceOf(47, 5)).toBe(2);
    expect(importanceOf(48, 50)).toBe(3);
    expect(importanceOf(5, 1)).toBe(3);
  });
});

describe('generic terms and line checks', () => {
  it('keeps closed-class words out of the cast, and common vocabulary out of a nonfiction one', () => {
    expect(isGenericTerm('such', 'fiction')).toBe(true);
    expect(isGenericTerm('world', 'fiction')).toBe(true);
    expect(isGenericTerm('front door', 'fiction')).toBe(true);
    expect(isGenericTerm('necrarchs', 'fiction')).toBe(false);
    expect(isGenericTerm('skinsuit', 'fiction')).toBe(false);
    expect(isGenericTerm('assholes', 'fiction')).toBe(true);
    expect(isGenericTerm('Dick', 'fiction')).toBe(false);
    expect(isGenericTerm('bullshit', 'nonfiction')).toBe(false);
    expect(isGenericTerm('control problem', 'nonfiction')).toBe(false);
    expect(isGenericTerm('world', 'nonfiction')).toBe(true);
    expect(isGenericTerm('singleton', 'nonfiction')).toBe(false);
    expect(isGenericTerm('One', 'nonfiction')).toBe(false);
  });

  it('keeps units of measure, nationalities and mild exclamations out of a novel cast', () => {
    expect(isUnitTerm('kilometers', 'fiction')).toBe(true);
    expect(isUnitTerm('kilograms', 'fiction')).toBe(true);
    expect(isUnitTerm('days', 'fiction')).toBe(true);
    expect(isUnitTerm('Days', 'fiction')).toBe(false);
    expect(isUnitTerm('kilometers', 'nonfiction')).toBe(false);
    expect(isUnitTerm('sled', 'fiction')).toBe(false);
    expect(isNationalityTerm('Canadian', 'fiction')).toBe(true);
    expect(isNationalityTerm('Russians', 'fiction')).toBe(true);
    expect(isNationalityTerm('Canadian Space Agency', 'fiction')).toBe(false);
    expect(isNationalityTerm('Veskari', 'fiction')).toBe(false);
    expect(isExclamationTerm('dang', 'fiction')).toBe(true);
    expect(isExclamationTerm('whoa', 'fiction')).toBe(true);
  });

  it('recognizes everyday fiction words up to SCOWL level 35 and filters fiction exclamations', () => {
    expect(isEverydayTerm('house', 'fiction')).toBe(true);
    expect(isEverydayTerm('cloak', 'fiction')).toBe(true);
    expect(isEverydayTerm('shit', 'fiction')).toBe(false);
    expect(isEverydayTerm('Cloak', 'fiction')).toBe(false);
    expect(isEverydayTerm('front door', 'fiction')).toBe(false);
    expect(isEverydayTerm('cloak', 'nonfiction')).toBe(false);
    for (const term of ['shit', 'hmm', 'ugh']) {
      expect(isGenericTerm(term, 'fiction')).toBe(true);
      expect(isGenericTerm(term, 'nonfiction')).toBe(false);
    }
    expect(isGenericTerm('Yoink', 'fiction')).toBe(false);
  });
});

describe('forms of address and interjections', () => {
  it('treats a name said mostly as "your X" as a form of address', () => {
    const text = sentences(4);
    text[0].text = 'Yes, your Grace.';
    text[1].text = 'Her Grace will see you.';
    text[2].text = 'Grace Holt came in.';
    text[3].text = 'As you wish, your Grace.';
    expect(honorific('Grace', [1, 2, 3, 4], text)).toBe(true);
    expect(honorific('Grace', [3], text)).toBe(false);
  });

  it('drops lowercase interjections and drawn-out sounds in a novel, not in nonfiction or as names', () => {
    expect(['alright', 'dude', 'errr', 'aaah', 'hmmmm'].every((word) => isExclamationTerm(word, 'fiction'))).toBe(true);
    expect(isExclamationTerm('errr', 'nonfiction')).toBe(false);
    expect(isExclamationTerm('Dude', 'fiction')).toBe(false);
    expect(isExclamationTerm('necrarch', 'fiction')).toBe(false);
  });
});
