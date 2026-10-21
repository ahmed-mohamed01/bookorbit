import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useMediaOverlay } from './useMediaOverlay'
import type { FoliateMediaOverlay } from '@/features/reader/epub/composables/useFoliate'
import type { TtsCurrentBook } from '@/features/tts/lib/tts-state'

function makeFakeMediaOverlay() {
  const mo = new EventTarget() as FoliateMediaOverlay & {
    start: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    next: ReturnType<typeof vi.fn>
    prev: ReturnType<typeof vi.fn>
    setRate: ReturnType<typeof vi.fn>
    setVolume: ReturnType<typeof vi.fn>
  }
  mo.start = vi.fn<FoliateMediaOverlay['start']>().mockResolvedValue(true)
  mo.pause = vi.fn<() => void>()
  mo.resume = vi.fn<() => void>()
  mo.stop = vi.fn<() => void>()
  mo.next = vi.fn<() => void>()
  mo.prev = vi.fn<() => void>()
  mo.setRate = vi.fn<(rate: number) => void>()
  mo.setVolume = vi.fn<(volume: number) => void>()
  return mo
}

const openHeadlessNarration = vi.hoisted(() =>
  vi.fn<(book: unknown, playSection: (index: number) => void, trackingEnabled: boolean) => Promise<unknown>>(),
)
vi.mock('../lib/headless-narration', () => ({ openHeadlessNarration }))

const SNAPSHOT_KEY = 'bookorbit.narration.background'

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve))

const book: TtsCurrentBook = {
  bookId: 1,
  bookFileId: 2,
  title: 'Test Book',
  author: 'Author',
  coverUrl: null,
  totalChapters: 5,
}

