import { describe, expect, it } from 'vitest'
import type { EpubMediaOverlayPlaylist, EpubMediaOverlayPlaylistItem } from '@bookorbit/types'
import { NarrationTimeline } from './narration-timeline'

type ItemSpec = [sectionIndex: number, text: string, audio: string, begin: number, end: number | null]

function playlist(specs: ItemSpec[], durationSeconds: number | null = null): EpubMediaOverlayPlaylist {
  const items: EpubMediaOverlayPlaylistItem[] = specs.map(([sectionIndex, text, audio, begin, end], index) => {
    const [textHref, textFragment] = text.split('#')
    return {
      index,
      sectionIndex,
      smilHref: `s${sectionIndex}.smil`,
      textHref: textHref!,
      textFragment: textFragment ?? null,
      audioHref: audio,
      audioMimeType: 'audio/mp4',
      clipBeginSeconds: begin,
      clipEndSeconds: end,
      durationSeconds: end === null ? null : end - begin,
      label: null,
    }
  })
  const resources = [...new Set(specs.map((spec) => spec[2]))].map((href) => ({ href, mediaType: 'audio/mp4', size: 1000 }))
  return { bookId: 1, fileId: 1, durationSeconds, items, sections: [], resources }
}

// Storyteller cuts a file at the silence after the next chapter's title, so chapter 11's title is
// spoken at the end of chapter 10's file.
const storyteller = playlist([
  [3, 'c10.xhtml#s1', 'a10.mp4', 0, 10],
  [3, 'c10.xhtml#s2', 'a10.mp4', 10, 20],
  [4, 'c11.xhtml#title', 'a10.mp4', 20, 23],
  [4, 'c11.xhtml#b1', 'a11.mp4', 0, 10],
  [4, 'c11.xhtml#b2', 'a11.mp4', 10, 20],
  [6, 'c12.xhtml#x1', 'a12.mp4', 0, 5],
])

describe('narration timeline', () => {
  it('keeps a chapter title spoken at the end of the previous file in that file', () => {
    const timeline = new NarrationTimeline(storyteller)
    expect(timeline.segments.map((s) => [s.href, s.start, s.duration])).toEqual([
      ['a10.mp4', 0, 23],
      ['a11.mp4', 23, 20],
      ['a12.mp4', 43, 5],
    ])
    expect(timeline.duration).toBe(48)
    expect(timeline.sectionClips(4).map((clip) => clip.text)).toEqual(['c11.xhtml#title', 'c11.xhtml#b1', 'c11.xhtml#b2'])
  })

  it('maps book positions to files and back', () => {
    const timeline = new NarrationTimeline(storyteller)
    const at = timeline.locate(30)!
    expect(at.segment.href).toBe('a11.mp4')
    expect(at.fileTime).toBe(7)
    expect(timeline.clipIn(at.segment, at.fileTime).text).toBe('c11.xhtml#b1')
    expect(timeline.clipStart(timeline.clips[4]!)).toBe(33)
    expect(timeline.position(at.segment, 12)).toBe(35)
    expect(timeline.locate(1000)!.fileTime).toBe(5)
    expect(timeline.locate(-5)!.fileTime).toBe(0)
  })

  it('finds the first narrated section from a section without narration', () => {
    const timeline = new NarrationTimeline(storyteller)
    expect(timeline.sectionAtOrAfter(5)).toBe(6)
    expect(timeline.sectionAtOrAfter(0)).toBe(3)
    expect(timeline.sectionAtOrAfter(7)).toBeNull()
    expect(timeline.sectionClips(5)).toEqual([])
  })

  it('splits a chapter that spans several files', () => {
    const timeline = new NarrationTimeline(
      playlist([
        [2, 'c.xhtml#a', 'p1.mp3', 100, 110],
        [2, 'c.xhtml#b', 'p1.mp3', 110, 120],
        [2, 'c.xhtml#c', 'p2.mp3', 0, 8],
      ]),
    )
    expect(timeline.segments.map((s) => [s.href, s.begin, s.start, s.duration])).toEqual([
      ['p1.mp3', 100, 0, 20],
      ['p2.mp3', 0, 20, 8],
    ])
    expect(timeline.nextFile(timeline.segments[0]!)?.href).toBe('p2.mp3')
    expect(timeline.nextFile(timeline.segments[1]!)).toBeNull()
  })

  it('seeks rather than plays through a jump inside one file', () => {
    const timeline = new NarrationTimeline(
      playlist([
        [1, 'c.xhtml#a', 'f.mp3', 0, 10],
        [1, 'c.xhtml#b', 'f.mp3', 30, 40],
        [1, 'c.xhtml#c', 'f.mp3', 40.3, 45],
      ]),
    )
    expect(timeline.segments.map((s) => [s.begin, s.end, s.first, s.last])).toEqual([
      [0, 10, 0, 0],
      [30, 45, 1, 2],
    ])
    expect(timeline.duration).toBe(25)
  })

  it('runs a clip with no end on to the next clip, or to the end of its file once that is known', () => {
    const timeline = new NarrationTimeline(
      playlist(
        [
          [1, 'a.xhtml#1', 'a.mp3', 0, null],
          [1, 'a.xhtml#2', 'a.mp3', 4, null],
          [2, 'b.xhtml#1', 'b.mp3', 0, 6],
        ],
        30,
      ),
    )
    expect(timeline.clips.map((clip) => clip.end)).toEqual([4, null, 6])
    expect(timeline.segments[0]!.end).toBeNull()
    // Until the file is opened its length is what the book declares beyond the known clips.
    expect(timeline.segments[0]!.duration).toBe(24)
    expect(timeline.segmentEnd(timeline.segments[0]!)).toBeNull()

    expect(timeline.setFileDuration('a.mp3', 20)).toBe(true)
    expect(timeline.segments[0]!.duration).toBe(20)
    expect(timeline.segments[1]!.start).toBe(20)
    expect(timeline.segmentEnd(timeline.segments[0]!)).toBe(20)
    expect(timeline.setFileDuration('a.mp3', 20)).toBe(false)
    expect(timeline.setFileDuration('b.mp3', 99)).toBe(false)
  })
})
