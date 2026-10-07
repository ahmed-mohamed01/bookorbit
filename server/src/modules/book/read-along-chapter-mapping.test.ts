import type { EpubMediaOverlayPlaylist, EpubMediaOverlayPlaylistItem } from '@bookorbit/types';
import { describe, expect, it } from 'vitest';

import {
  type AudioChapterSpan,
  audioFileStartsSeconds,
  buildAudioChapterSpans,
  buildNarrationChapterSpans,
  itemTimelineStarts,
  mapAudioPositionWithOffsets,
  mapReadAlongPositionWithOffsets,
  matchNarrationRuns,
  narrationSignature,
  type ReadAlongMappingOptions,
} from './read-along-chapter-mapping';
import type { NarrationFileOffset } from './read-along-offsets-store';

/** One narration file per entry, each covered back to back by clips of the given lengths. */
function makePlaylist(files: { href: string; clips: number[] }[]): EpubMediaOverlayPlaylist {
  const items: EpubMediaOverlayPlaylistItem[] = [];
  files.forEach((file, sectionIndex) => {
    let begin = 0;
    file.clips.forEach((length, clipIndex) => {
      items.push({
        index: items.length,
        sectionIndex,
        smilHref: `s${sectionIndex}.smil`,
        textHref: `c${sectionIndex}.xhtml`,
        textFragment: `c${sectionIndex}-s${clipIndex}`,
        audioHref: file.href,
        audioMimeType: 'audio/mp4',
        clipBeginSeconds: begin,
        clipEndSeconds: begin + length,
        durationSeconds: length,
        label: null,
      });
      begin += length;
    });
  });
  const durationSeconds = items.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0);
  return { bookId: 1, fileId: 1, durationSeconds, items, sections: [], resources: [] };
}

const REAL_CHAPTER_STARTS_MS = [
  0, 1231450, 4028711, 6642721, 8711573, 10909573, 12208544, 14545168, 16809207, 18548242, 19870433, 20983783, 22379720, 23727639, 25358469, 26734901,
  27264131, 28274338, 29603355, 30052847, 30507772, 31255966, 33070605, 35472710, 37669457, 37968530, 38991880, 41566276, 42992863, 44236803,
  45580542, 47818481, 49790737, 51310391, 52560042, 54734544, 57207609, 59583150, 61403501, 63417182, 65005520, 66790438, 67839283, 68766084,
  70719672, 71560141, 73244285, 77811185, 79263547, 80673602,
];
const REAL_NARRATION_DURATIONS_SECONDS = [
  1231.447, 2797.261, 2614.011, 2068.898, 2198, 1298.972, 2336.624, 2264.085, 1739.035, 1322.237, 1113.35, 1395.937, 1347.965, 1630.83, 1376.432, 535,
  1010.207, 1329.017, 449.492, 454.925, 748.241, 1814.639, 2402.152, 2196.793, 299.119, 1023.396, 2574.396, 1426.588, 1243.94, 1343.785, 2237.939,
  1972.257, 1519.701, 1249.651, 2174.502, 2473.112, 2375.587, 1820.351, 2013.681, 1588.384, 1784.964, 1048.845, 926.801, 1953.589, 840.469, 1684.191,
  4566.9, 1452.363, 1410.055, 765.237,
];
const REAL_CHAPTERS = buildAudioChapterSpans(
  REAL_CHAPTER_STARTS_MS.map((startMs) => ({ startMs })),
  81439,
);
// The same book with the opening and closing credits chapters Storyteller drops.
const WITH_CREDITS_STARTS_MS = [0, ...REAL_CHAPTER_STARTS_MS.map((startMs) => startMs + 45_000), 81_484_000];
const WITH_CREDITS_CHAPTERS = buildAudioChapterSpans(
  WITH_CREDITS_STARTS_MS.map((startMs) => ({ startMs })),
  81_544,
);
const REAL_PLAYLIST = makePlaylist(
  REAL_NARRATION_DURATIONS_SECONDS.map((duration, index) => ({ href: `chapter-${index + 1}.m4a`, clips: [duration] })),
);

