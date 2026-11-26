import { BadRequestException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiJobFailure, AiJobPause, AiUnitSkipped } from '../../ai-jobs/ai-feature';
import type { StoryGuideSubject } from '../../story-guides/pipeline/story-guide-subject';
import { BK_INDEX_POLL_MS, BK_INDEX_TIMEOUT_MS, BK_PLAN_FAILURE_TTL_MS, BkStoryGuideRunner } from './bk-story-guide-runner.service';

const models = { fast: { connectionId: 1, model: 'm', effort: 'low' } };
const subject = { key: 'k', bookId: 7, file: { id: 3 }, text: { sections: [{ words: 400 }, { words: 600 }] } } as unknown as StoryGuideSubject;
const ready = { artifact: {}, row: { status: 'ready' }, enabled: true, queued: false };
const waiting = (status: string) => ({ artifact: undefined, row: { status }, enabled: true, queued: false });

function setup(contexts: unknown[]) {
  const context = vi.fn();
  for (const next of contexts) context.mockResolvedValueOnce(next);
  context.mockResolvedValue(contexts.at(-1));
  const knowledge = {
    enabled: vi.fn().mockResolvedValue(true),
    sourceFileId: vi.fn().mockResolvedValue(3),
    context,
    peek: vi.fn().mockResolvedValue({ artifact: {}, fingerprint: 'f' }),
    build: vi.fn().mockResolvedValue({}),
  };
  const payload = { entities: [], coverage: 1 };
  const xray = { buildForStoryGuide: vi.fn().mockResolvedValue(payload), planEstimate: vi.fn() };
  const aiSettings = {
    features: vi.fn().mockResolvedValue({ 'book-knowledge': { enabled: true } }),
    slots: vi.fn().mockResolvedValue({ fast: { prices: { input: 1, output: 2 } } }),
  };
  const current = { slot: 'fast', connectionId: 1, model: 'm', prices: { input: 1, output: 2 }, jsonMode: 'native', maxOutputTokens: 8000 };
  const client = { resolveSlot: vi.fn().mockResolvedValue(current) };
  const runner = new BkStoryGuideRunner(knowledge as never, xray as never, aiSettings as never, client as never);
  const complete = vi.fn();
  const progress = vi.fn().mockResolvedValue(undefined);
  const controller = new AbortController();
  const ctx = { job: { id: 'job-1', generation: 2, models }, subject, signal: controller.signal, complete, progress } as never;
  return { runner, knowledge, xray, aiSettings, complete, ctx, controller, payload, client, current, progress };
}

