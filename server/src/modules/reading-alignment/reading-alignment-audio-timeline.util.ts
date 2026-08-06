export type AudioTimelineFile = {
  fileId: number;
  durationSeconds: number | null;
};

export interface AudioTimelineEntry {
  fileId: number;
  // Cumulative absolute second at which this file begins.
  startSeconds: number;
  // Effective duration used for the timeline (a null source duration contributes 0).
  durationSeconds: number;
}

export interface AudioTimeline {
  entries: AudioTimelineEntry[];
  totalSeconds: number;
  // True when any file had a null (unknown) duration. The resulting offsets are unreliable and a
  // caller should treat the timeline as incomplete before trusting absolute-to-file mapping.
  incomplete: boolean;
}

// Files arrive already in play order; this preserves that order and never re-sorts.
export function buildAudioTimeline(files: AudioTimelineFile[]): AudioTimeline {
  const entries: AudioTimelineEntry[] = [];
  let cumulative = 0;
  let incomplete = false;
  for (const file of files) {
    if (file.durationSeconds == null) incomplete = true;
    const dur = file.durationSeconds ?? 0;
    entries.push({ fileId: file.fileId, startSeconds: cumulative, durationSeconds: dur });
    cumulative += dur;
  }
  return { entries, totalSeconds: cumulative, incomplete };
}

// Maps an absolute book-wide second to a specific file and in-file offset. Mirrors resolveAbsPosition:
// clamps to [0, total], a value past the end resolves to the last file's end, before 0 resolves to the
// first file at 0.
export function absoluteSecondsToFilePosition(timeline: AudioTimeline, absSeconds: number): { fileId: number; positionSeconds: number } {
  const entries = timeline.entries;
  if (entries.length === 0) return { fileId: 0, positionSeconds: 0 };
  const target = Math.max(0, absSeconds);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const isLast = i === entries.length - 1;
    if (target < entry.startSeconds + entry.durationSeconds || isLast) {
      return {
        fileId: entry.fileId,
        positionSeconds: Math.max(0, Math.min(target - entry.startSeconds, entry.durationSeconds)),
      };
    }
  }
  const last = entries[entries.length - 1]!;
  return { fileId: last.fileId, positionSeconds: last.durationSeconds };
}

// Inverse of absoluteSecondsToFilePosition: maps a file + in-file offset back to an absolute second.
// An unknown file resolves to 0; the offset is clamped to the file's own [0, duration] range.
export function filePositionToAbsoluteSeconds(timeline: AudioTimeline, fileId: number, positionSeconds: number): number {
  const entry = timeline.entries.find((e) => e.fileId === fileId);
  if (!entry) return 0;
  const clamped = Math.max(0, Math.min(positionSeconds, entry.durationSeconds));
  return entry.startSeconds + clamped;
}
