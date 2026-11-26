import type { ForkStoryGuidePayload, StoryGuideAnchor } from '@bookorbit/types'

export const end = (s: number): StoryGuideAnchor => ({ s, end: true })
export const quote = (s: number, q: string, o = 0): StoryGuideAnchor => ({ s, o, q })

const arrived = quote(0, 'arrived')
const opened = quote(1, 'gate opens', 9)
const later = quote(1, 'gate closes', 40)
const join = { key: 'keeper', name: 'The Keeper', at: later, names: [{ text: 'The Keeper', at: arrived }], lines: [] }

export const guideFixture: ForkStoryGuidePayload = {
  format: 1,
  textKey: 'key',
  pipeline: 'pipeline',
  language: 'en',
  builtAt: '2026-11-25T00:00:00Z',
  models: {},
  coverage: 1,
  fixesRevision: 0,
  sections: ['Arrival', 'At the gate', 'The return'].map((title, s) => ({ s, title, chars: 100, h: 'hash' })),
  entities: [
    {
      key: 'ana',
      name: 'Captain Ana',
      kind: 'character',
      importance: 1,
      count: 10,
      fixed: false,
      joins: [join],
      names: [
        { text: 'Ana', at: arrived },
        { text: 'Annie', at: opened },
        { text: 'Captain Ana', at: later },
      ],
      lines: [{ text: 'An old line', through: end(0) }],
      profiles: [
        { text: 'A traveler', through: end(0) },
        { text: 'A visitor', through: opened },
        { text: 'Future profile', through: end(1) },
      ],
    },
    { key: 'ben', name: 'Ben', kind: 'character', names: [{ text: 'Ben', at: opened }], joins: [], lines: [], fixed: false },
    { key: 'gate', name: 'The gate', kind: 'place', names: [{ text: 'The gate', at: opened }], joins: [], lines: [], fixed: false },
    { key: 'return', name: 'Future name', kind: 'object', names: [{ text: 'Future name', at: end(1) }], joins: [], lines: [], fixed: false },
  ],
  ties: [
    { key: 'meeting', a: 'ana', b: 'ben', type: 'friend_of', label: 'friend of', at: opened, quotes: [opened, later], count: 2, fixed: false },
    { key: 'secret', a: 'ana', b: 'ben', type: 'parent_of', label: 'Future tie', at: later, quotes: [later], count: 1, fixed: false },
    { key: 'Keeper tie', a: 'keeper', b: 'ana', type: 'works_for', label: 'works for', at: opened, quotes: [opened], count: 1, fixed: false },
  ],
  summaries: [
    { text: 'They arrived.', through: end(0) },
    { text: 'The gate opened.', through: opened },
    { text: 'Future summary', through: end(1) },
    { text: 'Future ending', through: end(2) },
  ],
  links: [
    { a: 'ana', b: 'gate', score: 0.5, count: 2, at: arrived, until: opened },
    { a: 'ana', b: 'gate', score: 0.75, count: 3, at: opened },
    { a: 'ben', b: 'gate', score: 1, count: 4, at: later },
  ],
  chronicle: {
    version: 1,
    basis: '2026-11-25T00:00:00Z',
    entities: {
      ana: {
        about: [],
        timeline: [
          { note: 'Ana arrived.', at: arrived, through: end(0), chapter: null },
          { note: 'Future note', at: opened, through: end(1), chapter: null },
        ],
      },
      ben: { about: [], timeline: [{ note: 'The gate opens for Ben.', at: opened, through: opened, chapter: null }] },
    },
    pairs: {
      'ana|ben': [
        { text: 'Ana trusts Ben at the gate.', through: opened },
        { text: 'Future pair note', through: later },
      ],
    },
  },
}
export const fixtureCut = { s: 1, placedQuotes: ['gate opens'] }
