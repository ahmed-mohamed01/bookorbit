import { audioFingerprint } from "./audio-fingerprint.js";
import { markupRebuildSource, replayMetadata, sourceChapterFingerprint, upgradeRebuildSource, type MetadataEntry } from "./rebuild-metadata.js";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadAloudRebuildSourceEntry } from "@bookorbit/types";
import type { StageContext, StageResult } from "./pipeline-contract.js";
import { RebuildMismatchError } from "./rebuild-error.js";
import { rebuildPaths } from "./paths.js";
import { safeEntry } from "./validation.js";

// Merge hazard: these are the ZIP dependencies shipped by the pinned STAlign/EPUB packages.
// Resolve from their owners so pnpm deploy includes them without a second dependency/lockfile entry.
const alignRequire = createRequire(import.meta.resolve("@storyteller-platform/align"));
const epubRequire = createRequire(alignRequire.resolve("@storyteller-platform/epub"));
interface ZipEntry {
  filename: string;
  uncompressedSize: number;
  crc32: number;
  externalFileAttributes: number;
  openReadStream(): Promise<Readable>;
}
interface ZipReader extends AsyncIterable<ZipEntry> {
  close(): Promise<void>;
}
interface ZipWriter {
  outputStream: Readable;
  addReadStreamLazy(name: string, options: { compress: boolean }, callback: (done: (error: Error | null, stream?: Readable) => void) => void): void;
  addFile(path: string, name: string, options: { compress: boolean }): void;
  end(): void;
}
const reader = epubRequire("yauzl-promise") as { open(path: string): Promise<ZipReader> };
const writer = alignRequire("yazl") as { ZipFile: new () => ZipWriter };

export { RebuildMismatchError } from "./rebuild-error.js";

export async function rebuildFromIndex(context: StageContext, fingerprint = audioFingerprint): Promise<StageResult> {
  const replayPaths = rebuildPaths(context.paths.workDir);
  try {
    return await rebuildArchive(context, fingerprint, replayPaths);
  } finally {
    if (context.job.rebuild!.chapterFingerprint) await Promise.all(Object.values(replayPaths).map((path) => rm(path, { force: true })));
  }
}