function offsetsOf(
  playlist: EpubMediaOverlayPlaylist,
  chapters: AudioChapterSpan[],
  options?: ReadAlongMappingOptions,
): NarrationFileOffset[] | null {
  const match = matchNarrationRuns(playlist, chapters, options);
  return 'offsets' in match ? match.offsets : null;
}

function forward(playlist: EpubMediaOverlayPlaylist, chapters: AudioChapterSpan[], audioSeconds: number, options?: ReadAlongMappingOptions) {
  const offsets = offsetsOf(playlist, chapters, options);
  return offsets ? mapAudioPositionWithOffsets(playlist, offsets, audioSeconds) : null;
}

function reverse(playlist: EpubMediaOverlayPlaylist, chapters: AudioChapterSpan[], overlaySeconds: number, options?: ReadAlongMappingOptions) {
  const offsets = offsetsOf(playlist, chapters, options);
  return offsets ? mapReadAlongPositionWithOffsets(playlist, offsets, overlaySeconds) : null;
}

/** Chapter spans laid end to end from their lengths in seconds, starting at 0. */
function chaptersFromLengths(lengths: number[]): { chapters: AudioChapterSpan[]; startsSeconds: number[]; totalSeconds: number } {
  const starts: number[] = [];
  let elapsedMs = 0;
  for (const length of lengths) {
    starts.push(elapsedMs);
    elapsedMs += Math.round(length * 1000);
  }
  const totalSeconds = elapsedMs / 1000;
  return {
    chapters: buildAudioChapterSpans(
      starts.map((startMs) => ({ startMs })),
      totalSeconds,
    ),
    startsSeconds: starts.map((startMs) => startMs / 1000),
    totalSeconds,
  };
}

function playlistFromLengths(lengths: number[], name: (index: number) => string = (index) => `Audio/part-${index + 1}.mp4`) {
  return makePlaylist(lengths.map((length, index) => ({ href: name(index), clips: [length] })));
}

describe('buildAudioChapterSpans', () => {
  it('orders chapters and ends the last one at the audio total', () => {
    expect(buildAudioChapterSpans([{ startMs: 5000 }, { startMs: 0 }], 12.5)).toEqual([
      { startMs: 0, endMs: 5000 },
      { startMs: 5000, endMs: 12500 },
    ]);
  });

  it('spans the whole audio with one chapter when the book has no chapter table', () => {
    expect(buildNarrationChapterSpans([], 22875)).toEqual([{ startMs: 0, endMs: 22_875_000 }]);
    expect(buildNarrationChapterSpans([{ startMs: 0 }], 10)).toEqual([{ startMs: 0, endMs: 10_000 }]);
  });
});

describe('narrationSignature', () => {
  it('lists each narration file once in playlist order with its last clip end', () => {
    const playlist = makePlaylist([
      { href: 'b.mp4', clips: [4, 6] },
      { href: 'a.mp4', clips: [10] },
    ]);

    expect(narrationSignature(playlist)).toEqual([
      { audioHref: 'b.mp4', durationSeconds: 10 },
      { audioHref: 'a.mp4', durationSeconds: 10 },
    ]);
  });
});

