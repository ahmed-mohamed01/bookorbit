import { describe, expect, it } from 'vitest';
import type { Sentence, VisibleTerm } from '../core/model';
import { fictionNameCheck } from './xray-fiction-entries';

const sentence = (text: string): Sentence => ({
  ordinal: 1,
  spineIndex: 0,
  paragraphIndex: 0,
  href: 'x.xhtml',
  text,
  structure: 'body',
  heading: false,
  emphasis: [],
});

const term = (displayName: string): VisibleTerm => ({ displayName, mentions: [{ ordinal: 1, alias: displayName }] }) as unknown as VisibleTerm;

describe('fiction name check', () => {
  it('keeps titles made of sentence words', () => {
    expect(fictionNameCheck([sentence('Then the Gods Will sailed into port.')])(term('Gods Will'))).toBe(true);
    expect(fictionNameCheck([sentence('Then Free Will sold a thousand copies.')])(term('Free Will'))).toBe(true);
    expect(fictionNameCheck([sentence('Then I Would Never Leave played on the radio.')])(term('I Would Never Leave'))).toBe(true);
  });

  it('keeps a name met as the subject of a verb', () => {
    const check = fictionNameCheck([sentence('Then Tavia Pell crossed the bridge.')]);
    expect(check(term('Tavia Pell'))).toBe(true);
  });
});
