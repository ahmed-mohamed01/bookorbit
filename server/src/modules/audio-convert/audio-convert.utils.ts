import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';

import type {
  AudioConvertBitrate,
  AudioConvertChannels,
  AudioConvertCodec,
  AudioConvertCodecReason,
  AudioConvertResolvedCodec,
  AudiobookChapter,
} from '@bookorbit/types';

/** What ffprobe reports for one input file. */
export interface AudioProbe {
  durationMs: number;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrateKbps: number | null;
}

/** Codecs an MP4 container carries and players read without a re-encode. */
const MP4_COPYABLE_CODECS = new Set(['aac', 'mp3', 'alac']);

/**
 * The codec `auto` resolves to, like Audiobookshelf's encoder: a stream copy keeps the audio bit for
 * bit, but joining files only copies cleanly when every file has the same codec, rate and layout.
 */
export function chooseAutoCodec(probes: readonly AudioProbe[]): { codec: AudioConvertResolvedCodec; reason: AudioConvertCodecReason } {
  const first = probes[0];
  if (!first) return { codec: 'aac', reason: 'not_aac_compatible' };
  if (probes.some((probe) => probe.codec !== first.codec)) return { codec: 'aac', reason: 'mixed_codecs' };
  if (!first.codec || !MP4_COPYABLE_CODECS.has(first.codec)) return { codec: 'aac', reason: 'not_aac_compatible' };
  if (probes.some((probe) => probe.sampleRate !== first.sampleRate)) return { codec: 'aac', reason: 'mixed_sample_rates' };
  if (probes.some((probe) => probe.channels !== first.channels)) return { codec: 'aac', reason: 'mixed_channels' };
  return { codec: 'copy', reason: 'all_match' };
}

/** `copy` asked for explicitly still falls back to AAC when the files cannot be joined by copying. */
export function resolveCodec(requested: AudioConvertCodec, probes: readonly AudioProbe[]): AudioConvertResolvedCodec {
  const auto = chooseAutoCodec(probes);
  if (requested === 'aac') return 'aac';
  return auto.codec;
}

/** Each file's exact start on the joined timeline, in milliseconds. */
export function exactStartsMs(durationsMs: readonly number[]): number[] {
  const starts: number[] = [];
  let elapsed = 0;
  for (const duration of durationsMs) {
    starts.push(elapsed);
    elapsed += duration;
  }
  return starts;
}

/**
 * Each file's start on the timeline BookOrbit stores absolute positions on: the plain running sum of
 * the whole-second `book_files.duration_seconds`. The audiobook manifest, the player and the chapter
 * editor all place bookmarks and `book_metadata.chapters` on this timeline (no chapter snapping).
 */
export function plainStartsSeconds(durationsSeconds: readonly (number | null)[]): number[] {
  return exactStartsMs(durationsSeconds.map((seconds) => (seconds ?? 0) * 1000)).map((ms) => ms / 1000);
}

/**
 * Moves a book position from the timeline BookOrbit stored (whole-second file lengths) onto the
 * joined file's exact timeline. The file the position fell in keeps the same
 * offset, so a listener resumes at the same words.
 */
export function remapAbsoluteSeconds(positionSeconds: number, oldStartsSeconds: readonly number[], newStartsSeconds: readonly number[]): number {
  if (oldStartsSeconds.length === 0) return positionSeconds;
  const position = Math.max(0, positionSeconds);
  let index = 0;
  for (let i = 0; i < oldStartsSeconds.length; i++) {
    if (position >= oldStartsSeconds[i]!) index = i;
  }
  const offset = position - oldStartsSeconds[index]!;
  const nextNewStart = newStartsSeconds[index + 1];
  const newStart = newStartsSeconds[index]!;
  const limit = nextNewStart === undefined ? Number.POSITIVE_INFINITY : nextNewStart - newStart;
  return newStart + Math.max(0, Math.min(offset, limit));
}

