import { Logger } from '@nestjs/common';
import { AiError, type AiResult } from '../../ai/ai-client.types';
import type { Sentence } from '../core/model';
import { capped, inHalves, inOrder, XrayPrivacy, XrayRunCalls, XrayStepRun } from './xray-runner';

const sentences: Sentence[] = [0, 0, 1].map((spineIndex, index) => ({
  ordinal: index + 1,
  spineIndex,
  paragraphIndex: index,
  href: 'x',
  text: 'x'.repeat(10 * (index + 1)),
  structure: 'body',
  heading: false,
  emphasis: [],
}));

function reply(text: string): AiResult {
  return { text, usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' };
}

function setup() {
  const logger = new Logger('test');
  vi.spyOn(logger, 'log').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const privacy = new XrayPrivacy(sentences);
  return { privacy, logger, step: new XrayStepRun('lines', 'fast', privacy, logger, 'runId=r') };
}

const read = (answer: unknown) => {
  const lines = (answer as { lines?: unknown }).lines;
  return Array.isArray(lines) ? { items: lines as string[], rejected: { 'no-citation': 1 } } : null;
};

describe('XrayStepRun', () => {
  it('retries an unreadable reply once, then skips the unit and counts it', async () => {
    const { step, logger } = setup();
    const send = vi.fn(() => Promise.resolve(reply('not json')));
    expect(await step.unit({ id: 'l1', ordinals: [1, 2], send, read })).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    expect(step.finish()).toMatchObject({ units: 1, calls: 2, invalid: 2, skipped: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[book_knowledge.xray_unit] [fail]'));
  });

  it.each(['refused', 'filtered'] as const)('does not resend a reply the model %s', async (finish) => {
    const { step } = setup();
    const send = vi.fn(() => Promise.resolve({ ...reply(''), finish }));
    expect(await step.unit({ id: 'l1', ordinals: [1], send, read })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(step.finish()).toMatchObject({ calls: 1, invalid: 1, skipped: 1 });
  });

  it('treats a reply that fails the checks the same as unreadable JSON', async () => {
    const { step } = setup();
    const send = vi.fn().mockResolvedValueOnce(reply('{"other": 1}')).mockResolvedValueOnce(reply('Here: {"lines": ["a"]}'));
    expect(await step.unit({ id: 'l1', ordinals: [1], send, read })).toEqual(['a']);
    expect(step.finish()).toMatchObject({ calls: 2, invalid: 1, skipped: 0, rejected: { 'no-citation': 1 } });
  });

  it('retries a reply the client gave up on as invalid or too long', async () => {
    const { step } = setup();
    const send = vi.fn().mockRejectedValueOnce(new AiError('too-long', 'cut short')).mockRejectedValueOnce(new AiError('invalid-json', 'bad'));
    expect(await step.unit({ id: 'l1', ordinals: [1], send, read })).toBeNull();
    expect(step.finish().skipped).toBe(1);
  });

  it('does not resend a capped ask cut short, but still retries its unreadable reply', async () => {
    const { step } = setup();
    const cut = vi.fn().mockRejectedValue(new AiError('too-long', 'cut short'));
    expect(await step.unit({ id: 'l1', ordinals: [1], send: capped(cut), read })).toBeNull();
    expect(cut).toHaveBeenCalledTimes(1);
    expect(step.record).toMatchObject({ calls: 1, invalid: 1, skipped: 1, cut: 1 });
    const unreadable = vi.fn().mockResolvedValueOnce(reply('nope')).mockResolvedValueOnce(reply('{"lines": ["a"]}'));
    expect(await step.unit({ id: 'l2', ordinals: [1], send: capped(unreadable), read })).toEqual(['a']);
    expect(unreadable).toHaveBeenCalledTimes(2);
  });

  it('ends the build on any other AI error', async () => {
    const { step } = setup();
    const send = vi.fn().mockRejectedValue(new AiError('provider-down', 'down'));
    await expect(step.unit({ id: 'l1', ordinals: [1], send, read })).rejects.toThrow('down');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('records the sentences, characters and sections of every call', async () => {
    const { step, privacy, logger } = setup();
    const send = vi.fn().mockResolvedValueOnce(reply('nope')).mockResolvedValueOnce(reply('{"lines": []}'));
    await step.unit({ id: 'l1', ordinals: [1, 3, 3], send, read });
    expect(step.finish().privacy).toEqual({ calls: 2, sentences: 4, characters: 80, sections: 2 });
    expect(privacy.sentCharacters).toBe(80);
    expect(privacy.distinctCharacters()).toBe(40);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('sentences=2 characters=40 sections=2'));
  });
});

describe('inOrder', () => {
  it('keeps results in item order with bounded concurrency', async () => {
    let running = 0;
    let peak = 0;
    const result = await inOrder([30, 10, 20, 5], 2, async (delay) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, delay));
      running--;
      return delay * 2;
    });
    expect(result).toEqual([60, 20, 40, 10]);
    expect(peak).toBe(2);
  });

  it('stops taking new items after a failure', async () => {
    const work = vi.fn((item: number) => (item === 1 ? Promise.reject(new Error('stop')) : Promise.resolve(item)));
    await expect(inOrder([1, 2, 3, 4], 1, work)).rejects.toThrow('stop');
    expect(work).toHaveBeenCalledTimes(1);
  });
});

describe('inHalves', () => {
  it('retries a skipped list in halves down to single items', async () => {
    const send = vi.fn((items: readonly number[], id: string) =>
      Promise.resolve(items.includes(3) && items.length > 1 ? null : items.map((item) => `${id}:${item}`)),
    );
    expect(await inHalves([1, 2, 3, 4, 5], 'l1', send)).toEqual(['l1aa:1', 'l1aa:2', 'l1ab:3', 'l1b:4', 'l1b:5']);
    expect(await inHalves([7], 'l2', () => Promise.resolve(null))).toEqual([]);
  });
});

describe('XrayRunCalls', () => {
  it('waits for every call, including one launched while it waits', async () => {
    const calls = new XrayRunCalls(new AbortController());
    const finished: number[] = [];
    let release!: () => void;
    void calls.track(
      new Promise<void>((resolve) => (release = resolve)).then(() => {
        finished.push(1);
        void calls.track(Promise.reject(new Error('late')).finally(() => finished.push(2))).catch(() => undefined);
      }),
    );
    const waiting = calls.settled();
    release();
    await waiting;
    expect(finished).toEqual([1, 2]);
  });

  it('aborts the run on an error that ends the build, before the caller hears of it, and not on a retryable one', async () => {
    const calls = new XrayRunCalls(new AbortController());
    await calls.track(Promise.reject(new AiError('too-long', 'cut'))).catch(() => undefined);
    expect(calls.signal.aborted).toBe(false);
    const heard = await calls.track(Promise.reject(new AiError('provider-down', 'down'))).catch(() => calls.signal.aborted);
    expect(heard).toBe(true);
  });
});
