import { execFile as execFileCb, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import { mapWithConcurrency } from '../../common/utils/batch.utils';
import type { AudioProbe } from './audio-convert.utils';

const execFile = promisify(execFileCb);
const STDERR_MAX_CHARS = 16 * 1024;
/**
 * A long book can take a while to encode, but ffmpeg reports progress every half second while it works.
 * The faststart pass that moves the index to the front reports nothing, so a growing output file counts
 * as progress too.
 */
const STALL_MS = 5 * 60_000;

export class FfmpegCancelledError extends Error {
  constructor() {
    super('Conversion was cancelled');
    this.name = 'FfmpegCancelledError';
  }
}

/**
 * Runs ffmpeg with `-progress` on stdout. Unlike upstream's runner it can be cancelled, and it reports
 * how far it has got so the job can show a percentage.
 */
export function runConvertFfmpeg(
  binary: string,
  args: string[],
  options: { signal?: AbortSignal; onProgress?: (outTimeUs: number) => void; outputPath?: string; stallMs?: number } = {},
): Promise<void> {
  const stallMs = options.stallMs ?? STALL_MS;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new FfmpegCancelledError());
    const child = spawn(binary, ['-progress', 'pipe:1', '-nostats', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let partial = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let stalled = false;
    let lastOutput: string | null = null;
    let stallTimer = setTimeout(onStall, stallMs);

    function onStall() {
      void outputSignature().then((signature) => {
        if (settled) return;
        if (signature !== null && signature !== lastOutput) {
          lastOutput = signature;
          stallTimer = setTimeout(onStall, stallMs);
          return;
        }
        stalled = true;
        child.kill('SIGKILL');
      });
    }
    async function outputSignature(): Promise<string | null> {
      if (!options.outputPath) return null;
      const info = await stat(options.outputPath).catch(() => null);
      return info ? `${info.size}:${info.mtimeMs}` : null;
    }
    const onAbort = () => {
      cancelled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(onStall, stallMs);
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('out_time_us=')) continue;
        const value = Number(line.slice('out_time_us='.length));
        if (Number.isFinite(value)) options.onProgress?.(value);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < STDERR_MAX_CHARS) stderr += chunk.slice(0, STDERR_MAX_CHARS - stderr.length);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (cancelled) finish(new FfmpegCancelledError());
      else if (stalled) finish(new Error('ffmpeg stopped making progress'));
      else if (code === 0) finish();
      else finish(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-1500)}`));
    });
  });
}

interface FfprobeJson {
  format?: { duration?: string; bit_rate?: string };
  streams?: { codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number; bit_rate?: string }[];
  chapters?: unknown[];
}

/** Codec, rate, channels and exact length of a file's first audio stream; null when ffprobe cannot read it. */
export async function probeAudio(binary: string, path: string): Promise<(AudioProbe & { chapterCount: number }) | null> {
  try {
    const { stdout } = await execFile(
      binary,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', '-select_streams', 'a:0', path],
      { timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 },
    );
    const json = JSON.parse(String(stdout)) as FfprobeJson;
    const stream = json.streams?.find((candidate) => candidate.codec_type === 'audio');
    const seconds = Number(json.format?.duration);
    if (!stream || !Number.isFinite(seconds) || seconds <= 0) return null;
    const bitrate = Number(stream.bit_rate ?? json.format?.bit_rate);
    const sampleRate = Number(stream.sample_rate);
    return {
      durationMs: Math.round(seconds * 1000),
      codec: stream.codec_name ?? null,
      sampleRate: Number.isFinite(sampleRate) ? sampleRate : null,
      channels: typeof stream.channels === 'number' ? stream.channels : null,
      bitrateKbps: Number.isFinite(bitrate) ? Math.round(bitrate / 1000) : null,
      chapterCount: json.chapters?.length ?? 0,
    };
  } catch {
    return null;
  }
}

type ProbeResult = (AudioProbe & { chapterCount: number }) | null;

/**
 * Probes files a few at a time and remembers each result by path, size and mtime, so opening a book's
 * plan twice (or planning then converting) does not start one ffprobe per file again.
 */
export class AudioProbeCache {
  private readonly entries = new Map<string, ProbeResult>();

  constructor(
    private readonly probe: (path: string) => Promise<ProbeResult>,
    private readonly concurrency = 4,
    private readonly maxEntries = 5_000,
  ) {}

  probeAll(paths: readonly string[]): Promise<ProbeResult[]> {
    return mapWithConcurrency(paths, this.concurrency, (path) => this.probeOne(path));
  }

  private async probeOne(path: string): Promise<ProbeResult> {
    const info = await stat(path).catch(() => null);
    if (!info) return null;
    const key = `${path}\0${info.size}\0${info.mtimeMs}`;
    if (this.entries.has(key)) {
      const hit = this.entries.get(key)!;
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const result = await this.probe(path);
    // A failed probe is not remembered: it may be a passing problem such as a busy disk.
    if (result) {
      this.entries.set(key, result);
      if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    return result;
  }
}
