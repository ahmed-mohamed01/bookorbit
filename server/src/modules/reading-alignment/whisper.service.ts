import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { appConfig } from '../../config/config';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { describeError } from './reading-alignment-error.util';
import { WhisperModelService } from './whisper-model.service';

const TRANSCRIBE_EVENT = 'reading_alignment.transcribe';
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// stderr is only used to enrich a failure message, so cap what we retain: a noisy process must never
// grow memory without bound.
const MAX_STDERR_BYTES = 64 * 1024;
const MIN_TIMEOUT_MS = 60_000;
const TIMEOUT_PER_WINDOW_SECOND_MS = 4_000;

@Injectable()
export class WhisperService {
  private readonly logger = new Logger(WhisperService.name);

  constructor(
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    private readonly models: WhisperModelService,
  ) {}

  isAvailable(): boolean {
    return Boolean(this.config.whisperPath);
  }

  async transcribeWindow(audioFilePath: string, offsetSeconds: number, durationSeconds: number): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error('Whisper is not configured - set WHISPER_PATH to enable transcription');
    }

    const startedAt = Date.now();
    this.logger.log(`[${TRANSCRIBE_EVENT}] [start] offsetSeconds=${offsetSeconds} durationSeconds=${durationSeconds} - transcribing audio window`);

    // whisper.cpp reads a 16kHz mono WAV from a FILE (it does not accept a WAV on
    // stdin), so decode just the window to a temp file with a fast input seek
    // (`-ss` before `-i`), transcribe the file, then remove it.
    const clipPath = join(tmpdir(), `bo-whisper-${randomBytes(8).toString('hex')}.wav`);
    const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.ceil(durationSeconds) * TIMEOUT_PER_WINDOW_SECOND_MS);

    try {
      const modelPath = await this.models.ensureModelReady();
      await this.runProcess(
        this.config.ffmpegPath,
        ['-nostdin', '-ss', String(offsetSeconds), '-t', String(durationSeconds), '-i', audioFilePath, '-ac', '1', '-ar', '16000', '-y', clipPath],
        timeoutMs,
        'ffmpeg',
      );

      const output = await this.runProcess(this.config.whisperPath as string, ['-m', modelPath, '-f', clipPath, '-nt'], timeoutMs, 'whisper');
      const transcript = output.trim();

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `[${TRANSCRIBE_EVENT}] [end] offsetSeconds=${offsetSeconds} durationSeconds=${durationSeconds} durationMs=${durationMs} transcriptChars=${transcript.length} - transcription completed`,
      );
      return transcript;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${TRANSCRIBE_EVENT}] [fail] offsetSeconds=${offsetSeconds} durationSeconds=${durationSeconds} durationMs=${durationMs} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - transcription failed`,
      );
      throw error instanceof Error ? error : new Error(message);
    } finally {
      await unlink(clipPath).catch(() => {});
    }
  }

  // Runs a process to completion, resolving stdout on a zero exit and rejecting on
  // spawn error, non-zero exit, timeout, or runaway output. stderr is captured only
  // to enrich a failure message (whisper.cpp logs backend/system info there).
  private runProcess(command: string, args: string[], timeoutMs: number, label: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let settled = false;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch {
          // process may already be gone
        }
        run();
      };

      const timer = setTimeout(() => finish(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`))), timeoutMs);

      child.on('error', (err: Error) => finish(() => reject(new Error(`Failed to spawn ${label}: ${err.message}`))));
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        stderrBytes += chunk.length;
        stderr.push(chunk);
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          finish(() => reject(new Error(`${label} output exceeded the maximum allowed size`)));
          return;
        }
        stdout.push(chunk);
      });
      child.on('close', (code: number | null) => {
        if (code === 0) {
          finish(() => resolve(Buffer.concat(stdout).toString('utf8')));
          return;
        }
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        finish(() => reject(new Error(`${label} exited with code ${code}${detail ? `: ${detail.slice(0, 500)}` : ''}`)));
      });
    });
  }
}
