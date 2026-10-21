import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EpubMediaOverlayPlaylist, EpubMediaOverlayPlaylistItem } from '@bookorbit/types'
import type { FoliateMediaOverlay } from '@/features/reader/epub/composables/useFoliate'
import { PlaylistNarration } from './playlist-narration'

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = []
  #src = ''
  #currentTime = 0
  paused = true
  readyState = 0
  networkState = 0
  duration = NaN
  buffered = { length: 0, start: () => 0, end: () => 0 }
  error: { code: number } | null = null
  preload = ''
  volume = 1
  playbackRate = 1
  srcChanges: string[] = []
  seeks: number[] = []
  plays = 0

  constructor() {
    super()
    FakeAudio.instances.push(this)
  }

  get src() {
    return this.#src
  }

  set src(value: string) {
    this.#src = value
    this.srcChanges.push(value)
    this.readyState = 0
    this.error = null
    this.paused = true
  }

  get currentTime() {
    return this.#currentTime
  }

  set currentTime(value: number) {
    this.#currentTime = value
    this.seeks.push(value)
  }

  play() {
    this.plays++
    this.paused = false
    return Promise.resolve()
  }

  pause() {
    this.paused = true
  }

  load() {}

  removeAttribute(name: string) {
    if (name === 'src') this.#src = ''
  }

  loadMetadata(duration = NaN) {
    this.readyState = 1
    this.duration = duration
    this.dispatchEvent(new Event('loadedmetadata'))
  }

  playTo(time: number) {
    this.#currentTime = time
    this.dispatchEvent(new Event('timeupdate'))
  }

  fail() {
    this.error = { code: 2 }
    this.dispatchEvent(new Event('error'))
  }
}

type ItemSpec = [sectionIndex: number, text: string, audio: string, begin: number, end: number | null]

function playlist(specs: ItemSpec[]): EpubMediaOverlayPlaylist {
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
  return { bookId: 1, fileId: 1, durationSeconds: null, items, sections: [], resources }
}

// Chapter 11's title is spoken at the end of chapter 10's file, as Storyteller cuts them.
const book = playlist([
  [3, 'c10.xhtml#s1', 'a10.mp4', 0, 10],
  [3, 'c10.xhtml#s2', 'a10.mp4', 10, 20],
  [4, 'c11.xhtml#title', 'a10.mp4', 20, 23],
  [4, 'c11.xhtml#b1', 'a11.mp4', 0, 10],
  [4, 'c11.xhtml#b2', 'a11.mp4', 10, 20],
  [6, 'c12.xhtml#x1', 'a12.mp4', 0, 5],
])

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function open({
  list = book as EpubMediaOverlayPlaylist | null,
  loadBlob = vi.fn<(href: string) => Promise<Blob | null>>(async (href) => new Blob([href])),
} = {}) {
  const getMediaUrl = vi.fn<(href: string) => Promise<string>>(async (href) => `/media/${href}`)
  const fallback = Object.assign(new EventTarget(), {
    start: vi.fn<FoliateMediaOverlay['start']>(async () => true),
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
    next: vi.fn<() => void>(),
    prev: vi.fn<() => void>(),
    setRate: vi.fn<(rate: number) => void>(),
    setVolume: vi.fn<(volume: number) => void>(),
  }) as unknown as FoliateMediaOverlay
  const narration = new PlaylistNarration({
    book: { getMediaUrl, loadBlob },
    loadPlaylist: async () => list,
    fallback: () => fallback,
    createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
  })
  const highlights: { text: string; sectionIndex: number }[] = []
  narration.addEventListener('highlight', (e) => highlights.push((e as CustomEvent).detail))
  const times: { position: number; duration: number }[] = []
  narration.addEventListener('time', (e) => times.push((e as CustomEvent).detail))
  return { narration, getMediaUrl, loadBlob, fallback, highlights, times }
}