/** Chapters moved onto the exact timeline, cleaned the way BookOrbit stores them, and clipped to the length. */
export function rebaseChapters(
  chapters: readonly AudiobookChapter[],
  oldStartsSeconds: readonly number[],
  newStartsSeconds: readonly number[],
  totalMs: number,
): AudiobookChapter[] {
  const moved = chapters
    .map((chapter) => ({
      title: chapter.title,
      startMs: Math.round(remapAbsoluteSeconds(chapter.startMs / 1000, oldStartsSeconds, newStartsSeconds) * 1000),
    }))
    .filter((chapter) => chapter.startMs < totalMs)
    .sort((a, b) => a.startMs - b.startMs);
  const unique: AudiobookChapter[] = [];
  for (const chapter of moved) {
    if (unique.length > 0 && unique[unique.length - 1]!.startMs === chapter.startMs) continue;
    unique.push(chapter);
  }
  if (unique[0] && unique[0].startMs > 0) unique[0] = { ...unique[0], startMs: 0 };
  return unique;
}

/** One chapter per file, named after the file, for a joined book with no stored chapters. */
export function perFileChapters(paths: readonly string[], durationsMs: readonly number[]): AudiobookChapter[] {
  const starts = exactStartsMs(durationsMs);
  return paths.map((path, index) => ({ title: basename(path, extname(path)), startMs: starts[index]! }));
}

export function escapeFfmetadataValue(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\\=;#\n]/g, (character) => `\\${character}`);
}

export interface ConvertTags {
  title?: string | null;
  subtitle?: string | null;
  authors?: string[];
  narrators?: string[];
  seriesName?: string | null;
  seriesIndex?: string | null;
  publisher?: string | null;
  publishedDate?: string | null;
  publishedYear?: number | null;
  description?: string | null;
  genres?: string[];
  language?: string | null;
  asin?: string | null;
  isbn?: string | null;
}

/** Tag keys follow upstream's audio writer, so a converted file reads back like a written one. */
export function buildFfmetadata(tags: ConvertTags | null, chapters: readonly AudiobookChapter[] | null, totalMs: number): string {
  const lines = [';FFMETADATA1'];
  const push = (key: string, value: string | null | undefined) => {
    const text = value?.trim();
    if (text) lines.push(`${key}=${escapeFfmetadataValue(text)}`);
  };
  if (tags) {
    const authors = (tags.authors ?? []).filter(Boolean).join(', ');
    const narrators = (tags.narrators ?? []).filter(Boolean).join(', ');
    push('title', tags.title);
    push('album', tags.title);
    push('subtitle', tags.subtitle);
    push('artist', authors);
    push('album_artist', authors);
    push('composer', narrators);
    push('date', tags.publishedDate ?? (tags.publishedYear == null ? null : String(tags.publishedYear)));
    push('publisher', tags.publisher);
    push('description', tags.description);
    push('comment', tags.description);
    push('genre', (tags.genres ?? []).filter(Boolean).join(', '));
    push('language', tags.language);
    push('series', tags.seriesName);
    push('series-part', tags.seriesIndex);
    push('show', tags.seriesName);
    push('ASIN', tags.asin);
    push('ISBN', tags.isbn);
    push('media_type', '2');
  }
  if (chapters) {
    chapters.forEach((chapter, index) => {
      const end = chapters[index + 1]?.startMs ?? totalMs;
      if (end <= chapter.startMs) return;
      lines.push(
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        `START=${Math.round(chapter.startMs)}`,
        `END=${Math.round(end)}`,
        `title=${escapeFfmetadataValue(chapter.title)}`,
      );
    });
  }
  return `${lines.join('\n')}\n`;
}

/** ffmpeg concat-demuxer list. The duration lines pin each file's length so the joined timeline is exact. */
export function buildConcatList(paths: readonly string[], durationsMs: readonly number[]): string {
  const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;
  return (
    paths
      .map((path, index) => {
        const duration = durationsMs[index];
        return duration ? `file ${quote(path)}\nduration ${(duration / 1000).toFixed(3)}` : `file ${quote(path)}`;
      })
      .join('\n') + '\n'
  );
}

/**
 * Where ffmpeg takes chapters from: `metadata` writes the ffmetadata list, `source` keeps the single
 * input's own chapters, `none` writes no chapters at all.
 */
