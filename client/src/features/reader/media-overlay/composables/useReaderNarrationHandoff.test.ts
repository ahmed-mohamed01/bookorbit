import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { FoliateMediaOverlay } from '@/features/reader/epub/composables/useFoliate'
import type { TtsCurrentBook } from '@/features/tts/lib/tts-state'
import { useMediaOverlay } from './useMediaOverlay'
import { useReaderNarrationHandoff, type ReaderNarrationHandoffDeps } from './useReaderNarrationHandoff'

vi.mock('../lib/headless-narration', () => ({ openHeadlessNarration: vi.fn<() => Promise<unknown>>() }))

const book: TtsCurrentBook = { bookId: 1, bookFileId: 2, title: 'Test Book', author: null, coverUrl: null, totalChapters: 5 }

function fakeMediaOverlay() {
  const mo = new EventTarget() as FoliateMediaOverlay
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

function backgroundNarration() {
  const mo = fakeMediaOverlay()
  const player = useMediaOverlay()
  player.start(mo, () => undefined, book)
  mo.dispatchEvent(new CustomEvent('highlight', { detail: { text: 'c2.xhtml#s9', sectionIndex: 2 } }))
  player.handOff({ saveProgress: vi.fn<() => void>(), flush: vi.fn<() => void>(), release: vi.fn<() => void>() }, mo)
  return { mo, player }
}

function mountHandoff(overrides: Partial<ReaderNarrationHandoffDeps> = {}) {
  const deps: ReaderNarrationHandoffDeps = {
    fileId: book.bookFileId,
    trackingEnabled: ref(true),
    isNarratingHere: ref(false),
    isMediaOverlayAvailable: ref(true),
    chapters: ref([]),
    releaseNarration: () => null,
    progress: { setMediaOverlayProgress: vi.fn<() => void>(), flush: vi.fn<() => void>() },
    saveNarrationPos: vi.fn<() => void>(),
    bookDetailsLoaded: () => Promise.resolve(),
    buildTtsBook: () => Promise.resolve(book),
    beginNarration: vi.fn<ReaderNarrationHandoffDeps['beginNarration']>().mockResolvedValue(undefined),
    adoptRate: vi.fn<() => void>(),
    ...overrides,
  }
  let handoff!: ReturnType<typeof useReaderNarrationHandoff>
  const wrapper = mount(
    defineComponent({
      setup() {
        handoff = useReaderNarrationHandoff(deps)
        return () => null
      },
    }),
  )
  return { deps, wrapper, handoff }
}

describe('useReaderNarrationHandoff', () => {
  beforeEach(() => {
    useMediaOverlay().stop()
  })

  it('leaves the background narration playing when the reader unmounts before it commits', async () => {
    const { mo } = backgroundNarration()
    let finishDetails!: () => void
    const { wrapper, handoff, deps } = mountHandoff({ bookDetailsLoaded: () => new Promise<void>((resolve) => (finishDetails = resolve)) })

    const resuming = handoff.resumeHandedOffNarration()
    wrapper.unmount()
    finishDetails()
    await resuming

    expect(mo.stop).not.toHaveBeenCalled()
    expect(useMediaOverlay().isBackground.value).toBe(true)
    expect(useMediaOverlay().isPlaying.value).toBe(true)
    expect(deps.beginNarration).not.toHaveBeenCalled()
  })

  it('restarts a playing background narration in the reader at the reached sentence', async () => {
    backgroundNarration()
    const { handoff, deps } = mountHandoff()

    await handoff.resumeHandedOffNarration()

    expect(deps.beginNarration).toHaveBeenCalledWith(2, expect.any(Function))
    expect(deps.progress.setMediaOverlayProgress).toHaveBeenCalledWith('c2.xhtml#s9', 2)
  })

  it('hands the running engine to the app when the reader closes', () => {
    const mo = fakeMediaOverlay()
    useMediaOverlay().start(mo, () => undefined, book)
    const { wrapper } = mountHandoff({
      isNarratingHere: ref(true),
      releaseNarration: () => ({ mediaOverlay: mo, resolveSectionIndex: () => 0, hasNarration: () => true }),
    })

    wrapper.unmount()

    expect(useMediaOverlay().isBackground.value).toBe(true)
    expect(mo.stop).not.toHaveBeenCalled()
  })
})