async function rebuildArchive(
  context: StageContext,
  fingerprint: typeof audioFingerprint,
  replayPaths: ReturnType<typeof rebuildPaths>,
): Promise<StageResult> {
  const { job, paths, signal } = context;
  const rebuild = job.rebuild!;
  const replayContext = { ...context, paths: { ...paths, ...replayPaths } };
  const actual = new Set((await readdir(paths.processedAudioDir)).filter((name) => !name.startsWith(".") && !name.endsWith(".json")));
  const expected = new Set(rebuild.chunks.map((chunk) => chunk.name));
  if (actual.size !== expected.size || [...actual].some((name) => !expected.has(name)))
    throw new RebuildMismatchError("Processed audio differs from the timing index");
  const actualSizes = new Map<string, number>();
  for (const chunk of rebuild.chunks) {
    signal.throwIfAborted();
    const path = join(paths.processedAudioDir, chunk.name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) throw new RebuildMismatchError();
    actualSizes.set(chunk.name, info.size);
    if (chunk.audioMd5) {
      try {
        if ((await fingerprint(path, signal)) !== chunk.audioMd5) throw new RebuildMismatchError();
      } catch (error) {
        if (signal.aborted) throw error;
        throw new RebuildMismatchError("Chunk audio fingerprint differs or failed");
      }
      continue;
    }
    if (info.size !== chunk.size) throw new RebuildMismatchError();
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
    if (hash.digest("hex") !== chunk.sha256) throw new RebuildMismatchError();
  }
  const indexPath = join(paths.workDir, rebuild.indexEntry);
  if (!(await lstat(indexPath).catch(() => null))?.isFile()) throw new RebuildMismatchError("The timing index is missing");
  const zip = await reader.open(indexPath);
  let sourceZip: ZipReader | undefined;
  let upgradedZip: ZipReader | undefined;
  try {
    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let total = 0;
    for await (const entry of zip) {
      if (entry.filename.endsWith("/")) continue;
      if (!safeEntry(entry.filename) || names.has(entry.filename)) throw new RebuildMismatchError("Invalid timing index entries");
      names.add(entry.filename);
      total += entry.uncompressedSize;
      if (total > job.maxOutputBytes) throw new RebuildMismatchError("Timing index exceeds output limit");
      entries.push(entry);
    }
    const report = entries.find((entry) => entry.filename === rebuild.reportEntry);
    if (!report || report.uncompressedSize > 16 * 1024 * 1024 || !names.has("mimetype")) throw new RebuildMismatchError("Timing index is incomplete");
    if (rebuild.audioEntries.some((entry) => names.has(entry.href))) throw new RebuildMismatchError("Timing index still contains audio");
    const restored: ZipEntry[] = [];
    const restoredNames = new Set<string>();
    const sourceEntries = rebuild.sourceEntries ?? [];
    let replayed: MetadataEntry[] | undefined;
    if (rebuild.chapterFingerprint) {
      try {
        sourceZip = await reader.open(job.epub.path);
        const current: ZipEntry[] = [];
        for await (const entry of sourceZip) if (!entry.filename.endsWith("/")) current.push(entry);
        if ((await sourceChapterFingerprint(current)) !== rebuild.chapterFingerprint) throw new RebuildMismatchError("Source chapter bytes changed");
        await upgradeRebuildSource(replayContext);
        upgradedZip = await reader.open(replayPaths.upgradedEpubPath);
        const seen = new Set<string>();
        for await (const entry of upgradedZip) {
          if (entry.filename.endsWith("/")) continue;
          if (!safeEntry(entry.filename) || seen.has(entry.filename) || entry.filename.startsWith("bookorbit-timings/"))
            throw new RebuildMismatchError("Invalid source entries");
          seen.add(entry.filename);
        }
        // Markup also rewrites image-only spine pages, whose current cover links must survive.
        await markupRebuildSource(replayContext);
        await upgradedZip.close();
        upgradedZip = undefined;
        upgradedZip = await reader.open(replayPaths.markedEpubPath);
        const marked: ZipEntry[] = [];
        for await (const entry of upgradedZip) if (!entry.filename.endsWith("/")) marked.push(entry);
        replayed = inFullRunOrder(await replayMetadata(entries, marked, replayContext), entries, sourceEntries);
      } catch (error) {
        if (signal.aborted || error instanceof RebuildMismatchError) throw error;
        throw new RebuildMismatchError("Cannot replay current EPUB metadata");
      }
    } else if (sourceEntries.length) {
      if (!(await lstat(job.epub.path).catch(() => null))?.isFile()) throw new RebuildMismatchError("Source EPUB is missing");
      try {
        sourceZip = await reader.open(job.epub.path);
        const wanted = new Map(sourceEntries.map((entry) => [entry.href, entry]));
        for await (const entry of sourceZip) {
          const expected = wanted.get(entry.filename);
          if (!expected) continue;
          if (
            !safeEntry(entry.filename) ||
            names.has(entry.filename) ||
            restoredNames.has(entry.filename) ||
            ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000 ||
            entry.uncompressedSize !== expected.size ||
            entry.crc32 !== expected.crc32
          )
            throw new RebuildMismatchError("Source EPUB entry differs from the timing index");
          // Draining the stream makes yauzl-promise validate the data against its CRC32.
          for await (const bytes of await entry.openReadStream()) {
            signal.throwIfAborted();
            void bytes;
          }
          restored.push(entry);
          restoredNames.add(entry.filename);
        }
        if (restored.length !== sourceEntries.length) throw new RebuildMismatchError("Source EPUB entry is missing");
      } catch (error) {
        if (error instanceof RebuildMismatchError) throw error;
        throw new RebuildMismatchError("Cannot read source EPUB entries");
      }
    }
    const outputEntries =
      replayed ??
      inOriginalOrder(
        entries.filter((entry) => !entry.filename.startsWith("bookorbit-timings/")),
        restored,
        sourceEntries,
      );
    const audioHrefs = new Set(rebuild.audioEntries.map((audio) => audio.href));
    if (outputEntries.some((entry) => audioHrefs.has(entry.filename))) throw new RebuildMismatchError("Audio entry collides with the source");
    if (
      outputEntries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) +
        rebuild.audioEntries.reduce((sum, entry) => sum + actualSizes.get(entry.chunk)!, 0) >
      job.maxOutputBytes
    )
      throw new RebuildMismatchError("Rebuild exceeds output limit");
    await pipeline(await report.openReadStream(), createWriteStream(paths.reportPath), { signal });
    const output = new writer.ZipFile();
    const done = pipeline(output.outputStream, createWriteStream(paths.outputPath), { signal });
    void done.catch(() => undefined);
    try {
      for (const entry of outputEntries.toSorted((a, b) => Number(b.filename === "mimetype") - Number(a.filename === "mimetype"))) {
        output.addReadStreamLazy(entry.filename, { compress: entry.filename !== "mimetype" }, (callback) => {
          entry.openReadStream().then(
            (stream) => callback(null, stream),
            (error: Error) => callback(new RebuildMismatchError(error.message)),
          );
        });
      }
      for (const entry of rebuild.audioEntries) output.addFile(join(paths.processedAudioDir, entry.chunk), entry.href, { compress: false });
      output.end();
      await done;
    } catch (error) {
      output.outputStream.destroy(error instanceof Error ? error : undefined);
      await done.catch(() => undefined);
      throw error;
    }
    context.event("info", "rebuild_from_index", "Rebuilt the read-aloud EPUB from its timing index", { chunks: rebuild.chunks.length });
    return { data: { chunks: rebuild.chunks.length } };
  } finally {
    await Promise.all([upgradedZip?.close(), sourceZip?.close(), zip.close()]);
  }
}

