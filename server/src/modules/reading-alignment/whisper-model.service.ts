import { createWriteStream } from 'fs';
import { mkdir, rename, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { appConfig, storageConfig } from '../../config/config';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { describeError } from './reading-alignment-error.util';

const PROBE_EVENT = 'reading_alignment.model_probe';
const RESOLVE_EVENT = 'reading_alignment.model_resolve';
const DOWNLOAD_EVENT = 'reading_alignment.model_download';
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
// A failed DOWNLOAD is not retried for this long, so a doomed build cannot re-attempt a full model
// download on every transcription sample. Cheap failures (a missing file, an unknown name) retry
// freely - a late-mounting model volume must not be locked out for the price of one stat.
const RESOLVE_FAILURE_COOLDOWN_MS = 5 * 60_000;
// An error page served instead of a GGML binary is a few KB; the smallest real model is ~30MB.
// Anything under this threshold is a broken download regardless of the response status.
const MIN_MODEL_BYTES = 1024 * 1024;

// Model names published in the official whisper.cpp Hugging Face repo (the list in the pinned
// v1.9.1 download-ggml-model.sh), excluding the tinydiarize variants hosted in a different repo.
const KNOWN_MODELS = new Set([
  'tiny',
  'tiny.en',
  'tiny-q5_1',
  'tiny.en-q5_1',
  'tiny-q8_0',
  'base',
  'base.en',
  'base-q5_1',
  'base.en-q5_1',
  'base-q8_0',
  'small',
  'small.en',
  'small-q5_1',
  'small.en-q5_1',
  'small-q8_0',
  'medium',
  'medium.en',
  'medium-q5_0',
  'medium.en-q5_0',
  'medium-q8_0',
  'large-v1',
  'large-v2',
  'large-v2-q5_0',
  'large-v2-q8_0',
  'large-v3',
  'large-v3-q5_0',
  'large-v3-turbo',
  'large-v3-turbo-q5_0',
  'large-v3-turbo-q8_0',
]);

function isExplicitPath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.toLowerCase().endsWith('.bin');
}

type ResolvedModel = { path: string; mode: 'path' | 'name'; sizeBytes: number };