export type ConvertChapterMode = 'metadata' | 'source' | 'none';

export interface ConvertArgsInput {
  inputs: readonly string[];
  concatListPath: string;
  metadataPath: string;
  coverPath: string | null;
  outputPath: string;
  codec: AudioConvertResolvedCodec;
  bitrate: AudioConvertBitrate;
  channels: AudioConvertChannels;
  embedMetadata: boolean;
  chapters: ConvertChapterMode;
}

/** One ffmpeg pass: audio from input 0, tags and chapters from input 1, cover from input 2. */
export function buildConvertArgs(input: ConvertArgsInput): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  if (input.inputs.length > 1) args.push('-f', 'concat', '-safe', '0', '-i', input.concatListPath);
  else args.push('-i', input.inputs[0]!);
  args.push('-f', 'ffmetadata', '-i', input.metadataPath);
  if (input.coverPath) args.push('-i', input.coverPath);

  args.push('-map', '0:a');
  if (input.coverPath) args.push('-map', '2:v');
  args.push('-map_metadata', input.embedMetadata ? '1' : '0');
  args.push('-map_chapters', input.chapters === 'metadata' ? '1' : input.chapters === 'source' ? '0' : '-1');

  if (input.codec === 'copy') args.push('-c:a', 'copy');
  else {
    args.push('-c:a', 'aac', '-b:a', input.bitrate);
    if (input.channels) args.push('-ac', String(input.channels));
  }
  if (input.coverPath) args.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  args.push('-movflags', '+faststart', '-f', 'mp4', input.outputPath);
  return args;
}

/**
 * Where the converted file goes. A single file keeps its name beside itself; a joined book is written
 * to the book's folder and named after it, so "Book/Book - Part 1.mp3 …" and "Book/CD1/01.mp3,
 * Book/CD2/01.mp3" both become "Book/Book.m4b". Without a book folder that holds every file, the first
 * file's folder is used.
 */
export function outputPathFor(paths: readonly string[], bookFolder?: string | null): string {
  const first = paths[0]!;
  if (paths.length === 1) return join(dirname(first), `${basename(first, extname(first))}.m4b`);
  const folder = bookFolder && paths.every((path) => isInside(path, bookFolder)) ? bookFolder.replace(/\/+$/, '') : dirname(first);
  const name = basename(folder).trim();
  return join(folder, `${name || basename(first, extname(first))}.m4b`);
}

function isInside(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** How far ffmpeg has got, from its `-progress` output, as 0–100. */
export function progressPercent(outTimeUs: number, totalMs: number): number {
  if (!Number.isFinite(outTimeUs) || totalMs <= 0) return 0;
  return Math.max(0, Math.min(99, Math.floor((outTimeUs / 1000 / totalMs) * 100)));
}

/** Smallest step that keeps two `real` (float4) positions apart up to a few days of audio. */
const BOOKMARK_STEP_SECONDS = 0.05;

/**
 * Bookmarks moved onto the new timeline can land on the same second for one user (two marks clamped to
 * the exact end of a file), which `bookmarks_user_book_pos_uidx` forbids. A later duplicate moves a
 * twentieth of a second forward until it is free, comparing as the float4 column stores it.
 */
export function spreadBookmarkPositions<T extends { userId: number; positionSeconds: number; unique: boolean }>(rows: readonly T[]): number[] {
  const taken = new Map<number, Set<number>>();
  const result: number[] = new Array<number>(rows.length);
  const order = rows.map((_, index) => index).sort((a, b) => rows[a]!.positionSeconds - rows[b]!.positionSeconds || a - b);
  for (const index of order) {
    const row = rows[index]!;
    let position = row.positionSeconds;
    if (row.unique) {
      const used = taken.get(row.userId) ?? new Set<number>();
      taken.set(row.userId, used);
      while (used.has(Math.fround(position))) position += BOOKMARK_STEP_SECONDS;
      used.add(Math.fround(position));
    }
    result[index] = position;
  }
  return result;
}

/** Runs `fn` over `items` with at most `limit` running at once, keeping the input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
