vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  unlink: vi.fn(),
}));

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { unlink } from 'fs/promises';
import { PassThrough } from 'stream';
import { Logger } from '@nestjs/common';

import { WhisperService } from './whisper.service';

const spawnMock = vi.mocked(spawn);
const unlinkMock = vi.mocked(unlink);

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    whisperPath: '/usr/local/bin/whisper-cli',
    whisperModel: '/models/ggml-base.en.bin',
    ffmpegPath: 'ffmpeg',
    ...overrides,
  } as never;
}

function queueChildren(...children: FakeChild[]): void {
  for (const child of children) {
    spawnMock.mockImplementationOnce(() => child as never);
  }
}

describe('WhisperService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unlinkMock.mockResolvedValue(undefined);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('isAvailable', () => {
    it('is true when both whisper path and model are configured', () => {
      const service = new WhisperService(makeConfig());
      expect(service.isAvailable()).toBe(true);
    });

    it('is false when the whisper path is missing', () => {
      const service = new WhisperService(makeConfig({ whisperPath: undefined }));
      expect(service.isAvailable()).toBe(false);
    });

    it('is false when the whisper model is missing', () => {
      const service = new WhisperService(makeConfig({ whisperModel: undefined }));
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('transcribeWindow', () => {
    it('throws a clear error and never spawns when whisper is unavailable', async () => {
      const service = new WhisperService(makeConfig({ whisperPath: undefined }));
      await expect(service.transcribeWindow('/audio/book.m4b', 120, 15)).rejects.toThrow(/not configured/i);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('decodes only the window and returns the trimmed transcript', async () => {
      const service = new WhisperService(makeConfig());
      const ffmpeg = makeChild();
      const whisper = makeChild();
      queueChildren(ffmpeg, whisper);

      const promise = service.transcribeWindow('/audio/book.m4b', 120, 15);

      ffmpeg.emit('close', 0);
      await Promise.resolve();
      whisper.stdout.emit('data', Buffer.from('  Hello there, chapter one.  '));
      whisper.emit('close', 0);

      await expect(promise).resolves.toBe('Hello there, chapter one.');

      const [ffmpegBinary, ffmpegArgs] = spawnMock.mock.calls[0];
      expect(String(ffmpegBinary)).toContain('ffmpeg');
      const ssIndex = ffmpegArgs.indexOf('-ss');
      const inputIndex = ffmpegArgs.indexOf('-i');
      expect(ssIndex).toBeGreaterThanOrEqual(0);
      expect(ssIndex).toBeLessThan(inputIndex);
      expect(ffmpegArgs[ssIndex + 1]).toBe('120');
      expect(ffmpegArgs).toEqual(expect.arrayContaining(['-t', '15', '-ar', '16000', '-ac', '1']));
      expect(ffmpegArgs[inputIndex + 1]).toBe('/audio/book.m4b');
      const clipPath = ffmpegArgs[ffmpegArgs.length - 1];
      expect(clipPath).toMatch(/\.wav$/);

      const [whisperBinary, whisperArgs] = spawnMock.mock.calls[1];
      expect(whisperBinary).toBe('/usr/local/bin/whisper-cli');
      expect(whisperArgs).toEqual(['-m', '/models/ggml-base.en.bin', '-f', clipPath, '-nt']);
      expect(unlinkMock).toHaveBeenCalledWith(clipPath);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[reading_alignment.transcribe] [start]'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[reading_alignment.transcribe] [end]'));
    });

    it('throws and logs a fail entry when whisper exits non-zero', async () => {
      const service = new WhisperService(makeConfig());
      const ffmpeg = makeChild();
      const whisper = makeChild();
      queueChildren(ffmpeg, whisper);

      const promise = service.transcribeWindow('/audio/book.m4b', 300, 15);

      ffmpeg.emit('close', 0);
      await Promise.resolve();
      whisper.stderr.emit('data', Buffer.from('model load failed'));
      whisper.emit('close', 1);

      await expect(promise).rejects.toThrow(/exited with code 1/);
      const ffmpegArgs = spawnMock.mock.calls[0][1];
      expect(unlinkMock).toHaveBeenCalledWith(ffmpegArgs[ffmpegArgs.length - 1]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[reading_alignment.transcribe] [fail]'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('errorClass=Error'));
    });

    it('throws when ffmpeg fails to spawn', async () => {
      const service = new WhisperService(makeConfig());
      const ffmpeg = makeChild();
      queueChildren(ffmpeg);

      const promise = service.transcribeWindow('/audio/book.m4b', 0, 15);
      ffmpeg.emit('error', new Error('ENOENT'));

      await expect(promise).rejects.toThrow(/Failed to spawn ffmpeg/);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const ffmpegArgs = spawnMock.mock.calls[0][1];
      expect(unlinkMock).toHaveBeenCalledWith(ffmpegArgs[ffmpegArgs.length - 1]);
    });

    it('times out, kills both processes, and throws', async () => {
      vi.useFakeTimers();
      const service = new WhisperService(makeConfig());
      const ffmpeg = makeChild();
      const whisper = makeChild();
      queueChildren(ffmpeg, whisper);

      const promise = service.transcribeWindow('/audio/book.m4b', 60, 15);
      const assertion = expect(promise).rejects.toThrow(/timed out/);

      ffmpeg.emit('close', 0);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      expect(ffmpeg.kill).toHaveBeenCalled();
      expect(whisper.kill).toHaveBeenCalled();
      const ffmpegArgs = spawnMock.mock.calls[0][1];
      expect(unlinkMock).toHaveBeenCalledWith(ffmpegArgs[ffmpegArgs.length - 1]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[reading_alignment.transcribe] [fail]'));
    });
  });
});
