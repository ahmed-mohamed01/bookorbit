import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import type { TocItem } from '@/features/reader/epub/composables/useToc'
import { registerNarrationChapters, useNarrationChapters } from './useNarrationChapters'
import { installNarrationSleepWatchers, useNarrationSleep } from './useNarrationSleep'
import { useMediaOverlay } from './useMediaOverlay'

vi.mock('./useMediaOverlay', async () => {
  const { ref } = await import('vue')
  const activeMinutes = ref<number | null>(null)
  const remainingSeconds = ref<number | null>(null)
  const sleepTimer = {
    activeMinutes,
    remainingSeconds,
    presets: [5, 15],
    startTimer: (minutes: number) => {
      activeMinutes.value = minutes
      remainingSeconds.value = minutes * 60
    },
    cancelTimer: () => {
      activeMinutes.value = null
      remainingSeconds.value = null
    },
  }
  const state = { currentFragment: ref<string | null>(null), isActive: ref(false), pause: vi.fn<() => void>(), sleepTimer }
  return { useMediaOverlay: () => state }
})

const TOC: TocItem[] = [
  { label: 'Chapter 1', href: 'c1.xhtml' },
  { label: 'Chapter 2', href: 'c2.xhtml' },
  { label: 'Chapter 3', href: 'c3.xhtml' },
]
const SECTIONS: Record<string, number> = { 'front.xhtml': 0, 'c1.xhtml': 1, 'c2.xhtml': 2, 'c3.xhtml': 3 }

describe('useNarrationSleep', () => {
  const playSection = vi.fn<(section: number) => void>()
  let unregister: () => void
  let scope: EffectScope

  beforeEach(() => {
    const state = useMediaOverlay()
    state.isActive.value = false
    state.currentFragment.value = null
    state.sleepTimer.cancelTimer()
    vi.mocked(state.pause).mockClear()
    unregister = registerNarrationChapters({
      toc: ref(TOC),
      resolveSectionIndex: (href) => SECTIONS[href.split('#')[0]!],
      hasNarration: () => true,
      playSection,
    })
    scope = effectScope()
    scope.run(installNarrationSleepWatchers)
  })

  afterEach(() => {
    scope.stop()
    unregister()
  })

  // Mirrors useMediaOverlay: start() stops first, then reactivates, and the first sentence
  // highlight arrives later.
  async function startAt(fragment: string) {
    const state = useMediaOverlay()
    state.isActive.value = false
    state.currentFragment.value = null
    state.isActive.value = true
    await nextTick()
    state.currentFragment.value = fragment
    await nextTick()
  }

  async function playOn(fragment: string) {
    useMediaOverlay().currentFragment.value = fragment
    await nextTick()
  }

  function sleep() {
    return scope.run(() => useNarrationSleep())!
  }

  it('pauses once narration runs into the next chapter', async () => {
    await startAt('c1.xhtml#s1')
    sleep().select('chapter')

    await playOn('c1.xhtml#s2')
    expect(useMediaOverlay().pause).not.toHaveBeenCalled()
    await playOn('c2.xhtml#s1')

    expect(useMediaOverlay().pause).toHaveBeenCalledOnce()
    expect(sleep().mode.value).toBe('off')
  })

  it('does not pause on a picked chapter', async () => {
    await startAt('c1.xhtml#s1')
    sleep().select('chapter')

    await startAt('c3.xhtml#s1')

    expect(useMediaOverlay().pause).not.toHaveBeenCalled()
    expect(sleep().mode.value).toBe('chapter')
  })

  it('pauses when narrated front matter runs into the first chapter', async () => {
    await startAt('front.xhtml#s1')
    sleep().select('chapter')

    await playOn('c1.xhtml#s1')

    expect(useMediaOverlay().pause).toHaveBeenCalledOnce()
  })

  it('still pauses at the next chapter end after a chapter pick that did not restart', async () => {
    await startAt('c1.xhtml#s1')
    sleep().select('chapter')

    scope.run(() => useNarrationChapters())!.playChapter(2)
    await playOn('c2.xhtml#s1')

    expect(useMediaOverlay().pause).toHaveBeenCalledOnce()
  })

  it('turns end-of-chapter off when narration stops', async () => {
    await startAt('c1.xhtml#s1')
    sleep().select('chapter')

    useMediaOverlay().isActive.value = false
    await nextTick()

    expect(sleep().mode.value).toBe('off')
  })

  it('keeps the sleep timer through a narration restart but not through a stop', async () => {
    const state = useMediaOverlay()
    state.isActive.value = true
    state.sleepTimer.startTimer(30)
    state.sleepTimer.remainingSeconds.value = 600

    state.isActive.value = false
    state.sleepTimer.cancelTimer()
    state.isActive.value = true
    expect(state.sleepTimer.activeMinutes.value).toBe(30)
    expect(state.sleepTimer.remainingSeconds.value).toBe(600)

    state.isActive.value = false
    state.sleepTimer.cancelTimer()
    await Promise.resolve()
    state.isActive.value = true
    expect(state.sleepTimer.activeMinutes.value).toBeNull()
  })

  it('selects a timer, end of chapter, or off', () => {
    const value = sleep()
    expect(value.options.value.map((option) => option.label)).toEqual(['Off', '5 minutes', '15 minutes', 'End of chapter'])

    value.select('15')
    expect(useMediaOverlay().sleepTimer.activeMinutes.value).toBe(15)
    expect([value.mode.value, value.label.value, value.badge.value, value.isActive.value]).toEqual(['15', '15 min', '15m', true])

    value.select('chapter')
    expect(useMediaOverlay().sleepTimer.activeMinutes.value).toBeNull()
    expect([value.mode.value, value.label.value, value.badge.value]).toEqual(['chapter', 'End of chapter', 'Ch'])

    value.select('off')
    expect([value.mode.value, value.label.value, value.badge.value, value.isActive.value]).toEqual(['off', 'Sleep', null, false])
  })
})
