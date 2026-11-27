import { describe, expect, it, vi } from 'vitest';
import { BK_ESTIMATE_FALLBACK_FACTOR, BkStoryGuideEstimator } from './bk-story-guide-estimator';

const text = { fileId: 5, textKey: 'key', sections: [{ words: 1000 }], language: 'en' };
const models = { fast: { connectionId: 1, model: 'm' } };
const upstream = { words: 1000, minutes: 3, cost: 0.05 };

const priced = { fast: { prices: { input: 1, output: 1 } }, careful: { prices: { input: 1, output: 1 } } };

function make(artifact: unknown, file: unknown = { bookId: 7 }, slots: unknown = priced) {
  const settings = { slots: vi.fn().mockResolvedValue(slots) };
  const rates = { table: vi.fn().mockResolvedValue({ msPerUnit: () => 60_000 }) };
  const runner = { minutesLeft: vi.fn().mockReturnValue(4) };
  const texts = { file: vi.fn().mockResolvedValue(file) };
  const jobs = { artifactInfo: vi.fn().mockResolvedValue(artifact) };
  const estimator = new BkStoryGuideEstimator([settings, {}, rates] as never, texts, runner as never, jobs as never);
  return { estimator, runner, texts, jobs };
}

describe('BkStoryGuideEstimator', () => {
  it("quotes what the text's last build spent on the same model", async () => {
    const { estimator, jobs } = make({ costMicros: 209_253, models });
    const spy = vi.spyOn(Object.getPrototypeOf(BkStoryGuideEstimator.prototype), 'estimate').mockResolvedValue(upstream);
    expect(await estimator.estimate(text, ['bk'], models)).toEqual({ words: 1000, minutes: 3, cost: 0.2093 });
    expect(jobs.artifactInfo).toHaveBeenCalledWith('story-guides', 'key');
    spy.mockRestore();
  });

  it.each([
    ['no guide yet', null],
    ['a guide built on another model', { costMicros: 209_253, models: { fast: { connectionId: 1, model: 'other' } } }],
    ['a guide with no recorded cost', { costMicros: null, models }],
  ])("falls back to upstream's estimate for %s", async (_label, artifact) => {
    const { estimator } = make(artifact);
    const spy = vi.spyOn(Object.getPrototypeOf(BkStoryGuideEstimator.prototype), 'estimate').mockResolvedValue(upstream);
    expect((await estimator.estimate(text, ['bk'], models)).cost).toBe(0.05 * BK_ESTIMATE_FALLBACK_FACTOR);
    spy.mockRestore();
  });

  it("never falls below upstream's estimate for the whole pipeline when the text has no guide", async () => {
    const { estimator } = make(null);
    const spy = vi.spyOn(Object.getPrototypeOf(BkStoryGuideEstimator.prototype), 'estimate').mockResolvedValue(upstream);
    const result = await estimator.estimate(text, ['bk'], {});
    expect(result.minutes).toBe(3 * BK_ESTIMATE_FALLBACK_FACTOR);
    expect(result.cost!).toBeGreaterThanOrEqual(0.05);
    spy.mockRestore();
  });

  it('prices the no-guide fallback on the Fast slot only, so an unpriced Careful slot keeps a cost', async () => {
    const { estimator } = make(null, { bookId: 7 }, { fast: { prices: { input: 0.06, output: 0.18 } }, careful: { prices: null } });
    const result = await estimator.estimate(text, ['bk'], {});
    expect(result.cost).not.toBeNull();
    expect(result.cost!).toBeGreaterThan(0);
  });

  it('leaves other steps to upstream', async () => {
    const { estimator, jobs } = make(null);
    const spy = vi.spyOn(Object.getPrototypeOf(BkStoryGuideEstimator.prototype), 'estimate').mockResolvedValue(upstream);
    expect(await estimator.estimate(text, ['names'], {})).toBe(upstream);
    expect(jobs.artifactInfo).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reports no minutes left for a bk build outside the descriptions pass', async () => {
    const { estimator, runner } = make(null);
    expect(await estimator.minutesLeft(text, ['bk'], {}, { order: ['bk'], phase: 'bk', done: 0, total: 1 })).toBeNull();
    expect(await estimator.minutesLeft(text, ['bk'], {}, { order: ['bk'], phase: 'review', done: 1, total: 4 })).toBeNull();
    expect(runner.minutesLeft).not.toHaveBeenCalled();
  });

  it("reads the running build's own figure in the descriptions pass", async () => {
    const { estimator, runner } = make(null);
    expect(await estimator.minutesLeft(text, ['bk'], {}, { order: ['bk'], phase: 'lines', done: 3, total: 9 })).toBe(4);
    expect(runner.minutesLeft).toHaveBeenCalledWith(7);
  });

  it('leaves minutes left of other pipelines to upstream', async () => {
    const { estimator, runner } = make(null);
    const spy = vi.spyOn(Object.getPrototypeOf(BkStoryGuideEstimator.prototype), 'minutesLeft').mockResolvedValue(9);
    expect(await estimator.minutesLeft(text, ['names'], {}, { order: ['names'], phase: 'names', done: 1, total: 3 })).toBe(9);
    expect(runner.minutesLeft).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
