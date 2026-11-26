import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { ARTIFACT_TOO_LARGE_MESSAGE, ArtifactTooLargeError, writeArtifact, readGzipJson, writeGzipJsonAtomic } from './artifact';
import { ARTIFACT_VERSION, TEXT_VERSION, TERMS_VERSION } from './versions';
import type { Artifact, TextStage, Term, AliasLink } from './model';
import type { GlinerBuildOptions } from '../gliner/stage';

export interface BuildOptions {
  format?: string;
  fingerprint?: string;
  outputPath?: string;
  timeoutMs?: number;
  cacheDirectory?: string;
  bookId?: number;
  gliner?: GlinerBuildOptions;
}
export interface BuildResult {
  artifact: Artifact;
  stageMs: { fingerprint: number; text: number; gliner: number; terms: number; kinds: number; artifact: number };
  peakRssBytes: number;
  stagePeakRssBytes: Record<keyof BuildResult['stageMs'], number>;
  reused: { text: boolean; gliner: boolean; terms: boolean };
  artifactBytes: number;
  /** Size of the artifact's JSON, the cache's measure of its parsed memory. */
  jsonBytes: number;
}

export async function buildArtifactInProcess(bookPath: string, options: BuildOptions = {}): Promise<BuildResult> {
  const stageMs = { fingerprint: 0, text: 0, gliner: 0, terms: 0, kinds: 0, artifact: 0 };
  const stagePeakRssBytes = { fingerprint: 0, text: 0, gliner: 0, terms: 0, kinds: 0, artifact: 0 };
  const reused = { text: false, gliner: false, terms: false };
  const rss = (): number => process.resourceUsage().maxRSS * 1024;
  let start = performance.now();
  let fingerprint = options.fingerprint;
  if (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid source fingerprint');
  if (!fingerprint) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(bookPath)) hash.update(chunk);
    fingerprint = hash.digest('hex');
  }
  stageMs.fingerprint = performance.now() - start;
  stagePeakRssBytes.fingerprint = rss();
  const cacheRoot = options.cacheDirectory ? join(options.cacheDirectory, fingerprint) : undefined;
  async function cached<T>(filename: string, build: () => Promise<T> | T, stage: 'text' | 'terms'): Promise<T> {
    if (!cacheRoot) return build();
    const path = join(cacheRoot, filename);
    try {
      const value = await readGzipJson<T>(path);
      reused[stage] = true;
      return value;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const value = await build();
    await writeGzipJsonAtomic(path, value);
    return value;
  }
  start = performance.now();
  const { extractBookText } = await import('./book-text-stage.js');
  const format = options.format ?? 'epub';
  const text = await cached<TextStage>(`text-v${TEXT_VERSION}.json.gz`, () => extractBookText(bookPath, format), 'text');
  stageMs.text = performance.now() - start;
  stagePeakRssBytes.text = rss();
  let modelVotes: Artifact['modelVotes'];
  let kindSpans: number[] | undefined;
  if (options.gliner) {
    start = performance.now();
    const { buildKindSpans } = await import('../gliner/stage.js');
    const { votesFromKindSpans } = await import('../gliner/votes.js');
    const result = await buildKindSpans(text.sentences, options.gliner, options.bookId, cacheRoot);
    kindSpans = result.spans;
    modelVotes = result.timedOut ? [] : kindSpans && votesFromKindSpans(text.sentences, kindSpans);
    reused.gliner = result.reused;
    stageMs.gliner = performance.now() - start;
    stagePeakRssBytes.gliner = rss();
  }
  start = performance.now();
  const { extractTerms, extractAliasLinks } = await import('./term-extractor.js');
  const { terms, aliasLinks } = await cached<{ terms: Term[]; aliasLinks: AliasLink[] }>(
    `terms-text-v${TEXT_VERSION}-v${TERMS_VERSION}.json.gz`,
    () => {
      const terms = extractTerms(text.sentences);
      return { terms, aliasLinks: extractAliasLinks(text.sentences, terms) };
    },
    'terms',
  );
  stageMs.terms = performance.now() - start;
  stagePeakRssBytes.terms = rss();
  start = performance.now();
  const { annotateKindCues } = await import('./kind-cues.js');
  annotateKindCues(text.sentences, terms, kindSpans);
  const metadata =
    format === 'epub' || format === 'kepub'
      ? await (await import('./epub-metadata.js')).readEpubMetadata(bookPath).catch(() => undefined)
      : undefined;
  stageMs.kinds = performance.now() - start;
  stagePeakRssBytes.kinds = rss();
  const artifact: Artifact = {
    ...text,
    terms,
    aliasLinks,
    fingerprint,
    formatVersion: ARTIFACT_VERSION,
    textVersion: TEXT_VERSION,
    termsVersion: TERMS_VERSION,
    ...(modelVotes === undefined ? {} : { modelVotes }),
    ...(metadata === undefined ? {} : { metadata }),
  };
  start = performance.now();
  let artifactBytes = 0;
  let jsonBytes = 0;
  if (options.outputPath) {
    jsonBytes = await writeArtifact(options.outputPath, artifact);
    artifactBytes = (await stat(options.outputPath)).size;
  }
  stageMs.artifact = performance.now() - start;
  stagePeakRssBytes.artifact = rss();
  return { artifact, stageMs, stagePeakRssBytes, reused, peakRssBytes: rss(), artifactBytes, jsonBytes };
}

export function resolveTermWorkerPath(): string {
  const jsPath = join(__dirname, 'term-extractor.worker.js');
  if (existsSync(jsPath)) return jsPath;
  const tsPath = join(__dirname, 'term-extractor.worker.ts');
  return existsSync(tsPath) ? tsPath : jsPath;
}
function runBuildWorker(bookPath: string, options: BuildOptions): Promise<BuildResult> {
  return new Promise((resolve, reject) => {
    const path = resolveTermWorkerPath();
    const worker = new Worker(path, {
      workerData: { epubPath: bookPath, options },
      execArgv: path.endsWith('.ts') ? ['--import', 'tsx'] : undefined,
    });
    let settled = false;
    const finish = (error?: Error, result?: BuildResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        void worker.terminate();
        reject(error);
      } else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('Knowledge build timed out')), options.timeoutMs ?? (options.gliner ? 45 * 60_000 : 180_000));
    worker.once('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) {
        finish(new Error('Invalid build worker response'));
        return;
      }
      const value = message as { type?: string; result?: BuildResult; error?: string };
      if (value.type === 'result' && value.result?.artifact?.formatVersion === ARTIFACT_VERSION) finish(undefined, value.result);
      else if (value.type === 'error' && value.error === ARTIFACT_TOO_LARGE_MESSAGE) finish(new ArtifactTooLargeError());
      else finish(new Error(value.type === 'error' ? value.error : 'Invalid build worker response'));
    });
    worker.once('error', (error) => finish(error instanceof Error ? error : new Error('Build worker failed')));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`Build worker exited without result: ${code}`));
    });
  });
}

let buildQueue: Promise<unknown> = Promise.resolve();
export function buildArtifact(bookPath: string, options: BuildOptions = {}): Promise<BuildResult> {
  const next = buildQueue.then(async () => {
    if (!options.gliner) return runBuildWorker(bookPath, options);
    const { resolveGlinerModelPath } = await import('../gliner/stage.js');
    const modelPath = await resolveGlinerModelPath(options.gliner, options.bookId);
    return runBuildWorker(bookPath, { ...options, gliner: modelPath ? { ...options.gliner, modelPath } : undefined });
  });
  buildQueue = next.catch(() => undefined);
  return next;
}
