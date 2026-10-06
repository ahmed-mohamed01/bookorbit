import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error public Foliate asset has no TypeScript declarations.
import { EPUB } from '../../../../../public/assets/foliate/epub.js'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = []

  src: string
  paused = true
  seeking = false
  error: MediaError | null = null
  preload = ''
  readyState = 0
  duration = 100
  loadCalls = 0
  currentTime = 0
  volume = 1
  playbackRate = 1
  playCalls = 0
  bufferedRanges: [number, number][] = [[0, 100]]

  constructor(src: string) {
    super()
    this.src = src
    FakeAudio.instances.push(this)
  }

  get buffered() {
    const ranges = this.bufferedRanges
    return { length: ranges.length, start: (i: number) => ranges[i]![0], end: (i: number) => ranges[i]![1] }
  }

  play(): Promise<void> {
    this.playCalls++
    this.paused = false
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }

  load(): void {
    this.loadCalls++
  }

  emit(type: string): void {
    this.dispatchEvent(new Event(type))
  }

  emitCanPlayThrough(): void {
    this.emit('canplaythrough')
  }

  emitLoadedMetadata(): void {
    this.readyState = 1
    this.emit('loadedmetadata')
  }

  emitError(): void {
    this.emit('error')
  }
}

const smil = `<?xml version="1.0"?>
<smil xmlns="http://www.w3.org/ns/SMIL">
  <body><seq>
    <par><text src="chapter.xhtml#top"/><audio src="audio.mp3" clipBegin="0" clipEnd="1"/></par>
    <par><text src="chapter.xhtml#selected"/><audio src="audio.mp3" clipBegin="1" clipEnd="2"/></par>
  </seq></body>
</smil>`

const nextSmil = `<?xml version="1.0"?>
<smil xmlns="http://www.w3.org/ns/SMIL">
  <body><seq>
    <par><text src="next.xhtml#first"/><audio src="next.mp3" clipBegin="5" clipEnd="6"/></par>
  </seq></body>
</smil>`

const smilFiles: Record<string, string> = { 'OPS/chapter.smil': smil, 'OPS/next.smil': nextSmil }

function makeOverlay(loadBlob: (src: string) => Promise<Blob>, getMediaUrl?: (src: string) => Promise<string | null>) {
  const book = new EPUB({
    loadText: async (src: string) => smilFiles[src] ?? null,
    loadBlob,
    getMediaUrl,
    getSize: () => 0,
  })
  book.sections = [
    { id: 'OPS/chapter.xhtml', mediaOverlay: { href: 'OPS/chapter.smil' } },
    { id: 'OPS/next.xhtml', mediaOverlay: { href: 'OPS/next.smil' } },
  ]
  return book.getMediaOverlay()
}

