import { describe, expect, it } from 'vitest';
import type { Sentence } from '../core/model';
import { entity } from './xray-fixtures.testing';
import { xrayPayload, type XrayBuildResult } from './xray-payload';
import { systemTag } from './xray-system-tags';

function body(...lines: string[]): Sentence[] {
  return lines.map((text, index) => ({
    ordinal: index + 1,
    spineIndex: 0,
    paragraphIndex: index,
    href: 'chapter.xhtml',
    text,
    structure: 'body',
    heading: false,
    emphasis: [],
  }));
}

describe('systemTag', () => {
  it.each([
    ['Endurance', 'Endurance +1', 'Endurance: 12'],
    ['Power', 'Power 14', 'Power: 12 (+2)'],
    ['Acuity', 'Acuity increased to 9', 'Acuity -1'],
  ])('requires two stat lines for %s', (name, first, second) => {
    const sentences = body(first, second);
    expect(systemTag([name.toLowerCase(), name], sentences, 1)).toBeUndefined();
    expect(systemTag([name.toLowerCase()], sentences, 2)).toBe('stat');
  });

  it.each([
    ['Wardsong', 'Wardsong reached Novice 2'],
    ['Wardsong', 'New skill: Wardsong'],
    ['Wardsong', '[Skill: Wardsong]'],
    ['Wardsong', 'Skill gained: Wardsong'],
    ['Polymath Scholar', 'Polymath scholar: Apprentice 1'],
  ])('recognizes %s as a skill from %s', (name, line) => {
    expect(systemTag([name], body(line), 1)).toBe('skill');
  });

  it('requires two bare levels and gives confirmed stats priority', () => {
    const sentences = body('Wardsong Level 2', 'Wardsong level 3', 'Wardsong +1', 'Wardsong: 12');
    expect(systemTag(['Wardsong'], sentences, 1)).toBeUndefined();
    expect(systemTag(['Wardsong'], sentences, 2)).toBe('skill');
    expect(systemTag(['Wardsong'], sentences, 4)).toBe('stat');
  });

  it('ignores prose and non-body lines and matches the full name', () => {
    const sentences = body('Her endurance was failing.', 'New skill: Dawn Endurance', 'Endurance +1', 'Endurance: 12');
    sentences[2].structure = 'front';
    sentences[3].heading = true;
    expect(systemTag(['Endurance'], sentences, 4)).toBeUndefined();
  });
});

it('adds tags only to fiction payload entries that are eligible at the build cut', () => {
  const sentences = body('Endurance +1', 'Endurance: 12', 'Finesse +1', 'Finesse: 12', 'Wardsong reached Novice 2', 'New skill: Wardsong');
  const build: XrayBuildResult = {
    fingerprint: 'test',
    builtAt: '2026-01-01T00:00:00Z',
    language: 'en',
    models: {},
    coverage: 1,
    sections: [],
    entities: [entity('endurance', 'idea', [1, 2]), entity('finesse', 'character', [3, 4]), entity('wardsong', 'idea', [5, 6])],
    ties: [],
    lines: [],
    facts: [],
    summaries: [],
    links: [],
  };
  const anchor = (n: number) => ({ s: 0, o: n, q: '', n });
  expect(xrayPayload(build, anchor, { sentences, through: 6 }).entities.map(({ tag }) => tag)).toEqual(['stat', undefined, 'skill']);
  expect(xrayPayload(build, anchor, { sentences, through: 4 }).entities.map(({ tag }) => tag)).toEqual(['stat', undefined, undefined]);
  expect(xrayPayload(build, anchor).entities.every((entry) => !('tag' in entry))).toBe(true);
});
