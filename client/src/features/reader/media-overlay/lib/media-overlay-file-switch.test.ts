import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error public Foliate asset has no TypeScript declarations.
import { EPUB } from '../../../../../public/assets/foliate/epub.js'

type Clip = { id: string; src: string; begin: number; end: number }

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = []
  #src: string
  #currentTime = 0
  paused = true
  readyState = 0
  duration = NaN
  buffered = { length: 0, start: () => 0, end: () => 0 }
  error: MediaError | null = null
  preload = ''
  volume = 1
  playbackRate = 1
  srcChanges: string[] = []
  seeks: number[] = []

  constructor(src = '') {
    super()
    this.#src = src
    FakeAudio.instances.push(this)
  }

  get src() {
    return this.#src
  }

  set src(value: string) {
    this.#src = value
    this.srcChanges.push(value)
    this.readyState = 0
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

  loadMetadata() {
    this.readyState = 1
    this.dispatchEvent(new Event('loadedmetadata'))
  }

  // Plays up to `time` the way a browser reports it: the clock moves, then timeupdate fires.
  playTo(time: number) {
    this.#currentTime = time
    this.dispatchEvent(new Event('timeupdate'))
  }
}

function smil(sectionHref: string, clips: Clip[]): string {
  const pars = clips
    .map((clip) => `<par><text src="${sectionHref}#${clip.id}"/><audio src="${clip.src}" clipBegin="${clip.begin}s" clipEnd="${clip.end}s"/></par>`)
    .join('')
  return `<?xml version="1.0"?><smil xmlns="http://www.w3.org/ns/SMIL"><body><seq>${pars}</seq></body></smil>`
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

// Storyteller cuts a narration file at the silence nearest the audiobook's chapter mark, which is
// often the pause after the narrator reads the next chapter's title. The title of chapter 11 then
// lives at the end of chapter 10's file.
const chapter10: Clip[] = [
  { id: 's1', src: 'audio/00010.mp4', begin: 0, end: 10 },
  { id: 's2', src: 'audio/00010.mp4', begin: 10, end: 20 },
]
const chapter11: Clip[] = [
  { id: 'title', src: 'audio/00010.mp4', begin: 20, end: 23 },
  { id: 'b1', src: 'audio/00011.mp4', begin: 0, end: 10 },
  { id: 'b2', src: 'audio/00011.mp4', begin: 10, end: 20 },
]

interface Overlay extends EventTarget {
  start: (section: number, filter?: (item: unknown, index: number) => boolean) => Promise<boolean>
  stop: () => void
}
type EpubClass = new (loader: object) => { sections: unknown[]; getMediaOverlay: () => Overlay }

// By default the download of the next file fails, so a switch streams it; `prefetch` makes it succeed.
function openBook(nextChapter: Clip[] = chapter11, Epub: EpubClass = EPUB, prefetch = false) {
  const getMediaUrl = vi.fn<(href: string) => Promise<string>>(async (href) => `/media/${href}`)
  const loadBlob = vi.fn<(href: string) => Promise<Blob | null>>(async (href) => (prefetch ? new Blob([href], { type: 'audio/mpeg' }) : null))
  const book = new Epub({
    loadText: async (src: string) => {
      if (src === 'c10.smil') return smil('c10.xhtml', chapter10)
      if (src === 'c11.smil') return smil('c11.xhtml', nextChapter)
      return null
    },
    loadBlob,
    getSize: () => 0,
    getMediaUrl,
  })
  book.sections = [
    { id: 'c10.xhtml', mediaOverlay: { href: 'c10.smil' } },
    { id: 'c11.xhtml', mediaOverlay: { href: 'c11.smil' } },
  ]
  const overlay = book.getMediaOverlay()
  const heard: string[] = []
  overlay.addEventListener('highlight', (event: Event) => {
    const id = (event as CustomEvent<{ text: string }>).detail.text.split('#')[1]!
    if (heard.at(-1) !== id) heard.push(id)
  })
  return { overlay, heard, getMediaUrl, loadBlob }
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}

describe('narration moving into the next chapter', () => {
  const originalAudio = globalThis.Audio

  beforeEach(() => {
    FakeAudio.instances = []
    globalThis.Audio = FakeAudio as unknown as typeof Audio
  })

  afterEach(() => {
    globalThis.Audio = originalAudio
    setHidden(false)
    vi.restoreAllMocks()
  })

  async function playIntoChapter11(hidden: boolean) {
    setHidden(hidden)
    const book = openBook()
    await book.overlay.start(0)
    const first = FakeAudio.instances[0]!
    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))

    first.playTo(5)
    first.playTo(12)
    await flush()
    // Chapter 10 ends, and chapter 11's title follows in the same file.
    first.playTo(20.1)
    await flush()
    return { ...book, first }
  }

  it('plays a chapter title at the end of the previous file without reloading that file', async () => {
    const { overlay, heard, first } = await playIntoChapter11(true)

    expect(heard).toEqual(['s1', 's2', 'title'])
    expect(FakeAudio.instances).toHaveLength(1)
    expect(first.paused).toBe(false)
    expect(first.srcChanges).toEqual([])
    expect(first.seeks).toEqual([])
    overlay.stop()
  })

  it('switches to the next file on the playing element while the page is hidden', async () => {
    const { overlay, heard, first, getMediaUrl } = await playIntoChapter11(true)
    // The next file's link was resolved ahead, before the title started.
    expect(getMediaUrl).toHaveBeenCalledWith('audio/00011.mp4')
    const lookups = getMediaUrl.mock.calls.length

    first.playTo(23.2)

    // The switch happens in the same task: nothing waits on the network.
    expect(getMediaUrl.mock.calls.length).toBe(lookups)
    expect(FakeAudio.instances).toHaveLength(1)
    expect(first.src).toBe('/media/audio/00011.mp4')
    expect(first.paused).toBe(false)

    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))
    first.playTo(11)
    expect(heard).toEqual(['s1', 's2', 'title', 'b1', 'b2'])
    overlay.stop()
  })

  it('switches to a warmed element for the next file while the page is visible', async () => {
    const { overlay, heard, first } = await playIntoChapter11(false)
    expect(FakeAudio.instances).toHaveLength(2)
    const warmed = FakeAudio.instances[1]!
    expect(warmed.src).toBe('/media/audio/00011.mp4')
    warmed.loadMetadata()

    first.playTo(23.2)

    expect(first.src).toBe('')
    expect(warmed.paused).toBe(false)
    warmed.dispatchEvent(new Event('playing'))
    expect(heard).toEqual(['s1', 's2', 'title', 'b1'])
    overlay.stop()
  })

  it('lets go of the warmed element when the page went hidden after warming it', async () => {
    const { overlay, first } = await playIntoChapter11(false)
    const warmed = FakeAudio.instances[1]!
    setHidden(true)

    first.playTo(23.2)

    expect(warmed.src).toBe('')
    expect(first.src).toBe('/media/audio/00011.mp4')
    expect(first.paused).toBe(false)
    overlay.stop()
  })

  it('starts a chapter cut at its own file on the playing element while the page is hidden', async () => {
    setHidden(true)
    const { overlay, heard, getMediaUrl } = openBook(chapter11.slice(1))
    await overlay.start(0)
    const first = FakeAudio.instances[0]!
    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))
    first.playTo(12)
    await flush()
    const lookups = getMediaUrl.mock.calls.length

    first.playTo(20.1)
    await flush()

    expect(getMediaUrl.mock.calls.length).toBe(lookups)
    expect(FakeAudio.instances).toHaveLength(1)
    expect(first.src).toBe('/media/audio/00011.mp4')
    expect(first.paused).toBe(false)
    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))
    expect(heard).toEqual(['s1', 's2', 'b1'])
    overlay.stop()
  })

  it('stops the element once nothing follows the last chapter', async () => {
    const { overlay, heard, first } = await playIntoChapter11(true)
    first.playTo(23.2)
    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))

    first.playTo(15)
    first.playTo(20.1)
    await flush()

    expect(heard).toEqual(['s1', 's2', 'title', 'b1', 'b2'])
    expect(first.src).toBe('')
    expect(first.paused).toBe(true)
    overlay.stop()
  })

  it('moves on once when the file also ends while the next chapter is loading', async () => {
    setHidden(true)
    const { overlay, heard } = openBook()
    await overlay.start(0)
    const first = FakeAudio.instances[0]!
    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))
    first.playTo(12)
    await flush()

    first.playTo(20.1)
    first.dispatchEvent(new Event('ended'))
    first.playTo(20.2)
    await flush()

    expect(heard).toEqual(['s1', 's2', 'title'])
    expect(FakeAudio.instances).toHaveLength(1)
    expect(first.srcChanges).toEqual([])
    overlay.stop()
  })
})