describe('matchNarrationRuns on real library shapes', () => {
  it('folds chapters into one file, splits chapters over files and drops end credits (Elantris)', () => {
    const middle = Array.from({ length: 67 }, (_, index) => 1000 + ((index * 37) % 500) + 0.3);
    const lengths = [16.4, 13, 166.1, 900, 1100, 6, 2029.2, ...middle, 3.9, 2884.1, 1500, 36.5];
    const { chapters, startsSeconds } = chaptersFromLengths(lengths);
    expect(chapters).toHaveLength(78);

    // Chapters 8..74 narrate one file each, except two that Storyteller split for length.
    const middleFiles = middle.flatMap((length, index) => (index === 32 || index === 52 ? [600, length - 600 - 0.1] : [length - 0.1]));
    const files = [195.7, 899.9, 1099.9, 2035.1, ...middleFiles, 597.9, 412.3, 1370.4, 507.4, 1499.9];
    expect(files).toHaveLength(78);
    const playlist = playlistFromLengths(files);

    const offsets = offsetsOf(playlist, chapters)!;

    expect(offsets).toHaveLength(78);
    expect(offsets[0]!.startSeconds).toBe(0);
    expect(offsets[3]!.startSeconds).toBeCloseTo(startsSeconds[5]!, 6);
    expect(offsets[4]!.startSeconds).toBeCloseTo(startsSeconds[7]!, 6);
    // Four files narrate chapters 75 and 76 back to back.
    const run = 4 + middleFiles.length;
    expect(offsets[run]!.startSeconds).toBeCloseTo(startsSeconds[74]!, 6);
    expect(offsets[run + 1]!.startSeconds).toBeCloseTo(startsSeconds[74]! + 597.9, 6);
    expect(offsets[run + 3]!.startSeconds).toBeCloseTo(startsSeconds[74]! + 597.9 + 412.3 + 1370.4, 6);
    expect(offsets[77]!.startSeconds).toBeCloseTo(startsSeconds[76]!, 6);

    expect(mapAudioPositionWithOffsets(playlist, offsets, startsSeconds[74]! + 600)?.item.audioHref).toBe(`Audio/part-${run + 2}.mp4`);
    // The dropped end credits stay on the last sentence.
    expect(mapAudioPositionWithOffsets(playlist, offsets, startsSeconds[77]! + 20)?.item.audioHref).toBe('Audio/part-78.mp4');
  });

  it('places chapters split over two and three files, the last within its per-file rounding (Arcanum Unbounded)', () => {
    const lengths = [3000, 4000, 14272.3, 5000, 14000, 5100, 5200, 14100, 5300, 14200, 5400, 14300, 5500, 5600, 5700, 18354.0];
    const { chapters, startsSeconds } = chaptersFromLengths(lengths);
    const split = (length: number) => [7200, length - 7200 - 0.1];
    const files = [
      2999.8,
      3999.8,
      7196.6,
      7075.7,
      4999.8,
      ...split(14000),
      5099.8,
      5199.8,
      ...split(14100),
      5299.8,
      ...split(14200),
      5399.8,
      ...split(14300),
      5499.8,
      5599.8,
      5699.8,
      7197.4,
      7197.4,
      3960.2,
    ];
    expect(files).toHaveLength(23);
    const playlist = playlistFromLengths(files);

    const offsets = offsetsOf(playlist, chapters)!;

    expect(offsets[2]!.startSeconds).toBeCloseTo(startsSeconds[2]!, 6);
    expect(offsets[3]!.startSeconds).toBeCloseTo(startsSeconds[2]! + 7196.6, 6);
    expect(offsets[20]!.startSeconds).toBeCloseTo(startsSeconds[15]!, 6);
    expect(offsets[21]!.startSeconds).toBeCloseTo(startsSeconds[15]! + 7197.4, 6);
    expect(offsets[22]!.startSeconds).toBeCloseTo(startsSeconds[15]! + 2 * 7197.4, 6);
  });

  it('chains several files over audio without a chapter table (Shattered Lens)', () => {
    const playlist = playlistFromLengths([7197.3, 7195.1, 7205.1, 1277.4]);

    const offsets = offsetsOf(playlist, buildNarrationChapterSpans([], 22875))!;

    expect(offsets.map((offset) => offset.startSeconds)).toEqual([0, 7197.3, 7197.3 + 7195.1, 7197.3 + 7195.1 + 7205.1]);
  });

  it('places one file over audio without a chapter table that is shorter by rounding (Hope of Elantris)', () => {
    const playlist = playlistFromLengths([2898.4]);

    expect(offsetsOf(playlist, buildNarrationChapterSpans([], 2898))).toEqual([
      { audioHref: 'Audio/part-1.mp4', startSeconds: 0, durationSeconds: 2898.4 },
    ]);
  });

  it('keeps one file per chapter on chapters inflated by MP3 headers (Alcatraz)', () => {
    const lengths = [4578.985, 4528.418, 4435.2, 4610.7, 4499.9];
    const { chapters, startsSeconds } = chaptersFromLengths(lengths);
    const playlist = playlistFromLengths(
      lengths.map((length) => length - 2.6),
      (index) => `Audio/0000${index + 1}-00001.mp3`,
    );

    const offsets = offsetsOf(playlist, chapters)!;

    expect(offsets.map((offset) => offset.startSeconds)).toEqual(startsSeconds);
  });

  it('pairs a built read-along by Storyteller names despite moved cuts and dropped credits (Tress)', () => {
    const lengths = [45, ...Array.from({ length: 69 }, (_, index) => 600 + index * 3), 60];
    const { chapters, startsSeconds } = chaptersFromLengths(lengths);
    // Every other cut moved 9 s, so the durations alone no longer fit.
    const files = lengths.slice(1, 70).map((length, index) => length + (index % 2 === 0 ? 9 : -9));
    const playlist = playlistFromLengths(files, (index) => `OEBPS/Audio/00001-${String(index + 2).padStart(5, '0')}.mp4`);

    expect(offsetsOf(playlist, chapters)).toBeNull();
    const offsets = offsetsOf(playlist, chapters, { builtFromAudio: true, audioFileStartsSeconds: [0] })!;

    expect(offsets).toHaveLength(69);
    expect(offsets.map((offset) => offset.startSeconds)).toEqual(startsSeconds.slice(1, 70));
  });
});

