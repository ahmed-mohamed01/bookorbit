import type { EpubMediaOverlayPlaylist, EpubMediaOverlayPlaylistItem, ReadAlongNarrationMismatch } from '@bookorbit/types';

import type { NarrationFileOffset, NarrationSignatureEntry } from './read-along-offsets-store';

export type AudioChapterSpan = { startMs: number; endMs: number };

export type ReadAlongPosition = {
  item: EpubMediaOverlayPlaylistItem;
  overlaySeconds: number;
};

// An MP3 without a Xing header reports a header duration a few seconds longer than its decoded audio,
// and chapter tables are built from header durations, so a chapter may outrun the narration file cut
// from it by that much. The reverse only happens through millisecond rounding.
const MAX_CHAPTER_OVERHANG_SECONDS = 4;
const MAX_CHAPTER_SHORTFALL_SECONDS = 0.5;
const MAX_RUN_LENGTH = 8;
// A narration file can end a few seconds past its chapter when its last sentence is timed beyond the
// audio. One such chapter must not disable a book whose every other chapter fits exactly, so an
// in-order pairing is still trusted when nearly all files fit and the outliers stay close.
const MIN_EXACT_FIT_SHARE = 0.9;
const MAX_OUTLIER_SHARE_OF_CHAPTER = 0.03;
// Storyteller moves each chapter cut up to 10 s to the nearest silence, so a narration file it cut from
// the audiobook may differ from its chapter by a moved cut at each end plus header slack.
const STORYTELLER_CUT_SHIFT_SECONDS = 10;
const MAX_NAMED_FILE_DEVIATION_SECONDS = 2 * STORYTELLER_CUT_SHIFT_SECONDS + MAX_CHAPTER_OVERHANG_SECONDS;
// Storyteller names each narration file `<source file>-<range>`, both 1-based and five digits.
const STORYTELLER_FILE_NAME = /(?:^|\/)(\d{5})-(\d{5})\.[^/.]+$/;
const READ_ALONG_POSITION_EPSILON_SECONDS = 0.001;
// Covers whole-second rounding of a stored file duration plus an inflated MP3 header.
const FILE_START_SNAP_SECONDS = 2;

/**
 * `builtFromAudio`: BookOrbit generated this read-along from this audiobook, so Storyteller's file names
 * can pair narration files with chapters instead of durations alone. `audioFileStartsSeconds`: where each
 * of the audiobook's files starts, which a multi-file audiobook's names need to find their chapters.
 */
export type ReadAlongMappingOptions = { builtFromAudio?: boolean; audioFileStartsSeconds?: number[] };

type NarrationFile = { audioHref: string; durationSeconds: number; firstItemIndex: number; lastItemIndex: number };

/**
 * Chapter spans from a chapter table ordered by start. The last chapter runs to the audio total.
 */
export function buildAudioChapterSpans(chapters: { startMs: number }[], audioTotalSeconds: number): AudioChapterSpan[] {
  const ordered = [...chapters].filter((chapter) => Number.isFinite(chapter.startMs)).sort((left, right) => left.startMs - right.startMs);
  const totalMs = audioTotalSeconds * 1000;
  return ordered.map((chapter, index) => ({
    startMs: Math.max(0, chapter.startMs),
    endMs: Math.max(chapter.startMs, ordered[index + 1]?.startMs ?? totalMs),
  }));
}

/**
 * The chapter spans narration runs are matched against. A book without a chapter table is one chapter
 * spanning the whole audio, which a read-along cut into several files still fits as one run.
 */
export function buildNarrationChapterSpans(chapterStarts: { startMs: number }[], audioTotalSeconds: number): AudioChapterSpan[] {
  const spans = buildAudioChapterSpans(chapterStarts, audioTotalSeconds);
  if (spans.length > 0 || !(audioTotalSeconds > 0)) return spans;
  return [{ startMs: 0, endMs: audioTotalSeconds * 1000 }];
}

