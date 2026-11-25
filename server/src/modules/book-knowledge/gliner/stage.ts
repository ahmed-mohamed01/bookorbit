import { Logger } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { readGzipJson, writeGzipJsonAtomic } from '../core/artifact';
import type { Sentence } from '../core/model';
import { TEXT_VERSION } from '../core/versions';
import type { GlinerRunner } from './protocol';
import { collectKindSpans, KIND_SPANS_VERSION } from './kind-spans';
import { countBodyWords } from './votes';

export interface GlinerBuildOptions {
  directory: string;
  modelPath?: string;
  threads?: number;
  deadlineMs?: number;
}

/** A slow container CPU must not fail a long book forever: past this, the build goes on without model votes. */
export const GLINER_DEADLINE_MS = 20 * 60_000;
export class GlinerDeadlineError extends Error {
  constructor() {
    super('model inference passed its deadline');
    this.name = 'GlinerDeadlineError';
  }
}

type CachedStage = { textVersion: number; modelSignature: string } & Record<string, unknown>;

const logger = new Logger('BookKnowledgeGliner');
let missingModelLogged = false;

export async function resolveGlinerModelPath(options: GlinerBuildOptions, bookId?: number): Promise<string | undefined> {
  const path = options.modelPath ?? join(options.directory, 'model.onnx');
  try {
    if ((await stat(path)).isFile()) return path;
  } catch (error) {
    if (!isMissing(error) && !(error instanceof Error && 'code' in error && error.code === 'ENOTDIR')) {
      logger.warn(
        `[book_knowledge.gliner] [fail] bookId=${bookId ?? 'unknown'} durationMs=0 errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : error)}" - cannot access model file`,
      );
      return undefined;
    }
  }
  if (!missingModelLogged) {
    missingModelLogged = true;
    logger.log(
      `[book_knowledge.gliner] [end] bookId=${bookId ?? 'unknown'} durationMs=0 enabled=false path="${sanitizeLogValue(path)}" - model file unavailable`,
    );
  }
  return undefined;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function loadRunner(directory: string, modelPath: string, threads?: number): Promise<GlinerRunner> {
  const { createGlinerRunner } = await import('./runner.js');
  return createGlinerRunner(directory, modelPath, threads);
}

interface GlinerStage<T> {
  event: string;
  file: string;
  field: string;
  collect: (sentences: readonly Sentence[], runner: GlinerRunner) => Promise<{ value: T; windows: number; spans: number }>;
  valid: (value: unknown) => value is T;
}

async function runCachedStage<T>(
  stage: GlinerStage<T>,
  sentences: readonly Sentence[],
  options: GlinerBuildOptions,
  bookId: number | undefined,
  cacheRoot: string | undefined,
  createRunner: typeof loadRunner,
  now: () => number,
): Promise<{ value?: T; reused: boolean; timedOut?: true }> {
  const started = performance.now();
  const deadline = now() + (options.deadlineMs ?? GLINER_DEADLINE_MS);
  const identity = `bookId=${bookId ?? 'unknown'}`;
  try {
    const modelPath = await resolveGlinerModelPath(options, bookId);
    if (!modelPath) return { reused: false };
    const files = [modelPath, ...['gliner_config.json', 'tokenizer.json', 'tokenizer_config.json'].map((file) => join(options.directory, file))];
    const stats = await Promise.all(files.map((file) => stat(file)));
    const modelSignature = stats.map(({ size, mtimeMs }) => `${size}:${mtimeMs}`).join('/');
    const path = cacheRoot && join(cacheRoot, stage.file);
    if (path) {
      const cached = await readGzipJson<CachedStage>(path).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
        return undefined;
      });
      if (cached?.textVersion === TEXT_VERSION && cached.modelSignature === modelSignature && stage.valid(cached[stage.field])) {
        return { value: cached[stage.field] as T, reused: true };
      }
    }
    const words = countBodyWords(sentences);
    logger.log(`[${stage.event}] [start] ${identity} words=${words} - inference started`);
    const runner = await createRunner(options.directory, modelPath, options.threads);
    const timed: GlinerRunner = {
      predict: (text, labels, threshold) => (now() > deadline ? Promise.reject(new GlinerDeadlineError()) : runner.predict(text, labels, threshold)),
      release: () => runner.release(),
    };
    let result: Awaited<ReturnType<GlinerStage<T>['collect']>>;
    try {
      result = await stage.collect(sentences, timed);
    } finally {
      await runner.release();
    }
    if (path) await writeGzipJsonAtomic(path, { textVersion: TEXT_VERSION, modelSignature, [stage.field]: result.value } satisfies CachedStage);
    logger.log(
      `[${stage.event}] [end] ${identity} durationMs=${Math.round(performance.now() - started)} windows=${result.windows} spans=${result.spans} - inference completed`,
    );
    return { value: result.value, reused: false };
  } catch (error) {
    logger.warn(
      `[${stage.event}] [fail] ${identity} durationMs=${Math.round(performance.now() - started)} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : error)}" - inference failed`,
    );
    return error instanceof GlinerDeadlineError ? { reused: false, timedOut: true } : { reused: false };
  }
}

const kindStage: GlinerStage<number[]> = {
  event: 'book_knowledge.gliner',
  file: `gliner-kinds-v${KIND_SPANS_VERSION}.json.gz`,
  field: 'spans',
  collect: async (sentences, runner) => {
    const { spans, windows } = await collectKindSpans(sentences, runner);
    return { value: spans, windows, spans: spans.length / 4 };
  },
  valid: (value): value is number[] => Array.isArray(value) && value.length % 4 === 0,
};

export async function buildKindSpans(
  sentences: readonly Sentence[],
  options: GlinerBuildOptions,
  bookId?: number,
  cacheRoot?: string,
  createRunner = loadRunner,
  now: () => number = Date.now,
): Promise<{ spans?: number[]; reused: boolean; timedOut?: true }> {
  const { value, reused, timedOut } = await runCachedStage(kindStage, sentences, options, bookId, cacheRoot, createRunner, now);
  if (timedOut) return { reused, timedOut };
  return value ? { spans: value, reused } : { reused };
}
