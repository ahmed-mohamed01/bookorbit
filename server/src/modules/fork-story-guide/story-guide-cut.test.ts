import type { ForkStoryGuidePayload } from '@bookorbit/types';
import { describe, expect, it } from 'vitest';

import { buildStoryGuideCut } from './story-recap.core';

const anchor = (q: string, s = 1) => ({ s, o: 900, q });
const line = (q: string) => ({ through: anchor(q), text: q });
const door = anchor('door\n opened');
const guide: ForkStoryGuidePayload = {
  format: 1,
  textKey: 'key',
  pipeline: 'pipeline',
  builtAt: 'today',
  language: 'en',
  models: {},
  coverage: 1,
  fixesRevision: 0,
  sections: [],
  entities: [
    {
      key: 'ana',
      name: 'Ana',
      kind: 'character',
      fixed: false,
      names: [
        { text: 'Ana', at: anchor('Ana') },
        { text: 'repeated', at: anchor('repeated') },
        { text: 'other', at: anchor('other', 0) },
        { text: 'other', at: anchor('other', 2) },
      ],
      lines: [line('line')],
      profiles: [line('profile')],
      joins: [{ key: 'also', name: 'Also', at: anchor('joined'), names: [{ text: 'Also', at: anchor('alias') }], lines: [] }],
    },
  ],
  ties: [
    { key: 'tie', a: 'ana', b: 'also', type: 'friend_of', label: 'friend of', at: door, quotes: [door, anchor('later')], count: 2, fixed: false },
  ],
  links: [{ a: 'ana', b: 'also', score: 0.5, count: 2, at: anchor('linked'), until: anchor('until') }],
  summaries: [
    { through: door, text: 'It opened.' },
    { through: { s: 1, end: true }, text: 'The end.' },
  ],
  chronicle: {
    version: 1,
    basis: 'today',
    entities: { ana: { about: [], timeline: [{ through: anchor('through'), at: anchor('event'), chapter: null, note: 'Some news.' }] } },
    joins: { also: anchor('early') },
  },
};

describe('buildStoryGuideCut', () => {
  const before = 'Ana other repeated line profile joined alias door opened linked until through event early';
  const text = `${before} later repeated`;
  it('returns distinct original quotes only when their last collapsed occurrence ends at or before the cut', () => {
    const result = buildStoryGuideCut(guide, { chapterIndex: 1, offset: before.length, text });
    expect(result).toEqual({
      s: 1,
      placedQuotes: ['Ana', 'line', 'profile', 'alias', 'joined', 'door\n opened', 'linked', 'until', 'early', 'event', 'through'],
    });
  });

  it('keeps the known section with no quotes when the exact offset is unavailable', () => {
    expect(buildStoryGuideCut(guide, { chapterIndex: 1, offset: null, text })).toEqual({ s: 1, placedQuotes: [] });
  });

  it('returns null without a position', () => {
    expect(buildStoryGuideCut(guide, null)).toBeNull();
  });
});
