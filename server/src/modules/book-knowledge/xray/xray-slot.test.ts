import { XraySlot } from './xray-slot';

it('second acquire waits for release', async () => {
  const slot = new XraySlot();
  const first = await slot.acquire();
  expect(slot.busy()).toBe(true);
  const entered = vi.fn();
  const second = slot.acquire().then((release) => {
    entered();
    return release;
  });
  await Promise.resolve();
  expect(entered).not.toHaveBeenCalled();
  first();
  expect(slot.busy()).toBe(true);
  const release = await second;
  first();
  expect(slot.busy()).toBe(true);
  release();
  expect(slot.busy()).toBe(false);
});

it('aborted waiter is removed and the next one runs', async () => {
  const slot = new XraySlot();
  const first = await slot.acquire();
  const controller = new AbortController();
  const aborted = slot.acquire(controller.signal);
  const second = slot.acquire();
  const entered = vi.fn();
  const third = slot.acquire().then((release) => {
    entered();
    return release;
  });
  const reason = 'job cancelled';
  controller.abort(reason);
  await expect(aborted).rejects.toBe(reason);
  await expect(slot.acquire(controller.signal)).rejects.toBe(reason);
  first();
  const release = await second;
  expect(entered).not.toHaveBeenCalled();
  release();
  (await third)();
  expect(slot.busy()).toBe(false);
});