describe('BkStoryGuideRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fails unreadable when the job file is not BK's file", async () => {
    const { runner, knowledge, ctx } = setup([ready]);
    knowledge.sourceFileId.mockResolvedValue(99);
    await expect(runner.build(ctx)).rejects.toMatchObject({ reason: 'unreadable' });
  });

  it('fails unreadable when Book Knowledge is off', async () => {
    const { runner, aiSettings, ctx } = setup([ready]);
    aiSettings.features.mockResolvedValue({ 'book-knowledge': { enabled: false } });
    await expect(runner.build(ctx)).rejects.toThrow('Book Knowledge is off');
  });

  it('waits for a queued index, then builds', async () => {
    const { runner, knowledge, xray, ctx, payload, current, controller } = setup([waiting('queued'), waiting('running'), ready]);
    const done = runner.build(ctx);
    await vi.advanceTimersByTimeAsync(BK_INDEX_POLL_MS * 2);
    await expect(done).resolves.toBe(payload);
    expect(knowledge.context).toHaveBeenCalledTimes(3);
    expect(xray.buildForStoryGuide).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 7, use: { ...current, effort: 'low' }, signal: controller.signal }),
    );
  });

  it("passes the job's file and generation, so a changed file or a rebuild is not served stored answers", async () => {
    const { runner, xray, ctx } = setup([ready]);
    await runner.build(ctx);
    expect(xray.buildForStoryGuide).toHaveBeenCalledWith(expect.objectContaining({ fileId: 3, replayScope: '2' }));
  });

  it('fails as low-coverage when Book Knowledge answered too few units of a step', async () => {
    const { runner, xray, ctx } = setup([ready]);
    xray.buildForStoryGuide.mockResolvedValue({ entities: [], coverage: 0.5 });
    await expect(runner.build(ctx)).rejects.toMatchObject({ reason: 'low-coverage' });
  });

  it('fails when the index still fails after one retry', async () => {
    const { runner, knowledge, ctx } = setup([waiting('failed')]);
    await expect(runner.build(ctx)).rejects.toBeInstanceOf(AiJobFailure);
    expect(knowledge.build).toHaveBeenCalledTimes(1);
  });

  it('requeues a failed index once, then builds', async () => {
    const { runner, knowledge, ctx, payload } = setup([waiting('failed'), waiting('queued'), ready]);
    const done = runner.build(ctx);
    await vi.advanceTimersByTimeAsync(BK_INDEX_POLL_MS * 2);
    await expect(done).resolves.toBe(payload);
    expect(knowledge.build).toHaveBeenCalledExactlyOnceWith(7, expect.anything(), 'full');
  });

  it('fails after the timeout', async () => {
    const { runner, ctx } = setup([waiting('running')]);
    const done = runner.build(ctx).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(BK_INDEX_TIMEOUT_MS + BK_INDEX_POLL_MS);
    expect(await done).toMatchObject({ reason: 'error', message: 'Book Knowledge index timed out' });
  });

  it('rejects at once on abort while waiting', async () => {
    const { runner, ctx, controller } = setup([waiting('running')]);
    const done = runner.build(ctx).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error('stop'));
    expect(await done).toMatchObject({ message: 'stop' });
  });

  it('maps AiUnitSkipped to a skipped result and forwards the call with its tuning', async () => {
    const { runner, xray, complete, ctx } = setup([ready]);
    complete.mockRejectedValueOnce(new AiUnitSkipped('refused')).mockResolvedValueOnce({ text: 'ok', finish: 'stop' });
    xray.buildForStoryGuide.mockImplementation(async ({ complete: ask }) => {
      const request = { use: { model: 'x' }, system: 's', user: 'u', maxOutputTokens: 9, temperature: 0 };
      const skipped = await ask(request);
      const passed = await ask(request);
      expect(skipped).toEqual({ text: '', usage: { input: 0, output: 0 }, finish: 'refused', model: 'x' });
      expect(passed).toMatchObject({ text: 'ok' });
      return { entities: [] };
    });
    await runner.build(ctx);
    expect(complete).toHaveBeenCalledWith({ system: 's', user: 'u', maxOutputTokens: 9, temperature: 0 });
  });

  it('builds the slot choice from the job model when the slot moved', async () => {
    const { runner, client, xray, ctx } = setup([ready]);
    client.resolveSlot.mockResolvedValue({ slot: 'fast', connectionId: 2, model: 'other', prices: null, jsonMode: 'native' });
    await runner.build(ctx);
    expect(xray.buildForStoryGuide).toHaveBeenCalledWith(
      expect.objectContaining({ use: { slot: 'fast', connectionId: 1, model: 'm', prices: null, jsonMode: 'auto', effort: 'low' } }),
    );
  });

  it('queues the index once when the book has no index row', async () => {
    const { runner, knowledge, ctx } = setup([{ artifact: undefined, row: undefined, enabled: true, queued: false }, waiting('queued'), ready]);
    const done = runner.build(ctx);
    await vi.advanceTimersByTimeAsync(BK_INDEX_POLL_MS * 2);
    await done;
    expect(knowledge.build).toHaveBeenCalledTimes(1);
    expect(knowledge.build).toHaveBeenCalledWith(7, expect.anything(), 'full');
  });

  it('estimate prices the dry-run plan, claims no minutes, and keeps the plan per index', async () => {
    const { runner, xray, knowledge } = setup([ready]);
    xray.planEstimate.mockResolvedValue({ promptTokens: 2_000_000, outputTokens: 500_000, minutes: 12.2 });
    expect(await runner.estimate(7, subject.text)).toEqual({ words: 1000, minutes: null, cost: 3 });
    await runner.estimate(7, subject.text);
    expect(xray.planEstimate).toHaveBeenCalledTimes(1);
    knowledge.peek.mockResolvedValue({ artifact: {}, fingerprint: 'g' });
    await runner.estimate(7, subject.text);
    expect(xray.planEstimate).toHaveBeenCalledTimes(2);
  });

  it('estimate is null and logs the failure with its duration and error class when the plan fails', async () => {
    const { runner, xray } = setup([ready]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    xray.planEstimate.mockRejectedValue(new TypeError('bad "plan"'));
    expect(await runner.estimate(7, subject.text)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[story_guide\.bk_estimate\] \[fail\] bookId=7 durationMs=\d+ errorClass=TypeError error="bad \\"plan\\"" - /),
    );
    warn.mockRestore();
  });

  it('estimate is null and queues nothing when the index is stale or missing', async () => {
    const { runner, xray, knowledge } = setup([waiting('queued')]);
    knowledge.peek.mockResolvedValue(null);
    expect(await runner.estimate(7, subject.text)).toBeNull();
    expect(xray.planEstimate).not.toHaveBeenCalled();
    expect(knowledge.context).not.toHaveBeenCalled();
    expect(knowledge.build).not.toHaveBeenCalled();
  });
  it('reports the index wait and the build stages as upstream phases, and forgets the build after', async () => {
    const { runner, xray, ctx, progress } = setup([waiting('queued'), waiting('running'), ready]);
    xray.buildForStoryGuide.mockImplementation(({ onProgress }) => {
      onProgress('kinds', 0, 2);
      onProgress('dense', 0, 5);
      expect(runner.minutesLeft(7)).toBeNull();
      onProgress('finish', 0, 0);
      return Promise.resolve({ entities: [] });
    });
    const done = runner.build(ctx);
    await vi.advanceTimersByTimeAsync(BK_INDEX_POLL_MS * 2);
    await done;
    expect(progress.mock.calls.map(([phase]) => phase)).toEqual(['text', 'names', 'review', 'lines', 'assemble']);
    expect(runner.minutesLeft(7)).toBeNull();
  });

  it('builds when the engine context has no progress hook', async () => {
    const { runner, payload, ctx } = setup([ready]);
    const bare: Record<string, unknown> = { ...ctx };
    delete bare.progress;
    await expect(runner.build(bare as never)).resolves.toBe(payload);
  });

  it('logs a pause as a stopped build, not a failure', async () => {
    const { runner, xray, ctx } = setup([ready]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    xray.buildForStoryGuide.mockRejectedValue(new AiJobPause('over-estimate'));
    await expect(runner.build(ctx)).rejects.toBeInstanceOf(AiJobPause);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[story_guide\.bk_build\] \[end\] jobId=job-1 bookId=7 durationMs=\d+ outcome=paused - /),
    );
    warn.mockRestore();
    log.mockRestore();
  });

  it('returns only after every progress write has landed', async () => {
    const { runner, ctx, progress, payload } = setup([ready]);
    let release!: () => void;
    progress.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    let settled = false;
    const done = runner.build(ctx).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    progress.mockResolvedValue(undefined);
    release();
    await expect(done).resolves.toBe(payload);
  });

  it('forgets the build after a failure', async () => {
    const { runner, xray, ctx } = setup([ready]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    xray.buildForStoryGuide.mockImplementation(({ onProgress }) => {
      onProgress('dense', 0, 5);
      onProgress('dense', 1, 5);
      onProgress('dense', 2, 5);
      onProgress('dense', 3, 5);
      return Promise.reject(new Error('provider down'));
    });
    await expect(runner.build(ctx)).rejects.toThrow('provider down');
    expect(runner.minutesLeft(7)).toBeNull();
    warn.mockRestore();
  });

  it('logs an abort mid-build as cancelled, not a failure', async () => {
    const { runner, xray, ctx, controller } = setup([ready]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    xray.buildForStoryGuide.mockImplementation(() => {
      controller.abort(new Error('stop'));
      return Promise.reject(new Error('stop'));
    });
    await expect(runner.build(ctx)).rejects.toThrow('stop');
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[story_guide\.bk_build\] \[end\] jobId=job-1 bookId=7 durationMs=\d+ outcome=cancelled - /),
    );
    warn.mockRestore();
    log.mockRestore();
  });

  it('fails unreadable when the source file cannot be read', async () => {
    const { runner, knowledge, ctx } = setup([ready]);
    knowledge.context.mockReset().mockRejectedValue(new BadRequestException('Book Knowledge cannot read the source file'));
    await expect(runner.build(ctx)).rejects.toMatchObject({ reason: 'unreadable', message: 'Book Knowledge cannot read the source file' });
  });

  it('is enabled only with both Book Knowledge switches on', async () => {
    const { runner, knowledge, aiSettings } = setup([ready]);
    await expect(runner.enabled()).resolves.toBe(true);
    knowledge.enabled.mockResolvedValue(false);
    await expect(runner.enabled()).resolves.toBe(false);
    knowledge.enabled.mockResolvedValue(true);
    aiSettings.features.mockResolvedValue({ 'book-knowledge': { enabled: false } });
    await expect(runner.enabled()).resolves.toBe(false);
  });

  it('keeps a failed plan briefly, so status polls neither retry nor log it', async () => {
    const { runner, xray } = setup([ready]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    xray.planEstimate.mockRejectedValue(new Error('no model'));
    expect(await runner.estimate(7, subject.text)).toBeNull();
    expect(await runner.estimate(7, subject.text)).toBeNull();
    expect(xray.planEstimate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(BK_PLAN_FAILURE_TTL_MS);
    await runner.estimate(7, subject.text);
    expect(xray.planEstimate).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
