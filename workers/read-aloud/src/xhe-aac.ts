import { execFile } from "node:child_process";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { StageError, type StageContext } from "./pipeline-contract.js";

/**
 * xHE-AAC (USAC) audiobooks, which Audible now ships, are only partly decodable by ffmpeg's own AAC
 * decoder: it drops about one frame in five ("Not yet implemented in FFmpeg"). STAlign splits with a
 * stream copy, so the loss happens later, when the speech model decodes the pieces, and every
 * sentence is timed on audio about 24% shorter than the book. Read along then runs ahead of the
 * narration by an amount that grows through each chapter.
 *
 * Such a file is re-encoded to plain AAC before splitting, keeping its chapters. With ffmpeg's
 * libfdk_aac decoder every frame decodes; without it, each frame ffmpeg cannot decode becomes
 * silence of the same length, so the timeline still matches the book's.
 */
export const XHE_AAC_PROFILE = "xHE-AAC";

/** Part of the preparing-audio cache key, so audio split before this re-encode existed is split again. */
export const AUDIO_PREPARE_VERSION = 2;

export type XheAacDecoder = "libfdk_aac" | "native";

export function reencodeArgs(input: string, output: string, decoder: XheAacDecoder): string[] {
  return [
    "-nostdin",
    // The native decoder reports every frame it drops; only a failure that stops ffmpeg matters here.
    "-v",
    "fatal",
    ...(decoder === "libfdk_aac" ? ["-c:a", "libfdk_aac"] : []),
    "-i",
    input,
    "-map",
    "0:a:0",
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    // Places every decoded frame at its timestamp and fills what is missing with silence.
    "-af",
    "aresample=async=1:first_pts=0",
    "-ac",
    "1",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-f",
    "mp4",
    "-y",
    output,
  ];
}

/** Replaces each xHE-AAC file linked into `dir` with a plain AAC copy under the same name. */
export async function reencodeXheAac(dir: string, context: StageContext): Promise<number> {
  let decoder: XheAacDecoder | null = null;
  let count = 0;
  for (const name of (await readdir(dir)).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if ((await audioProfile(path, context.signal)) !== XHE_AAC_PROFILE) continue;
    decoder ??= (await ffmpeg(["-hide_banner", "-decoders"], context.signal)).includes(" libfdk_aac ") ? "libfdk_aac" : "native";
    const startedAt = Date.now();
    // Hidden, so STAlign never takes a half-written copy for an input.
    const partial = join(dir, `.${name}.partial`);
    try {
      await ffmpeg(reencodeArgs(path, partial, decoder), context.signal);
      // Replaces the symlink itself; the library file it pointed at is never written.
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true });
    }
    count += 1;
    context.event(
      decoder === "native" ? "warn" : "info",
      "audio_xhe_aac_reencoded",
      decoder === "native"
        ? "An xHE-AAC file was re-encoded; ffmpeg cannot decode every frame of it, so those frames are silence"
        : "An xHE-AAC file was re-encoded to AAC",
      { file: name, decoder, durationMs: Date.now() - startedAt },
    );
  }
  return count;
}

async function audioProfile(path: string, signal: AbortSignal): Promise<string | null> {
  const out = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=profile", "-of", "csv=p=0", path], signal);
  return out.trim() || null;
}

function ffmpeg(args: string[], signal: AbortSignal): Promise<string> {
  return run("ffmpeg", args, signal);
}

function run(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

type ReportTrack = { duration?: unknown; source?: { start?: unknown; end?: unknown } | null };

/** Pieces shorter than this say little about decoding: a few frames of rounding are a large share. */
const MIN_TRACK_SECONDS = 30;

/**
 * How much of the book the speech model heard, from the alignment report: for the typical piece,
 * `duration` (what decoded) over its `source` stretch of the book. A decoder that drops frames (as
 * ffmpeg does on xHE-AAC) shortens every piece by the same share, and the index would run ahead.
 * The median keeps one odd piece, such as a last chapter mark past the end of its file, from
 * deciding it. Null when no piece is long enough to judge.
 */
export function decodedShare(tracks: unknown): { share: number; tracks: number } | null {
  if (!Array.isArray(tracks)) return null;
  const shares: number[] = [];
  for (const track of tracks as ReportTrack[]) {
    const { duration, source } = track ?? {};
    if (typeof duration !== "number" || typeof source?.start !== "number" || typeof source.end !== "number") continue;
    const expected = source.end - source.start;
    if (expected >= MIN_TRACK_SECONDS) shares.push(duration / expected);
  }
  if (!shares.length) return null;
  shares.sort((a, b) => a - b);
  return { share: shares[Math.floor(shares.length / 2)], tracks: shares.length };
}

/** Fails the job when the audio decoded short, rather than storing an index that runs ahead. */
export function assertFullyDecoded(tracks: unknown): void {
  const decoded = decodedShare(tracks);
  if (!decoded || decoded.share >= 0.98) return;
  throw new StageError(
    "invalid_output",
    `The audio decoded to ${Math.round(decoded.share * 100)}% of its length, so the timings would run ahead of the narration`,
  );
}