/** Each narration file of the playlist, in playlist order, with its length from the SMIL clip ends. */
export function narrationSignature(playlist: EpubMediaOverlayPlaylist): NarrationSignatureEntry[] {
  return collectNarrationFiles(playlist).map((file) => ({ audioHref: file.audioHref, durationSeconds: file.durationSeconds }));
}

export type NarrationRunMatch = { offsets: NarrationFileOffset[] } | { mismatch: ReadAlongNarrationMismatch };

/**
 * Places every narration file of a Storyteller read-along on the audiobook clock.
 *
 * Storyteller cuts narration per chapter but folds short chapters into one file, splits a chapter over
 * two hours into several, and drops chapters it could not align (credits). So a run of consecutive
 * narration files is paired with a run of consecutive chapters whose lengths agree, and inside a run
 * the files follow each other. A read-along built from different audio fails to match instead of
 * landing on a wrong sentence.
 */
export function matchNarrationRuns(
  playlist: EpubMediaOverlayPlaylist,
  chapters: AudioChapterSpan[],
  options: ReadAlongMappingOptions = {},
): NarrationRunMatch {
  const files = collectNarrationFiles(playlist);
  const named = options.builtFromAudio ? matchFilesByStorytellerName(files, chapters, options.audioFileStartsSeconds ?? [0]) : null;
  if (named) return { offsets: offsetsFromChapterPairs(files, chapters, named) };

  const runs = matchRuns(files, chapters);
  if ('offsets' in runs) return runs;

  const outliers = matchFilesWithOutliers(files, chapters);
  if (outliers) return { offsets: offsetsFromChapterPairs(files, chapters, outliers) };
  return runs;
}

/**
 * Places an audiobook time on the read-along narration through stored file offsets. A time between
 * two files (unnarrated credits, a chapter that outruns its narration) waits at the next file's first
 * sentence; a time past the last file stays on its last sentence.
 */
export function mapAudioPositionWithOffsets(
  playlist: EpubMediaOverlayPlaylist,
  offsets: NarrationFileOffset[],
  audioSeconds: number,
): ReadAlongPosition | null {
  const filesByHref = new Map(collectNarrationFiles(playlist).map((file) => [file.audioHref, file]));
  const ordered = offsets.filter((offset) => filesByHref.has(offset.audioHref)).sort((left, right) => left.startSeconds - right.startSeconds);
  if (ordered.length === 0) return null;

  const time = Math.max(0, audioSeconds);
  let index = -1;
  while (index + 1 < ordered.length && ordered[index + 1]!.startSeconds <= time) index += 1;

  const items = playlist.items;
  const itemStarts = itemTimelineStarts(items);
  if (index < 0) return atItem(items, itemStarts, firstPlayableIndex(items, filesByHref.get(ordered[0]!.audioHref)!), 0);

  const offset = ordered[index]!;
  const next = ordered[index + 1];
  const secondsIntoFile = time - offset.startSeconds;
  if (next && secondsIntoFile > offset.durationSeconds) {
    return atItem(items, itemStarts, firstPlayableIndex(items, filesByHref.get(next.audioHref)!), 0);
  }
  return locateInFile(items, itemStarts, filesByHref.get(offset.audioHref)!, Math.min(secondsIntoFile, offset.durationSeconds));
}

/**
 * The inverse of `mapAudioPositionWithOffsets`: the audiobook time narrating the sentence at a
 * read-along position.
 */
