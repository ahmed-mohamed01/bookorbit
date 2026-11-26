import { afterEach, describe, expect, it, vi } from 'vitest';

import { BK_PROGRESS_EVERY_MS, BkStoryGuideProgress } from './bk-story-guide-progress';

function make() {
  let now = 0;
  const writes: [string, number, number][] = [];
  const write = vi.fn((phase: string, done: number, total: number) => {
    writes.push([phase, done, total]);
    return Promise.resolve();
  });
  const progress = new BkStoryGuideProgress(write, () => now);
  return { progress, writes, write, tick: (ms: number) => (now += ms) };
}

describe('BkStoryGuideProgress', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lands the newest dropped write once the second is up', async () => {
    vi.useFakeTimers();
    const { progress, writes, tick } = make();
    progress.stage('dense', 0, 5);
    tick(200);
    progress.stage('dense', 1, 5);
    tick(200);
    progress.stage('dense', 2, 5);
    await vi.advanceTimersByTimeAsync(599);
    expect(writes).toEqual([['lines', 0, 5]]);
    tick(600);
    await vi.advanceTimersByTimeAsync(1);
    await progress.settled();
    expect(writes).toEqual([
      ['lines', 0, 5],
      ['lines', 2, 5],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes a pending write when settled and leaves no timer', async () => {
    vi.useFakeTimers();
    const { progress, writes } = make();
    progress.stage('kinds', 0, 4);
    progress.stage('alias', 0, 0);
    expect(vi.getTimerCount()).toBe(1);
    await progress.settled();
    expect(writes).toEqual([
      ['review', 0, 4],
      ['review', 0, 0],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes nothing when the values have not changed', async () => {
    const { progress, writes, tick } = make();
    progress.index('running');
    tick(5_000);
    progress.index('running');
    tick(5_000);
    progress.index('ready');
    await progress.settled();
    expect(writes).toEqual([['names', 0, 0]]);
  });

  it("maps BK's stages onto upstream's phases, alias staying on the review it follows", async () => {
    const { progress, writes } = make();
    progress.index('queued');
    progress.index('running');
    progress.stage('kinds', 0, 4);
    progress.stage('alias', 0, 0);
    progress.stage('dense', 0, 9);
    progress.stage('finish', 0, 0);
    await progress.settled();
    expect(writes).toEqual([
      ['text', 0, 0],
      ['names', 0, 0],
      ['review', 0, 4],
      ['lines', 0, 9],
      ['assemble', 0, 0],
    ]);
  });

  it('writes a phase change at once, the same phase once a second, and the last unit always', async () => {
    const { progress, writes, tick } = make();
    progress.stage('dense', 0, 3);
    progress.stage('dense', 1, 3);
    tick(BK_PROGRESS_EVERY_MS);
    progress.stage('dense', 2, 3);
    progress.stage('dense', 3, 3);
    await progress.settled();
    expect(writes).toEqual([
      ['lines', 0, 3],
      ['lines', 2, 3],
      ['lines', 3, 3],
    ]);
  });

  it('lands writes in call order and keeps going after a failed write', async () => {
    const order: string[] = [];
    let first = true;
    const write = vi.fn(async (phase: string) => {
      if (first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('lost lease');
      }
      order.push(phase);
    });
    const progress = new BkStoryGuideProgress(write);
    progress.index(undefined);
    progress.index('running');
    progress.stage('kinds', 0, 1);
    await expect(progress.settled()).resolves.toBeUndefined();
    expect(order).toEqual(['names', 'review']);
  });

  it('does nothing without a writer', async () => {
    const progress = new BkStoryGuideProgress(undefined);
    progress.stage('dense', 1, 2);
    await expect(progress.settled()).resolves.toBeUndefined();
  });

  it('clamps negative and fractional counts', async () => {
    const { progress, writes } = make();
    progress.stage('kinds', -2, 3.7);
    await progress.settled();
    expect(writes).toEqual([['review', 0, 3]]);
  });

  it('gives minutes left from the recent chunks once three finished, and none at the end', () => {
    const { progress, tick } = make();
    progress.stage('dense', 0, 10);
    expect(progress.minutesLeft()).toBeNull();
    for (let done = 1; done <= 2; done++) {
      tick(60_000);
      progress.stage('dense', done, 10);
    }
    expect(progress.minutesLeft()).toBeNull();
    tick(60_000);
    progress.stage('dense', 3, 10);
    expect(progress.minutesLeft()).toBe(7);
    tick(30_000);
    progress.stage('dense', 4, 10);
    tick(30_000);
    progress.stage('dense', 5, 10);
    tick(30_000);
    progress.stage('dense', 6, 10);
    expect(progress.minutesLeft()).toBe(2);
    progress.stage('dense', 10, 10);
    expect(progress.minutesLeft()).toBeNull();
  });

  it('gives at least one minute, and none outside the descriptions pass', () => {
    const { progress, tick } = make();
    progress.stage('dense', 0, 100);
    for (let done = 1; done <= 3; done++) {
      tick(10);
      progress.stage('dense', done, 100);
    }
    expect(progress.minutesLeft()).toBe(1);
    progress.stage('finish', 0, 0);
    expect(progress.minutesLeft()).toBeNull();
  });
});