class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = []
  state: AudioContextState
  destination = {}
  sources: { audio: FakeAudio; connected: unknown; disconnected: boolean }[] = []

  constructor() {
    super()
    this.state = FakeAudioContext.startState
    FakeAudioContext.instances.push(this)
  }

  static startState: AudioContextState = 'running'

  resume() {
    this.state = 'running'
    return Promise.resolve()
  }

  createMediaElementSource(audio: FakeAudio) {
    if (this.sources.some((source) => source.audio === audio)) throw new Error('already routed')
    const source = {
      audio,
      connected: null as unknown,
      disconnected: false,
      connect(destination: unknown) {
        source.connected = destination
      },
      disconnect() {
        source.disconnected = true
      },
    }
    this.sources.push(source)
    return source
  }
}

describe('narration audio output on Android', () => {
  const originalAudio = globalThis.Audio
  const originalContext = globalThis.AudioContext

  beforeEach(() => {
    vi.resetModules()
    FakeAudio.instances = []
    FakeAudioContext.instances = []
    FakeAudioContext.startState = 'running'
    globalThis.Audio = FakeAudio as unknown as typeof Audio
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 10; K) Chrome/155.0.0.0 Mobile Safari/537.36')
  })

  afterEach(() => {
    globalThis.Audio = originalAudio
    globalThis.AudioContext = originalContext
    setHidden(false)
    vi.restoreAllMocks()
  })

  async function freshBook(nextChapter: Clip[] = chapter11) {
    // @ts-expect-error public Foliate asset has no TypeScript declarations.
    const { EPUB: FreshEPUB } = await import('../../../../../public/assets/foliate/epub.js')
    return openBook(nextChapter, FreshEPUB)
  }

  it('keeps one output open across a file switch in the background', async () => {
    setHidden(true)
    const { overlay } = await freshBook(chapter11.slice(1))
    await overlay.start(0)
    const first = FakeAudio.instances[0]!
    await flush()
    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))
    first.playTo(12)
    await flush()

    first.playTo(20.1)
    await flush()

    expect(first.src).toBe('/media/audio/00011.mp4')
    expect(FakeAudioContext.instances).toHaveLength(1)
    const [context] = FakeAudioContext.instances
    expect(context!.sources).toHaveLength(1)
    expect(context!.sources[0]!.audio).toBe(first)
    expect(context!.sources[0]!.connected).toBe(context!.destination)
    overlay.stop()
    expect(context!.sources[0]!.disconnected).toBe(true)
  })

  it('leaves an element on its own output until the context is running', async () => {
    FakeAudioContext.startState = 'suspended'
    const resume = vi.spyOn(FakeAudioContext.prototype, 'resume').mockReturnValue(new Promise<void>(() => {}))
    const { overlay } = await freshBook()
    await overlay.start(0)
    await flush()

    expect(resume).toHaveBeenCalled()
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(0)
    overlay.stop()
  })

  it('does not route audio off Android', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1')
    const { overlay } = await freshBook()
    await overlay.start(0)
    await flush()

    expect(FakeAudioContext.instances).toHaveLength(0)
    overlay.stop()
  })
})