export function mapReadAlongPositionWithOffsets(
  playlist: EpubMediaOverlayPlaylist,
  offsets: NarrationFileOffset[],
  overlaySeconds: number,
): number | null {
  const starts = itemTimelineStarts(playlist.items);
  let index = -1;
  for (let candidate = 0; candidate < playlist.items.length; candidate += 1) {
    if (!isPlayable(playlist.items[candidate]!)) continue;
    if (index >= 0 && starts[candidate]! > overlaySeconds) break;
    index = candidate;
  }
  if (index < 0) return null;

  const item = playlist.items[index]!;
  const offset = offsets.find((candidate) => candidate.audioHref === item.audioHref);
  if (!offset) return null;

  const secondsIntoItem = Math.max(0, Math.min(item.durationSeconds ?? 0, overlaySeconds - starts[index]!));
  // A file paired by name may run past the start of the next one; its tail must not land the audiobook
  // in the next file's narration.
  const nextStart = offsets.reduce(
    (nearest, candidate) => (candidate.startSeconds > offset.startSeconds && candidate.startSeconds < nearest ? candidate.startSeconds : nearest),
    Number.POSITIVE_INFINITY,
  );
  const end = Math.min(offset.startSeconds + offset.durationSeconds, nextStart);
  const audioSeconds = offset.startSeconds + item.clipBeginSeconds + secondsIntoItem;
  return Math.max(offset.startSeconds, Math.min(audioSeconds, end - READ_ALONG_POSITION_EPSILON_SECONDS));
}

/**
 * Where each audio file starts in the book. A file start within a chapter-table start is snapped to it:
 * stored file durations are rounded while chapter tables keep milliseconds, and the two must agree for
 * a position to land on the chapter the mapping expects.
 */
export function audioFileStartsSeconds(fileDurationsSeconds: number[], chapterStartsMs: number[]): number[] {
  const starts: number[] = [];
  let elapsed = 0;
  for (const duration of fileDurationsSeconds) {
    const nearest = chapterStartsMs.reduce<number | null>(
      (best, startMs) => (best === null || Math.abs(startMs / 1000 - elapsed) < Math.abs(best - elapsed) ? startMs / 1000 : best),
      null,
    );
    const start = nearest !== null && Math.abs(nearest - elapsed) <= FILE_START_SNAP_SECONDS ? nearest : elapsed;
    starts.push(start);
    elapsed = start + duration;
  }
  return starts;
}

/**
 * Where each item starts on the narration clock that stored read-along positions use. Items without a
 * positive duration take no time, so they share the start of the item after them.
 */
export function itemTimelineStarts(items: EpubMediaOverlayPlaylistItem[]): number[] {
  const starts: number[] = [];
  let elapsed = 0;
  for (const item of items) {
    starts.push(elapsed);
    if (isPlayable(item)) elapsed += item.durationSeconds;
  }
  return starts;
}

export function isPlayable(item: EpubMediaOverlayPlaylistItem): item is EpubMediaOverlayPlaylistItem & { durationSeconds: number } {
  return typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0;
}

function collectNarrationFiles(playlist: EpubMediaOverlayPlaylist): NarrationFile[] {
  const files: NarrationFile[] = [];
  const byHref = new Map<string, NarrationFile>();
  playlist.items.forEach((item, index) => {
    const end = clipEnd(item);
    let file = byHref.get(item.audioHref);
    if (!file) {
      file = { audioHref: item.audioHref, durationSeconds: end, firstItemIndex: index, lastItemIndex: index };
      byHref.set(item.audioHref, file);
      files.push(file);
    }
    file.durationSeconds = Math.max(file.durationSeconds, end);
    file.lastItemIndex = index;
  });
  return files;
}

/**
 * Pairs each narration file with the chapter its Storyteller name points at, in whatever order the
 * EPUB plays them (a book may narrate an appendix chapter early). Source file N is the audiobook's file
 * N: BookOrbit uploads them numbered in track order and only references files whose names already sort
 * that way. Range N is the Nth chapter starting inside that file. A read-along built before that
 * numbering, or a chapter Storyteller split for length, fails the duration check and falls back to
 * duration matching.
 */
