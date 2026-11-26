import { describe, expect, it, vi } from 'vitest';
import { BK_ESTIMATE_FALLBACK_FACTOR, BkStoryGuideEstimator } from './bk-story-guide-estimator';

const text = { fileId: 5, sections: [{ words: 1000 }], language: 'en' };
const upstream = { words: 1000, minutes: 3, cost: 0.05 };

const priced = { fast: { prices: { input: 1, output: 1 } }, careful: { prices: { input: 1, output: 1 } } };

function make(planned: unknown, file: unknown = { bookId: 7 }, slots: unknown = priced) {
  const settings = { slots: vi.fn().mockResolvedValue(slots) };
  const rates = { table: vi.fn().mockResolvedValue({ msPerUnit: () => 60_000 }) };
  const runner = { estimate: vi.fn().mockResolvedValue(planned), minutesLeft: vi.fn().mockReturnValue(4) };
  const texts = { file: vi.fn().mockResolvedValue(file) };
  const estimator = new BkStoryGuideEstimator([settings, {}, rates] as never, texts, runner as never);
  return { estimator, runner, texts };
}

describe('BkStoryGuideEstimator', () => {
  it('uses the runner plan for the bk step', async () => {
    const planned = { words: 10, minutes: null, cost: 1 };
    const { estimator, runner } = make(planned);
    expect(await estimator.estimate(text, ['bk'], {})).toBe(planned);
    expect(runner.estimate).toHaveBeenCalledWith(7, text);
  });

  it("never falls below upstream's estimate for the whole pipeline when the index is not ready", async () => {
    const { estimator } = make(null);
    const spy = vi.spyOn(Object.getPrototypeOf(BkStoryGuideEstimator.prototype), 'estimate').mockResolvedValue(upstream);
    const result = await estimator.estimate(text, ['bk'], {});
    expect(result.minutes).toBe(3 * BK_ESTIMATE_FALLBACK_FACTOR);
    expect(result.cost!).toBeGreaterThanOrEqual(0.05);
    spy.mockRestore();
  });

  it('prices the cold-index fallback on the Fast slot only, so an unpriced Careful slot keeps a cost', async () => {
    const { estimator } = make(null, { bookId: 7 }, { fast: { prices: { input: 0.06, output: 0.18 } }, careful: { prices: null } });
    const result = await estimator.estimate(text, ['bk'], {});
    expect(result.cost).not.toBeNull();
    expect(result.cost!).toBeGreaterThan(0);
  });

  it('leaves other steps to upstream', async () => {
    const { estimator, runner } = make(null);
    const spy = vi.spyOn(Object.getPrototypeOf(BkStoryGuideEstimator.prototype), 'estimate').mockResolvedValue(upstream);
    expect(await estimator.estimate(text, ['names'], {})).toBe(upstream);
    expect(runner.estimate).not.toHaveBeenCalled();
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
