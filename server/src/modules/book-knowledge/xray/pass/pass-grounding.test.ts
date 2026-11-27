import { describe, expect, it } from 'vitest';
import { garbledTerm, ungroundedNames } from './pass-grounding';

describe('garbledTerm', () => {
  const own = ['Deepward'];
  const quoted = ["Merged into the full skill: 'Deepward scholar'!"];
  const garbled = 'A skill merging her studies into one scholarship.';

  it('flags a reworded quoted or bracketed term that contains an own name', () => {
    expect(garbledTerm(garbled, quoted, own)).toBe('scholarship');
    expect(garbledTerm(garbled, ['[Deepward scholar: A skill from merged studies.]'], own)).toBe('scholarship');
    expect(garbledTerm('A shield spell with an embershield.', ['The spell is “Deepward ember”.'], own)).toBe('embershield');
    expect(garbledTerm('A spell called emberg.', ['The spell is ‘Deepward emberglass’.'], own)).toBe('emberg');
  });

  it('allows the whole term, inflections, and quotes unrelated to the entry', () => {
    expect(garbledTerm('A skill called Deepward scholar.', quoted, own)).toBeNull();
    expect(garbledTerm('A skill for scholars.', quoted, own)).toBeNull();
    expect(garbledTerm('A guard of embers.', ['She cast "Deepward ember".'], own)).toBeNull();
    expect(garbledTerm(garbled, ['Merged into the full skill: "Vellin scholar"!'], own)).toBeNull();
    expect(garbledTerm('A skill called deepward SCHOLAR.', ['[Deepward scholar: A skill from merged studies.]'], own)).toBeNull();
  });

  it('allows ship compounds with a four-letter base', () => {
    expect(garbledTerm('A skill merging her studies into one sageship.', ["Merged into 'Deepward sage'!"], own)).toBeNull();
  });
});

describe('ungroundedNames', () => {
  const support = ['Viv reached rank three of the hedge witch path.', 'She bound the war golem Solfis.'];

  it('passes a line built from what it was given', () => {
    expect(ungroundedNames('A hedge witch of rank three who bound the war golem Solfis.', support)).toEqual([]);
  });

  it('names the capitalised names nothing given mentions', () => {
    expect(ungroundedNames('A hedge witch exploring Cassian springs with Ilsa.', support)).toEqual(['Cassian', 'Ilsa']);
  });

  it('leaves lowercase words alone, however rare', () => {
    expect(ungroundedNames('A hedge witch exploring springs with millipedes, wielding obsidian.', support)).toEqual([]);
  });

  it('ignores the capital that opens the line', () => {
    expect(ungroundedNames('Young woman who travels south.', support)).toEqual([]);
  });

  it('matches word forms and possessives', () => {
    expect(ungroundedNames("A witch bound to Solfis's core, binding golems.", ['Solfis binds the golem core.', 'witch'])).toEqual([]);
  });

  it('ignores an ordinary word that opens a later sentence, but not a name there', () => {
    expect(ungroundedNames('A hedge witch. They fear her. Aboard the barge she bound Solfis. Ilsa watched.', support)).toEqual(['Ilsa']);
  });
});
