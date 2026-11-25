import { describe, expect, it } from 'vitest';
import { annotateKindCues, CUE, KIND_LABELS } from './kind-cues';
import { decideKind, metadataKeys, termKinds } from './kinds';
import type { Artifact, Mention, Sentence } from './model';
import { extractTerms } from './term-extractor';
import { visibleTerms } from './artifact';

const label = (name: (typeof KIND_LABELS)[number]): number => KIND_LABELS.indexOf(name);
function mention(ordinal: number, alias: string, extra: Partial<Mention> = {}): Mention {
  return {
    ordinal,
    alias,
    definition: false,
    capitalized: true,
    person: false,
    place: false,
    nested: false,
    structural: false,
    lowercase: alias === alias.toLowerCase(),
    ...extra,
  };
}
function term(displayName: string, mentions: Mention[], key = displayName.toLowerCase()) {
  return { key, displayName, aliases: [], mentions };
}
function voted(count: number, name: (typeof KIND_LABELS)[number], alias = 'Veyra', from = 1, extra: Partial<Mention> = {}): Mention[] {
  return Array.from({ length: count }, (_, index) => mention(from + index, alias, { kindLabel: label(name), kindAt: from + index, ...extra }));
}
const none = new Set<string>();

describe('kind vote rules', () => {
  it('R5 needs at least two votes and 40 percent of the votes', () => {
    expect(decideKind(term('Veyra', voted(1, 'person or character')), 99, none).kind).toBeNull();
    expect(decideKind(term('Veyra', voted(2, 'person or character')), 99, none)).toMatchObject({ kind: 'person', rule: 'R5 majority' });
    const split = [...voted(2, 'person or character'), ...voted(2, 'place or location', 'Veyra', 3), ...voted(2, 'object or artifact', 'Veyra', 5)];
    expect(decideKind(term('Veyra', split), 99, none).kind).toBeNull();
    const ideas = [...voted(2, 'magic or power system'), ...voted(1, 'force or energy', 'Veyra', 3), ...voted(2, 'place or location', 'Veyra', 4)];
    expect(decideKind(term('Veyra', ideas), 99, none)).toMatchObject({ kind: 'idea', votes: { idea: 3, place: 2 } });
  });

  it('R2 lets animal, god or spirit beat person at 30 percent and at least 5 votes', () => {
    const horse = [...voted(9, 'person or character'), ...voted(5, 'animal or creature', 'Veyra', 10)];
    expect(decideKind(term('Veyra', horse), 99, none)).toMatchObject({ kind: 'animal', subtype: 'animal', rule: 'R2 specific' });
    const god = [...voted(6, 'person or character'), ...voted(5, 'god or deity', 'Veyra', 7)];
    expect(decideKind(term('Veyra', god), 99, none)).toMatchObject({ kind: 'person', subtype: 'god' });
    const few = [...voted(6, 'person or character'), ...voted(4, 'animal or creature', 'Veyra', 7)];
    expect(decideKind(term('Veyra', few), 99, none)).toMatchObject({ kind: 'person', subtype: null });
    const small = [...voted(20, 'person or character'), ...voted(5, 'spirit or supernatural being', 'Veyra', 21)];
    expect(decideKind(term('Veyra', small), 99, none).subtype).toBeNull();
  });

  it('R3 turns class-like characters into groups, and "the" counts for nothing', () => {
    const order = voted(4, 'person or character', 'Wardens', 1, { cues: CUE.plural });
    expect(decideKind(term('Wardens', order, 'warden'), 99, none)).toMatchObject({ kind: 'group', rule: 'R3 class' });
    const single = voted(4, 'person or character', 'Lantern');
    expect(decideKind(term('Lantern', single), 99, none).kind).toBe('person');
    const mixed = [...voted(2, 'person or character', 'Lantern', 1, { cues: CUE.classDeterminer }), ...voted(3, 'person or character', 'Lantern', 3)];
    expect(decideKind(term('Lantern', mixed), 99, none).kind).toBe('person');
    const lower = voted(4, 'person or character', 'drift', 1, { cues: 0 });
    lower[0] = { ...lower[0], cues: CUE.indefinite | CUE.classDeterminer };
    expect(decideKind(term('drift', lower), 99, none).kind).toBe('group');
    const place = voted(4, 'place or location', 'Wardens', 1, { cues: CUE.plural });
    expect(decideKind(term('Wardens', place, 'warden'), 99, none).kind).toBe('place');
  });

  it('J1 marks the book title or an author name as junk', () => {
    const keys = metadataKeys({ titles: ['The Hollow Lantern'], authors: ['Mira Quell'] });
    expect([...keys].sort()).toEqual(['hollow lantern', 'mira quell', 'quell mira', 'the hollow lantern']);
    expect(decideKind(term('Hollow Lantern', voted(3, 'object or artifact')), 99, keys)).toMatchObject({ kind: 'junk', rule: 'J1 metadata' });
    expect(decideKind(term('Mira Quell', voted(3, 'person or character'), 'mira quell'), 99, keys).kind).toBe('junk');
    expect(decideKind(term('Mira', voted(3, 'person or character')), 99, keys).kind).toBe('person');
  });

  it('J4 marks bracket labels made only of common words as junk', () => {
    const bracketed = voted(3, 'person or character', 'Dead person', 1, { cues: CUE.bracket });
    expect(decideKind(term('Dead person', bracketed, 'dead person'), 99, none)).toMatchObject({ kind: 'junk', rule: 'J4 bracket label' });
    const rare = voted(3, 'person or character', 'Vexnor', 1, { cues: CUE.bracket });
    expect(decideKind(term('Vexnor', rare), 99, none).kind).toBe('person');
    const once = [...voted(1, 'person or character', 'Dead person', 1, { cues: CUE.bracket }), ...voted(2, 'person or character', 'Dead person', 2)];
    expect(decideKind(term('Dead person', once, 'dead person'), 99, none).kind).toBe('person');
  });

  it('counts only capitalised mentions for a capitalised name', () => {
    const mentions = [...voted(2, 'person or character'), ...voted(3, 'concept or idea', 'veyra', 3)];
    expect(decideKind(term('Veyra', mentions), 99, none)).toMatchObject({ kind: 'person', mentions: 2 });
  });

  it('never counts a vote whose window ends after the cut-off', () => {
    const mentions = [mention(1, 'Veyra', { kindLabel: 0, kindAt: 3 }), mention(2, 'Veyra', { kindLabel: 0, kindAt: 3 })];
    expect(decideKind(term('Veyra', mentions), 2, none).kind).toBeNull();
    expect(decideKind(term('Veyra', mentions), 3, none).kind).toBe('person');
  });
});

