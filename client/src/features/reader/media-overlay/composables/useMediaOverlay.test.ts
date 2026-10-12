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

      expect(player.handoff(makeSink())).toBe(true)

      expect(player.isBackground.value).toBe(true)
      expect(player.isActive.value).toBe(true)
      expect(player.isDetached.value).toBe(false)
      expect(mo.stop).not.toHaveBeenCalled()
      player.narrateFromHere()
      expect(narrateFromHere).not.toHaveBeenCalled()
    })

    it('refuses a hand-off with nothing playing and releases the sink', () => {
      const sink = makeSink()

      expect(useMediaOverlay().handoff(sink)).toBe(false)

      expect(useMediaOverlay().isBackground.value).toBe(false)
      expect(sink.release).toHaveBeenCalledOnce()
    })

    it('saves each narrated sentence through the sink and flushes on pause', () => {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.start(mo, vi.fn<() => void>(), book)
      highlight(mo, 'c1.xhtml#s1', 1)
      const sink = makeSink()
      player.handoff(sink)

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
      player.handoff(sink)

      player.stop()

      expect(sink.flush).toHaveBeenCalled()
      expect(sink.release).toHaveBeenCalledOnce()
      expect(player.isBackground.value).toBe(false)
    })

    it('ends the background session when another book starts narrating', () => {
      const player = useMediaOverlay()
      player.start(makeFakeMediaOverlay(), vi.fn<() => void>(), book)
      const sink = makeSink()
      player.handoff(sink)

      player.start(makeFakeMediaOverlay(), vi.fn<() => void>(), { ...book, bookFileId: 3 })

      expect(sink.release).toHaveBeenCalledOnce()
      expect(player.isBackground.value).toBe(false)
    })

    it('hands narration back to a reader opening the same file, from the current sentence', () => {
      const mo = makeFakeMediaOverlay()
      const player = useMediaOverlay()
      player.start(mo, vi.fn<() => void>(), book)
      highlight(mo, 'c2.xhtml#s9', 2)
      player.handoff(makeSink())

      expect(player.takeOver(book.bookFileId + 1)).toBeNull()
      expect(player.isActive.value).toBe(true)

      expect(player.takeOver(book.bookFileId)).toEqual({ fragment: 'c2.xhtml#s9', sectionIndex: 2, wasPlaying: true })
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
      player.handoff(makeSink())

      player.playSection(4)

      expect(mo.start).toHaveBeenCalledWith(4)
      expect(player.currentFragment.value).toBeNull()
      expect(player.isPlaying.value).toBe(true)
    })
  })
})