describe('playlist narration', () => {
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  let objectUrls = 0

  beforeEach(() => {
    FakeAudio.instances = []
    objectUrls = 0
    URL.createObjectURL = vi.fn<(object: Blob | MediaSource) => string>(() => `blob:file-${++objectUrls}`)
    URL.revokeObjectURL = vi.fn<(url: string) => void>()
    setHidden(false)
  })

  afterEach(() => {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    vi.useRealTimers()
  })

  it('plays a chapter title at the end of the previous file, then the next file on the same element', async () => {
    const { narration, loadBlob, highlights } = open()
    expect(await narration.start(3)).toBe(true)
    const audio = FakeAudio.instances[0]!
    expect(audio.src).toBe('/media/a10.mp4')
    audio.loadMetadata(23)
    expect(audio.paused).toBe(false)

    audio.playTo(12)
    // The next file is near, so it is downloaded ahead.
    expect(loadBlob).toHaveBeenCalledWith('a11.mp4')
    await flush()
    audio.playTo(21)
    expect(highlights.at(-1)).toMatchObject({ text: 'c11.xhtml#title', sectionIndex: 4 })

    setHidden(true)
    audio.playTo(23)
    await flush()
    expect(FakeAudio.instances).toHaveLength(1)
    expect(audio.src).toBe('blob:file-1')
    expect(audio.paused).toBe(false)
    audio.loadMetadata(20)
    expect(audio.seeks.at(-1)).toBe(0)
    audio.playTo(11)
    expect(highlights.at(-1)).toMatchObject({ text: 'c11.xhtml#b2', sectionIndex: 4 })
  })

  it('waits for the download of the next file on a hidden page instead of streaming it', async () => {
    const download = deferred<Blob | null>()
    const loadBlob = vi.fn<(href: string) => Promise<Blob | null>>((href) =>
      href === 'a11.mp4' ? download.promise : Promise.resolve(new Blob([href])),
    )
    const { narration, getMediaUrl } = open({ loadBlob })
    await narration.start(3)
    const audio = FakeAudio.instances[0]!
    audio.loadMetadata(23)
    audio.playTo(5)
    setHidden(true)
    audio.playTo(23)
    await flush()
    expect(audio.src).toBe('/media/a10.mp4')
    expect(getMediaUrl).not.toHaveBeenCalledWith('a11.mp4')

    download.resolve(new Blob(['a11']))
    await flush()
    expect(audio.src).toBe('blob:file-1')
    expect(audio.paused).toBe(false)
  })

  it('streams the next file when the page is visible and its download is not ready', async () => {
    const loadBlob = vi.fn<(href: string) => Promise<Blob | null>>(() => new Promise<Blob | null>(() => {}))
    const { narration } = open({ loadBlob })
    await narration.start(3)
    const audio = FakeAudio.instances[0]!
    audio.loadMetadata(23)
    audio.playTo(23)
    await flush()
    expect(audio.src).toBe('/media/a11.mp4')
  })

  it('starts at the sentence a filter picks, and reports a section without that sentence', async () => {
    const { narration, highlights } = open()
    expect(await narration.start(4, (item) => item.text === 'c11.xhtml#b2')).toBe(true)
    const audio = FakeAudio.instances[0]!
    expect(audio.src).toBe('/media/a11.mp4')
    audio.loadMetadata(20)
    expect(audio.currentTime).toBe(10)
    expect(highlights.at(-1)?.text).toBe('c11.xhtml#b2')

    expect(await narration.start(4, (item) => item.text === 'missing')).toBe(false)
  })

  it('moves past a section without narration to the next one that has it', async () => {
    const { narration, highlights } = open()
    expect(await narration.start(5, (item) => item.text === 'missing')).toBe(true)
    expect(highlights.at(-1)?.text).toBe('c12.xhtml#x1')
  })

  it('seeks across the book and reports the book position', async () => {
    const { narration, highlights, times } = open()
    await narration.start(3)
    const audio = FakeAudio.instances[0]!
    audio.loadMetadata(23)
    expect(narration.duration).toBe(48)

    narration.seekTo(33)
    await flush()
    expect(audio.src).toBe('/media/a11.mp4')
    audio.loadMetadata(20)
    expect(audio.currentTime).toBe(10)
    expect(highlights.at(-1)?.text).toBe('c11.xhtml#b2')
    audio.playTo(12)
    expect(times.at(-1)).toEqual({ position: 35, duration: 48 })

    narration.seekTo(5)
    await flush()
    expect(audio.src).toBe('/media/a10.mp4')
  })

  it('steps sentence by sentence across files', async () => {
    const { narration, highlights } = open()
    await narration.start(4)
    const audio = FakeAudio.instances[0]!
    expect(audio.src).toBe('/media/a10.mp4')
    audio.loadMetadata(23)
    narration.next()
    await flush()
    expect(audio.src).toBe('/media/a11.mp4')
    expect(highlights.at(-1)?.text).toBe('c11.xhtml#b1')
    narration.prev()
    await flush()
    expect(audio.src).toBe('/media/a10.mp4')
    expect(highlights.at(-1)?.text).toBe('c11.xhtml#title')
  })

  it('keeps a paused narration paused when the listener seeks', async () => {
    const { narration } = open()
    await narration.start(3)
    const audio = FakeAudio.instances[0]!
    audio.loadMetadata(23)
    narration.pause()
    expect(audio.paused).toBe(true)
    narration.seekTo(15)
    await flush()
    expect(audio.currentTime).toBe(15)
    expect(audio.paused).toBe(true)
  })

  it('retries a dropped stream where it was', async () => {
    vi.useFakeTimers()
    const { narration, getMediaUrl } = open()
    await narration.start(3)
    const first = FakeAudio.instances[0]!
    first.loadMetadata(23)
    first.playTo(14)
    first.fail()
    expect(getMediaUrl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(getMediaUrl).toHaveBeenCalledTimes(2)
    const second = FakeAudio.instances[1]!
    expect(second.src).toBe('/media/a10.mp4')
    second.loadMetadata(23)
    expect(second.currentTime).toBe(14)
    expect(second.paused).toBe(false)
  })

  it('ends at the end of the book', async () => {
    const { narration } = open()
    const ended = vi.fn<() => void>()
    narration.addEventListener('end', ended)
    await narration.start(6)
    const audio = FakeAudio.instances[0]!
    audio.loadMetadata(5)
    audio.playTo(5)
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('opens the warmed file when play starts there', async () => {
    const { narration, getMediaUrl } = open()
    expect(await narration.prepare(4, (item) => item.text === 'c11.xhtml#b1')).toBe(true)
    const audio = FakeAudio.instances[0]!
    expect(audio.src).toBe('/media/a11.mp4')
    expect(audio.preload).toBe('metadata')
    audio.loadMetadata(20)
    expect(audio.currentTime).toBe(0)

    await narration.start(4, (item) => item.text === 'c11.xhtml#b2')
    expect(FakeAudio.instances).toHaveLength(1)
    expect(getMediaUrl).toHaveBeenCalledTimes(1)
    expect(audio.currentTime).toBe(10)
    expect(audio.paused).toBe(false)
  })

  it("falls back to foliate's engine when the book has no playlist", async () => {
    const { narration, fallback } = open({ list: null })
    expect(await narration.start(2)).toBe(true)
    expect(fallback.start).toHaveBeenCalledWith(2, undefined)
    narration.pause()
    expect(fallback.pause).toHaveBeenCalled()
  })
})
