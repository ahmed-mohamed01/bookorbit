import { describe, expect, it } from 'vitest';
import type { Sentence } from '../core/model';
import { entity } from './xray-fixtures.testing';
import { PassCast } from './pass/pass-cast';
import { foldName, foldSpellings, fusedEntries, isJoinedPart, joinedParts } from './xray-name-fold';
import { noAnswer, text } from './pass/pass-read';
import { aliasCandidates } from './dense/dense-alias';

describe('foldName', () => {
  it('folds case, spaces, hyphens and dots', () => {
    expect(foldName('Rell-gate')).toBe(foldName('rell gate'));
    expect(foldName('St. Ives')).toBe(foldName('St Ives'));
    expect(foldName('Rell gate')).not.toBe(foldName('Rell gates'));
  });
});

describe('joinedParts', () => {
  it('splits a joined list and leaves other names whole', () => {
    expect(joinedParts('Quill and Bram')).toEqual(['Quill', 'Bram']);
    expect(joinedParts('Quill, Bram & Sef')).toEqual(['Quill', 'Bram', 'Sef']);
    expect(joinedParts('Brandon')).toEqual([]);
    expect(isJoinedPart('Quill and Bram', 'quill')).toBe(true);
    expect(isJoinedPart('Quillander', 'Quill')).toBe(false);
  });
});

describe('fusedEntries', () => {
  const entry = (key: string, name: string, kind: 'character' | 'group' | 'place' | 'object') => ({ key, names: [name], kind });

  it('drops a name that only joins two character or group entries', () => {
    const entries = [entry('q', 'Quill', 'character'), entry('b', 'Bram', 'character'), entry('qb', 'Quill and Bram', 'character')];
    expect([...fusedEntries(entries)]).toEqual(['qb']);
    const crew = [entry('q', 'Quill', 'character'), entry('w', 'Wardens', 'group'), entry('qw', 'Quill & the Wardens', 'group')];
    expect(fusedEntries(crew).size).toBe(0);
  });

  it('keeps a joined name whose parts are no entries of their own, or not people', () => {
    expect(fusedEntries([entry('se', 'Salt and Ember', 'place')]).size).toBe(0);
    expect(fusedEntries([entry('s', 'Salt', 'object'), entry('e', 'Ember', 'object'), entry('se', 'Salt and Ember', 'place')]).size).toBe(0);
    expect(fusedEntries([entry('s', 'Salt', 'character'), entry('se', 'Salt and Ember', 'place')]).size).toBe(0);
  });
});

describe('foldSpellings', () => {
  it('merges spellings that differ by hyphen, space or case into the more mentioned one', () => {
    const spaced = entity('e1', 'idea', [2, 5, 9], { name: 'Rell gate', count: 9, names: [{ text: 'Rell gate', ordinal: 2 }] });
    const hyphened = entity('e2', 'character', [4, 5], { name: 'Rell-gate', count: 2, first: 4, names: [{ text: 'Rell-gate', ordinal: 4 }] });
    const other = entity('e3', 'place', [1], { name: 'Marrowgate' });
    const kept = foldSpellings([hyphened, other, spaced]);
    expect(kept.map(({ name }) => name)).toEqual(['Marrowgate', 'Rell gate']);
    const head = kept[1];
    expect(head).toMatchObject({ kind: 'idea', count: 11, first: 2, ordinals: [2, 4, 5, 9] });
    expect(head.names.map(({ text }) => text)).toEqual(['Rell gate', 'Rell-gate']);
  });
});

describe('merging a joined name', () => {
  const sentences: Sentence[] = Array.from({ length: 4 }, (_, index) => ({
    ordinal: index + 1,
    spineIndex: 0,
    paragraphIndex: index,
    href: 'invented.xhtml',
    text: 'Quill and Bram walked on.',
    structure: 'body',
    heading: false,
    emphasis: [],
  }));

  it('never merges "Quill and Bram" into Quill or Bram, so the two are never chained', () => {
    const quill = entity('e1', 'character', [1, 2, 3], { name: 'Quill' });
    const bram = entity('e2', 'character', [1, 4], { name: 'Bram' });
    const both = entity('e3', 'character', [1], { name: 'Quill and Bram' });
    const cast = new PassCast([quill, bram, both]);
    expect(aliasCandidates(cast, sentences).filter(({ member, head }) => [member, head].includes(both))).toEqual([]);
    expect(cast.merge({ member: both, head: quill, ordinal: 1, rule: 'model' })).toBe(false);
    expect(cast.merge({ member: both, head: bram, ordinal: 1, rule: 'model' })).toBe(false);
    expect(cast.headOf(quill)).not.toBe(cast.headOf(bram));
  });
});

describe('a written-out null', () => {
  it('is no text', () => {
    for (const value of ['Null', 'null', 'None.', ' N/A ']) expect(text(value)).toBe('');
    expect(noAnswer('Nullbringer')).toBe(false);
    expect(text('A null field hums around the ship.')).toBe('A null field hums around the ship.');
  });
});