function sentence(ordinal: number, text: string): Sentence {
  return { ordinal, text, spineIndex: 0, paragraphIndex: ordinal, href: 'invented.xhtml', structure: 'body', heading: false, emphasis: [] };
}

describe('kind leak gate', () => {
  it('gives the same kinds from a full-book build and from a prefix build', () => {
    const lines = [
      'Veyra crossed the bridge at dawn.',
      'Veyra said nothing to the guards.',
      'The Wardens of Ostrel watched the road.',
      'Veyra spoke with a Warden near the gate.',
      'Later, Veyra was revealed as a Warden herself.',
      'The Wardens were never seen again.',
    ];
    const sentences = lines.map((text, index) => sentence(index + 1, text));
    const spans: number[] = [];
    let offset = 0;
    sentences.forEach((value, index) => {
      for (const match of value.text.matchAll(/Veyra|Wardens?/g)) {
        const name = match[0] === 'Veyra' ? (index >= 4 ? 'group, people or organization' : 'person or character') : 'group, people or organization';
        spans.push(offset + match.index, offset + match.index + match[0].length, label(name), Math.min(index + 2, sentences.length));
      }
      offset += value.text.length + 1;
    });
    const build = (input: Sentence[]): Artifact => {
      const terms = extractTerms(input);
      annotateKindCues(input, terms, spans);
      return { formatVersion: 3, textVersion: 1, termsVersion: 1, fingerprint: '', seeds: [], aliasLinks: [], sentences: input, terms };
    };
    const full = build(sentences);
    for (const cutoff of [2, 3, 4, 5]) {
      const prefix = build(sentences.slice(0, cutoff));
      const decide = (artifact: Artifact) => Object.fromEntries(termKinds(artifact, visibleTerms(artifact, cutoff), cutoff));
      expect(decide(prefix)).toEqual(decide(full));
    }
    const atTwo = termKinds(full, visibleTerms(full, 2), 2).get('veyra');
    expect(atTwo?.votes).toEqual({ person: 1 });
  });

  it('keeps kinds and cues out of mentions it cannot find', () => {
    const sentences = [sentence(1, 'Veyra waited.')];
    const terms = extractTerms(sentences);
    for (const value of terms) for (const feature of value.features) feature.alias = 'Missing';
    annotateKindCues(sentences, terms, [0, 5, 0, 1]);
    expect(terms.flatMap((value) => value.features).some((feature) => feature.kindLabel !== undefined)).toBe(false);
  });
});
