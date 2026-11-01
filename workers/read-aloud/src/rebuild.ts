import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadAloudRebuildSourceEntry } from "@bookorbit/types";
import type { StageContext, StageResult } from "./pipeline-contract.js";
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

export class RebuildMismatchError extends Error {
  constructor(message = "The timing index does not match the processed audio") {
    super(message);
    this.name = "RebuildMismatchError";
  }
}

export async function rebuildFromIndex(context: StageContext): Promise<StageResult> {
  const { job, paths, signal } = context;
  const rebuild = job.rebuild!;
  const actual = new Set((await readdir(paths.processedAudioDir)).filter((name) => !name.startsWith(".") && !name.endsWith(".json")));
  const expected = new Set(rebuild.chunks.map((chunk) => chunk.name));
  if (actual.size !== expected.size || [...actual].some((name) => !expected.has(name)))
    throw new RebuildMismatchError("Processed audio differs from the timing index");
  for (const chunk of rebuild.chunks) {
    signal.throwIfAborted();
    const path = join(paths.processedAudioDir, chunk.name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.size !== chunk.size) throw new RebuildMismatchError();
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
    if (hash.digest("hex") !== chunk.sha256) throw new RebuildMismatchError();
  }
  const indexPath = join(paths.workDir, rebuild.indexEntry);
  if (!(await lstat(indexPath).catch(() => null))?.isFile()) throw new RebuildMismatchError("The timing index is missing");
  const zip = await reader.open(indexPath);
  let sourceZip: ZipReader | undefined;
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
    if (sourceEntries.length) {
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
    const sizes = new Map(rebuild.chunks.map((chunk) => [chunk.name, chunk.size]));
    if (
      total +
        sourceEntries.reduce((sum, entry) => sum + entry.size, 0) +
        rebuild.audioEntries.reduce((sum, entry) => sum + sizes.get(entry.chunk)!, 0) >
      job.maxOutputBytes
    )
      throw new RebuildMismatchError("Rebuild exceeds output limit");
    await pipeline(await report.openReadStream(), createWriteStream(paths.reportPath), { signal });
    const output = new writer.ZipFile();
    const done = pipeline(output.outputStream, createWriteStream(paths.outputPath), { signal });
    void done.catch(() => undefined);
    try {
      const kept = entries.filter((entry) => !entry.filename.startsWith("bookorbit-timings/"));
      kept.sort((a, b) => Number(b.filename === "mimetype") - Number(a.filename === "mimetype"));
      for (const entry of inOriginalOrder(kept, restored, sourceEntries)) {
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
    await sourceZip?.close();
    await zip.close();
  }
}

/** Puts each restored source entry back where it sat in the aligned EPUB; entries without a position go last. */
function inOriginalOrder(kept: ZipEntry[], restored: ZipEntry[], sourceEntries: readonly ReadAloudRebuildSourceEntry[]): ZipEntry[] {
  const positions = new Map(sourceEntries.map((entry) => [entry.href, entry.position ?? Number.MAX_SAFE_INTEGER]));
  const captureOrder = new Map(sourceEntries.map((entry, index) => [entry.href, index]));
  const pending = [...restored].sort(
    (a, b) => positions.get(a.filename)! - positions.get(b.filename)! || captureOrder.get(a.filename)! - captureOrder.get(b.filename)!,
  );
  const ordered: ZipEntry[] = [];
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
