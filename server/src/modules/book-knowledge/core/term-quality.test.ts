import { describe, expect, it } from 'vitest';
import { extractAliasLinks, extractTerms } from './term-extractor';
import { oftenWith, visibleTerm } from './artifact';
import { rankTerms } from './term-ranking';
import { wordRarity } from './common-words';
import type { Artifact, Sentence } from './model';

function artifact(texts: string[]): Artifact {
  const sentences: Sentence[] = texts.map((text, i) => ({
    text,
    ordinal: i + 1,
    spineIndex: Math.floor(i / 3),
    paragraphIndex: i,
    href: 'invented.xhtml',
    structure: 'body',
    heading: false,
    emphasis: [],
  }));
  return {
    sentences,
    terms: extractTerms(sentences),
    seeds: [],
    aliasLinks: [],
    fingerprint: 'invented',
    formatVersion: 1,
    textVersion: 2,
    termsVersion: 2,
  };
}

describe('term quality from the reading prefix', () => {
  it('counts noun uses only and drops a minority noun reading without looking ahead', () => {
    const a = artifact([
      'The record is dusty.',
      'We record the signal.',
      'We record the signal.',
      'A possible result is new.',
      'They achieve a large result.',
    ]);
    expect(a.terms.find((term) => term.key === 'record')?.features.map((m) => m.noun)).toEqual([true, false, false]);
    expect(visibleTerm(a, 'record', 1)).toBeUndefined();
    expect(visibleTerm(a, 'record', 3)).toBeUndefined();
    for (const key of ['possible', 'new', 'achieve']) expect(visibleTerm(a, key, Infinity)).toBeUndefined();
  });

  it('admits recurring participles with noun heads, but waits for prefix support', () => {
    const a = artifact([
      'The folded crystal glows.',
      'The folded crystal glows.',
      'The folded crystal glows.',
      'The crystal loading continues.',
      'The crystal loading continues.',
      'The crystal loading continues.',
    ]);
    expect(visibleTerm(a, 'folded crystal', Infinity)?.count).toBe(3);
    expect(visibleTerm(a, 'crystal loading', Infinity)?.count).toBe(3);
    const t = a.terms.find((term) => term.key === 'folded crystal')!;
    expect(t.features[0].forgiven).toBe(true);
    expect(visibleTerm(a, t.key, 1)).toBeUndefined();
    expect(visibleTerm(a, t.key, 2)).toBeUndefined();
    const defined = artifact(['We call this phenomenon the folded crystal.', 'The folded crystal glows.']);
    expect(visibleTerm(defined, 'folded crystal', 2)?.count).toBe(2);
    const verbs = artifact(['They watched glowing softly.', 'They watched glowing softly.', 'They watched glowing softly.']);
    expect(visibleTerm(verbs, 'watched glowing', Infinity)).toBeUndefined();
  });

  it.each([
    'We call this phenomenon the amber lattice.',
    'This is the amber lattice.',
    'A device which we call amber lattice hums.',
    'We term amber lattice a device.',
    'The amber lattice thesis concerns echoes.',
    'The amber lattice holds that echoes persist.',
    'The amber lattice, which stores echoes, hums.',
    'Amber lattice, in other words, stores echoes.',
    'By amber lattice we mean a device.',
    'What we might call amber lattice hums.',
    'Amber lattice (an echo device) hums.',
    'We call it “amber lattice”.',
  ])('recognizes an introduction: %s', (text) => {
    const a = artifact([text]);
    expect(visibleTerm(a, 'amber lattice', 1)?.mentions[0].definition).toBe(true);
  });

  it('recognizes article headings and first-use emphasis', () => {
    const a = artifact(['The amber lattice', 'An amber lattice hums.']);
    a.sentences[0].heading = true;
    a.sentences[1].emphasis = ['amber lattice'];
    a.terms = extractTerms(a.sentences);
    expect(visibleTerm(a, 'amber lattice', 2)?.mentions.every((m) => m.definition)).toBe(true);
  });

  it('penalizes generic pairs and uses independent rather than nested frequency', () => {
    const a = artifact([
      'A large number arrived.',
      'A large number arrived.',
      'We call this phenomenon the amber lattice.',
      ...Array<string>(20).fill('The silver amber lattice was silent.'),
    ]);
    const ranked = rankTerms(a, Infinity);
    const score = (key: string) => ranked.find((term) => term.key === key)?.score ?? 0;
    expect(score('amber lattice')).toBeGreaterThan(score('large number'));
    expect(ranked.some((term) => term.key === 'large number')).toBe(false);
    const b = artifact(Array<string>(20).fill('The silver amber lattice was silent.'));
    const r = rankTerms(b, Infinity);
    expect(r.findIndex((term) => term.key === 'silver amber lattice')).toBeLessThan(r.findIndex((term) => term.key === 'amber lattice'));
    expect(rankTerms(a, 3)).toEqual(rankTerms(artifact(a.sentences.slice(0, 3).map((s) => s.text)), 3));
  });

  it('strips possessive modifiers and keeps later spelling variants out of earlier ranks', () => {
    const early = ['Neris’s amber lattice was silent.', 'Olin’s crimson prism was silent.'];
    const prefix = artifact(early);
    const full = artifact([...early, "Neris's amber lattice was silent.", "Olin's crimson prism was silent.", 'Neris watched Olin.']);
    expect(prefix.terms.some((term) => /[’']s/.test(term.key))).toBe(false);
    expect(rankTerms(full, 2)).toEqual(rankTerms(prefix, 2));
  });

  it('keeps real-looking names with common words competitive in their own types', () => {
    const a = artifact([
      'Dr Rose Green said hello.',
      'Dr Rose Green replied quietly.',
      'We arrived in Silver Bay.',
      'We stayed near Silver Bay.',
      'Dr Zorin Valtek said hello.',
      'Dr Zorin Valtek replied quietly.',
    ]);
    const ranked = rankTerms(a, Infinity);
    expect(ranked.find((t) => t.key === 'rose green')?.type).toBe('person');
    expect(ranked.find((t) => t.key === 'silver bay')?.type).toBe('place');
    expect(ranked.find((t) => t.key === 'rose green')?.score).toBeGreaterThan(0);
    const changed = structuredClone(a);
    changed.terms.find((term) => term.key === 'rose green')!.rarity = 1;
    expect(ranked.find((t) => t.key === 'rose green')?.score).toBe(rankTerms(changed, Infinity).find((t) => t.key === 'rose green')?.score);
    expect(wordRarity('the')).toBe(0);
    expect(wordRarity('xyloquartz')).toBe(1);
  });
});

it('recognizes an invented adjective as a noun after a determiner before a non-noun', () => {
  const a = artifact([
    'A velorous waits.',
    'The velorous sleeps.',
    'The velorous gate opens.',
    'The velorous gate closes.',
    'The velorous gate hums.',
  ]);
  const term = a.terms.find((term) => term.key === 'velorous')!;
  expect(term.features.map((mention) => mention.noun)).toEqual([true, true, false, false, false]);
  expect(visibleTerm(a, 'velorous', 2)?.count).toBe(2);
  expect(visibleTerm(a, 'velorous', 5)).toBeUndefined();
});
it('keeps a defined invented adjective only once its definition is read', () => {
  const a = artifact([
    'The glimmerous gate opens.',
    'The glimmerous gate closes.',
    'The glimmerous gate hums.',
    'A glimmerous is a keeper of sparks.',
  ]);
  expect(visibleTerm(a, 'glimmerous', 3)).toBeUndefined();
  expect(rankTerms(a, 3)).toEqual(rankTerms(artifact(a.sentences.slice(0, 3).map((sentence) => sentence.text)), 3));
  expect(visibleTerm(a, 'glimmerous', 4)?.count).toBe(4);
  expect(rankTerms(a, 4).some((term) => term.key === 'glimmerous')).toBe(true);
});
it('keeps a standalone definition even when stored noun readings are absent', () => {
  const a = artifact(['The velorous gate opens.', 'The velorous gate closes.', 'Velorous means a keeper of sparks.']);
  for (const mention of a.terms.find((term) => term.key === 'velorous')!.features) mention.noun = false;
  expect(visibleTerm(a, 'velorous', 2)).toBeUndefined();
  expect(visibleTerm(a, 'velorous', 3)?.count).toBe(3);
});

it('uses human actions and citations without honorifics and avoids directional place guesses', () => {
  const a = artifact([
    'Neravel smiled at the gate.',
    'We spoke to Neravel.',
    'They heard from Zoravel.',
    'The report cites Elora Venn (2008).',
    'According to Elora Venn, the device works.',
    'Power is a resource.',
    'The Power rose again.',
    'The Power fell again.',
    'We waited in Thornhaven.',
    'We walked near Thornhaven.',
  ]);
  expect(visibleTerm(a, 'neravel', Infinity)?.type).toBe('person');
  expect(visibleTerm(a, 'zoravel', Infinity)?.type).toBe('concept');
  expect(visibleTerm(a, 'elora venn', Infinity)?.type).toBe('person');
  expect(visibleTerm(a, 'power', Infinity)?.type).toBe('concept');
  expect(visibleTerm(a, 'thornhaven', Infinity)?.type).toBe('place');
});

it('keeps classification evidence inside the reading prefix', () => {
  const texts = ['We sent a letter to Zoravel.', 'We received a letter from Zoravel.', 'Zoravel smiled.'];
  const full = artifact(texts);
  expect(visibleTerm(full, 'zoravel', 2)?.type).toBe('concept');
  expect(visibleTerm(full, 'zoravel', 3)?.type).toBe('person');
  expect(rankTerms(full, 2)).toEqual(rankTerms(artifact(texts.slice(0, 2)), 2));
});

it('excludes noises, interjections, repeated words and contraction fragments', () => {
  const a = artifact([
    'Oh wow! Hmmmm! Aaaaaaaa!',
    "I'm ready. I'm ready. I'm ready.",
    'Wow Wow arrived. Wow Wow arrived. Wow Wow arrived.',
    'Oh Damn appeared. Oh Damn appeared. Oh Damn appeared.',
  ]);
  for (const term of rankTerms(a, Infinity)) expect(term.key).not.toMatch(/^(?:oh|wow|hmmm|aaaa)|\bm\b|damn/);
});

it('shares person evidence across active aliases only after the link is read', () => {
  const a = artifact(['We sent a letter to Zoravel.', 'Neravel Voss smiled.', 'Zoravel is also known as Neravel Voss.']);
  a.aliasLinks = [{ left: 'zoravel', right: 'neravel voss', ordinal: 3 }];
  expect(visibleTerm(a, 'zoravel', 1)?.type).toBe('concept');
  expect(visibleTerm(a, 'zoravel', 3)?.type).toBe('person');
});

it('merges a bracketed short form into its long form from the defining sentence, under the long name', () => {
  const a = artifact([
    'The SGD step is cheap. The SGD step repeats. The SGD step converges.',
    'We now describe stochastic gradient descent (SGD) in full.',
    'SGD samples one batch. SGD updates the weights. SGD repeats until it settles.',
  ]);
  a.aliasLinks = extractAliasLinks(a.sentences, a.terms);
  expect(a.aliasLinks).toContainEqual({ left: 'stochastic gradient descent', right: 'sgd', ordinal: 2 });
  expect(visibleTerm(a, 'stochastic gradient descent', 1)).toBeUndefined();
  expect(visibleTerm(a, 'sgd', 1)?.displayName).toBe('SGD');
  const merged = visibleTerm(a, 'sgd', 3);
  expect(merged?.displayName).toBe('stochastic gradient descent');
  expect(merged?.aliases).toContain('SGD');
});

it('links identity statements only between names or distinctive terms', () => {
  const a = artifact([
    'The old tavern stood by the road. The tavern was quiet. The tavern was dark.',
    'The tavern was called the First Spire by locals. The First Spire was busy.',
    'Zoravel walked in. Neravel Voss smiled. Zoravel is also known as Neravel Voss.',
  ]);
  const links = extractAliasLinks(a.sentences, a.terms);
  expect(links.some((link) => link.left === 'tavern')).toBe(false);
  expect(links).toContainEqual(expect.objectContaining({ left: 'zoravel', right: 'neravel voss' }));
});

it('counts distinct shared body paragraphs and excludes word parts in both directions', () => {
  const early = [
    'The amber lattice hummed.',
    'A crimson prism spun beside the tall amber lattice.',
    'The crimson prism cracked.',
    'The tall amber lattice surrounds the crimson prism.',
    'The silver cylinder rang.',
    'The violet crystal broke.',
    'The amber lattice hummed.',
    'The cobalt mirror gleamed.',
  ];
  const prefix = artifact(early);
  const full = artifact([
    ...early,
    'The amber lattice surrounds the crimson prism.',
    'The amber lattice surrounds the crimson prism.',
    ...Array<string>(5).fill('The amber lattice surrounds the golden toroid.'),
    ...Array<string>(9).fill('The crimson prism cracked.'),
  ]);
  for (const a of [prefix, full]) {
    a.sentences.slice(0, 3).forEach((sentence) => (sentence.paragraphIndex = 0));
    a.sentences[6].paragraphIndex = 0;
  }
  full.sentences[8].structure = 'notes';
  full.sentences[9].structure = 'index';
  const related = oftenWith(prefix, 'amber lattice', 8);
  expect(related).toContainEqual({ key: 'crimson prism', displayName: 'crimson prism', count: 2, first: 2 });
  expect(related.map((term) => term.key)).not.toContain('lattice');
  expect(related.map((term) => term.key)).not.toContain('tall amber lattice');
  expect(oftenWith(full, 'amber lattice', 3)).toEqual([]);
  expect(oftenWith(full, 'amber lattice', 10)).toEqual(related);
  expect(oftenWith(full, 'amber lattice', 8)).toEqual(related);
  expect(rankTerms(full, 8)).toEqual(rankTerms(prefix, 8));
});

it('drops ubiquitous terms with zero PMI and sorts equal associations by key', () => {
  const a = artifact([
    ...Array<string>(2).fill('A violet crystal sits beside an amber lattice and an obsidian gyroscope.'),
    ...Array<string>(2).fill('A crimson prism sits beside an amber lattice and an obsidian gyroscope.'),
    ...Array<string>(2).fill('The obsidian gyroscope rang beside a silver cylinder.'),
  ]);
  const keys = oftenWith(a, 'amber lattice', 6).map((term) => term.key);
  expect(keys.filter((key) => ['crimson prism', 'violet crystal', 'obsidian gyroscope'].includes(key))).toEqual(['crimson prism', 'violet crystal']);
});

it('keeps the complete candidate when a shorter key has the same paragraph evidence', () => {
  const a = artifact([
    ...Array<string>(4).fill('The amber lattice stood beside the Azure Beacon.'),
    ...Array<string>(4).fill('The silver cylinder rang.'),
  ]);
  expect(rankTerms(a, 8).map((term) => term.key)).toEqual(expect.arrayContaining(['azure', 'azure beacon']));
  const keys = oftenWith(a, 'amber lattice', 8).map((term) => term.key);
  expect(keys).toContain('azure beacon');
  expect(keys).not.toContain('azure');
});

it('boosts only visible terms with two detections across distinct cutoff-visible keys', () => {
  const a = artifact(['The amber lattice hummed.', 'A crimson prism spun.', 'The amber lattice hummed.', 'A crimson prism spun.']);
  a.aliasLinks = [{ left: 'amber lattice', right: 'crimson prism', ordinal: 3 }];
  const voted: Artifact = {
    ...a,
    modelVotes: [
      { key: 'amber lattice', deltas: [1] },
      { key: 'crimson prism', deltas: [2, 2] },
      { key: 'silver gyroscope', deltas: [1, 0] },
    ],
  };
  const score = (input: Artifact, cutoff: number) => rankTerms(input, cutoff).find((term) => term.key === 'amber lattice')?.score;
  expect(rankTerms(voted, 2)).toEqual(rankTerms(a, 2));
  expect(score(voted, 3)).toBeGreaterThan(score(a, 3)!);
  expect(rankTerms(voted, 4).map((term) => term.key)).not.toContain('silver gyroscope');

  const future: Artifact = { ...a, modelVotes: [{ key: 'amber lattice', deltas: [1, 3] }] };
  expect(rankTerms(future, 3)).toEqual(rankTerms(a, 3));
  expect(score(future, 4)).toBeGreaterThan(score(a, 4)!);
});

it('includes a named single word below rank 150 only after five mentions', () => {
  const a = artifact([
    ...Array<string>(2).fill('Yesterday, Pattern smiled beside the amber lattice.'),
    ...Array<string>(12).fill('We call it a zirconium quartzite prism.'),
    ...Array<string>(3).fill('Yesterday, Pattern smiled.'),
  ]);
  const pattern = a.terms.find((term) => term.key === 'pattern')!;
  pattern.features.forEach((mention) => (mention.proper = false));
  const template = a.terms.find((term) => term.key === 'zirconium quartzite prism')!;
  const filler = Array.from({ length: 150 }, (_, i) => ({
    ...template,
    key: `zirconium quartzite prism${i}`,
    rarity: 1,
    features: template.features.map((mention) => ({ ...mention, definition: true, introduced: true, nested: false })),
  }));
  a.terms.push(...filler);

  expect(rankTerms(a, 16).findIndex((term) => term.key === 'pattern')).toBeGreaterThanOrEqual(150);
  expect(rankTerms(a, 17).findIndex((term) => term.key === 'pattern')).toBeGreaterThanOrEqual(150);
  expect(oftenWith(a, 'amber lattice', 16).some((term) => term.key === 'pattern')).toBe(false);
  expect(oftenWith(a, 'amber lattice', 17)).toContainEqual({ key: 'pattern', displayName: 'Pattern', count: 2, first: 1 });
});

it('rescues common-word names with five mid-sentence capitalized mentions without proper tags', () => {
  const a = artifact(Array<string>(6).fill('Yesterday, Pattern smiled.'));
  const term = a.terms.find((term) => term.key === 'pattern')!;
  expect(wordRarity(term.key)).toBe(0);
  term.features.forEach((mention) => (mention.proper = false));
  const control = structuredClone(a);
  control.terms.find((term) => term.key === 'pattern')!.features.forEach((mention) => (mention.capitalized = false));
  const scoreAt = (data: Artifact, cutoff: number) => rankTerms(data, cutoff).find((item) => item.key === 'pattern')!.score;
  expect(scoreAt(a, 4)).toBe(scoreAt(control, 4));
  expect(scoreAt(a, 5)).toBeGreaterThan(scoreAt(control, 5));
});

it('keeps a future candidate-forming use from exposing earlier incidental emphasis', () => {
  const early = 'The paint looks vivid.';
  const prefix = artifact([early]);
  const full = artifact([early, 'Later we saw a vivid.']);
  for (const a of [prefix, full]) {
    a.sentences[0].emphasis = ['vivid'];
    a.terms = extractTerms(a.sentences);
  }
  expect(rankTerms(full, 1)).toEqual(rankTerms(prefix, 1));
  expect(rankTerms(full, 2).map((term) => term.key)).toContain('vivid');
});

it('links a cased epithet at the third body pattern once coverage and person thresholds hold', () => {
  const a = artifact([
    ...Array<string>(6).fill('Neravel smiled at the gate.'),
    'We met Neravel Brightwing.',
    'We met Neravel, the Brightwing.',
    'We met Neravel the brightwing.',
    'We met Neravel the Brightwing.',
  ]);
  a.aliasLinks = extractAliasLinks(a.sentences, a.terms);
  expect(a.aliasLinks).toContainEqual({ left: 'brightwing', right: 'neravel', ordinal: 10 });
  expect(visibleTerm(a, 'brightwing', 9)?.key).toBe('brightwing');
  expect(visibleTerm(a, 'brightwing', 10)?.key).toBe('neravel');
});

it('suppresses family surnames starting when a competing given name is person-like', () => {
  const early = [...Array<string>(5).fill('Neravel smiled at the gate.'), ...Array<string>(3).fill('We met Neravel Voss.')];
  const prefix = artifact(early);
  const full = artifact([...early, 'We invited Toralen Voss.', 'Toralen smiled.']);
  const competingFirst = artifact([...early.slice(0, -1), 'Toralen smiled.', 'We invited Toralen Voss.', early.at(-1)!]);
  for (const a of [prefix, full, competingFirst]) a.aliasLinks = extractAliasLinks(a.sentences, a.terms);
  expect(full.aliasLinks).toContainEqual({ left: 'voss', right: 'neravel', ordinal: 8, untilOrdinal: 10 });
  expect(rankTerms(full, 8)).toEqual(rankTerms(prefix, 8));
  expect(visibleTerm(full, 'voss', 9)?.key).toBe('neravel');
  expect(visibleTerm(full, 'voss', 10)?.key).toBe('voss');
  expect(competingFirst.aliasLinks.some((link) => link.left === 'voss')).toBe(false);
});

it('ignores titles and keeps an established epithet as coverage and person evidence fall', () => {
  const a = artifact([
    ...Array<string>(3).fill('Neravel smiled.'),
    ...Array<string>(4).fill('We met Neravel.'),
    ...Array<string>(3).fill('We met Neravel Brightwing.'),
    'House Brightwing stood.',
    ...Array<string>(31).fill('We met Brightwing.'),
    ...Array<string>(6).fill('We met Neravel.'),
  ]);
  a.terms.find((term) => term.key === 'house')!.features.forEach((mention) => (mention.person = true));
  a.aliasLinks = extractAliasLinks(a.sentences, a.terms);
  expect(a.aliasLinks).toContainEqual({ left: 'brightwing', right: 'neravel', ordinal: 10 });
  expect(visibleTerm(a, 'brightwing', Infinity)?.key).toBe('neravel');
});

it('requires epithet coverage and independent person evidence', () => {
  const rarePattern = artifact([
    ...Array<string>(5).fill('Neravel smiled at the gate.'),
    ...Array<string>(40).fill('We met Brightwing.'),
    ...Array<string>(3).fill('We met Neravel the Brightwing.'),
  ]);
  const nonPerson = artifact(Array<string>(3).fill('We viewed the statue of Neravel the Brightwing.'));
  for (const a of [rarePattern, nonPerson]) {
    expect(extractAliasLinks(a.sentences, a.terms).some((link) => link.left === 'brightwing')).toBe(false);
  }
});

it('boosts observed index aliases and cross-reference targets only once seen', () => {
  const a = artifact([
    'The crimson prisms gleamed.',
    'A cobalt prism spun.',
    'The crimson prisms and the cobalt prism shattered.',
    'The amber lattice hummed.',
    'The violet crystal broke.',
    'The golden toroid spun.',
  ]);
  a.aliasLinks = [{ left: 'crimson prism', right: 'cobalt prism', ordinal: 2 }];
  const fillers = Array.from({ length: 19 }, (_, i) => `Entry ${i + 1}, ${i + 10}`);
  const short = { ...a, seeds: [[...fillers.slice(1), 'Amber lattice, 50'].join('\n')] };
  const withIndex = {
    ...a,
    seeds: [[...fillers, 'Cobalt prisms (optics), 155\u201359, 207', 'Ceramics. See Amber Lattice.', 'Golden toroid, 55'].join('\n')],
  };
  expect(rankTerms(short, 5)).toEqual(rankTerms(a, 5));
  const ranked = rankTerms(withIndex, 5);
  const original = rankTerms(a, 5);
  const score = (terms: typeof ranked, key: string) => terms.find((term) => term.key === key)!.score;
  expect(score(ranked, 'crimson prism') - score(original, 'crimson prism')).toBeGreaterThanOrEqual(7);
  expect(score(ranked, 'amber lattice') - score(original, 'amber lattice')).toBeCloseTo(7);
  expect(score(ranked, 'violet crystal')).toBe(score(original, 'violet crystal'));
  expect(ranked.map((term) => term.key)).not.toContain('golden toroid');
  expect(rankTerms(withIndex, 1)).toEqual(rankTerms(a, 1));
});

it('makes a common-word index heading visible at its first encounter', () => {
  const early = ['We watched the sunrise.', 'The experience machine broke.'];
  const fillers = Array.from({ length: 19 }, (_, i) => `Entry ${i + 1}, ${i + 10}`);
  const seeds = [[...fillers, 'Experience machine, 50'].join('\n')];
  const prefix = artifact(early);
  const full = { ...artifact([...early, 'The experience machine failed again.']), seeds };
  expect(visibleTerm(prefix, 'experience machine', 2)).toBeUndefined();
  expect(visibleTerm(full, 'experience machine', 1)).toBeUndefined();
  expect(visibleTerm(full, 'experience machine', 2)?.count).toBe(1);
  expect(rankTerms(full, 2)).toEqual(rankTerms({ ...prefix, seeds }, 2));
  const score = (cutoff: number) => rankTerms(full, cutoff).find((term) => term.key === 'experience machine')!.score;
  expect(score(2)).toBeLessThan(20.5);
  expect(score(3)).toBeGreaterThan(20.5);
});

it('keeps a recurring common-word pair spread over chapters but not a single common word', () => {
  const texts = Array.from({ length: 6 }, () => 'The control problem stayed open.');
  const spread = artifact(texts);
  const oneChapter = artifact(texts);
  oneChapter.sentences.forEach((sentence) => (sentence.spineIndex = 0));
  expect(['control', 'problem'].map(wordRarity)).toEqual([0, 0]);
  expect(visibleTerm(spread, 'control problem', 4)).toBeUndefined();
  expect(visibleTerm(spread, 'control problem', 5)?.count).toBe(5);
  expect(visibleTerm(oneChapter, 'control problem', 6)).toBeUndefined();
  expect(visibleTerm(spread, 'problem', 6)).toBeUndefined();
});

it('filters lightly defined function words and calendar uses while retaining a named weekday', () => {
  const a = artifact(['We said Perhaps aloud.', 'Perhaps we should leave.', 'We arrived on Monday.', 'Later, Monday smiled.']);
  a.sentences[0].emphasis = ['Perhaps'];
  a.sentences[2].emphasis = ['Monday'];
  a.terms = extractTerms(a.sentences);
  expect(visibleTerm(a, 'perhap', 3)).toBeDefined();
  expect(visibleTerm(a, 'monday', 3)).toBeDefined();
  expect(rankTerms(a, 3).map((term) => term.key)).not.toContain('perhap');
  expect(rankTerms(a, 3).map((term) => term.key)).not.toContain('monday');
  expect(rankTerms(a, 4).map((term) => term.key)).toContain('monday');
});

it('ranks incidental emphasis below explicit definitions for generic pairs and attributive adjectives', () => {
  const incidental = artifact([
    'A fictional character left.',
    'The paint looks vivid.',
    ...Array<string>(40).fill('A fictional character left.'),
    ...Array<string>(8).fill('A vivid mural gleamed.'),
    'The vivid remained.',
  ]);
  incidental.sentences[0].emphasis = ['fictional character'];
  incidental.sentences[1].emphasis = ['vivid'];
  incidental.terms = extractTerms(incidental.sentences);
  const defined = artifact([
    'We call it a fictional character.',
    'Vivid means a keeper of sparks.',
    ...incidental.sentences.slice(2).map((sentence) => sentence.text),
  ]);
  for (const key of ['fictional character', 'vivid']) {
    const score = (a: Artifact) => rankTerms(a, Infinity).find((term) => term.key === key)!.score;
    expect(score(defined)).toBeGreaterThan(score(incidental) + 5);
  }
});

it.each(['Elora Venn (2008) described the device.', 'Elora Venn et al. described the device.'])(
  'recognizes a citation without dialogue: %s',
  (text) => expect(visibleTerm(artifact([text]), 'elora venn', Infinity)?.type).toBe('person'),
);

it('rejects capitalized finite-verb fragments while preserving participle modifiers', () => {
  const a = artifact(Array<string>(3).fill('Neravel Walked. The Folded Crystal glows.'));
  expect(visibleTerm(a, 'neravel walked', Infinity)).toBeUndefined();
  expect(visibleTerm(a, 'folded crystal', Infinity)).toBeDefined();
});

it('does not take a capital from a word that opens a quoted sentence as its card spelling', () => {
  const a = artifact([...Array<string>(4).fill('“Glimmerwax,” she said.'), ...Array<string>(3).fill('She rubbed the glimmerwax on the blade.')]);
  expect(visibleTerm(a, 'glimmerwax', 7)?.displayName).toBe('glimmerwax');
});

it('links no epithet that is an everyday word the book writes in lowercase, or on a single person cue', () => {
  const station = artifact([
    ...Array<string>(4).fill('Kell said nothing at the gate.'),
    ...Array<string>(4).fill('The station hummed below them.'),
    'We reached Kell Station.',
    'We left Kell Station.',
    'We missed Kell Station.',
  ]);
  expect(extractAliasLinks(station.sentences, station.terms).some((link) => link.left === 'station')).toBe(false);
  const thin = artifact(['Orsk smiled.', 'Orsk nodded.', 'We met Orsk Lyrae.', 'We met Orsk Lyrae.', 'We met Orsk Lyrae.']);
  expect(extractAliasLinks(thin.sentences, thin.terms).some((link) => link.left === 'lyrae')).toBe(false);
  const plain = artifact(['Orsk smiled.', 'Orsk nodded.', 'Orsk waved.', 'We met Orsk Lyrae.', 'We met Orsk Lyrae.', 'We met Orsk Lyrae.']);
  expect(extractAliasLinks(plain.sentences, plain.terms).some((link) => link.left === 'lyrae')).toBe(true);
});
