import type { EpubMediaOverlayPlaylist, EpubMediaOverlayPlaylistItem } from '@bookorbit/types';
import { describe, expect, it } from 'vitest';

import { buildAudioChapterSpans, itemTimelineStarts, mapAudioPositionToReadAlong } from './read-along-chapter-mapping';

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
});