describe('narration with the next file downloaded ahead', () => {
  const originalAudio = globalThis.Audio
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL

  beforeEach(() => {
    FakeAudio.instances = []
    globalThis.Audio = FakeAudio as unknown as typeof Audio
    let next = 0
    URL.createObjectURL = vi.fn<(object: Blob | MediaSource) => string>(() => `blob:prefetched-${++next}`)
    URL.revokeObjectURL = vi.fn<(url: string) => void>()
  })

  afterEach(() => {
    globalThis.Audio = originalAudio
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    setHidden(false)
    vi.restoreAllMocks()
  })

  async function playToChapterEnd(hidden: boolean) {
    setHidden(hidden)
    const book = openBook(chapter11.slice(1), EPUB, true)
    await book.overlay.start(0)
    const first = FakeAudio.instances[0]!
    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))
    first.playTo(12)
    await flush()
    return { ...book, first }
  }

  it('plays the next file from memory on the playing element while the page is hidden', async () => {
    const { overlay, heard, first, loadBlob, getMediaUrl } = await playToChapterEnd(true)
    expect(loadBlob).toHaveBeenCalledWith('audio/00011.mp4')
    const lookups = getMediaUrl.mock.calls.length

    first.playTo(20.1)
    await flush()

    expect(getMediaUrl.mock.calls.length).toBe(lookups)
    expect(FakeAudio.instances).toHaveLength(1)
    expect(first.src).toBe('blob:prefetched-1')
    expect(first.paused).toBe(false)
    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))
    expect(heard).toEqual(['s1', 's2', 'b1'])
    overlay.stop()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:prefetched-1')
  })

  it('prefers the downloaded file over a warmed element while the page is visible', async () => {
    const { overlay, first } = await playToChapterEnd(false)
    const warmed = FakeAudio.instances.slice(1)

    first.playTo(20.1)
    await flush()

    expect(first.src).toBe('blob:prefetched-1')
    for (const element of warmed) expect(element.src).toBe('')
    overlay.stop()
  })

  it('keeps the downloaded file when the reader jumps within the chapter', async () => {
    const { overlay, first, loadBlob } = await playToChapterEnd(true)

    await overlay.start(0, (_item: unknown, index: number) => index === 1)
    first.loadMetadata()
    first.dispatchEvent(new Event('playing'))
    first.playTo(20.1)
    await flush()

    expect(loadBlob).toHaveBeenCalledTimes(1)
    expect(first.src).toBe('blob:prefetched-1')
    overlay.stop()
  })

  it('streams the next file when its download failed', async () => {
    setHidden(true)
    const { overlay, first, loadBlob } = await (async () => {
      const book = openBook(chapter11.slice(1), EPUB, false)
      await book.overlay.start(0)
      const element = FakeAudio.instances[0]!
      element.loadMetadata()
      element.dispatchEvent(new Event('playing'))
      element.playTo(12)
      await flush()
      return { ...book, first: element }
    })()
    expect(loadBlob).toHaveBeenCalledWith('audio/00011.mp4')

    first.playTo(20.1)
    await flush()

    expect(first.src).toBe('/media/audio/00011.mp4')
    overlay.stop()
  })

  it('streams again when the downloaded file cannot be played', async () => {
    const { overlay, first } = await playToChapterEnd(true)
    first.playTo(20.1)
    await flush()
    expect(first.src).toBe('blob:prefetched-1')

    first.error = { code: 4 } as MediaError
    first.dispatchEvent(new Event('error'))
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await flush()

    expect(FakeAudio.instances.at(-1)!.src).toBe('/media/audio/00011.mp4')
    overlay.stop()
  })
})
