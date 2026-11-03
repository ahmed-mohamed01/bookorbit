import { copyFile, lstat, mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ReadAloudWorkerRebuildRequest } from "@bookorbit/types";
import type { WorkerConfig } from "./config.js";
import { errorClass, errorMessage, logLine } from "./log.js";
import type { WorkPaths } from "./pipeline-contract.js";

/**
 * Fork: with READ_ALOUD_LOCAL_WORK_ROOT set, a job runs in `<localWorkRoot>/<jobId>` on the worker's own
 * disk and only the files the server reads are copied into the shared job folder at the end. A worker on
 * another machine otherwise pays a network round trip for every small read and write STAlign makes.
 */

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLISHED_FILES = ["output.epub", "report.json"] as const;
const PRUNE_EVENT = "read_aloud.worker.local_work_prune";
const PUBLISH_EVENT = "read_aloud.worker.local_work_publish";

export type RunFolders = { workDir: string; publishDir: string | null };

type SyncCounts = { copied: number; unchanged: number; removed: number };

export function runFolders(config: Pick<WorkerConfig, "localWorkRoot">, sharedWorkDir: string, jobId: string): RunFolders {
  if (!config.localWorkRoot) return { workDir: sharedWorkDir, publishDir: null };
  return { workDir: join(config.localWorkRoot, jobId), publishDir: sharedWorkDir };
}

/** Clears an earlier run's published files, brings in what the server staged for this run, and prunes in the background. */
export async function prepareLocalRun(
  config: Pick<WorkerConfig, "localWorkRoot" | "workRoot">,
  folders: RunFolders,
  request: Pick<ReadAloudWorkerRebuildRequest, "jobId" | "rebuild">,
): Promise<void> {
  if (!folders.publishDir || !config.localWorkRoot) return;
  await mkdir(folders.publishDir, { recursive: true });
  // Without local work the runner deletes these before aligning, so a failed rerun never leaves the last run's output behind.
  for (const name of PUBLISHED_FILES) await rm(join(folders.publishDir, name), { force: true });
  await mkdir(folders.workDir, { recursive: true });
  if (request.rebuild) {
    const name = request.rebuild.indexEntry;
    const local = join(folders.workDir, name);
    await copyFile(join(folders.publishDir, name), local).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      // A missing index falls back to full alignment in the runner, so an earlier attempt's copy must not stand in for it.
      await rm(local, { force: true });
    });
  }
  // The server waits on the submit request, and pruning many folders over a network share can outlast its timeout.
  void pruneLocalWork(config.localWorkRoot, config.workRoot, request.jobId);
}

/**
 * Brings the shared job folder in line with what the server reads: the output and report, and the processed
 * audio that edition sync hashes into its timing index. Each file lands under a temporary name first so the
 * server never reads half of one, and unchanged audio chunks are not copied again.
 */
export async function publishOutputs(
  paths: Pick<WorkPaths, "workDir" | "processedAudioDir" | "outputPath" | "reportPath">,
  publishDir: string | null,
  jobId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!publishDir || publishDir === paths.workDir) return;
  const startedAt = Date.now();
  logLine(PUBLISH_EVENT, "start", { jobId }, "publishing outputs to the shared job folder");
  const counts: SyncCounts = { copied: 0, unchanged: 0, removed: 0 };
  try {
    await mkdir(publishDir, { recursive: true });
    // Left by earlier builds, which replaced the whole folder at once.
    await rm(join(publishDir, ".processed-audio.partial"), { recursive: true, force: true });
    await syncFolder(paths.processedAudioDir, join(publishDir, "processed-audio"), counts, signal);
    for (const [source, name] of [
      [paths.outputPath, "output.epub"],
      [paths.reportPath, "report.json"],
    ] as const) {
      signal?.throwIfAborted();
      await publishFile(source, join(publishDir, name));
    }
    logLine(
      PUBLISH_EVENT,
      "end",
      { jobId, durationMs: Date.now() - startedAt, copiedFiles: counts.copied, unchangedFiles: counts.unchanged, removedFiles: counts.removed },
      "published outputs to the shared job folder",
    );
  } catch (error) {
    logLine(
      PUBLISH_EVENT,
      "fail",
      { jobId, durationMs: Date.now() - startedAt, errorClass: errorClass(error), error: errorMessage(error) },
      "publishing outputs to the shared job folder failed",
    );
    throw error;
  }
}

/** Never throws: a failed prune only leaves cache behind. */
export async function pruneLocalWork(localWorkRoot: string, workRoot: string, keepJobId: string): Promise<number> {
  const startedAt = Date.now();
  let removed = 0;
  try {
    // An unmounted share looks like every job folder is gone; keep the local cache until it is back.
    if (!(await lstat(workRoot).catch(() => null))?.isDirectory()) return 0;
    const entries = await readdir(localWorkRoot).catch(() => [] as string[]);
    const gone: string[] = [];
    for (const entry of entries) {
      if (entry === keepJobId || !JOB_ID.test(entry)) continue;
      if (await isMissing(join(workRoot, entry))) gone.push(entry);
    }
    if (gone.length === 0) return 0;
    logLine(PRUNE_EVENT, "start", { candidates: gone.length }, "pruning local job folders");
    for (const entry of gone) {
      await rm(join(localWorkRoot, entry), { recursive: true, force: true });
      removed += 1;
    }
    logLine(PRUNE_EVENT, "end", { durationMs: Date.now() - startedAt, removed, kept: entries.length - removed }, "pruned local job folders");
    return removed;
  } catch (error) {
    logLine(
      PRUNE_EVENT,
      "fail",
      { durationMs: Date.now() - startedAt, removed, errorClass: errorClass(error), error: errorMessage(error) },
      "pruning local job folders failed",
    );
    return removed;
  }
}

/** Only a definite ENOENT counts: a share that times out or refuses access must not cost the cache. */
async function isMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function syncFolder(source: string, target: string, counts: SyncCounts, signal?: AbortSignal): Promise<void> {
  await mkdir(target, { recursive: true });
  const names = new Set<string>();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal?.throwIfAborted();
    names.add(entry.name);
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    const existing = await lstat(to).catch(() => null);
    if (existing && existing.isDirectory() !== entry.isDirectory()) await rm(to, { recursive: true, force: true });
    if (entry.isDirectory()) {
      await syncFolder(from, to, counts, signal);
      continue;
    }
    const info = await stat(from);
    if (existing?.isFile() && existing.size === info.size && wholeSeconds(existing.mtimeMs) === wholeSeconds(info.mtimeMs)) {
      counts.unchanged += 1;
      continue;
    }
    await publishFile(from, to);
    counts.copied += 1;
  }
  for (const entry of await readdir(target)) {
    if (names.has(entry)) continue;
    await rm(join(target, entry), { recursive: true, force: true });
    counts.removed += 1;
  }
}

async function publishFile(source: string, target: string): Promise<void> {
  const partial = join(dirname(target), `.${basename(target)}.partial`);
  await copyFile(source, partial);
  const { atime, mtime } = await stat(source);
  // The next publish compares modification times; a share that refuses them only costs a fresh copy then.
  await utimes(partial, atime, mtime).catch(() => undefined);
  await rename(partial, target);
}

/** Network shares round file times, so compare them at a granularity every share keeps. */
function wholeSeconds(ms: number): number {
  return Math.trunc(ms / 1000);
}