describe('Foliate MediaOverlay concurrency', () => {
  const originalAudio = globalThis.Audio
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  beforeEach(() => {
    FakeAudio.instances = []
    globalThis.Audio = FakeAudio as unknown as typeof Audio
    URL.createObjectURL = vi.fn<(object: Blob | MediaSource) => string>(() => 'blob:media-overlay')
    URL.revokeObjectURL = vi.fn<(url: string) => void>()
  })

  afterEach(() => {
    globalThis.Audio = originalAudio
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    vi.restoreAllMocks()
  })

  it('reports whether the requested SMIL entry exists', async () => {
    const loadBlob = vi.fn<(src: string) => Promise<Blob>>().mockResolvedValue(new Blob(['audio']))
    const overlay = makeOverlay(loadBlob)

    await expect(overlay.start(0, (item: { text: string }) => item.text.endsWith('#selected'))).resolves.toBe(true)
    await expect(overlay.start(0, (item: { text: string }) => item.text.endsWith('#missing'))).resolves.toBe(false)

    expect(loadBlob).toHaveBeenCalledOnce()
    overlay.stop()
  })

  it('discards an in-flight audio load when a newer start supersedes it', async () => {
    const loads: Deferred<Blob>[] = []
    const loadBlob = vi.fn<(src: string) => Promise<Blob>>(() => {
      const load = deferred<Blob>()
      loads.push(load)
      return load.promise
    })
    const overlay = makeOverlay(loadBlob)
    const highlights: string[] = []
    overlay.addEventListener('highlight', (event: Event) => highlights.push((event as CustomEvent<{ text: string }>).detail.text))

    const selectedStart = overlay.start(0, (item: { text: string }) => item.text.endsWith('#selected'))
    await vi.waitFor(() => expect(loads).toHaveLength(1))
    const fallbackStart = overlay.start(0)
    await vi.waitFor(() => expect(loads).toHaveLength(2))

    loads[0]!.resolve(new Blob(['selected audio']))
    await selectedStart
    expect(FakeAudio.instances).toHaveLength(0)

    loads[1]!.resolve(new Blob(['fallback audio']))
    await fallbackStart
    expect(FakeAudio.instances).toHaveLength(1)

    FakeAudio.instances[0]!.emitCanPlayThrough()
    expect(highlights).toEqual(['OPS/chapter.xhtml#top'])

    overlay.stop()
    expect(FakeAudio.instances[0]!.paused).toBe(true)
  })

  it('does not create audio when playback stops during a blob load', async () => {
    const load = deferred<Blob>()
    const loadBlob = vi.fn<(src: string) => Promise<Blob>>(() => load.promise)
    const overlay = makeOverlay(loadBlob)

    const start = overlay.start(0)
    await vi.waitFor(() => expect(loadBlob).toHaveBeenCalledOnce())
    overlay.stop()
    load.resolve(new Blob(['audio']))
    await start

    expect(FakeAudio.instances).toHaveLength(0)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('ignores a late canplaythrough event after playback stops', async () => {
    const overlay = makeOverlay(async () => new Blob(['audio']))

    await overlay.start(0)
    const audio = FakeAudio.instances[0]!
    overlay.stop()
    audio.emitCanPlayThrough()

    expect(audio.playCalls).toBe(0)
    expect(audio.paused).toBe(true)
  })

  describe('streamed audio', () => {
    const streamUrl = (src: string) => `/api/v1/epub/1/file/${src}`
    const flush = () => vi.advanceTimersByTimeAsync(0)
    const latest = () => FakeAudio.instances.at(-1)!

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    type GetMediaUrl = (src: string) => Promise<string | null>

    function makeStreamingOverlay(getMediaUrl = vi.fn<GetMediaUrl>(async (src) => streamUrl(src))) {
      const loadBlob = vi.fn<(src: string) => Promise<Blob>>().mockResolvedValue(new Blob(['audio']))
      const overlay = makeOverlay(loadBlob, getMediaUrl)
      const buffering: boolean[] = []
      overlay.addEventListener('buffering', (e: Event) => buffering.push((e as CustomEvent<boolean>).detail))
      return { overlay, loadBlob, getMediaUrl, buffering }
    }

    it('plays from a streamable URL without downloading the audio', async () => {
      const { overlay, loadBlob, getMediaUrl } = makeStreamingOverlay()

      await overlay.start(0, (item: { text: string }) => item.text.endsWith('#selected'))
      const audio = latest()
      audio.emitLoadedMetadata()
      await flush()

      expect(getMediaUrl).toHaveBeenCalledWith('OPS/audio.mp3')
      expect(loadBlob).not.toHaveBeenCalled()
      expect(audio.src).toBe(streamUrl('OPS/audio.mp3'))
      expect(audio.currentTime).toBe(1)
      expect(audio.playCalls).toBe(1)

      overlay.stop()
      expect(audio.src).toBe('')
      expect(audio.loadCalls).toBe(1)
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    })

    it('starts as soon as metadata is known and reports buffering until audio plays', async () => {
      const { overlay, buffering } = makeStreamingOverlay()

      await overlay.start(0)
      const audio = latest()
      audio.bufferedRanges = [[0, 0.5]]
      expect(buffering).toEqual([true])
      audio.emitLoadedMetadata()
      await flush()

      expect(audio.playCalls).toBe(1)
      expect(buffering).toEqual([true, false])
      overlay.stop()
    })

    it('leaves a stall right after a seek to the browser', async () => {
      const { overlay } = makeStreamingOverlay()
      await overlay.start(0)
      const audio = latest()
      audio.emitLoadedMetadata()
      await flush()

      audio.currentTime = 1
      audio.emit('seeking')
      audio.bufferedRanges = [[1, 1.2]]
      audio.emit('waiting')

      expect(audio.paused).toBe(false)
      overlay.stop()
    })

    it('holds playback after a stall until the buffer refills', async () => {
      const { overlay } = makeStreamingOverlay()
      await overlay.start(0)
      const audio = latest()
      audio.emitLoadedMetadata()
      await flush()

      audio.bufferedRanges = [[0, 0.2]]
      audio.emit('waiting')
      expect(audio.paused).toBe(true)
      audio.bufferedRanges = [[0, 0.8]]
      audio.emit('progress')
      await flush()
      expect(audio.playCalls).toBe(1)

      audio.bufferedRanges = [[0, 10]]
      audio.emit('progress')
      await flush()
      expect(audio.playCalls).toBe(2)
      overlay.stop()
    })

    it('does not start a stream the reader paused while metadata loaded', async () => {
      const { overlay } = makeStreamingOverlay()

      await overlay.start(0)
      overlay.pause()
      latest().emitLoadedMetadata()
      await flush()

      expect(latest().playCalls).toBe(0)
      overlay.stop()
    })

    it('seeks the current element when skipping to a sentence in the same file', async () => {
      const { overlay, getMediaUrl } = makeStreamingOverlay()
      await overlay.start(0)
      const audio = latest()
      audio.emitLoadedMetadata()
      await flush()

      overlay.next()
      await flush()

      expect(FakeAudio.instances).toHaveLength(1)
      expect(getMediaUrl).toHaveBeenCalledOnce()
      expect(audio.currentTime).toBe(1)
      expect(audio.paused).toBe(false)
      overlay.stop()
    })

    it('warms the next section before the boundary and plays it without a new request', async () => {
      const { overlay, getMediaUrl } = makeStreamingOverlay()
      await overlay.start(0)
      const current = latest()
      current.emitLoadedMetadata()
      await flush()

      current.currentTime = 1.5
      current.emit('timeupdate')
      await flush()
      expect(FakeAudio.instances).toHaveLength(2)
      const next = latest()
      expect(next.src).toBe(streamUrl('OPS/next.mp3'))
      expect(next.preload).toBe('auto')
      next.emitLoadedMetadata()
      expect(next.currentTime).toBe(5)

      current.emit('ended')
      await flush()

      expect(FakeAudio.instances).toHaveLength(2)
      expect(getMediaUrl).toHaveBeenCalledTimes(2)
      expect(next.playCalls).toBe(1)
      overlay.stop()
      expect(next.src).toBe('')
    })

    it('prepares the starting clip so play reuses it without new requests', async () => {
      const { overlay, getMediaUrl } = makeStreamingOverlay()
      const selected = (item: { text: string }) => item.text.endsWith('#selected')

      await expect(overlay.prepare(0, selected)).resolves.toBe(true)
      const warmed = latest()
      expect(warmed.preload).toBe('metadata')
      warmed.emitLoadedMetadata()
      expect(warmed.currentTime).toBe(1)

      await overlay.start(0, selected)

      expect(FakeAudio.instances).toHaveLength(1)
      expect(getMediaUrl).toHaveBeenCalledOnce()
      expect(warmed.preload).toBe('auto')
      expect(warmed.playCalls).toBe(1)
      overlay.stop()
    })

    it('discards a prepared clip when playback starts somewhere else', async () => {
      const { overlay } = makeStreamingOverlay()
      await overlay.prepare(1)
      const warmed = latest()

      await overlay.start(0)

      expect(warmed.src).toBe('')
      expect(FakeAudio.instances).toHaveLength(2)
      overlay.stop()
    })

    it('reuses a prepared file when play starts at another sentence in it', async () => {
      const { overlay, getMediaUrl } = makeStreamingOverlay()
      await overlay.prepare(0)
      const warmed = latest()
      warmed.emitLoadedMetadata()

      await overlay.start(0, (item: { text: string }) => item.text.endsWith('#selected'))

      expect(FakeAudio.instances).toHaveLength(1)
      expect(getMediaUrl).toHaveBeenCalledOnce()
      expect(warmed.currentTime).toBe(1)
      overlay.stop()
    })

    it('re-points a prepared file instead of fetching it again', async () => {
      const { overlay, getMediaUrl } = makeStreamingOverlay()
      await overlay.prepare(0)
      latest().emitLoadedMetadata()

      await overlay.prepare(0, (item: { text: string }) => item.text.endsWith('#selected'))
      await overlay.prepare(0, (item: { text: string }) => item.text.endsWith('#selected'))

      expect(FakeAudio.instances).toHaveLength(1)
      expect(getMediaUrl).toHaveBeenCalledOnce()
      expect(latest().currentTime).toBe(1)
      overlay.stop()
    })

    it('prepares the start of the section when no sentence matches, as play would', async () => {
      const { overlay } = makeStreamingOverlay()

      await expect(overlay.prepare(1, () => false)).resolves.toBe(true)
      latest().emitLoadedMetadata()

      expect(latest().src).toBe(streamUrl('OPS/next.mp3'))
      expect(latest().currentTime).toBe(5)
      overlay.stop()
    })

    it('does not reuse a failed element when skipping during a retry', async () => {
      const { overlay, getMediaUrl } = makeStreamingOverlay()
      await overlay.start(0)
      const failed = latest()
      failed.emitLoadedMetadata()
      await flush()
      failed.error = { code: 2 } as MediaError
      failed.emitError()

      overlay.next()
      await flush()

      expect(FakeAudio.instances).toHaveLength(2)
      expect(getMediaUrl).toHaveBeenCalledTimes(2)
      expect(latest().src).toBe(streamUrl('OPS/audio.mp3'))
      overlay.stop()
    })

    it('gives up with an error when a stream keeps failing after it played', async () => {
      const { overlay, loadBlob } = makeStreamingOverlay()
      const errors: unknown[] = []
      overlay.addEventListener('error', (e: Event) => errors.push((e as CustomEvent).detail))
      vi.spyOn(console, 'error').mockImplementation(() => {})

      await overlay.start(0)
      for (let i = 0; i < 7; i++) {
        latest().emitLoadedMetadata()
        await flush()
        latest().emitError()
        await vi.advanceTimersByTimeAsync(1000)
      }

      expect(FakeAudio.instances).toHaveLength(7)
      expect(errors).toHaveLength(1)
      expect(loadBlob).not.toHaveBeenCalled()
      overlay.stop()
    })

    it('does not warm the next section while the current one is still buffering', async () => {
      const { overlay } = makeStreamingOverlay()
      await overlay.start(0)
      const current = latest()
      current.emitLoadedMetadata()
      await flush()

      // At 1/40 speed the second left is 40s away, but almost nothing past the playhead is buffered.
      overlay.setRate(1 / 40)
      current.currentTime = 1
      current.bufferedRanges = [[0.9, 1.1]]
      current.emit('timeupdate')
      await flush()

      expect(FakeAudio.instances).toHaveLength(1)
      overlay.stop()
    })

    it('retries a failed probe with backoff and reports an error without downloading the file', async () => {
      const getMediaUrl = vi.fn<GetMediaUrl>(async () => {
        throw new Error('offline')
      })
      const { overlay, loadBlob } = makeStreamingOverlay(getMediaUrl)
      const errors: unknown[] = []
      overlay.addEventListener('error', (e: Event) => errors.push((e as CustomEvent).detail))
      vi.spyOn(console, 'error').mockImplementation(() => {})

      await overlay.start(0)
      await vi.advanceTimersByTimeAsync(1000 + 3000 + 8000)

      expect(getMediaUrl).toHaveBeenCalledTimes(4)
      expect(loadBlob).not.toHaveBeenCalled()
      expect(errors).toHaveLength(1)
      overlay.stop()
    })

    it('falls back to downloading the file when the stream never plays', async () => {
      const { overlay, loadBlob, getMediaUrl } = makeStreamingOverlay()

      await overlay.start(0)
      for (const delay of [1000, 3000, 8000]) {
        latest().emitError()
        await vi.advanceTimersByTimeAsync(delay)
      }
      expect(getMediaUrl).toHaveBeenCalledTimes(4)
      latest().emitError()
      await flush()

      expect(loadBlob).toHaveBeenCalledOnce()
      expect(latest().src).toBe('blob:media-overlay')
      overlay.stop()
    })

    it('keeps streaming after failures that follow successful playback', async () => {
      const { overlay, loadBlob } = makeStreamingOverlay()

      await overlay.start(0)
      for (let i = 0; i < 5; i++) {
        latest().emitLoadedMetadata()
        await flush()
        latest().emitError()
        await vi.advanceTimersByTimeAsync(1000)
      }

      expect(FakeAudio.instances).toHaveLength(6)
      expect(loadBlob).not.toHaveBeenCalled()
      overlay.stop()
    })

    it('downloads the audio when no streamable URL is available', async () => {
      const { overlay, loadBlob } = makeStreamingOverlay(vi.fn<GetMediaUrl>(async () => null))

      await overlay.start(0)

      expect(loadBlob).toHaveBeenCalledOnce()
      expect(latest().src).toBe('blob:media-overlay')
      overlay.stop()
    })
  })
})
