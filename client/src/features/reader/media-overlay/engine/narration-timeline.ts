import type { EpubMediaOverlayPlaylist } from '@bookorbit/types'
import { mediaOverlayItemFragment } from '../lib/media-overlay-resume'

export interface NarrationClip {
  index: number
  sectionIndex: number
  text: string
  href: string
  begin: number
  // Null when the clip runs on to the end of its file.
  end: number | null
  segment: number
}

// A run of clips that play back to back in one file, so the element plays it without a seek.
export interface NarrationSegment {
  index: number
  href: string
  begin: number
  end: number | null
  first: number
  last: number
  start: number
  duration: number
}

// Within this much of the previous clip's end, the next clip in the same file plays on without a seek.
const CONTINUOUS_AHEAD_SECONDS = 0.5
const CONTINUOUS_BEHIND_SECONDS = 1

function isContinuous(previous: NarrationClip, clip: NarrationClip): boolean {
  if (previous.href !== clip.href || previous.end === null) return false
  return clip.begin <= previous.end + CONTINUOUS_AHEAD_SECONDS && clip.begin >= previous.end - CONTINUOUS_BEHIND_SECONDS
}

function lastAtOrBefore<T>(list: T[], value: number, key: (entry: T) => number, from = 0, to = list.length - 1): number {
  let low = from
  let high = to
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (key(list[mid]!) <= value) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  return found
}

// The whole book's narration on one clock, built from the server playlist: segments sit end to
// end, so any book position maps to a file and a time in it, and any clip to a book position.
export class NarrationTimeline {
  readonly clips: NarrationClip[] = []
  readonly segments: NarrationSegment[] = []
  readonly sizes = new Map<string, number>()
  #sections = new Map<number, { first: number; last: number }>()
  #fileDurations = new Map<string, number>()
  #declaredDuration: number | null

  constructor(playlist: EpubMediaOverlayPlaylist) {
    this.#declaredDuration = playlist.durationSeconds
    for (const resource of playlist.resources) this.sizes.set(resource.href, resource.size)

    const items = playlist.items.filter((item) => item.textHref && item.audioHref)
    items.forEach((item, i) => {
      const next = items[i + 1]
      const runsInto = next && next.audioHref === item.audioHref && next.clipBeginSeconds >= item.clipBeginSeconds
      const clip: NarrationClip = {
        index: this.clips.length,
        sectionIndex: item.sectionIndex,
        text: mediaOverlayItemFragment(item)!,
        href: item.audioHref,
        begin: item.clipBeginSeconds,
        end: item.clipEndSeconds ?? (runsInto ? next.clipBeginSeconds : null),
        segment: 0,
      }
      const previous = this.clips.at(-1)
      const segment = this.segments.at(-1)
      if (previous && segment && isContinuous(previous, clip)) {
        segment.last = clip.index
        segment.end = clip.end
      } else {
        this.segments.push({
          index: this.segments.length,
          href: clip.href,
          begin: clip.begin,
          end: clip.end,
          first: clip.index,
          last: clip.index,
          start: 0,
          duration: 0,
        })
      }
      clip.segment = this.segments.length - 1
      this.clips.push(clip)

      const section = this.#sections.get(clip.sectionIndex)
      if (section) section.last = clip.index
      else this.#sections.set(clip.sectionIndex, { first: clip.index, last: clip.index })
    })
    this.#layout()
  }

  get duration(): number {
    const last = this.segments.at(-1)
    return last ? last.start + last.duration : 0
  }

  // A segment that runs to the end of its file has no known length until the file is opened.
  // Until then the book's declared length is shared out among them.
  #layout() {
    const open = new Set(this.segments.filter((segment) => segment.end === null && !this.#fileDurations.has(segment.href)))
    const known = this.segments.reduce((sum, segment) => (open.has(segment) ? sum : sum + this.#knownDuration(segment)), 0)
    const estimate = open.size > 0 && this.#declaredDuration !== null ? Math.max(0, this.#declaredDuration - known) / open.size : 0
    let start = 0
    for (const segment of this.segments) {
      segment.start = start
      segment.duration = open.has(segment) ? estimate : this.#knownDuration(segment)
      start += segment.duration
    }
  }

  #knownDuration(segment: NarrationSegment): number {
    const end = segment.end ?? this.#fileDurations.get(segment.href) ?? segment.begin
    return Math.max(0, end - segment.begin)
  }

  // Returns true when the clock moved, so positions shown from it are stale.
  setFileDuration(href: string, seconds: number): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0 || this.#fileDurations.get(href) === seconds) return false
    if (!this.segments.some((segment) => segment.href === href && segment.end === null)) return false
    this.#fileDurations.set(href, seconds)
    this.#layout()
    return true
  }

  // The time in the segment's file where it stops playing.
  segmentEnd(segment: NarrationSegment): number | null {
    return segment.end ?? this.#fileDurations.get(segment.href) ?? null
  }

  clipStart(clip: NarrationClip): number {
    const segment = this.segments[clip.segment]!
    return segment.start + clip.begin - segment.begin
  }

  position(segment: NarrationSegment, fileTime: number): number {
    return segment.start + Math.min(Math.max(fileTime - segment.begin, 0), segment.duration)
  }

  // The clip being spoken at `fileTime` in this segment: the last one that has begun.
  clipIn(segment: NarrationSegment, fileTime: number): NarrationClip {
    const index = lastAtOrBefore(this.clips, fileTime, (clip) => clip.begin, segment.first, segment.last)
    return this.clips[index < 0 ? segment.first : index]!
  }

  locate(seconds: number): { segment: NarrationSegment; fileTime: number } | null {
    if (this.segments.length === 0) return null
    const t = Math.min(Math.max(seconds, 0), this.duration)
    const index = Math.max(
      0,
      lastAtOrBefore(this.segments, t, (segment) => segment.start),
    )
    // A segment with no length shares its start with the next, which is the one that plays.
    let segment = this.segments[index]!
    while (segment.duration === 0 && this.segments[segment.index + 1]?.start === segment.start) segment = this.segments[segment.index + 1]!
    return { segment, fileTime: segment.begin + Math.min(t - segment.start, segment.duration) }
  }

  sectionClips(sectionIndex: number): NarrationClip[] {
    const range = this.#sections.get(sectionIndex)
    return range ? this.clips.slice(range.first, range.last + 1) : []
  }

  // The first section from `sectionIndex` on that has narration.
  sectionAtOrAfter(sectionIndex: number): number | null {
    let best: number | null = null
    for (const index of this.#sections.keys()) if (index >= sectionIndex && (best === null || index < best)) best = index
    return best
  }

  // The next segment that plays from another file, and how far into the book it starts.
  nextFile(segment: NarrationSegment): NarrationSegment | null {
    for (let i = segment.index + 1; i < this.segments.length; i++) {
      if (this.segments[i]!.href !== segment.href) return this.segments[i]!
    }
    return null
  }
}