@Injectable()
export class WhisperModelService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhisperModelService.name);
  private resolvedPath: string | null = null;
  private inflight: Promise<string> | null = null;
  private lastFailure: { atMs: number; error: Error } | null = null;

  constructor(
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  // Boot-time readiness probe: CHECK-only (a stat plus name validation), so a large download cannot
  // delay boot. A named model that is not cached stays pending and is downloaded lazily by the first
  // alignment build.
  onApplicationBootstrap(): void {
    if (!this.config.readingAlignmentEnabled) return;
    void this.probeAtBoot();
  }

  private async probeAtBoot(): Promise<void> {
    const startedAt = Date.now();

    const value = this.config.whisperModel;
    if (!isExplicitPath(value) && KNOWN_MODELS.has(value)) {
      const target = join(this.storage.appDataPath, 'models', `ggml-${value}.bin`);
      // Same floor the resolver applies: a truncated leftover must read as "not cached", or this
      // check-only probe would fall through into a full download at boot.
      if (((await this.fileSize(target)) ?? 0) < MIN_MODEL_BYTES) {
        this.logger.log(
          `[${PROBE_EVENT}] [end] durationMs=${Date.now() - startedAt} outcome=pending_download path="${sanitizeLogValue(target)}" - model not cached; it downloads on the first alignment build`,
        );
        return;
      }
    }

    try {
      await this.ensureModelReady();
    } catch {
      // The resolution failure was already logged with its cause by resolve()'s [fail] entry.
      this.logger.warn(`[${PROBE_EVENT}] [end] durationMs=${Date.now() - startedAt} outcome=not_ready - whisper model not ready`);
    }
  }

  // Resolves the configured model to a GGML file on disk, downloading a named model on first
  // use. Single-flight: concurrent callers (parallel transcription windows) share one resolution,
  // so a cold start never triggers duplicate downloads.
  ensureModelReady(): Promise<string> {
    if (this.resolvedPath) return Promise.resolve(this.resolvedPath);
    if (!this.inflight && this.lastFailure && Date.now() - this.lastFailure.atMs < RESOLVE_FAILURE_COOLDOWN_MS) {
      return Promise.reject(this.lastFailure.error);
    }
    this.inflight ??= this.resolve().then(
      (path) => {
        this.resolvedPath = path;
        this.lastFailure = null;
        this.inflight = null;
        return path;
      },
      (error: unknown) => {
        this.inflight = null;
        throw error;
      },
    );
    return this.inflight;
  }

  private async resolve(): Promise<string> {
    const startedAt = Date.now();
    this.logger.log(`[${RESOLVE_EVENT}] [start] model="${sanitizeLogValue(this.config.whisperModel)}" - resolving whisper model`);
    try {
      const resolved = await this.resolveModelFile();
      this.logger.log(
        `[${RESOLVE_EVENT}] [end] durationMs=${Date.now() - startedAt} mode=${resolved.mode} sizeBytes=${resolved.sizeBytes} path="${sanitizeLogValue(resolved.path)}" - whisper model ready`,
      );
      return resolved.path;
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${RESOLVE_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - whisper model resolution failed`,
      );
      throw error;
    }
  }

  private async resolveModelFile(): Promise<ResolvedModel> {
    const value = this.config.whisperModel;

    if (isExplicitPath(value)) {
      const sizeBytes = await this.fileSize(value);
      if (sizeBytes == null) {
        throw new Error(
          `Whisper model file not found at "${value}" - fix WHISPER_MODEL or use a model name (e.g. base.en) to download it automatically`,
        );
      }
      if (sizeBytes < MIN_MODEL_BYTES) {
        throw new Error(`Whisper model file at "${value}" is only ${sizeBytes} bytes - too small to be a GGML model`);
      }
      return { path: value, mode: 'path', sizeBytes };
    }

    if (!KNOWN_MODELS.has(value)) {
      throw new Error(`Unknown whisper model "${value}" - use a whisper.cpp model name (e.g. base.en, small.en) or an absolute path to a GGML file`);
    }

    const modelsDir = join(this.storage.appDataPath, 'models');
    const target = join(modelsDir, `ggml-${value}.bin`);
    // A cached file below the floor is a truncated leftover, not a model: redownload over it.
    const cachedBytes = await this.fileSize(target);
    if (cachedBytes != null && cachedBytes >= MIN_MODEL_BYTES) {
      return { path: target, mode: 'name', sizeBytes: cachedBytes };
    }

    const downloadedBytes = await this.download(value, modelsDir, target);
    return { path: target, mode: 'name', sizeBytes: downloadedBytes };
  }

  private async download(model: string, modelsDir: string, target: string): Promise<number> {
    const url = `${MODEL_BASE_URL}/ggml-${model}.bin`;
    const partPath = `${target}.part`;
    const startedAt = Date.now();
    this.logger.log(`[${DOWNLOAD_EVENT}] [start] model=${model} target="${sanitizeLogValue(target)}" - downloading whisper model`);

    try {
      await mkdir(modelsDir, { recursive: true });

      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok || !response.body) {
        throw new Error(`model download failed with HTTP ${response.status}`);
      }

      // Without a declared length, a cleanly-terminated short stream would be indistinguishable from
      // a complete file and get cached as a corrupt model forever. Hugging Face always declares it.
      const expectedBytes = Number(response.headers.get('content-length') ?? '');
      if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
        throw new Error('model download response did not declare a content-length; refusing to trust the stream');
      }

      await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(partPath));

      const written = await stat(partPath);
      if (written.size < MIN_MODEL_BYTES || written.size !== expectedBytes) {
        throw new Error(`model download was incomplete (${written.size} bytes on disk, expected ${expectedBytes})`);
      }

      await rename(partPath, target);
      this.logger.log(
        `[${DOWNLOAD_EVENT}] [end] model=${model} durationMs=${Date.now() - startedAt} sizeBytes=${written.size} - whisper model downloaded`,
      );
      return written.size;
    } catch (error) {
      await unlink(partPath).catch(() => {});
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${DOWNLOAD_EVENT}] [fail] model=${model} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - whisper model download failed`,
      );
      const failure = error instanceof Error ? error : new Error(message);
      this.lastFailure = { atMs: Date.now(), error: failure };
      throw failure;
    }
  }

  private async fileSize(path: string): Promise<number | null> {
    try {
      const stats = await stat(path);
      return stats.isFile() ? stats.size : null;
    } catch {
      return null;
    }
  }
}