/** Orders replayed entries like the aligned EPUB: the index's order, dropped source entries at their positions, anything new last. */
function inFullRunOrder<T extends { filename: string }>(
  replayed: T[],
  stored: readonly ZipEntry[],
  sourceEntries: readonly ReadAloudRebuildSourceEntry[],
): T[] {
  const byName = new Map(replayed.map((entry) => [entry.filename, entry]));
  const dropped = new Set(sourceEntries.map((entry) => entry.href));
  const kept = stored.filter((entry) => byName.has(entry.filename)).map((entry) => byName.get(entry.filename)!);
  const keptNames = new Set(kept.map((entry) => entry.filename));
  const restored = replayed.filter((entry) => dropped.has(entry.filename) && !keptNames.has(entry.filename));
  const ordered = inOriginalOrder(kept, restored, sourceEntries);
  const placed = new Set(ordered.map((entry) => entry.filename));
  return [...ordered, ...replayed.filter((entry) => !placed.has(entry.filename))];
}

/** Puts each restored source entry back where it sat in the aligned EPUB; entries without a position go last. */
function inOriginalOrder<T extends { filename: string }>(kept: T[], restored: T[], sourceEntries: readonly ReadAloudRebuildSourceEntry[]): T[] {
  const positions = new Map(sourceEntries.map((entry) => [entry.href, entry.position ?? Number.MAX_SAFE_INTEGER]));
  const captureOrder = new Map(sourceEntries.map((entry, index) => [entry.href, index]));
  const pending = [...restored].sort(
    (a, b) => positions.get(a.filename)! - positions.get(b.filename)! || captureOrder.get(a.filename)! - captureOrder.get(b.filename)!,
  );
  const ordered: T[] = [];
  for (const [index, entry] of kept.entries()) {
    while (pending.length && positions.get(pending[0].filename)! <= index) ordered.push(pending.shift()!);
    ordered.push(entry);
  }
  return [...ordered, ...pending];
}

export async function clearRebuildOutput(context: StageContext): Promise<void> {
  await rm(context.paths.outputPath, { force: true });
  await rm(context.paths.reportPath, { force: true });
}