describe('matchNarrationRuns mismatches', () => {
  it('names the first file no run can place and the chapter after the last one used', () => {
    const chapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 100_000 }, { startMs: 200_000 }, { startMs: 300_000 }], 400);
    const playlist = playlistFromLengths([100, 60, 100, 100]);

    expect(matchNarrationRuns(playlist, chapters)).toEqual({ mismatch: { narrationFile: 2, narrationSeconds: 60, chapter: 2, chapterSeconds: 100 } });
  });

  it('counts dropped opening credits before the chapter it names', () => {
    const chapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 30_000 }, { startMs: 130_000 }], 230);
    const playlist = playlistFromLengths([100, 50]);

    expect(matchNarrationRuns(playlist, chapters)).toEqual({ mismatch: { narrationFile: 2, narrationSeconds: 50, chapter: 3, chapterSeconds: 100 } });
  });

  it('refuses a run that outruns its chapters by more than its rounding allowance', () => {
    const { chapters } = chaptersFromLengths([7000, 7000]);
    const playlist = playlistFromLengths([7001.2]);

    expect('mismatch' in matchNarrationRuns(playlist, chapters)).toBe(true);
  });

  it('refuses an empty narration', () => {
    expect('mismatch' in matchNarrationRuns(makePlaylist([]), buildNarrationChapterSpans([], 100))).toBe(true);
  });
});

