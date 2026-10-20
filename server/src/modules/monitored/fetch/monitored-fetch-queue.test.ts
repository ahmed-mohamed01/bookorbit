import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitoredFetchQueue } from './monitored-fetch-queue';

afterEach(() => vi.useRealTimers());
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function harness() {
  const releases = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  const run = vi.fn(
    (id: string, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        releases.set(id, resolve);
        signals.set(id, signal);
      }),
  );
  const refill = vi.fn().mockResolvedValue([]);
  const onError = vi.fn();
  const queue = new MonitoredFetchQueue({ concurrency: 2, pendingCap: 500, run, refill, onError });
  return { queue, run, refill, onError, releases, signals };
}
describe('MonitoredFetchQueue', () => {
  it('deduplicates pending and running ids and limits concurrency to two', async () => {
    const h = harness();
    expect(h.queue.enqueue('a')).toBe(true);
    expect(h.queue.enqueue('a')).toBe(false);
    h.queue.enqueue('b');
    h.queue.enqueue('c');
    expect(h.queue.enqueue('c')).toBe(false);
    expect(h.run).toHaveBeenCalledTimes(2);
    h.releases.get('a')!();
    await flush();
    expect(h.run).toHaveBeenCalledTimes(3);
    h.queue.stop();
    h.releases.forEach((release) => release());
    await h.queue.waitForIdle();
  });
  it('caps pending at 500 and refills after draining', async () => {
    const h = harness();
    for (let i = 0; i < 502; i++) expect(h.queue.enqueue(String(i))).toBe(true);
    expect(h.queue.enqueue('overflow')).toBe(false);
    h.run.mockImplementation(async () => {});
    h.refill.mockResolvedValueOnce(['overflow']).mockResolvedValue([]);
    h.releases.forEach((release) => release());
    await h.queue.waitForIdle();
    expect(h.refill).toHaveBeenCalled();
    expect(h.run).toHaveBeenCalledWith('overflow', expect.any(AbortSignal));
  });
  it('cancels pending ids and aborts running ids', async () => {
    const h = harness();
    h.queue.enqueue('a');
    h.queue.enqueue('b');
    h.queue.enqueue('c');
    h.queue.cancel('a');
    h.queue.cancel('c');
    expect(h.signals.get('a')!.aborted).toBe(true);
    h.releases.forEach((release) => release());
    await h.queue.waitForIdle();
    expect(h.run).toHaveBeenCalledTimes(2);
  });
  it('replaces retry timers and fires at the requested time', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.queue.scheduleRetry('a', new Date(Date.now() + 100));
    h.queue.scheduleRetry('a', new Date(Date.now() + 200));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.releases.get('a')!();
    await h.queue.waitForIdle();
  });
  it('stops, aborts running jobs and clears retry timers', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.queue.enqueue('a');
    h.queue.scheduleRetry('b', new Date(Date.now() + 100));
    h.queue.stop();
    expect(h.signals.get('a')!.aborted).toBe(true);
    expect(h.queue.enqueue('c')).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    h.releases.get('a')!();
    await h.queue.waitForIdle();
  });
  it('reports a rejecting run and keeps draining', async () => {
    const error = new Error('failure');
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const queue = new MonitoredFetchQueue({ concurrency: 1, pendingCap: 500, run, onError, refill: () => Promise.resolve([]) });
    queue.enqueue('a');
    queue.enqueue('b');
    await queue.waitForIdle();
    expect(onError).toHaveBeenCalledWith('a', error);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

it('continues refilling when a returned batch finishes immediately', async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  const refill = vi.fn().mockResolvedValueOnce(['b']).mockResolvedValueOnce(['c']).mockResolvedValue([]);
  const queue = new MonitoredFetchQueue({ concurrency: 2, pendingCap: 500, run, refill, onError: vi.fn() });
  queue.enqueue('a');
  await queue.waitForIdle();
  expect(run.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
});

it('keeps a fired retry when pending capacity is full', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const run = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const queue = new MonitoredFetchQueue({ concurrency: 1, pendingCap: 1, run, refill: () => Promise.resolve([]), onError: vi.fn() });
  queue.enqueue('running');
  queue.enqueue('pending');
  queue.scheduleRetry('retry', new Date(Date.now() + 100));
  await vi.advanceTimersByTimeAsync(100);
  release();
  await queue.waitForIdle();
  expect(run.mock.calls.map(([id]) => id)).toEqual(['running', 'pending', 'retry']);
});
