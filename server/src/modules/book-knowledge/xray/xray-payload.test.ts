import type { BookKnowledgeXrayAnchor } from '@bookorbit/types';
import { storyKind } from './xray-entities';
import { entity } from './xray-fixtures.testing';
import { foldKey, xrayPayload, type XrayBuildResult } from './xray-payload';

const anchor = (ordinal: number): BookKnowledgeXrayAnchor => ({ s: Math.floor(ordinal / 100), o: ordinal % 100, q: `q${ordinal}`, n: ordinal });

describe('storyKind', () => {
  it('maps Book Knowledge kinds onto upstream kinds', () => {
    expect(storyKind('person', 'concept')).toEqual({ kind: 'character', sub: null });
    expect(storyKind('animal', 'concept')).toEqual({ kind: 'character', sub: 'animal' });
    expect(storyKind('title', 'person')).toEqual({ kind: 'idea', sub: 'title' });
    for (const kind of ['place', 'group', 'object', 'idea'] as const) expect(storyKind(kind, 'person').kind).toBe(kind);
    expect(storyKind(null, 'person').kind).toBe('character');
    expect(storyKind(null, 'place').kind).toBe('place');
    expect(storyKind(null, 'concept').kind).toBe('idea');
  });
});

describe('xrayPayload', () => {
  const viv = entity('viv', 'character', [5, 120], {
    name: 'Viv',
    names: [
      { text: 'Viv', ordinal: 5 },
      { text: 'Princess Bob', ordinal: 120 },
    ],
    joins: [{ key: 'dread gardener', name: 'Dread Gardener', names: [{ text: 'Dread Gardener', ordinal: 7 }], ordinal: 130 }],
  });
  const arthur = entity('arthur', 'character', [8, 140], { name: 'Arthur', sub: 'animal', importance: 2 });
  const vivTwin = entity('viv2', 'place', [300], { name: 'Viv', importance: 3 });
  const build: XrayBuildResult = {
    fingerprint: 'f'.repeat(64),
    builtAt: '2026-11-20T00:00:00.000Z',
    language: 'en',
    models: { fast: 'm', careful: 'm' },
    coverage: 1,
    sections: [{ s: 1, title: 'One', chars: 10, h: 'abcd1234' }],
    entities: [viv, arthur, vivTwin],
    ties: [
      { a: arthur, type: 'bonded_to', b: viv, cite: 140 },
      { a: arthur, type: 'bonded_to', b: viv, cite: 8 },
      { a: arthur, type: 'bonded_to', b: viv, cite: 140 },
    ],
    lines: [
      { entity: viv, text: 'A gardener.', cites: [5], through: 40 },
      { entity: viv, text: 'A gardener who knows the guild.', cites: [120], through: 125 },
    ],
    facts: [
      { entity: viv, text: 'She rules.', cite: 120 },
      { entity: viv, text: 'She digs.', cite: 6 },
    ],
    summaries: [{ text: 'It starts.', ordinal: 99 }],
    links: [
      { a: 'arthur', b: 'viv', score: 0.95, count: 4, from: 8, until: 140 },
      { a: 'arthur', b: 'viv', score: 1, count: 6, from: 140, until: null },
      { a: 'arthur', b: 'outsider', score: 0.5, count: 2, from: 140, until: null },
    ],
  };
  const payload = xrayPayload(build, anchor);

  it('carries the build mode and where it came from, and leaves both out when the build has none', () => {
    expect(xrayPayload({ ...build, mode: 'nonfiction', modeSource: 'model' }, anchor)).toMatchObject({ mode: 'nonfiction', modeSource: 'model' });
    expect(payload).not.toHaveProperty('mode');
    expect(payload).not.toHaveProperty('modeSource');
  });

  it('leaves out an entry with no line, note or tie when the build has a chronicle', () => {
    const toil = entity('toil', 'idea', [50], { name: 'Toil', importance: 3 });
    const note = { through: anchor(40), chapter: null, note: 'Sees the gate.', at: anchor(5) };
    const chronicled = xrayPayload(
      {
        ...build,
        entities: [...build.entities, toil],
        chronicle: {
          entities: [
            { ref: { entity: vivTwin, join: null }, value: { about: [], timeline: [note] } },
            { ref: { entity: toil, join: null }, value: { about: [], timeline: [{ ...note, note: null }] } },
          ],
          pairs: [],
        },
      },
      anchor,
    );
    expect(chronicled.entities.map((e) => e.key)).toEqual(['viv', 'arthur', 'viv-2']);
    expect(payload.entities).toHaveLength(3);
  });

  it("keeps upstream's shape and keys", () => {
    expect(payload).toMatchObject({ format: 1, pipeline: 'bk-xray-1', textKey: `bk:${build.fingerprint}`, fixesRevision: 0 });
    expect(payload.entities.map((e) => e.key)).toEqual(['viv', 'arthur', 'viv-2']);
    expect(foldKey('Saint-Lys, Viviane')).toBe('saint-lys-viviane');
  });

  it('carries kinds, sub-kinds, names and joins with anchors from their sentences', () => {
    const [first, second] = payload.entities;
    expect(first).toMatchObject({ kind: 'character', importance: 1, fixed: false });
    expect(first.names).toEqual([
      { text: 'Viv', at: anchor(5) },
      { text: 'Princess Bob', at: anchor(120) },
    ]);
    expect(first.joins).toEqual([
      { key: 'dread-gardener', name: 'Dread Gardener', names: [{ text: 'Dread Gardener', at: anchor(7) }], lines: [], profiles: [], at: anchor(130) },
    ]);
    expect(second).toMatchObject({ kind: 'character', sub: 'animal', importance: 2 });
  });

  it('keeps every line version, each anchored at the last sentence it was written from, and ships no single facts as profiles', () => {
    expect(payload.entities[0].lines).toEqual([
      { through: anchor(40), text: 'A gardener.' },
      { through: anchor(125), text: 'A gardener who knows the guild.' },
    ]);
    expect(payload.entities[0].profiles).toEqual([]);
    expect(payload.summaries).toEqual([{ through: anchor(99), text: 'It starts.' }]);
  });

  it('folds repeated ties into one with its first quote first', () => {
    expect(payload.ties).toEqual([
      {
        key: 'arthur|bonded_to|viv',
        a: 'arthur',
        type: 'bonded_to',
        b: 'viv',
        label: 'bonded to',
        at: anchor(8),
        quotes: [anchor(8), anchor(140)],
        count: 2,
        fixed: false,
      },
    ]);
  });

  it('puts untyped connections in links with the span each snapshot holds, and drops pairs outside the cast', () => {
    expect(payload.links).toEqual([
      { a: 'arthur', b: 'viv', score: 0.95, count: 4, at: anchor(8), until: anchor(140) },
      { a: 'arthur', b: 'viv', score: 1, count: 6, at: anchor(140) },
    ]);
  });
});

describe('links', () => {
  it('keeps every link inside the cast, however many an entry has, and drops one to an entry outside it', () => {
    const hub = entity('hub', 'place', [1]);
    const spokes = Array.from({ length: 24 }, (_, i) => entity(`spoke${i}`, 'place', [1]));
    const link = (a: string, b: string, score: number) => ({ a, b, score, count: 1, from: 1, until: null });
    const links = xrayPayload(
      {
        fingerprint: 'f',
        builtAt: 'now',
        language: 'en',
        models: { fast: 'm' },
        coverage: 1,
        sections: [],
        ties: [],
        lines: [],
        facts: [],
        summaries: [],
        entities: [hub, ...spokes],
        links: [...spokes.map((spoke) => link('hub', spoke.key, 0.9)), link('hub', 'gone', 0.5)],
      },
      anchor,
    ).links;
    expect(links).toHaveLength(24);
    expect(links.some((item) => item.b === 'gone')).toBe(false);
  });
});
