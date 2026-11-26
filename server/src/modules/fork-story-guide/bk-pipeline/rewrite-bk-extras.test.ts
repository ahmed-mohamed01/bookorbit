import type {
  BookKnowledgeXrayAnchor,
  BookKnowledgeXrayEntity,
  BookKnowledgeXrayPayload,
  StoryGuideChronicleEntity,
  StoryGuideFixTarget,
  StoryGuidePayloadV1,
} from '@bookorbit/types';

import { applyStoryGuideFixes, type StoryGuideFixInput } from '../../story-guides/fixes/apply-fixes';
import { rewriteBkExtras } from './rewrite-bk-extras';

const at = { s: 0, o: 2, q: 'First sighting', n: 3 } satisfies BookKnowledgeXrayAnchor;
const first = { s: 0, end: true, n: 7 } satisfies BookKnowledgeXrayAnchor;
const second = { s: 1, end: true, n: 15 } satisfies BookKnowledgeXrayAnchor;

function upstreamGuide(): StoryGuidePayloadV1 {
  return {
    format: 1,
    textKey: 'text-key',
    pipeline: 'story-guide',
    builtAt: '2026-11-25T00:00:00.000Z',
    language: 'en',
    models: {},
    coverage: 1,
    fixesRevision: 0,
    sections: [],
    entities: [],
    ties: [],
  };
}

function entry(key: string) {
  return {
    key,
    name: key,
    names: [{ text: key, at }],
    lines: [
      { through: first, text: 'First line' },
      { through: second, text: 'Second line' },
    ],
    profiles: [
      { through: first, text: 'First description' },
      { through: second, text: 'Second description' },
    ],
  };
}

function entity(key: string): BookKnowledgeXrayEntity {
  return { ...entry(key), kind: 'character', joins: [], fixed: false, importance: 1, count: 2 };
}

function chronicleEntity(key: string): StoryGuideChronicleEntity {
  return {
    about: entry(key).profiles,
    timeline: [{ through: first, chapter: null, at, note: `${key} appears` }],
  };
}

function bkGuide(): BookKnowledgeXrayPayload {
  const base = upstreamGuide();
  const ada = entity('ada');
  ada.joins.push({ ...entry('alias'), at });
  return {
    ...base,
    entities: [ada, entity('bea'), entity('cy')],
    chronicle: {
      version: 1,
      basis: base.builtAt,
      entities: { ada: chronicleEntity('ada'), alias: chronicleEntity('alias'), bea: chronicleEntity('bea'), cy: chronicleEntity('cy') },
      pairs: { 'ada|bea': [{ through: first, text: 'Ada meets Bea' }], 'alias|cy': [], 'bea|cy': [] },
      joins: { alias: first },
    },
    links: [
      { a: 'ada', b: 'bea', at, count: 1, score: 1 },
      { a: 'cy', b: 'alias', at, count: 1, score: 1 },
      { a: 'bea', b: 'cy', at, count: 1, score: 1 },
    ],
  };
}

function target(key: string): StoryGuideFixTarget {
  return { key, names: [] };
}

function apply(payload: BookKnowledgeXrayPayload, kind: string, key: string, data: Record<string, unknown> = {}) {
  const fix: StoryGuideFixInput = { id: 'fix', kind, target: target(key), data, from: null };
  return applyStoryGuideFixes(payload, [fix]).payload as BookKnowledgeXrayPayload;
}

describe('rewriteBkExtras', () => {
  it('returns an upstream payload unchanged', () => {
    const payload = upstreamGuide();
    expect(rewriteBkExtras(payload)).toBe(payload);
  });

  it('hide drops the key from chronicle, pairs and links', () => {
    const payload = apply(bkGuide(), 'hide', 'ada');
    const before = structuredClone(payload);
    const rewritten = rewriteBkExtras(payload);

    expect(rewritten).not.toBe(payload);
    expect(payload).toEqual(before);
    expect(Object.keys(rewritten.chronicle!.entities)).toEqual(['bea', 'cy']);
    expect(rewritten.chronicle!.pairs).toEqual({ 'bea|cy': [] });
    expect(rewritten.chronicle!.joins).toEqual({});
    expect(rewritten.links).toEqual([{ a: 'bea', b: 'cy', at, count: 1, score: 1 }]);
  });

  it("merge keeps the merged key's chronicle under its join", () => {
    const original = bkGuide();
    const rewritten = rewriteBkExtras(apply(original, 'merge', 'bea', { into: target('ada') }));

    expect(rewritten.entities.map(({ key }) => key)).toEqual(['ada', 'cy']);
    expect(rewritten.entities[0].joins.map(({ key }) => key)).toContain('bea');
    expect(rewritten.chronicle!.entities.bea).toEqual(original.chronicle!.entities.bea);
  });

  it('merge drops pairs and links between keys in the same entity', () => {
    const original = bkGuide();
    original.chronicle!.pairs!['alias|bea'] = [];
    original.links.push({ a: 'bea', b: 'alias', at, count: 1, score: 1 });
    const rewritten = rewriteBkExtras(apply(original, 'merge', 'bea', { into: target('ada') }));

    expect(rewritten.chronicle!.pairs).toEqual({ 'alias|cy': [], 'bea|cy': [] });
    expect(rewritten.links).toEqual([
      { a: 'cy', b: 'alias', at, count: 1, score: 1 },
      { a: 'bea', b: 'cy', at, count: 1, score: 1 },
    ]);
  });

  it('split drops join metadata for the promoted key', () => {
    const original = bkGuide();
    original.entities[0].joins.push({ ...entry('other-alias'), at });
    original.chronicle!.joins!['other-alias'] = second;
    const rewritten = rewriteBkExtras(apply(original, 'split', 'ada', { name: 'alias' }));

    expect(rewritten.entities.map(({ key }) => key)).toContain('alias');
    expect(rewritten.chronicle!.entities.alias).toEqual(original.chronicle!.entities.alias);
    expect(rewritten.chronicle!.joins).toEqual({ 'other-alias': second });
  });

  it('line edit updates the matching about entry', () => {
    const original = bkGuide();
    const through = { s: 1, end: true } as const;
    original.entities[0].joins[0].profiles![1].through = through;
    const payload = apply(original, 'line', 'alias', { through, text: 'Edited description' });
    const rewritten = rewriteBkExtras(payload);

    expect(rewritten.chronicle!.entities.alias.about).toEqual([
      { through: first, text: 'First description' },
      { through: second, text: 'Edited description' },
    ]);
    expect(rewritten.chronicle!.entities.ada).toEqual(chronicleEntity('ada'));
  });

  it('line hide removes the matching about entry', () => {
    const payload = apply(bkGuide(), 'line-hide', 'ada', { through: { s: 0, end: true } });
    const rewritten = rewriteBkExtras(payload);

    expect(rewritten.chronicle!.entities.ada).toEqual({
      ...chronicleEntity('ada'),
      about: [{ through: second, text: 'Second description' }],
    });
  });

  it('keeps about without profiles and clears it for an empty profiles array', () => {
    const payload = bkGuide();
    delete payload.entities[0].profiles;
    payload.entities[0].joins[0].profiles = [];
    const rewritten = rewriteBkExtras(payload);

    expect(rewritten.chronicle!.entities.ada.about).toEqual(chronicleEntity('ada').about);
    expect(rewritten.chronicle!.entities.alias.about).toEqual([]);
  });
});