describe('mapAudioPositionWithOffsets', () => {
  // Evershore shape: opening and closing credits carry no narration file, so the read-along timeline
  // starts 30 s later than the audiobook's.
  const creditsChapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 30_000 }, { startMs: 40_000 }, { startMs: 100_000 }], 120);
  const creditsPlaylist = makePlaylist([
    { href: 'a/00001-00002.mp4', clips: [4, 6] },
    { href: 'a/00001-00003.mp4', clips: [10, 10, 20, 20] },
  ]);

  it('lands on the clip covering the offset inside the matching chapter file', () => {
    // 55 s is 15 s into the third chapter, inside its second clip (10-20 s).
    const position = forward(creditsPlaylist, creditsChapters, 55);

    expect(position?.item.textFragment).toBe('c1-s1');
    // Read-along timeline: 10 s of the first file, then 15 s into the second.
    expect(position?.overlaySeconds).toBe(25);
  });

  it('does not smear skipped chapters across the book the way a whole-book stretch does', () => {
    const stretched = 55 * ((creditsPlaylist.durationSeconds ?? 0) / 120);

    expect(stretched).toBeCloseTo(32.08, 1);
    expect(forward(creditsPlaylist, creditsChapters, 55)?.overlaySeconds).toBe(25);
  });

  it('starts at the first narration for a position inside unnarrated opening credits', () => {
    const position = forward(creditsPlaylist, creditsChapters, 12);

    expect(position?.item.textFragment).toBe('c0-s0');
    expect(position?.overlaySeconds).toBe(0);
  });

  it('resumes the last sentence for a position inside unnarrated closing credits', () => {
    const position = forward(creditsPlaylist, creditsChapters, 110);

    expect(position?.item.textFragment).toBe('c1-s3');
    expect(position?.overlaySeconds).toBe(50);
  });

  // Alcatraz shape: one MP3 per chapter, each chapter a few seconds longer than the narration cut from
  // it because the header duration is inflated.
  const mp3Chapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 102_600 }], 205.1);
  const mp3Playlist = makePlaylist([
    { href: '00001-00001.mp3', clips: [50, 50] },
    { href: '00002-00001.mp3', clips: [40, 60] },
  ]);

  it('matches chapters that outrun their narration file by an inflated header duration', () => {
    const position = forward(mp3Playlist, mp3Chapters, 102.6 + 45);

    expect(position?.item.textFragment).toBe('c1-s1');
    expect(position?.overlaySeconds).toBeCloseTo(145, 6);
  });

  it('waits at the next file for a phantom tail between two files', () => {
    const position = forward(mp3Playlist, mp3Chapters, 101.5);

    expect(position?.item.textFragment).toBe('c1-s0');
    expect(position?.overlaySeconds).toBe(100);
  });

  it('stays inside the clip at its very end, where the next sentence starts', () => {
    const position = forward(mp3Playlist, mp3Chapters, 49.9999999);

    expect(position?.item.textFragment).toBe('c0-s0');
    expect(position?.overlaySeconds).toBeLessThan(itemTimelineStarts(mp3Playlist.items)[1]!);
  });

  it('never lands on a zero-length clip', () => {
    const playlist = makePlaylist([{ href: 'a.mp4', clips: [10, 0, 20] }]);
    playlist.items[2]!.clipBeginSeconds = 10;
    playlist.items[2]!.clipEndSeconds = 30;
    playlist.items[1]!.clipBeginSeconds = 10;
    playlist.items[1]!.clipEndSeconds = 10;

    const position = forward(playlist, buildAudioChapterSpans([{ startMs: 0 }], 30), 10);

    expect(position?.item.textFragment).toBe('c0-s2');
    expect(position?.overlaySeconds).toBe(10);
  });

  it('refuses a read-along whose narration does not fit the chapter table', () => {
    const otherAudio = makePlaylist([
      { href: 'x.mp4', clips: [70] },
      { href: 'y.mp4', clips: [15] },
    ]);

    expect(forward(otherAudio, creditsChapters, 55)).toBeNull();
  });

  it('refuses when the read-along has more narration than the audiobook', () => {
    expect(forward(creditsPlaylist, buildAudioChapterSpans([{ startMs: 0 }], 60), 10)).toBeNull();
  });

  it('maps the real read-along with its chapter 16 outlier when the credits chapters were also dropped', () => {
    const audioSeconds = WITH_CREDITS_STARTS_MS[17]! / 1000 + 400;

    const position = forward(REAL_PLAYLIST, WITH_CREDITS_CHAPTERS, audioSeconds);

    expect(position?.item.audioHref).toBe('chapter-17.m4a');
    expect(reverse(REAL_PLAYLIST, WITH_CREDITS_CHAPTERS, position!.overlaySeconds)).toBeCloseTo(audioSeconds, 6);
    expect(forward(REAL_PLAYLIST, WITH_CREDITS_CHAPTERS, 10)?.item.audioHref).toBe('chapter-1.m4a');
  });

  it('maps the real read-along in both directions despite its tolerated chapter 16 outlier', () => {
    const audioSeconds = REAL_CHAPTER_STARTS_MS[16]! / 1000 + 400;

    const position = forward(REAL_PLAYLIST, REAL_CHAPTERS, audioSeconds);

    expect(position?.item.audioHref).toBe('chapter-17.m4a');
    expect(reverse(REAL_PLAYLIST, REAL_CHAPTERS, position!.overlaySeconds)).toBeCloseTo(audioSeconds, 6);
  });

  it('rejects an outlier beyond the larger of four seconds and three percent', () => {
    const chapters = buildAudioChapterSpans(
      Array.from({ length: 10 }, (_, index) => ({ startMs: index * 1_000_000 })),
      10_000,
    );
    const playlist = makePlaylist(Array.from({ length: 10 }, (_, index) => ({ href: `${index}.m4a`, clips: [index === 5 ? 1031 : 1000] })));

    expect(forward(playlist, chapters, 5500)).toBeNull();
  });

  it('rejects the tolerant match when fewer than ninety percent of narration files fit, even within a run', () => {
    const chapters = buildAudioChapterSpans(
      Array.from({ length: 10 }, (_, index) => ({ startMs: index * 100_000 })),
      1000,
    );
    const playlist = makePlaylist(Array.from({ length: 10 }, (_, index) => ({ href: `${index}.m4a`, clips: [index < 2 ? 103 : 100] })));

    expect(forward(playlist, chapters, 250)).toBeNull();
  });
});