function matchFilesByStorytellerName(
  files: NarrationFile[],
  chapters: AudioChapterSpan[],
  audioFileStartsSeconds: number[],
): Map<number, NarrationFile> | null {
  if (files.length === 0) return null;
  const chaptersByFile = audioFileStartsSeconds.map((start, index) => {
    const end = audioFileStartsSeconds[index + 1] ?? Number.POSITIVE_INFINITY;
    return chapters.flatMap((chapter, chapterIndex) =>
      chapter.startMs / 1000 >= start - FILE_START_SNAP_SECONDS && chapter.startMs / 1000 < end - FILE_START_SNAP_SECONDS ? [chapterIndex] : [],
    );
  });
  const matched = new Map<number, NarrationFile>();
  for (const file of files) {
    const name = STORYTELLER_FILE_NAME.exec(file.audioHref);
    if (!name) return null;
    const chapterIndex = chaptersByFile[Number(name[1]) - 1]?.[Number(name[2]) - 1];
    const chapter = chapterIndex === undefined ? undefined : chapters[chapterIndex];
    if (chapterIndex === undefined || !chapter || matched.has(chapterIndex)) return null;
    if (Math.abs((chapter.endMs - chapter.startMs) / 1000 - file.durationSeconds) > MAX_NAMED_FILE_DEVIATION_SECONDS) return null;
    matched.set(chapterIndex, file);
  }
  return matched;
}

/**
 * Dynamic programme over (narration files placed, chapters consumed). A step pairs a run of up to
 * `MAX_RUN_LENGTH` files with a run of up to as many chapters whose lengths agree, or skips a chapter
 * Storyteller dropped. The fewest skipped chapters win, then the most runs: every run is anchored to a
 * chapter start, so a finer pairing keeps each file exact instead of chaining file lengths.
 */
function matchRuns(files: NarrationFile[], chapters: AudioChapterSpan[]): NarrationRunMatch {
  const fileCount = files.length;
  const chapterCount = chapters.length;
  if (fileCount === 0 || chapterCount === 0) return { mismatch: describeRunMismatch(files, chapters, 0, 0) };

  const fileEnds = prefixSums(files.map((file) => file.durationSeconds));
  const chapterEnds = prefixSums(chapters.map((chapter) => (chapter.endMs - chapter.startMs) / 1000));
  // A skipped chapter costs more than any number of runs can earn back.
  const skipCost = fileCount + 1;
  const width = chapterCount + 1;
  const cost = new Float64Array((fileCount + 1) * width).fill(Number.POSITIVE_INFINITY);
  const stepFiles = new Int16Array((fileCount + 1) * width);
  const stepChapters = new Int16Array((fileCount + 1) * width);
  cost[0] = 0;
  const relax = (file: number, chapter: number, value: number, runFiles: number, runChapters: number): void => {
    const index = file * width + chapter;
    if (value >= cost[index]!) return;
    cost[index] = value;
    stepFiles[index] = runFiles;
    stepChapters[index] = runChapters;
  };

  for (let file = 0; file <= fileCount; file += 1) {
    for (let chapter = 0; chapter <= chapterCount; chapter += 1) {
      const here = cost[file * width + chapter]!;
      if (here === Number.POSITIVE_INFINITY) continue;
      if (chapter < chapterCount) relax(file, chapter + 1, here + skipCost, 0, 1);
      for (let runFiles = 1; runFiles <= MAX_RUN_LENGTH && file + runFiles <= fileCount; runFiles += 1) {
        const narrationSeconds = fileEnds[file + runFiles]! - fileEnds[file]!;
        for (let runChapters = 1; runChapters <= MAX_RUN_LENGTH && chapter + runChapters <= chapterCount; runChapters += 1) {
          const overhang = chapterEnds[chapter + runChapters]! - chapterEnds[chapter]! - narrationSeconds;
          if (overhang > MAX_CHAPTER_OVERHANG_SECONDS) break;
          if (overhang >= -runShortfallSeconds(runFiles)) relax(file + runFiles, chapter + runChapters, here - 1, runFiles, runChapters);
        }
      }
    }
  }

  if (cost[fileCount * width + chapterCount] === Number.POSITIVE_INFINITY) {
    let placed = fileCount;
    while (placed > 0 && !cost.subarray(placed * width, (placed + 1) * width).some(Number.isFinite)) placed -= 1;
    const nextChapter = cost.subarray(placed * width, (placed + 1) * width).findIndex(Number.isFinite);
    return { mismatch: describeRunMismatch(files, chapters, placed, nextChapter) };
  }

  const offsets: NarrationFileOffset[] = new Array<NarrationFileOffset>(fileCount);
  let file = fileCount;
  let chapter = chapterCount;
  while (file > 0 || chapter > 0) {
    const runFiles = stepFiles[file * width + chapter]!;
    const runChapters = stepChapters[file * width + chapter]!;
    file -= runFiles;
    chapter -= runChapters;
    let startSeconds = chapters[chapter]!.startMs / 1000;
    for (let index = file; index < file + runFiles; index += 1) {
      const { audioHref, durationSeconds } = files[index]!;
      offsets[index] = { audioHref, startSeconds, durationSeconds };
      startSeconds += durationSeconds;
    }
  }
  return { offsets };
}