describe('useMediaOverlay', () => {
  beforeEach(() => {
    useMediaOverlay().stop()
    sessionStorage.clear()
    openHeadlessNarration.mockReset()
  })

  it('start activates playback, applies rate/volume and invokes the start fn', () => {
    const mo = makeFakeMediaOverlay()
    const startFn = vi.fn<() => void>()
    const player = useMediaOverlay()

    player.start(mo, startFn, book)

    expect(player.isActive.value).toBe(true)
    expect(player.isPlaying.value).toBe(true)
    expect(player.currentBook.value).toEqual(book)
    expect(mo.setRate).toHaveBeenCalledWith(player.rate.value)
    expect(mo.setVolume).toHaveBeenCalledWith(player.volume.value)
    expect(startFn).toHaveBeenCalledOnce()
  })

  it('returns the start function result', async () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()
    const result = Promise.resolve('started')

    expect(player.start(mo, () => result, book)).toBe(result)
    await result
  })

  it('toggle pauses then resumes the underlying instance', () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()
    player.start(mo, vi.fn<() => void>(), book)

    player.toggle()
    expect(mo.pause).toHaveBeenCalledOnce()
    expect(player.isPlaying.value).toBe(false)

    player.toggle()
    expect(mo.resume).toHaveBeenCalledOnce()
    expect(player.isPlaying.value).toBe(true)
  })

  it('next/prev delegate to the instance', () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()
    player.start(mo, vi.fn<() => void>(), book)

    player.nextSentence()
    player.prevSentence()

    expect(mo.next).toHaveBeenCalledOnce()
    expect(mo.prev).toHaveBeenCalledOnce()
  })

  it('setRate clamps to the supported range and forwards to the instance', () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()
    player.start(mo, vi.fn<() => void>(), book)

    player.setRate(10)
    expect(player.rate.value).toBe(4)
    expect(mo.setRate).toHaveBeenLastCalledWith(4)

    player.setRate(0.1)
    expect(player.rate.value).toBe(0.5)
    expect(mo.setRate).toHaveBeenLastCalledWith(0.5)
  })

  it('stop tears down state and stops the instance', () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()
    player.start(mo, vi.fn<() => void>(), book)

    player.stop()

    expect(mo.stop).toHaveBeenCalledOnce()
    expect(player.isActive.value).toBe(false)
    expect(player.isPlaying.value).toBe(false)
    expect(player.currentBook.value).toBeNull()
  })

  it('highlight events keep playback marked as playing and track the fragment', () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()
    player.start(mo, vi.fn<() => void>(), book)
    player.pause()
    expect(player.isPlaying.value).toBe(false)

    mo.dispatchEvent(new CustomEvent('highlight', { detail: { text: 'ch.xhtml#s1', sectionIndex: 3 } }))
    expect(player.isPlaying.value).toBe(true)
    expect(player.currentFragment.value).toBe('ch.xhtml#s1')
    expect(player.currentSectionIndex.value).toBe(3)
  })

  it('tracks the book position from the engine, seeks through it, and stops playing at the end', () => {
    const mo = makeFakeMediaOverlay() as ReturnType<typeof makeFakeMediaOverlay> & { seekTo: ReturnType<typeof vi.fn> }
    mo.seekTo = vi.fn<(seconds: number) => void>()
    const player = useMediaOverlay()
    player.start(mo, vi.fn<() => void>(), book)
    expect(player.positionSeconds.value).toBeNull()

    mo.dispatchEvent(new CustomEvent('time', { detail: { position: 42, duration: 900 } }))
    expect(player.positionSeconds.value).toBe(42)
    expect(player.durationSeconds.value).toBe(900)

    player.seekTo(300)
    expect(mo.seekTo).toHaveBeenCalledWith(300)

    mo.dispatchEvent(new CustomEvent('end'))
    expect(player.isPlaying.value).toBe(false)
    expect(player.isActive.value).toBe(true)

    player.stop()
    expect(player.positionSeconds.value).toBeNull()
    expect(player.durationSeconds.value).toBeNull()
  })

  it('stop clears the tracked fragment', () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()
    player.start(mo, vi.fn<() => void>(), book)
    mo.dispatchEvent(new CustomEvent('highlight', { detail: { text: 'ch.xhtml#s9', sectionIndex: 3 } }))
    expect(player.currentFragment.value).toBe('ch.xhtml#s9')

    player.stop()
    expect(player.currentFragment.value).toBeNull()
    expect(player.currentSectionIndex.value).toBeNull()
  })

  it('detach only takes effect while narration is active and stop resets it', () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()

    player.detach()
    expect(player.isDetached.value).toBe(false)

    player.start(mo, () => undefined, book)
    player.detach()
    expect(player.isDetached.value).toBe(true)

    player.attach()
    expect(player.isDetached.value).toBe(false)

    player.detach()
    player.stop()
    expect(player.isDetached.value).toBe(false)
  })

  it('detached actions invoke the handlers given to start only while active', () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()
    const narrateFromHere = vi.fn<() => void>()
    const returnToNarration = vi.fn<() => void>()

    player.narrateFromHere()
    player.returnToNarration()
    expect(narrateFromHere).not.toHaveBeenCalled()
    expect(returnToNarration).not.toHaveBeenCalled()

    player.start(mo, () => undefined, book, { narrateFromHere, returnToNarration })
    player.detach()
    player.narrateFromHere()
    player.returnToNarration()
    expect(narrateFromHere).toHaveBeenCalledOnce()
    expect(returnToNarration).toHaveBeenCalledOnce()

    player.stop()
    player.narrateFromHere()
    player.returnToNarration()
    expect(narrateFromHere).toHaveBeenCalledOnce()
    expect(returnToNarration).toHaveBeenCalledOnce()
  })

  it('restarting narration clears the detached state', () => {
    const mo = makeFakeMediaOverlay()
    const player = useMediaOverlay()

    player.start(mo, () => undefined, book)
    player.detach()
    player.start(mo, () => undefined, book)

    expect(player.isDetached.value).toBe(false)
    expect(player.isActive.value).toBe(true)
  })

  describe('background narration', () => {
    function makeSink() {
      return {
        saveProgress: vi.fn<(fragment: string, section: number) => void>(),
        flush: vi.fn<() => void>(),
        release: vi.fn<() => void>(),
      }
    }

    function highlight(mo: EventTarget, text: string, sectionIndex: number) {
      mo.dispatchEvent(new CustomEvent('highlight', { detail: { text, sectionIndex } }))
    }

    it('keeps playing after hand-off, dropping the reader-only detached state', () => {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      const narrateFromHere = vi.fn<() => void>()
      player.start(mo, vi.fn<() => void>(), book, { narrateFromHere, returnToNarration: vi.fn<() => void>() })
      player.detach()

      expect(player.handOff(makeSink(), mo)).toBe(true)

      expect(player.isBackground.value).toBe(true)
      expect(player.isActive.value).toBe(true)
      expect(player.isDetached.value).toBe(false)
      expect(mo.stop).not.toHaveBeenCalled()
      player.narrateFromHere()
      expect(narrateFromHere).not.toHaveBeenCalled()
    })

    it('refuses a hand-off with nothing playing and releases the sink', () => {
      const sink = makeSink()
      const released = makeFakeMediaOverlay()

      expect(useMediaOverlay().handOff(sink, released)).toBe(false)

      expect(useMediaOverlay().isBackground.value).toBe(false)
      expect(sink.release).toHaveBeenCalledOnce()
      expect(released.stop).toHaveBeenCalledOnce()
    })

    it('saves each narrated sentence through the sink and flushes on pause', () => {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.start(mo, vi.fn<() => void>(), book)
      highlight(mo, 'c1.xhtml#s1', 1)
      const sink = makeSink()
      player.handOff(sink, mo)

      highlight(mo, 'c1.xhtml#s2', 1)
      expect(sink.saveProgress).toHaveBeenCalledExactlyOnceWith('c1.xhtml#s2', 1)

      player.pause()
      expect(sink.flush).toHaveBeenCalledOnce()
    })

    it('flushes and releases the sink when stopped', () => {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.start(mo, vi.fn<() => void>(), book)
      const sink = makeSink()
      player.handOff(sink, mo)

      player.stop()

      expect(sink.flush).toHaveBeenCalled()
      expect(sink.release).toHaveBeenCalledOnce()
      expect(player.isBackground.value).toBe(false)
    })

    it('ends the background session when another book starts narrating', () => {
      const player = useMediaOverlay()
      const first = makeFakeMediaOverlay()
      player.start(first, vi.fn<() => void>(), book)
      const sink = makeSink()
      player.handOff(sink, first)

      player.start(makeFakeMediaOverlay(), vi.fn<() => void>(), { ...book, bookFileId: 3 })

      expect(sink.release).toHaveBeenCalledOnce()
      expect(player.isBackground.value).toBe(false)
    })

    it('hands narration back to a reader opening the same file, from the current sentence', () => {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.start(mo, vi.fn<() => void>(), book)
      highlight(mo, 'c2.xhtml#s9', 2)
      player.handOff(makeSink(), mo)

      expect(player.takeOver(book.bookFileId + 1)).toBeNull()
      expect(player.isActive.value).toBe(true)

      expect(player.takeOver(book.bookFileId)).toEqual({ fragment: 'c2.xhtml#s9', sectionIndex: 2, wasPlaying: true, hasEngine: true })
      expect(player.isActive.value).toBe(true)
      expect(mo.stop).not.toHaveBeenCalled()

      player.stopBackground()
      expect(player.isActive.value).toBe(false)
      expect(mo.stop).toHaveBeenCalled()
    })

    it('does not take over narration that is still owned by its reader', () => {
      const player = useMediaOverlay()
      player.start(makeFakeMediaOverlay(), vi.fn<() => void>(), book)

      expect(player.takeOver(book.bookFileId)).toBeNull()
      expect(player.isActive.value).toBe(true)
    })

    it('plays a picked section from its start without a reader', () => {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.start(mo, vi.fn<() => void>(), book)
      highlight(mo, 'c1.xhtml#s1', 1)
      player.pause()
      player.handOff(makeSink(), mo)

      player.playSection(4)

      expect(mo.start).toHaveBeenCalledWith(4)
      expect(player.currentFragment.value).toBeNull()
      expect(player.isPlaying.value).toBe(true)
    })
  })
  describe('background snapshot', () => {
    function makeSink() {
      return {
        saveProgress: vi.fn<(fragment: string, section: number) => void>(),
        flush: vi.fn<() => void>(),
        release: vi.fn<() => void>(),
      }
    }

    function backgroundNarration() {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.restoreBackground(7)
      player.start(mo, vi.fn<() => void>(), book)
      mo.dispatchEvent(new CustomEvent('highlight', { detail: { text: 'c2.xhtml#s9', sectionIndex: 2 } }))
      const sink = makeSink()
      player.handOff(sink, mo)
      return { mo, player, sink }
    }

    function stored() {
      const raw = sessionStorage.getItem(SNAPSHOT_KEY)
      return raw ? JSON.parse(raw) : null
    }

    it('writes a snapshot once narration moves to the background', () => {
      const { player } = backgroundNarration()

      expect(stored()).toEqual({ userId: 7, book, fragment: 'c2.xhtml#s9', sectionIndex: 2, rate: player.rate.value, trackingEnabled: true })
    })

    it('writes a snapshot while a reader owns the narration', () => {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.restoreBackground(7)
      player.start(mo, vi.fn<() => void>(), book)
      mo.dispatchEvent(new CustomEvent('highlight', { detail: { text: 'c1.xhtml#s1', sectionIndex: 1 } }))

      expect(stored()).toEqual({ userId: 7, book, fragment: 'c1.xhtml#s1', sectionIndex: 1, rate: player.rate.value, trackingEnabled: true })
      expect(player.isBackground.value).toBe(false)
    })

    it('takes over a snapshot for the file before the background restore has run', () => {
      useMediaOverlay().restoreBackground(7)
      sessionStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ userId: 7, book, fragment: 'c2.xhtml#s9', sectionIndex: 2, rate: 1.5, trackingEnabled: true }),
      )
      const player = useMediaOverlay()
      expect(player.isActive.value).toBe(false)

      expect(player.takeOver(book.bookFileId)).toEqual({ fragment: 'c2.xhtml#s9', sectionIndex: 2, wasPlaying: false, hasEngine: false })
      expect(player.rate.value).toBe(1.5)
    })

    it('adopts a restored position paused in the reader and starts it on play', async () => {
      const starter = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      const player = useMediaOverlay()
      player.restoreBackground(7)

      player.adoptPaused(book, { fragment: 'c2.xhtml#s9', sectionIndex: 2 }, starter)

      expect(player.isActive.value).toBe(true)
      expect(player.isBackground.value).toBe(false)
      expect(player.isPlaying.value).toBe(false)
      expect(player.isAwaitingPlay.value).toBe(true)
      expect(stored()).toEqual({ userId: 7, book, fragment: 'c2.xhtml#s9', sectionIndex: 2, rate: player.rate.value, trackingEnabled: true })

      player.toggle()
      await Promise.resolve()

      expect(starter).toHaveBeenCalledOnce()
      expect(openHeadlessNarration).not.toHaveBeenCalled()
    })

    it('clears the adopted starter and snapshot on stop', () => {
      const starter = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      const player = useMediaOverlay()
      player.restoreBackground(7)
      player.adoptPaused(book, { fragment: 'c2.xhtml#s9', sectionIndex: 2 }, starter)

      player.stop()
      player.toggle()

      expect(starter).not.toHaveBeenCalled()
      expect(player.isAwaitingPlay.value).toBe(false)
      expect(stored()).toBeNull()
    })

    it('keeps an adopted pause as a restored background session when the reader closes', () => {
      const starter = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      const sink = makeSink()
      const released = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.restoreBackground(7)
      player.adoptPaused(book, { fragment: 'c2.xhtml#s9', sectionIndex: 2 }, starter)

      expect(player.handOff(sink, released)).toBe(true)

      expect(sink.release).toHaveBeenCalledOnce()
      expect(released.stop).toHaveBeenCalledOnce()
      expect(player.isBackground.value).toBe(true)
      expect(player.isAwaitingPlay.value).toBe(false)
      expect(stored()).not.toBeNull()
    })

    it('clears the snapshot on stop, take over and when a reader starts narrating', () => {
      backgroundNarration().player.stop()
      expect(stored()).toBeNull()

      const taken = backgroundNarration()
      taken.player.takeOver(book.bookFileId)
      expect(stored()).not.toBeNull()
      taken.player.stopBackground()
      expect(stored()).toBeNull()

      const restarted = backgroundNarration()
      restarted.player.start(makeFakeMediaOverlay(), vi.fn<() => void>(), book)
      expect(stored()).toBeNull()
    })

    it('restores a paused background session without an engine', () => {
      backgroundNarration()
      const snapshot = sessionStorage.getItem(SNAPSHOT_KEY)!
      useMediaOverlay().stop()
      sessionStorage.setItem(SNAPSHOT_KEY, snapshot)
      const player = useMediaOverlay()

      player.restoreBackground(7)

      expect(player.isActive.value).toBe(true)
      expect(player.isBackground.value).toBe(true)
      expect(player.isPlaying.value).toBe(false)
      expect(player.currentBook.value).toEqual(book)
      expect(player.currentFragment.value).toBe('c2.xhtml#s9')
      expect(player.currentSectionIndex.value).toBe(2)
      expect(openHeadlessNarration).not.toHaveBeenCalled()
    })

    it('discards a snapshot that belongs to another user', () => {
      backgroundNarration()
      const snapshot = sessionStorage.getItem(SNAPSHOT_KEY)!
      useMediaOverlay().stop()
      sessionStorage.setItem(SNAPSHOT_KEY, snapshot)
      const player = useMediaOverlay()

      player.restoreBackground(8)

      expect(player.isActive.value).toBe(false)
      expect(stored()).toBeNull()
    })

    it('ignores a corrupt snapshot', () => {
      sessionStorage.setItem(SNAPSHOT_KEY, '{not json')
      const player = useMediaOverlay()

      player.restoreBackground(7)

      expect(player.isActive.value).toBe(false)
    })

    it('hands a restored session back to a reader, which ends it once it takes over', () => {
      sessionStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ userId: 7, book, fragment: 'c2.xhtml#s9', sectionIndex: 2, rate: 1.5, trackingEnabled: true }),
      )
      const player = useMediaOverlay()
      player.restoreBackground(7)

      expect(player.takeOver(book.bookFileId)).toEqual({ fragment: 'c2.xhtml#s9', sectionIndex: 2, wasPlaying: false, hasEngine: false })
      expect(player.isActive.value).toBe(true)

      player.stopBackground()
      expect(player.isActive.value).toBe(false)
      expect(stored()).toBeNull()
    })

    it('builds the engine on play and resumes at the saved sentence', async () => {
      sessionStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ userId: 7, book, fragment: 'c2.xhtml#s9', sectionIndex: 2, rate: 1.5, trackingEnabled: true }),
      )
      const mo = makeFakeMediaOverlay()
      const sink = makeSink()
      openHeadlessNarration.mockResolvedValue({ mediaOverlay: mo, sink })
      const player = useMediaOverlay()
      player.restoreBackground(7)

      player.toggle()
      expect(player.isPlaying.value).toBe(true)
      await vi.waitFor(() => expect(mo.start).toHaveBeenCalled())

      expect(mo.setRate).toHaveBeenCalledWith(1.5)
      expect(mo.start).toHaveBeenCalledWith(2, expect.any(Function))
      const filter = mo.start.mock.calls[0]![1] as (item: { text: string }) => boolean
      expect(filter({ text: 'c2.xhtml#s9' })).toBe(true)
      expect(filter({ text: 'c2.xhtml#s10' })).toBe(false)

      mo.dispatchEvent(new CustomEvent('highlight', { detail: { text: 'c2.xhtml#s10', sectionIndex: 2 } }))
      expect(sink.saveProgress).toHaveBeenCalledWith('c2.xhtml#s10', 2)

      player.stop()
      expect(mo.stop).toHaveBeenCalled()
      expect(sink.release).toHaveBeenCalled()
    })

    it('keeps the restored session and shows an error when the engine fails to load', async () => {
      sessionStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ userId: 7, book, fragment: 'c2.xhtml#s9', sectionIndex: 2, rate: 1, trackingEnabled: true }),
      )
      openHeadlessNarration.mockRejectedValue(new Error('offline'))
      const player = useMediaOverlay()
      player.restoreBackground(7)

      player.toggle()
      await vi.waitFor(() => expect(player.error.value).toBe('offline'))

      expect(player.isPlaying.value).toBe(false)
      expect(player.isBackground.value).toBe(true)
      expect(stored()).not.toBeNull()
    })

    it('keeps the background narration untouched until the reader commits to it', () => {
      const { mo, player } = backgroundNarration()

      player.takeOver(book.bookFileId)
      player.takeOver(book.bookFileId)

      expect(mo.stop).not.toHaveBeenCalled()
      expect(player.isBackground.value).toBe(true)
      expect(player.isPlaying.value).toBe(true)
    })

    it('ends a background session when a reader adopts its paused position', () => {
      const { mo, player } = backgroundNarration()
      const starter = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

      player.adoptPaused(book, { fragment: 'c2.xhtml#s9', sectionIndex: 2 }, starter)

      expect(mo.stop).toHaveBeenCalled()
      expect(player.isBackground.value).toBe(false)
      expect(player.isAwaitingPlay.value).toBe(true)
    })

    it('keeps a peek reader from writing progress after a reload', async () => {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.restoreBackground(7)
      player.start(mo, vi.fn<() => void>(), book, undefined, { trackingEnabled: false })
      mo.dispatchEvent(new CustomEvent('highlight', { detail: { text: 'c2.xhtml#s9', sectionIndex: 2 } }))
      player.handOff(makeSink(), mo)
      expect(stored().trackingEnabled).toBe(false)

      const snapshot = sessionStorage.getItem(SNAPSHOT_KEY)!
      player.stop()
      sessionStorage.setItem(SNAPSHOT_KEY, snapshot)
      openHeadlessNarration.mockResolvedValue({ mediaOverlay: makeFakeMediaOverlay(), sink: makeSink() })
      player.restoreBackground(7)
      player.toggle()

      await vi.waitFor(() => expect(openHeadlessNarration).toHaveBeenCalled())
      expect(openHeadlessNarration.mock.calls[0]![2]).toBe(false)
    })

    it('drops the engine when paused while it is still starting, keeping the saved position', async () => {
      sessionStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ userId: 7, book, fragment: 'c2.xhtml#s9', sectionIndex: 2, rate: 1, trackingEnabled: true }),
      )
      const mo = makeFakeMediaOverlay()
      let finishStart!: (value: boolean) => void
      mo.start.mockReturnValue(new Promise<boolean>((resolve) => (finishStart = resolve)))
      const sink = makeSink()
      openHeadlessNarration.mockResolvedValue({ mediaOverlay: mo, sink })
      const player = useMediaOverlay()
      player.restoreBackground(7)
      player.toggle()
      await vi.waitFor(() => expect(mo.start).toHaveBeenCalled())

      player.pause()
      finishStart(true)
      await flushMicrotasks()

      expect(mo.stop).toHaveBeenCalled()
      expect(sink.release).toHaveBeenCalledOnce()
      expect(mo.start).toHaveBeenCalledOnce()
      expect(player.isPlaying.value).toBe(false)
      expect(player.isBackground.value).toBe(true)
      expect(player.currentFragment.value).toBe('c2.xhtml#s9')
      expect(stored()).not.toBeNull()

      openHeadlessNarration.mockResolvedValue({ mediaOverlay: makeFakeMediaOverlay(), sink: makeSink() })
      player.toggle()
      await vi.waitFor(() => expect(openHeadlessNarration).toHaveBeenCalledTimes(2))
    })

    it('releases an engine that finishes loading after the session was stopped', async () => {
      sessionStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ userId: 7, book, fragment: 'c2.xhtml#s9', sectionIndex: 2, rate: 1, trackingEnabled: true }),
      )
      const sink = makeSink()
      let finish!: (value: unknown) => void
      openHeadlessNarration.mockReturnValue(new Promise((resolve) => (finish = resolve)))
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.restoreBackground(7)
      player.toggle()

      player.stop()
      finish({ mediaOverlay: mo, sink })
      await vi.waitFor(() => expect(sink.release).toHaveBeenCalled())

      expect(mo.start).not.toHaveBeenCalled()
      expect(player.isActive.value).toBe(false)
    })
  })
})
