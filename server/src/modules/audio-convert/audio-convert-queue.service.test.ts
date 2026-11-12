import { Test } from '@nestjs/testing';

import { LibraryOperationGate } from '../../common/services/library-operation-gate.service';
import { appConfig } from '../../config/config';
import { FfmpegCancelledError } from './audio-convert-ffmpeg';
import {
  AudioConvertConverterService,
  ConvertCancelledError,
  ConvertDeferredError,
  ConvertError,
  type ConvertHooks,
} from './audio-convert-converter.service';
import { AudioConvertQueueService } from './audio-convert-queue.service';
import { AudioConvertRepository } from './audio-convert.repository';
import type { AudioConvertJobRow } from './schema/audio-convert.schema';

const settings = { id: 1, enabled: true, backupDays: 14 };
const job = {
  id: 'job-1',
  bookId: 9,
  libraryId: 2,
  trigger: 'manual',
  status: 'running',
  result: null,
  workPaths: null,
} as unknown as AudioConvertJobRow;
const result = { filesMerged: 2, codec: 'copy', warnings: [] };

async function setup() {
  const repo = {
    getSettings: vi.fn().mockResolvedValue(settings),
    claim: vi.fn().mockResolvedValue(job),
    defer: vi.fn().mockResolvedValue(undefined),
    updateJob: vi.fn().mockResolvedValue(null),
    lastPlayedAt: vi.fn().mockResolvedValue(null),
    interruptedJobs: vi.fn().mockResolvedValue([]),
  };
  const converter = { convert: vi.fn(), recoverInterrupted: vi.fn(), deleteBackup: vi.fn() };
  const gate = { isHeld: vi.fn().mockReturnValue(false) };
  const module = await Test.createTestingModule({
    providers: [
      AudioConvertQueueService,
      { provide: AudioConvertRepository, useValue: repo },
      { provide: AudioConvertConverterService, useValue: converter },
      { provide: LibraryOperationGate, useValue: gate },
      { provide: appConfig.KEY, useValue: { nodeEnv: 'test' } },
    ],
  }).compile();
  return { queue: module.get(AudioConvertQueueService), repo, converter, gate };
}

/** A convert that waits until the test lets it go, exposing its signal and hooks. */
function pendingConvert() {
  let release!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  const seen: { signal?: AbortSignal; hooks?: ConvertHooks } = {};
  const impl = (_job: unknown, _settings: unknown, signal: AbortSignal, hooks: ConvertHooks) => {
    seen.signal = signal;
    seen.hooks = hooks;
    return new Promise((resolve, reject) => {
      release = resolve;
      fail = reject;
      signal.addEventListener('abort', () => reject(new FfmpegCancelledError()));
    });
  };
  return { impl, seen, release: (value: unknown) => release(value), fail: (error: unknown) => fail(error) };
}