// Each file in a run carries its own millisecond rounding, so a longer run may outrun its chapters by more.
function runShortfallSeconds(runFiles: number): number {
  return MAX_CHAPTER_SHORTFALL_SECONDS * runFiles;
}

function prefixSums(values: number[]): number[] {
  const sums = [0];
  for (const value of values) sums.push(sums.at(-1)! + value);
  return sums;
}

/** The first narration file no run could place, against the chapter after the last one consumed. */
function describeRunMismatch(
  files: NarrationFile[],
  chapters: AudioChapterSpan[],
  placedFiles: number,
  nextChapter: number,
): ReadAlongNarrationMismatch {
  const chapterIndex = Math.min(Math.max(0, nextChapter), chapters.length - 1);
  const chapter = chapters[chapterIndex];
  return {
    narrationFile: placedFiles + 1,
    narrationSeconds: files[placedFiles]?.durationSeconds ?? 0,
    chapter: chapter ? chapterIndex + 1 : 0,
    chapterSeconds: chapter ? (chapter.endMs - chapter.startMs) / 1000 : 0,
  };
}

function offsetsFromChapterPairs(
  files: NarrationFile[],
  chapters: AudioChapterSpan[],
  fileByChapter: Map<number, NarrationFile>,
): NarrationFileOffset[] {
  const startByHref = new Map([...fileByChapter].map(([chapterIndex, file]) => [file.audioHref, chapters[chapterIndex]!.startMs / 1000]));
  return files.map((file) => ({ audioHref: file.audioHref, startSeconds: startByHref.get(file.audioHref)!, durationSeconds: file.durationSeconds }));
}

/**
 * In-order alignment that may skip chapters (credits Storyteller dropped) and pays one outlier per
 * file that only loosely fits its chapter; the alignment with the fewest outliers wins.
 */
function matchFilesWithOutliers(files: NarrationFile[], chapters: AudioChapterSpan[]): Map<number, NarrationFile> | null {
  const fileCount = files.length;
  const chapterCount = chapters.length;
  if (fileCount === 0 || fileCount > chapterCount) return null;

  const maxOutliers = Math.floor(fileCount * (1 - MIN_EXACT_FIT_SHARE));
  if (maxOutliers === 0) return null;

  // outliers[f][c]: fewest outliers placing the first f files within the first c chapters.
  const unreachable = fileCount + 1;
  const width = chapterCount + 1;
  const outliers = new Int32Array((fileCount + 1) * width).fill(unreachable);
  for (let chapter = 0; chapter <= chapterCount; chapter += 1) outliers[chapter] = 0;
  for (let file = 1; file <= fileCount; file += 1) {
    for (let chapter = file; chapter <= chapterCount; chapter += 1) {
      const skip = outliers[file * width + chapter - 1]!;
      const cost = fitCost(chapters[chapter - 1]!, files[file - 1]!);
      const pair = cost === null ? unreachable : outliers[(file - 1) * width + chapter - 1]! + cost;
      outliers[file * width + chapter] = Math.min(skip, pair, unreachable);
    }
  }
  if (outliers[fileCount * width + chapterCount]! > maxOutliers) return null;

  const matched = new Map<number, NarrationFile>();
  let chapter = chapterCount;
  for (let file = fileCount; file > 0; file -= 1) {
    while (outliers[file * width + chapter - 1] === outliers[file * width + chapter]) chapter -= 1;
    matched.set(chapter - 1, files[file - 1]!);
    chapter -= 1;
  }
  return matched;
}

