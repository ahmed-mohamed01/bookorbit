import { describe, expect, it } from 'vitest';
import type { BookKnowledgeXrayEntity, BookKnowledgeXrayPayload, StoryGuideChronicleEntity } from '@bookorbit/types';
import { assembleBkStoryGuide } from './bk-story-guide-assemble';

const meta = {
  textKey: 'text-key',
  pipeline: 'bk-pipeline-1',
  models: { fast: { connectionId: 1, model: 'fast-model' }, careful: { connectionId: 2, model: 'careful-model' } },
  coverage: 0.9,
  builtAt: '2026-11-25T10:00:00.000Z',
};

const anchor = (s: number) => ({ s, end: true as const });
const at = { s: 0, o: 1, q: 'quote' };

function chronicleEntity(about: StoryGuideChronicleEntity['about']): StoryGuideChronicleEntity {
  return { about, timeline: [] };
}

function makeBk(): BookKnowledgeXrayPayload {
  const entity: BookKnowledgeXrayEntity = {
    key: 'anna',
    name: 'Anna',
    kind: 'character',
    names: [{ text: 'Anna', at }],
    joins: [{ key: 'the-queen', name: 'The Queen', names: [], lines: [], at }],
    lines: [],
    fixed: false,
    importance: 1,
    count: 40,
    sub: 'title',
  };
  const quiet: BookKnowledgeXrayEntity = { ...entity, key: 'bo', name: 'Bo', joins: [], importance: 3, count: 2, sub: undefined };
  return {
    format: 1,
    textKey: 'old',
    pipeline: 'old',
    builtAt: 'old',
    language: 'en',
    models: {},
    coverage: 1,
    fixesRevision: 0,
    sections: [],
    entities: [entity, quiet],
    ties: [],
    links: [{ a: 'anna', b: 'bo', score: 0.5, count: 3, at }],
    chronicle: {
      version: 1,
      basis: 'old',
      entities: {
        anna: chronicleEntity([
          { through: anchor(1), text: 'First.' },
          { through: anchor(4), text: 'Second.' },
        ]),
        'the-queen': chronicleEntity([{ through: anchor(2), text: 'Queen text.' }]),
      },
    },
  };
}

describe('assembleBkStoryGuide', () => {
  it('sets textKey, pipeline, models, builtAt and format from meta', () => {
    const out = assembleBkStoryGuide(makeBk(), meta);
    expect(out.format).toBe(1);
    expect(out.textKey).toBe('text-key');
    expect(out.pipeline).toBe('bk-pipeline-1');
    expect(out.builtAt).toBe(meta.builtAt);
    expect(out.coverage).toBe(0.9);
    expect(out.models).toEqual({ fast: 'fast-model', careful: 'careful-model' });
  });

  it("stores the lower of the engine's coverage and Book Knowledge's own", () => {
    expect(assembleBkStoryGuide({ ...makeBk(), coverage: 0.95 }, { ...meta, coverage: 1 }).coverage).toBe(0.95);
    expect(assembleBkStoryGuide({ ...makeBk(), coverage: 1 }, { ...meta, coverage: 0.92 }).coverage).toBe(0.92);
  });

  it('uses engine coverage when a cached result has no coverage field', () => {
    const cached: Parameters<typeof assembleBkStoryGuide>[0] = makeBk();
    delete cached.coverage;
    expect(assembleBkStoryGuide(cached, meta).coverage).toBe(meta.coverage);
  });

  it('uses engine coverage when cached coverage is non-finite', () => {
    expect(assembleBkStoryGuide({ ...makeBk(), coverage: Number.NaN }, meta).coverage).toBe(meta.coverage);
  });

  it('clamps assembled coverage to the allowed range', () => {
    expect(assembleBkStoryGuide({ ...makeBk(), coverage: -0.1 }, meta).coverage).toBe(0);
    expect(assembleBkStoryGuide({ ...makeBk(), coverage: 1.5 }, { ...meta, coverage: 1.1 }).coverage).toBe(1);
  });

  it('fills profiles from chronicle about, in order, with through', () => {
    const out = assembleBkStoryGuide(makeBk(), meta);
    expect(out.entities[0].profiles).toEqual([
      { text: 'First.', through: anchor(1) },
      { text: 'Second.', through: anchor(4) },
    ]);
    expect(out.entities[0].joins[0].profiles).toEqual([{ text: 'Queen text.', through: anchor(2) }]);
    expect(out.entities[1].profiles).toBeUndefined();
  });

  it('keeps chronicle, links, importance, count and sub; basis equals builtAt', () => {
    const bk = makeBk();
    const snapshot = structuredClone(bk);
    const out = assembleBkStoryGuide(bk, meta);
    expect(bk).toEqual(snapshot);
    expect(out.links).toEqual(snapshot.links);
    expect(out.chronicle?.basis).toBe(meta.builtAt);
    expect(out.chronicle?.entities).toEqual(snapshot.chronicle?.entities);
    const first = out.entities[0] as BookKnowledgeXrayEntity;
    expect(first.importance).toBe(1);
    expect(first.count).toBe(40);
    expect(first.sub).toBe('title');
  });
});
