import { IndexerOperationLock, SlotWaitAbortedError } from './indexer-operation-lock';

describe('IndexerOperationLock.runShared', () => {
  const hold = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    return { held, release };
  };

  it('runs up to the limit at once and hands a freed slot to the next waiter', async () => {
    const lock = new IndexerOperationLock();
    const first = hold();
    const order: string[] = [];

    const a = lock.runShared(1, 1, async () => {
      order.push('a');
      await first.held;
    });
    const b = lock.runShared(1, 1, () => {
      order.push('b');
      return Promise.resolve();
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['a']);

    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });

  it('releases the slot when the operation throws', async () => {
    const lock = new IndexerOperationLock();

    await expect(lock.runShared(1, 1, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(lock.runShared(1, 1, () => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('lets a waiter give up without the slot later passing to it', async () => {
    const lock = new IndexerOperationLock();
    const first = hold();
    const controller = new AbortController();
    const running = lock.runShared(1, 1, () => first.held);
    const gaveUp = lock.runShared(1, 1, () => Promise.resolve('never'), controller.signal);
    const after = vi.fn(() => Promise.resolve('after'));
    const next = lock.runShared(1, 1, after);

    controller.abort();
    await expect(gaveUp).rejects.toBeInstanceOf(SlotWaitAbortedError);
    first.release();
    await running;
    await expect(next).resolves.toBe('after');
  });
});
