import type { EpubMediaOverlayPlaylist, EpubMediaOverlayPlaylistItem } from '@bookorbit/types';

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
const READ_ALONG_POSITION_EPSILON_SECONDS = 0.001;
// Covers whole-second rounding of a stored file duration plus an inflated MP3 header.
const FILE_START_SNAP_SECONDS = 2;

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
 * Places an audiobook position on a Storyteller read-along's narration.
 *
 * Storyteller cuts one narration file per source chapter and drops chapters it could not align
 * (credits, pages under four words), so the read-along's timeline is the audiobook's with gaps. A
 * whole-book stretch smears those gaps across every chapter; mapping per chapter keeps each sentence
 * exact. Narration files are matched to chapters by duration in order, so file naming never matters
 * and a read-along built from different audio fails to match instead of landing on a wrong sentence.
 */
export function mapAudioPositionToReadAlong(
  playlist: EpubMediaOverlayPlaylist,
  chapters: AudioChapterSpan[],
  audioSeconds: number,
): ReadAlongPosition | null {
  const files = collectNarrationFiles(playlist);
  const fileByChapter = matchFilesToChapters(files, chapters);
  if (!fileByChapter) return null;

  const positionMs = Math.max(0, audioSeconds * 1000);
  let chapterIndex = chapters.findIndex((chapter) => positionMs >= chapter.startMs && positionMs < chapter.endMs);
  if (chapterIndex < 0) chapterIndex = positionMs < (chapters[0]?.startMs ?? 0) ? 0 : chapters.length - 1;

  const itemStarts = itemTimelineStarts(playlist.items);
  const file = fileByChapter.get(chapterIndex);
  if (file) {
    const offsetSeconds = (positionMs - chapters[chapterIndex]!.startMs) / 1000;
    return locateInFile(playlist.items, itemStarts, file, offsetSeconds);
  }

  // A chapter with no narration (opening or closing credits): the nearest narration that follows it,
  // or the last sentence when nothing does.
  for (let index = chapterIndex + 1; index < chapters.length; index += 1) {
    const next = fileByChapter.get(index);
    if (next) return atItem(playlist.items, itemStarts, firstPlayableIndex(playlist.items, next), 0);
  }
  for (let index = chapterIndex - 1; index >= 0; index -= 1) {
    const previous = fileByChapter.get(index);
    if (previous) return atItem(playlist.items, itemStarts, lastPlayableIndex(playlist.items, previous), 0);
  }
  return null;
}

/**
 * The inverse of `mapAudioPositionToReadAlong`: the audiobook time narrating the sentence at a
 * read-along position. Null when the narration does not fit the chapter table.
 */
export function mapReadAlongPositionToAudio(playlist: EpubMediaOverlayPlaylist, chapters: AudioChapterSpan[], overlaySeconds: number): number | null {
  const fileByChapter = matchFilesToChapters(collectNarrationFiles(playlist), chapters);
  if (!fileByChapter) return null;

  const starts = itemTimelineStarts(playlist.items);
  let index = -1;
  for (let candidate = 0; candidate < playlist.items.length; candidate += 1) {
    if (!isPlayable(playlist.items[candidate]!)) continue;
    if (index >= 0 && starts[candidate]! > overlaySeconds) break;
    index = candidate;
  }
  if (index < 0) return null;

  const item = playlist.items[index]!;
  const chapterIndex = [...fileByChapter].find(([, file]) => file.audioHref === item.audioHref)?.[0];
  if (chapterIndex === undefined) return null;

  const secondsIntoItem = Math.max(0, Math.min(item.durationSeconds ?? 0, overlaySeconds - starts[index]!));
  return chapters[chapterIndex]!.startMs / 1000 + item.clipBeginSeconds + secondsIntoItem;
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

function matchFilesToChapters(files: NarrationFile[], chapters: AudioChapterSpan[]): Map<number, NarrationFile> | null {
  if (files.length === 0 || files.length > chapters.length) return null;

  const matched = new Map<number, NarrationFile>();
  let chapterIndex = 0;
  for (const file of files) {
    while (chapterIndex < chapters.length && !chapterFitsFile(chapters[chapterIndex]!, file)) chapterIndex += 1;
    if (chapterIndex === chapters.length) return null;
    matched.set(chapterIndex, file);
    chapterIndex += 1;
  }
  return matched;
}

function chapterFitsFile(chapter: AudioChapterSpan, file: NarrationFile): boolean {
  const overhang = (chapter.endMs - chapter.startMs) / 1000 - file.durationSeconds;
  return overhang >= -MAX_CHAPTER_SHORTFALL_SECONDS && overhang <= MAX_CHAPTER_OVERHANG_SECONDS;
}

function clipEnd(item: EpubMediaOverlayPlaylistItem): number {
  return item.clipEndSeconds ?? item.clipBeginSeconds + (item.durationSeconds ?? 0);
}

function firstPlayableIndex(items: EpubMediaOverlayPlaylistItem[], file: NarrationFile): number {
  for (let index = file.firstItemIndex; index <= file.lastItemIndex; index += 1) {
    if (items[index]!.audioHref === file.audioHref && isPlayable(items[index]!)) return index;
  }
  return file.firstItemIndex;
}

function lastPlayableIndex(items: EpubMediaOverlayPlaylistItem[], file: NarrationFile): number {
  for (let index = file.lastItemIndex; index >= file.firstItemIndex; index -= 1) {
    if (items[index]!.audioHref === file.audioHref && isPlayable(items[index]!)) return index;
  }
  return file.lastItemIndex;
}

function locateInFile(items: EpubMediaOverlayPlaylistItem[], itemStarts: number[], file: NarrationFile, offsetSeconds: number): ReadAlongPosition {
  for (let index = file.firstItemIndex; index <= file.lastItemIndex; index += 1) {
    const item = items[index]!;
    if (item.audioHref !== file.audioHref || !isPlayable(item)) continue;
    if (offsetSeconds < clipEnd(item)) return atItem(items, itemStarts, index, offsetSeconds - item.clipBeginSeconds);
  }
  // Past the last clip: header-inflated MP3s let a player report a few seconds of phantom tail.
  return atItem(items, itemStarts, lastPlayableIndex(items, file), 0);
}

// Kept strictly inside the item: its end is where the next item starts, and a stored position there
// would resume one sentence late.
function atItem(items: EpubMediaOverlayPlaylistItem[], itemStarts: number[], index: number, secondsIntoItem: number): ReadAlongPosition {
  const item = items[index]!;
  const duration = isPlayable(item) ? item.durationSeconds : 0;
  const within = Math.min(Math.max(0, secondsIntoItem), Math.max(0, duration - READ_ALONG_POSITION_EPSILON_SECONDS));
  return { item, overlaySeconds: itemStarts[index]! + within };
}
