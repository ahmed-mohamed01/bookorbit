import { describe, expect, it } from 'vitest';

import {
  absoluteSecondsToFilePosition,
  buildAudioTimeline,
  filePositionToAbsoluteSeconds,
  type AudioTimelineFile,
} from './reading-alignment-audio-timeline.util';

describe('buildAudioTimeline', () => {
  it('assigns cumulative start offsets in the given order without re-sorting', () => {
    const files: AudioTimelineFile[] = [
      { fileId: 30, durationSeconds: 100 },
      { fileId: 10, durationSeconds: 200 },
      { fileId: 20, durationSeconds: 50 },
    ];
    const timeline = buildAudioTimeline(files);
    expect(timeline.entries).toEqual([
      { fileId: 30, startSeconds: 0, durationSeconds: 100 },
      { fileId: 10, startSeconds: 100, durationSeconds: 200 },
      { fileId: 20, startSeconds: 300, durationSeconds: 50 },
    ]);
    expect(timeline.totalSeconds).toBe(350);
    expect(timeline.incomplete).toBe(false);
  });

  it('handles a single-file m4b', () => {
    const timeline = buildAudioTimeline([{ fileId: 1, durationSeconds: 3600 }]);
    expect(timeline.entries).toEqual([{ fileId: 1, startSeconds: 0, durationSeconds: 3600 }]);
    expect(timeline.totalSeconds).toBe(3600);
    expect(timeline.incomplete).toBe(false);
  });

  it('marks the timeline incomplete and treats a null duration as 0', () => {
    const timeline = buildAudioTimeline([
      { fileId: 1, durationSeconds: 100 },
      { fileId: 2, durationSeconds: null },
      { fileId: 3, durationSeconds: 40 },
    ]);
    expect(timeline.incomplete).toBe(true);
    expect(timeline.entries).toEqual([
      { fileId: 1, startSeconds: 0, durationSeconds: 100 },
      { fileId: 2, startSeconds: 100, durationSeconds: 0 },
      { fileId: 3, startSeconds: 100, durationSeconds: 40 },
    ]);
    expect(timeline.totalSeconds).toBe(140);
  });

  it('returns zero values for an empty list', () => {
    const timeline = buildAudioTimeline([]);
    expect(timeline.entries).toEqual([]);
    expect(timeline.totalSeconds).toBe(0);
    expect(timeline.incomplete).toBe(false);
  });
});

describe('absoluteSecondsToFilePosition', () => {
  const timeline = buildAudioTimeline([
    { fileId: 1, durationSeconds: 100 },
    { fileId: 2, durationSeconds: 200 },
    { fileId: 3, durationSeconds: 50 },
  ]);

  it('resolves a position in the middle of the first file', () => {
    expect(absoluteSecondsToFilePosition(timeline, 40)).toEqual({ fileId: 1, positionSeconds: 40 });
  });

  it('resolves a position in the middle of a later file', () => {
    expect(absoluteSecondsToFilePosition(timeline, 150)).toEqual({ fileId: 2, positionSeconds: 50 });
  });

  it('resolves a boundary exactly at a file edge to the start of the next file', () => {
    expect(absoluteSecondsToFilePosition(timeline, 100)).toEqual({ fileId: 2, positionSeconds: 0 });
    expect(absoluteSecondsToFilePosition(timeline, 300)).toEqual({ fileId: 3, positionSeconds: 0 });
  });

  it('clamps a value past the end to the last file end', () => {
    expect(absoluteSecondsToFilePosition(timeline, 9999)).toEqual({ fileId: 3, positionSeconds: 50 });
  });

  it('clamps a value before the start to the first file at 0', () => {
    expect(absoluteSecondsToFilePosition(timeline, -25)).toEqual({ fileId: 1, positionSeconds: 0 });
  });

  it('resolves the exact total to the last file end', () => {
    expect(absoluteSecondsToFilePosition(timeline, 350)).toEqual({ fileId: 3, positionSeconds: 50 });
  });

  it('resolves a single-file m4b anywhere inside it', () => {
    const single = buildAudioTimeline([{ fileId: 7, durationSeconds: 3600 }]);
    expect(absoluteSecondsToFilePosition(single, 1234)).toEqual({ fileId: 7, positionSeconds: 1234 });
    expect(absoluteSecondsToFilePosition(single, 99999)).toEqual({ fileId: 7, positionSeconds: 3600 });
  });

  it('returns a zero sentinel for an empty timeline', () => {
    const empty = buildAudioTimeline([]);
    expect(absoluteSecondsToFilePosition(empty, 42)).toEqual({ fileId: 0, positionSeconds: 0 });
  });
});

describe('filePositionToAbsoluteSeconds', () => {
  const timeline = buildAudioTimeline([
    { fileId: 1, durationSeconds: 100 },
    { fileId: 2, durationSeconds: 200 },
    { fileId: 3, durationSeconds: 50 },
  ]);

  it('maps a file + offset back to an absolute second', () => {
    expect(filePositionToAbsoluteSeconds(timeline, 1, 40)).toBe(40);
    expect(filePositionToAbsoluteSeconds(timeline, 2, 50)).toBe(150);
    expect(filePositionToAbsoluteSeconds(timeline, 3, 50)).toBe(350);
  });

  it('clamps an offset beyond the file duration', () => {
    expect(filePositionToAbsoluteSeconds(timeline, 2, 9999)).toBe(300);
  });

  it('clamps a negative offset to the file start', () => {
    expect(filePositionToAbsoluteSeconds(timeline, 2, -5)).toBe(100);
  });

  it('returns 0 for an unknown file', () => {
    expect(filePositionToAbsoluteSeconds(timeline, 999, 10)).toBe(0);
  });
});

describe('round-trip', () => {
  const timeline = buildAudioTimeline([
    { fileId: 1, durationSeconds: 137 },
    { fileId: 2, durationSeconds: 211 },
    { fileId: 3, durationSeconds: 59 },
    { fileId: 4, durationSeconds: 400 },
  ]);

  it('recovers the original absolute second within tolerance', () => {
    for (const x of [0, 1, 50, 137, 200, 347, 348, 400, 606, 806]) {
      const pos = absoluteSecondsToFilePosition(timeline, x);
      const back = filePositionToAbsoluteSeconds(timeline, pos.fileId, pos.positionSeconds);
      expect(Math.abs(back - x)).toBeLessThanOrEqual(1e-9);
    }
  });
});