function fitCost(chapter: AudioChapterSpan, file: NarrationFile): 0 | 1 | null {
  if (chapterFitsFile(chapter, file)) return 0;
  const spanSeconds = (chapter.endMs - chapter.startMs) / 1000;
  const allowed = Math.max(MAX_CHAPTER_OVERHANG_SECONDS, spanSeconds * MAX_OUTLIER_SHARE_OF_CHAPTER);
  return Math.abs(spanSeconds - file.durationSeconds) <= allowed ? 1 : null;
}

function chapterFitsFile(chapter: AudioChapterSpan, file: NarrationFile): boolean {
  const overhang = (chapter.endMs - chapter.startMs) / 1000 - file.durationSeconds;
  return overhang >= -MAX_CHAPTER_SHORTFALL_SECONDS && overhang <= MAX_CHAPTER_OVERHANG_SECONDS;
}

function clipEnd(item: EpubMediaOverlayPlaylistItem): number {
  return item.clipEndSeconds ?? item.clipBeginSeconds + (item.durationSeconds ?? 0);
}

/**
 * A narration file's playable items in audio order. The EPUB plays them in text order, which differs
 * when a sentence aligned early in the book (an epigraph repeated later) borrows a clip from the file.
 */
function itemsByClip(items: EpubMediaOverlayPlaylistItem[], file: NarrationFile): number[] {
  const indexes: number[] = [];
  for (let index = file.firstItemIndex; index <= file.lastItemIndex; index += 1) {
    if (items[index]!.audioHref === file.audioHref && isPlayable(items[index]!)) indexes.push(index);
  }
  return indexes.sort((left, right) => items[left]!.clipBeginSeconds - items[right]!.clipBeginSeconds);
}

function firstPlayableIndex(items: EpubMediaOverlayPlaylistItem[], file: NarrationFile): number {
  return itemsByClip(items, file)[0] ?? file.firstItemIndex;
}

function lastPlayableIndex(items: EpubMediaOverlayPlaylistItem[], file: NarrationFile): number {
  return itemsByClip(items, file).at(-1) ?? file.lastItemIndex;
}

function locateInFile(items: EpubMediaOverlayPlaylistItem[], itemStarts: number[], file: NarrationFile, offsetSeconds: number): ReadAlongPosition {
  const ordered = itemsByClip(items, file);
  for (const index of ordered) {
    const item = items[index]!;
    if (offsetSeconds < clipEnd(item)) return atItem(items, itemStarts, index, offsetSeconds - item.clipBeginSeconds);
  }
  // Past the last clip: header-inflated MP3s let a player report a few seconds of phantom tail.
  return atItem(items, itemStarts, ordered.at(-1) ?? lastPlayableIndex(items, file), 0);
}

// Kept strictly inside the item: its end is where the next item starts, and a stored position there
// would resume one sentence late.
function atItem(items: EpubMediaOverlayPlaylistItem[], itemStarts: number[], index: number, secondsIntoItem: number): ReadAlongPosition {
  const item = items[index]!;
  const duration = isPlayable(item) ? item.durationSeconds : 0;
  const within = Math.min(Math.max(0, secondsIntoItem), Math.max(0, duration - READ_ALONG_POSITION_EPSILON_SECONDS));
  return { item, overlaySeconds: itemStarts[index]! + within };
}