describe('AudioConvertQueueService', () => {
  it('defers a claimed job while the library is busy or the book was just played', async () => {
    const { queue, repo, converter, gate } = await setup();
    gate.isHeld.mockReturnValue(true);
    await queue.tick();
    expect(repo.defer).toHaveBeenCalledWith('job-1', expect.any(Date));
    gate.isHeld.mockReturnValue(false);
    repo.lastPlayedAt.mockResolvedValue(new Date());
    await queue.tick();
    expect(repo.defer).toHaveBeenCalledTimes(2);
    expect(converter.convert).not.toHaveBeenCalled();
  });

  it('checks again right before the swap: a play during the encode defers the job instead of failing it', async () => {
    const { queue, repo, converter } = await setup();
    converter.convert.mockImplementation(async (_job: unknown, _settings: unknown, _signal: AbortSignal, hooks: ConvertHooks) => {
      repo.lastPlayedAt.mockResolvedValue(new Date());
      const until = await hooks.readyToSwap();
      expect(until).toBeInstanceOf(Date);
      throw new ConvertDeferredError(until!);
    });
    await queue.tick();
    expect(repo.defer).toHaveBeenCalledWith('job-1', expect.any(Date));
    expect(repo.updateJob).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'failed' }));
  });

  it('records success with the backup path', async () => {
    const { queue, repo, converter } = await setup();
    converter.convert.mockResolvedValue({ result, backupPath: '/backups/9-job-1' });
    await queue.tick();
    expect(repo.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'success', backupPath: '/backups/9-job-1', codecUsed: 'copy' }),
    );
  });

  it('fails a job with its error code', async () => {
    const { queue, repo, converter } = await setup();
    converter.convert.mockRejectedValue(new ConvertError('verify_failed', 'too short'));
    await queue.tick();
    expect(repo.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', errorCode: 'verify_failed', errorMessage: 'too short' }),
    );
  });

  it('marks a user cancel as cancelled', async () => {
    const { queue, repo, converter } = await setup();
    const pending = pendingConvert();
    converter.convert.mockImplementation(pending.impl);
    const tick = queue.tick();
    await vi.waitFor(() => expect(pending.seen.signal).toBeDefined());
    expect(queue.cancelRunning('job-1')).toBe(true);
    await tick;
    expect(repo.updateJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'cancelled' }));
  });

  it('cannot cancel once the swap has started, and a cancel that came first stops the swap', async () => {
    const { queue, converter } = await setup();
    const pending = pendingConvert();
    converter.convert.mockImplementation(pending.impl);
    const tick = queue.tick();
    await vi.waitFor(() => expect(pending.seen.hooks).toBeDefined());
    expect(pending.seen.hooks!.enterSwap()).toBe(true);
    expect(queue.cancelRunning('job-1')).toBe(false);
    pending.release({ result, backupPath: null });
    await tick;

    const second = pendingConvert();
    converter.convert.mockImplementation(second.impl);
    const again = queue.tick();
    await vi.waitFor(() => expect(second.seen.hooks).toBeDefined());
    expect(queue.cancelRunning('job-1')).toBe(true);
    expect(second.seen.hooks!.enterSwap()).toBe(false);
    await again;
  });

  it('puts the running job back in the queue on shutdown instead of marking it cancelled', async () => {
    const { queue, repo, converter } = await setup();
    const pending = pendingConvert();
    converter.convert.mockImplementation(pending.impl);
    const tick = queue.tick();
    await vi.waitFor(() => expect(pending.seen.signal).toBeDefined());
    await queue.onModuleDestroy();
    await tick;
    expect(repo.defer).toHaveBeenCalledWith('job-1', expect.any(Date));
    expect(repo.updateJob).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'cancelled' }));
  });

  it('treats a cancel during the backup like any other cancel', async () => {
    const { queue, repo, converter } = await setup();
    converter.convert.mockImplementation((_job: unknown, _settings: unknown, signal: AbortSignal) => {
      queue.cancelRunning('job-1');
      expect(signal.aborted).toBe(true);
      return Promise.reject(new ConvertCancelledError());
    });
    await queue.tick();
    expect(repo.updateJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'cancelled' }));
  });

  describe('recover', () => {
    it('marks a committed swap as success, keeping its backup', async () => {
      const { queue, repo, converter } = await setup();
      repo.interruptedJobs.mockResolvedValue([job]);
      converter.recoverInterrupted.mockResolvedValue({ status: 'success', backupPath: '/backups/x', result });
      await queue.recover();
      expect(repo.updateJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'success', backupPath: '/backups/x' }));
    });

    it('marks an undone job failed as interrupted', async () => {
      const { queue, repo, converter } = await setup();
      repo.interruptedJobs.mockResolvedValue([job]);
      converter.recoverInterrupted.mockResolvedValue({ status: 'failed', message: 'unchanged' });
      await queue.recover();
      expect(repo.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'failed', errorCode: 'interrupted', errorMessage: 'unchanged' }),
      );
    });
  });
});