describe('mapReadAlongPositionWithOffsets', () => {
  const chapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 30_000 }, { startMs: 40_000 }, { startMs: 100_000 }], 120);
  const playlist = makePlaylist([
    { href: 'a/00001-00002.mp4', clips: [4, 6] },
    { href: 'a/00001-00003.mp4', clips: [10, 10, 20, 20] },
  ]);

  it.each([30.5, 34, 45, 55, 72.25, 99])('returns the audiobook time a forward mapping of %s s came from', (audioSeconds) => {
    const position = forward(playlist, chapters, audioSeconds)!;

    expect(reverse(playlist, chapters, position.overlaySeconds)).toBeCloseTo(audioSeconds, 6);
  });

  it('places a sentence start at the start of its clip within the chapter', () => {
    // c1-s2 starts 20 s into the second file, which narrates the chapter starting at 40 s.
    expect(reverse(playlist, chapters, itemTimelineStarts(playlist.items)[4]!)).toBe(60);
  });

  it('clamps the end of real narration file 16 before the next file starts', () => {
    const fileStart = REAL_NARRATION_DURATIONS_SECONDS.slice(0, 15).reduce((sum, duration) => sum + duration, 0);
    const audioSeconds = reverse(REAL_PLAYLIST, REAL_CHAPTERS, fileStart + 533);

    expect(audioSeconds).toBeCloseTo(REAL_CHAPTER_STARTS_MS[16]! / 1000 - 0.001, 6);
    expect(audioSeconds).toBeLessThan(REAL_CHAPTER_STARTS_MS[16]! / 1000);
  });

  it('clamps inside the file when no other file follows', () => {
    const offsets = [{ audioHref: 'a.mp4', startSeconds: 10, durationSeconds: 20 }];
    const single = makePlaylist([{ href: 'a.mp4', clips: [20] }]);

    expect(mapReadAlongPositionWithOffsets(single, offsets, 25)).toBeCloseTo(29.999, 6);
  });

  it('refuses a narration file the offsets do not name', () => {
    expect(mapReadAlongPositionWithOffsets(playlist, [{ audioHref: 'other.mp4', startSeconds: 0, durationSeconds: 10 }], 2)).toBeNull();
  });
});

