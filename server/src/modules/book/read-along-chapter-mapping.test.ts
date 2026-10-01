import type { EpubMediaOverlayPlaylist, EpubMediaOverlayPlaylistItem } from '@bookorbit/types';
import { describe, expect, it } from 'vitest';

import {
  audioFileStartsSeconds,
  buildAudioChapterSpans,
  describeChapterMismatch,
  itemTimelineStarts,
  mapAudioPositionToReadAlong,
  mapReadAlongPositionToAudio,
} from './read-along-chapter-mapping';

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

describe('buildAudioChapterSpans', () => {
  it('orders chapters and ends the last one at the audio total', () => {
    expect(buildAudioChapterSpans([{ startMs: 5000 }, { startMs: 0 }], 12.5)).toEqual([
      { startMs: 0, endMs: 5000 },
      { startMs: 5000, endMs: 12500 },
    ]);
  });
});

describe('mapAudioPositionToReadAlong', () => {
  // Evershore shape: opening and closing credits carry no narration file, so the read-along timeline
  // starts 30 s later than the audiobook's.
  const creditsChapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 30_000 }, { startMs: 40_000 }, { startMs: 100_000 }], 120);
  const creditsPlaylist = makePlaylist([
    { href: 'a/00001-00002.mp4', clips: [4, 6] },
    { href: 'a/00001-00003.mp4', clips: [10, 10, 20, 20] },
  ]);

  it('lands on the clip covering the offset inside the matching chapter file', () => {
    // 55 s is 15 s into the third chapter, inside its second clip (10-20 s).
    const position = mapAudioPositionToReadAlong(creditsPlaylist, creditsChapters, 55);

    expect(position?.item.textFragment).toBe('c1-s1');
    // Read-along timeline: 10 s of the first file, then 15 s into the second.
    expect(position?.overlaySeconds).toBe(25);
  });

  it('does not smear skipped chapters across the book the way a whole-book stretch does', () => {
    const stretched = 55 * ((creditsPlaylist.durationSeconds ?? 0) / 120);
    const position = mapAudioPositionToReadAlong(creditsPlaylist, creditsChapters, 55);

    expect(stretched).toBeCloseTo(32.08, 1);
    expect(position?.overlaySeconds).toBe(25);
  });

  it('starts at the first narration for a position inside unnarrated opening credits', () => {
    const position = mapAudioPositionToReadAlong(creditsPlaylist, creditsChapters, 12);

    expect(position?.item.textFragment).toBe('c0-s0');
    expect(position?.overlaySeconds).toBe(0);
  });

  it('resumes the last sentence for a position inside unnarrated closing credits', () => {
    const position = mapAudioPositionToReadAlong(creditsPlaylist, creditsChapters, 110);

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
    const position = mapAudioPositionToReadAlong(mp3Playlist, mp3Chapters, 102.6 + 45);

    expect(position?.item.textFragment).toBe('c1-s1');
    expect(position?.overlaySeconds).toBeCloseTo(145, 6);
  });

  it('resumes the last sentence of the file for a phantom tail past its last clip', () => {
    const position = mapAudioPositionToReadAlong(mp3Playlist, mp3Chapters, 101.5);

    expect(position?.item.textFragment).toBe('c0-s1');
    expect(position?.overlaySeconds).toBe(50);
  });

  it('stays inside the clip at its very end, where the next sentence starts', () => {
    const position = mapAudioPositionToReadAlong(mp3Playlist, mp3Chapters, 49.9999999);

    expect(position?.item.textFragment).toBe('c0-s0');
    expect(position?.overlaySeconds).toBeLessThan(itemTimelineStarts(mp3Playlist.items)[1]!);
  });

  it('never lands on a zero-length clip', () => {
    const playlist = makePlaylist([{ href: 'a.mp4', clips: [10, 0, 20] }]);
    playlist.items[2]!.clipBeginSeconds = 10;
    playlist.items[2]!.clipEndSeconds = 30;
    playlist.items[1]!.clipBeginSeconds = 10;
    playlist.items[1]!.clipEndSeconds = 10;

    const position = mapAudioPositionToReadAlong(playlist, buildAudioChapterSpans([{ startMs: 0 }], 30), 10);

    expect(position?.item.textFragment).toBe('c0-s2');
    expect(position?.overlaySeconds).toBe(10);
  });

  it('refuses a read-along whose narration does not fit the chapter table', () => {
    const otherAudio = makePlaylist([
      { href: 'x.mp4', clips: [70] },
      { href: 'y.mp4', clips: [10] },
    ]);

    expect(mapAudioPositionToReadAlong(otherAudio, creditsChapters, 55)).toBeNull();
  });

  it('refuses rather than shifting every later file when a mid-book file fits no chapter', () => {
    const chapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 100_000 }, { startMs: 200_000 }, { startMs: 300_000 }], 400);
    const playlist = makePlaylist([
      { href: '1.mp4', clips: [100] },
      { href: '2.mp4', clips: [60] },
      { href: '3.mp4', clips: [100] },
      { href: '4.mp4', clips: [100] },
    ]);

    expect(mapAudioPositionToReadAlong(playlist, chapters, 350)).toBeNull();
  });

  it('refuses when the read-along has more narration files than the audiobook has chapters', () => {
    expect(mapAudioPositionToReadAlong(creditsPlaylist, buildAudioChapterSpans([{ startMs: 0 }], 120), 10)).toBeNull();
  });

  it('maps the real read-along with its chapter 16 outlier when the credits chapters were also dropped', () => {
    const audioSeconds = WITH_CREDITS_STARTS_MS[17]! / 1000 + 400;

    const forward = mapAudioPositionToReadAlong(REAL_PLAYLIST, WITH_CREDITS_CHAPTERS, audioSeconds);

    expect(forward?.item.audioHref).toBe('chapter-17.m4a');
    expect(mapReadAlongPositionToAudio(REAL_PLAYLIST, WITH_CREDITS_CHAPTERS, forward!.overlaySeconds)).toBeCloseTo(audioSeconds, 6);
    expect(mapAudioPositionToReadAlong(REAL_PLAYLIST, WITH_CREDITS_CHAPTERS, 10)?.item.audioHref).toBe('chapter-1.m4a');
  });

  it('maps the real read-along in both directions despite its tolerated chapter 16 outlier', () => {
    const audioSeconds = REAL_CHAPTER_STARTS_MS[16]! / 1000 + 400;

    const forward = mapAudioPositionToReadAlong(REAL_PLAYLIST, REAL_CHAPTERS, audioSeconds);

    expect(forward?.item.audioHref).toBe('chapter-17.m4a');
    expect(mapReadAlongPositionToAudio(REAL_PLAYLIST, REAL_CHAPTERS, forward!.overlaySeconds)).toBeCloseTo(audioSeconds, 6);
  });

  it('rejects an outlier beyond the larger of four seconds and three percent', () => {
    const chapters = buildAudioChapterSpans(
      Array.from({ length: 10 }, (_, index) => ({ startMs: index * 1_000_000 })),
      10_000,
    );
    const playlist = makePlaylist(Array.from({ length: 10 }, (_, index) => ({ href: `${index}.m4a`, clips: [index === 5 ? 1031 : 1000] })));

    expect(mapAudioPositionToReadAlong(playlist, chapters, 5500)).toBeNull();
  });

  it('rejects the tolerant match when fewer than ninety percent of narration files fit exactly', () => {
    const chapters = buildAudioChapterSpans(
      Array.from({ length: 10 }, (_, index) => ({ startMs: index * 100_000 })),
      1000,
    );
    const playlist = makePlaylist(Array.from({ length: 10 }, (_, index) => ({ href: `${index}.m4a`, clips: [index < 2 ? 102 : 100] })));

    expect(mapAudioPositionToReadAlong(playlist, chapters, 250)).toBeNull();
  });

  it('gives no outlier to a read-along with fewer than ten narration files', () => {
    const chapters = buildAudioChapterSpans(
      Array.from({ length: 10 }, (_, index) => ({ startMs: index * 100_000 })),
      1000,
    );
    const playlist = makePlaylist(Array.from({ length: 9 }, (_, index) => ({ href: `${index}.m4a`, clips: [index === 4 ? 102 : 100] })));

    expect(mapAudioPositionToReadAlong(playlist, chapters, 450)).toBeNull();
  });
});