describe('read-along built from this audiobook', () => {
  // Storyteller dropped the opening credits (range 1) and moved the cut between ranges 2 and 3 by 9 s.
  const chapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 30_000 }, { startMs: 330_000 }], 700);
  const named = makePlaylist([
    { href: 'Audio/00001-00002.mp4', clips: [150, 159] },
    { href: 'Audio/00001-00003.mp4', clips: [361] },
  ]);
  const built = { builtFromAudio: true };

  it('anchors each file at its named chapter, where durations alone chain the files of one run', () => {
    expect(forward(named, chapters, 400)?.overlaySeconds).toBeCloseTo(309 + 61, 6);

    const position = forward(named, chapters, 400, built);

    expect(position?.item.audioHref).toBe('Audio/00001-00003.mp4');
    expect(position?.overlaySeconds).toBeCloseTo(309 + 70, 6);
    expect(reverse(named, chapters, position!.overlaySeconds, built)).toBeCloseTo(400, 6);
  });

  it('clamps a narration file that runs past its named chapter', () => {
    expect(reverse(named, chapters, 305, built)).toBeCloseTo(329.999, 6);
  });

  it('refuses when a named file strays beyond a moved cut at each end and durations fit no run', () => {
    const stray = makePlaylist([
      { href: 'Audio/00001-00002.mp4', clips: [270] },
      { href: 'Audio/00001-00003.mp4', clips: [370] },
    ]);

    expect(forward(stray, chapters, 400, built)).toBeNull();
  });

  it('follows the names when the EPUB narrates a later chapter first', () => {
    const reordered = makePlaylist([
      { href: 'Audio/00001-00003.mp4', clips: [361] },
      { href: 'Audio/00001-00002.mp4', clips: [150, 159] },
    ]);

    expect(forward(reordered, chapters, 400, built)?.overlaySeconds).toBeCloseTo(70, 6);
    expect(reverse(reordered, chapters, 361 + 10, built)).toBeCloseTo(40, 6);
  });

  it('refuses two narration files named for the same chapter', () => {
    const duplicate = makePlaylist([
      { href: 'Audio/00001-00002.mp4', clips: [300] },
      { href: 'Audio/00001-00002.m4a', clips: [300] },
    ]);

    expect(forward(duplicate, chapters, 400, built)).toBeNull();
  });

  describe('a multi-file audiobook', () => {
    // File 1 holds the credits and chapter 2; file 2 holds chapter 3.
    const fileStarts = { ...built, audioFileStartsSeconds: [0, 330] };

    it('pairs source file N with audio file N and range N with its Nth chapter', () => {
      const multi = makePlaylist([
        { href: 'Audio/00001-00002.mp4', clips: [309] },
        { href: 'Audio/00002-00001.mp4', clips: [361] },
      ]);

      expect(forward(multi, chapters, 400, fileStarts)?.overlaySeconds).toBeCloseTo(309 + 70, 6);
      expect(reverse(multi, chapters, 309 + 70, fileStarts)).toBeCloseTo(400, 6);
    });

    it('falls back to durations for a read-along whose source files were numbered out of track order', () => {
      const scrambled = makePlaylist([
        { href: 'Audio/00002-00001.mp4', clips: [309] },
        { href: 'Audio/00001-00002.mp4', clips: [361] },
      ]);

      expect(offsetsOf(scrambled, chapters, fileStarts)?.map((offset) => offset.startSeconds)).toEqual([30, 339]);
    });
  });

  it('places a position in a file by audio time when a sentence early in the book borrowed one of its clips', () => {
    // An epigraph aligned to the end of chapter 3's narration plays before chapter 2.
    const playlist = makePlaylist([
      { href: 'Audio/00001-00003.mp4', clips: [361] },
      { href: 'Audio/00001-00002.mp4', clips: [150, 159] },
      { href: 'Audio/00001-00003.mp4', clips: [361] },
    ]);
    playlist.items[0] = { ...playlist.items[0]!, clipBeginSeconds: 350, clipEndSeconds: 361, durationSeconds: 11 };
    const position = forward(playlist, chapters, 340, built);

    expect(position?.item.index).toBe(3);
    expect(position?.overlaySeconds).toBeCloseTo(11 + 309 + 10, 6);
    expect(forward(playlist, chapters, 690, built)?.item.index).toBe(3);
  });

  it('matches other file names by duration alone', () => {
    const plain = makePlaylist([
      { href: 'Audio/chapter-2.mp4', clips: [309] },
      { href: 'Audio/chapter-3.mp4', clips: [361] },
    ]);

    expect(offsetsOf(plain, chapters, built)?.map((offset) => offset.startSeconds)).toEqual([30, 339]);
  });
});

describe('audioFileStartsSeconds', () => {
  it('snaps rounded file starts onto the chapter table, without the rounding piling up', () => {
    // Alcatraz: whole-second stored durations against millisecond chapter starts.
    expect(audioFileStartsSeconds([4579, 4528, 4435], [0, 4_578_985, 9_107_403])).toEqual([0, 4578.985, 9107.403]);
  });

  it('keeps summed starts where no chapter starts near a file', () => {
    expect(audioFileStartsSeconds([100, 100], [0, 30_000])).toEqual([0, 100]);
  });
});