describe('mapReadAlongPositionToAudio', () => {
  const chapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 30_000 }, { startMs: 40_000 }, { startMs: 100_000 }], 120);
  const playlist = makePlaylist([
    { href: 'a/00001-00002.mp4', clips: [4, 6] },
    { href: 'a/00001-00003.mp4', clips: [10, 10, 20, 20] },
  ]);

  it.each([30.5, 34, 45, 55, 72.25, 99])('returns the audiobook time a forward mapping of %s s came from', (audioSeconds) => {
    const forward = mapAudioPositionToReadAlong(playlist, chapters, audioSeconds)!;

    expect(mapReadAlongPositionToAudio(playlist, chapters, forward.overlaySeconds)).toBeCloseTo(audioSeconds, 6);
  });

  it('places a sentence start at the start of its clip within the chapter', () => {
    // c1-s2 starts 20 s into the second file, which narrates the chapter starting at 40 s.
    const start = itemTimelineStarts(playlist.items)[4]!;

    expect(mapReadAlongPositionToAudio(playlist, chapters, start)).toBe(60);
  });

  it('refuses when the narration does not fit the chapter table', () => {
    expect(mapReadAlongPositionToAudio(playlist, buildAudioChapterSpans([{ startMs: 0 }], 120), 5)).toBeNull();
  });

  it('clamps the end of real narration file 16 inside audiobook chapter 16', () => {
    const fileStart = REAL_NARRATION_DURATIONS_SECONDS.slice(0, 15).reduce((sum, duration) => sum + duration, 0);
    const audioSeconds = mapReadAlongPositionToAudio(REAL_PLAYLIST, REAL_CHAPTERS, fileStart + 533);

    expect(audioSeconds).toBeCloseTo(REAL_CHAPTER_STARTS_MS[16]! / 1000 - 0.001, 6);
    expect(audioSeconds).toBeLessThan(REAL_CHAPTER_STARTS_MS[16]! / 1000);
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

  it('pairs narration files with chapters by Storyteller name when durations alone refuse', () => {
    expect(mapAudioPositionToReadAlong(named, chapters, 400)).toBeNull();

    const forward = mapAudioPositionToReadAlong(named, chapters, 400, built);

    expect(forward?.item.audioHref).toBe('Audio/00001-00003.mp4');
    expect(forward?.overlaySeconds).toBeCloseTo(309 + 70, 6);
    expect(mapReadAlongPositionToAudio(named, chapters, forward!.overlaySeconds, built)).toBeCloseTo(400, 6);
  });

  it('clamps a narration file that runs past its named chapter', () => {
    expect(mapReadAlongPositionToAudio(named, chapters, 305, built)).toBeCloseTo(329.999, 6);
  });

  it('falls back to duration matching when a named file strays beyond a moved cut at each end', () => {
    const stray = makePlaylist([
      { href: 'Audio/00001-00002.mp4', clips: [270] },
      { href: 'Audio/00001-00003.mp4', clips: [370] },
    ]);

    expect(mapAudioPositionToReadAlong(stray, chapters, 400, built)).toBeNull();
  });

  it('ignores names from several source files without the audiobook file starts', () => {
    const multi = makePlaylist([
      { href: 'Audio/00001-00002.mp4', clips: [309] },
      { href: 'Audio/00002-00001.mp4', clips: [361] },
    ]);

    expect(mapAudioPositionToReadAlong(multi, chapters, 400, built)).toBeNull();
  });

  it('follows the names when the EPUB narrates a later chapter first', () => {
    const reordered = makePlaylist([
      { href: 'Audio/00001-00003.mp4', clips: [361] },
      { href: 'Audio/00001-00002.mp4', clips: [150, 159] },
    ]);

    expect(mapAudioPositionToReadAlong(reordered, chapters, 400)).toBeNull();
    expect(mapAudioPositionToReadAlong(reordered, chapters, 400, built)?.overlaySeconds).toBeCloseTo(70, 6);
    expect(mapReadAlongPositionToAudio(reordered, chapters, 361 + 10, built)).toBeCloseTo(40, 6);
  });

  it('refuses two narration files named for the same chapter', () => {
    const duplicate = makePlaylist([
      { href: 'Audio/00001-00002.mp4', clips: [300] },
      { href: 'Audio/00001-00002.m4a', clips: [300] },
    ]);

    expect(mapAudioPositionToReadAlong(duplicate, chapters, 400, built)).toBeNull();
  });

  describe('a multi-file audiobook', () => {
    // File 1 holds the credits and chapter 2; file 2 holds chapter 3.
    const fileStarts = { ...built, audioFileStartsSeconds: [0, 330] };

    it('pairs source file N with audio file N and range N with its Nth chapter', () => {
      const multi = makePlaylist([
        { href: 'Audio/00001-00002.mp4', clips: [309] },
        { href: 'Audio/00002-00001.mp4', clips: [361] },
      ]);

      expect(mapAudioPositionToReadAlong(multi, chapters, 400, fileStarts)?.overlaySeconds).toBeCloseTo(309 + 70, 6);
      expect(mapReadAlongPositionToAudio(multi, chapters, 309 + 70, fileStarts)).toBeCloseTo(400, 6);
    });

    it('falls back to durations for a read-along whose source files were numbered out of track order', () => {
      const scrambled = makePlaylist([
        { href: 'Audio/00002-00001.mp4', clips: [309] },
        { href: 'Audio/00001-00002.mp4', clips: [361] },
      ]);

      expect(mapAudioPositionToReadAlong(scrambled, chapters, 400, fileStarts)).toBeNull();
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
    const forward = mapAudioPositionToReadAlong(playlist, chapters, 340, built);

    expect(forward?.item.index).toBe(3);
    expect(forward?.overlaySeconds).toBeCloseTo(11 + 309 + 10, 6);
    expect(mapAudioPositionToReadAlong(playlist, chapters, 690, built)?.item.index).toBe(3);
  });

  it('names nothing for a read-along with other file names', () => {
    const plain = makePlaylist([
      { href: 'Audio/chapter-2.mp4', clips: [309] },
      { href: 'Audio/chapter-3.mp4', clips: [361] },
    ]);

    expect(mapAudioPositionToReadAlong(plain, chapters, 400, built)).toBeNull();
  });
});

describe('describeChapterMismatch', () => {
  it('identifies chapter 16 as the first mismatch in the real read-along', () => {
    expect(describeChapterMismatch(REAL_PLAYLIST, REAL_CHAPTERS)).toEqual({
      narrationFiles: 50,
      chapters: 50,
      firstMismatch: 16,
      chapterSeconds: 529.23,
      narrationSeconds: 535,
    });
  });

  it('names the real culprit when earlier chapters were dropped as credits', () => {
    expect(describeChapterMismatch(REAL_PLAYLIST, WITH_CREDITS_CHAPTERS)).toMatchObject({
      narrationFiles: 50,
      chapters: 52,
      firstMismatch: 16,
      chapterSeconds: 529.23,
      narrationSeconds: 535,
    });
  });

  it('returns null mismatch details when every narration file fits', () => {
    const playlist = makePlaylist([
      { href: '1.m4a', clips: [100] },
      { href: '2.m4a', clips: [100] },
    ]);
    const chapters = buildAudioChapterSpans([{ startMs: 0 }, { startMs: 100_000 }], 200);

    expect(describeChapterMismatch(playlist, chapters)).toEqual({
      narrationFiles: 2,
      chapters: 2,
      firstMismatch: null,
      chapterSeconds: null,
      narrationSeconds: null,
    });
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
