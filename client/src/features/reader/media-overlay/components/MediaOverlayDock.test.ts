import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ref } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import MediaOverlayDock from './MediaOverlayDock.vue'
import { useMediaOverlay } from '../composables/useMediaOverlay'
import { useNarrationDockLayout } from '../composables/useNarrationDockLayout'
import { useTtsMiniPlayerUi } from '@/features/tts/composables/useTtsMiniPlayerUi'

vi.mock('../composables/useMediaOverlay', async () => {
  const { ref } = await import('vue')
  const state = {
    isActive: ref(false),
    isPlaying: ref(false),
    isWaitingForAudio: ref(false),
    isDetached: ref(false),
    isBackground: ref(false),
    isAwaitingPlay: ref(false),
    error: ref<string | null>(null),
    currentFragment: ref<string | null>(null),
    currentBook: ref<{ title: string; author: string; coverUrl: string | null } | null>(null),
    currentSectionIndex: ref<number | null>(null),
    toggle: vi.fn<() => void>(),
    pause: vi.fn<() => void>(),
    narrateFromHere: vi.fn<() => void>(),
    returnToNarration: vi.fn<() => void>(),
    sleepTimer: {
      activeMinutes: ref<number | null>(null),
      remainingSeconds: ref<number | null>(null),
      startTimer: vi.fn<(minutes: number) => void>(),
      cancelTimer: vi.fn<() => void>(),
    },
  }
  return { useMediaOverlay: () => state }
})

// The real flag is a read-only computed; the mock is a ref the tests drive.
const waitingForAudio = (state: ReturnType<typeof useMediaOverlay>) => state.isWaitingForAudio as Ref<boolean>

function mountDock() {
  return mount(MediaOverlayDock, {
    attachTo: document.body,
    global: {
      stubs: {
        MediaOverlayFullPlayer: {
          emits: ['minimise'],
          template: '<div data-test="full-player"><button data-test="inside" /><button data-narration-minimise @click="$emit(\'minimise\')" /></div>',
        },
      },
    },
  })
}

enableAutoUnmount(afterEach)

describe('MediaOverlayDock', () => {
  beforeEach(async () => {
    const state = useMediaOverlay()
    state.isActive.value = false
    state.isPlaying.value = true
    waitingForAudio(state).value = false
    state.isDetached.value = false
    state.isBackground.value = false
    state.isAwaitingPlay.value = false
    state.error.value = null
    vi.mocked(state.toggle).mockClear()
    useTtsMiniPlayerUi().setReaderFooterVisible(true)
    useTtsMiniPlayerUi().setReaderOpen(false)
    localStorage.clear()
    const layout = useNarrationDockLayout()
    layout.side.value = 'center'
    layout.setMini(false)
    localStorage.clear()
  })

  async function startNarration() {
    const wrapper = mountDock()
    useMediaOverlay().isActive.value = true
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('shows a spinner on the play button while audio is loading', async () => {
    const wrapper = await startNarration()
    const playButton = () => wrapper.find('[data-dock="pill"] button')
    expect(playButton().attributes('aria-label')).toBe('Pause narration')

    waitingForAudio(useMediaOverlay()).value = true
    await wrapper.vm.$nextTick()

    expect(playButton().attributes('aria-label')).toBe('Loading narration audio')
    expect(playButton().find('.animate-spin').exists()).toBe(true)
  })

  it('stays off the page while the reader toolbars are hidden, unless something needs acting on', async () => {
    const wrapper = await startNarration()
    expect(wrapper.find('[data-dock="pill"]').exists()).toBe(true)

    useTtsMiniPlayerUi().setReaderFooterVisible(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-dock]').exists()).toBe(false)

    useMediaOverlay().isDetached.value = true
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-dock="pill"]').exists()).toBe(true)

    useMediaOverlay().isDetached.value = false
    useMediaOverlay().error.value = 'Failed to load clip'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })

  it('shows the pill with the toolbars hidden while a reloaded reader waits for play', async () => {
    const wrapper = await startNarration()
    useTtsMiniPlayerUi().setReaderFooterVisible(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-dock]').exists()).toBe(false)

    const state = useMediaOverlay()
    state.isPlaying.value = false
    state.isAwaitingPlay.value = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-dock="pill"]').exists()).toBe(true)
    expect(wrapper.find('[data-dock="pill"] button').attributes('aria-label')).toBe('Play narration')
  })

  it('keeps the pill up after the reader closes and lifts other bottom-edge UI above it', async () => {
    const wrapper = await startNarration()
    useTtsMiniPlayerUi().setReaderFooterVisible(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-dock]').exists()).toBe(false)

    useMediaOverlay().isBackground.value = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-dock="pill"]').exists()).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--narration-dock-clearance')).not.toBe('')

    useMediaOverlay().isBackground.value = false
    await wrapper.vm.$nextTick()
    expect(document.documentElement.style.getPropertyValue('--narration-dock-clearance')).toBe('')
  })

  it('names the narrated book on the pill once narration plays in the background', async () => {
    const wrapper = await startNarration()
    const state = useMediaOverlay()
    state.currentBook.value = { title: 'The Way of Kings', author: 'Brandon Sanderson', coverUrl: null } as never
    expect(wrapper.find('[data-test="background-now-playing"]').exists()).toBe(false)

    state.isBackground.value = true
    await wrapper.vm.$nextTick()

    const nowPlaying = wrapper.find('[data-test="background-now-playing"]')
    expect(nowPlaying.text()).toContain('The Way of Kings')
    expect(nowPlaying.text()).toContain('Brandon Sanderson')
    await nowPlaying.trigger('click')
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(true)
    state.currentBook.value = null
  })

  it('shrinks the open full player back to the pill when narration moves to the background', async () => {
    const wrapper = await startNarration()
    await wrapper.find('[aria-label="Open narration controls"]').trigger('click')
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(true)

    useMediaOverlay().isBackground.value = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(false)
    expect(wrapper.find('[data-dock="pill"]').exists()).toBe(true)
  })

  it('starts as a pill that toggles playback without opening the full player', async () => {
    const wrapper = await startNarration()

    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(false)
    await wrapper.findAll('button')[0]!.trigger('click')

    expect(useMediaOverlay().toggle).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(false)
  })

  it('expands to the full player and collapses on a tap outside it', async () => {
    const wrapper = await startNarration()

    await wrapper.findAll('button')[1]!.trigger('click')
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(true)

    wrapper.find('[data-test="inside"]').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(true)

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(false)
  })

  it('keeps the player open when a tap outside only closes an open menu', async () => {
    const wrapper = await startNarration()
    await wrapper.find('[aria-label="Open narration controls"]').trigger('click')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)

    document.documentElement.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    menu.remove()

    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(true)
  })

  it('collapses on a tap in the book but not when focus moves into a new chapter frame', async () => {
    const wrapper = await startNarration()
    await wrapper.findAll('button')[1]!.trigger('click')

    window.dispatchEvent(new Event('blur'))
    await new Promise((resolve) => setTimeout(resolve))
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(true)

    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { type: 'foliate-click' } }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(false)
  })

  it('keeps the pill while reading away from the narration and offers both ways back', async () => {
    const wrapper = await startNarration()

    useMediaOverlay().isDetached.value = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(false)
    await wrapper.find('[aria-label="Back to narration"]').trigger('click')
    await wrapper.find('[aria-label="Narrate from here"]').trigger('click')
    expect(useMediaOverlay().returnToNarration).toHaveBeenCalledOnce()
    expect(useMediaOverlay().narrateFromHere).toHaveBeenCalledOnce()
  })

  it('shows an error on the pill instead of opening the full player', async () => {
    const wrapper = await startNarration()

    useMediaOverlay().error.value = 'Audio failed'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="Open narration controls"]').exists()).toBe(true)
    expect(wrapper.find('[role="alert"]').text()).toBe('Audio failed')
  })

  it('minimises the full player while an error is showing', async () => {
    const wrapper = await startNarration()
    await wrapper.find('[aria-label="Open narration controls"]').trigger('click')
    useMediaOverlay().error.value = 'Audio failed'
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-narration-minimise]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })

  it('moves focus into the full player on open and back to the pill on minimise', async () => {
    const wrapper = await startNarration()

    await wrapper.find('[aria-label="Open narration controls"]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find('[data-narration-minimise]').element)

    await wrapper.find('[data-narration-minimise]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find('[aria-label="Open narration controls"]').element)
  })

  it('collapses on Escape unless a menu is open', async () => {
    const wrapper = await startNarration()
    await wrapper.find('[aria-label="Open narration controls"]').trigger('click')
    await flushPromises()

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(true)

    menu.remove()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-test="full-player"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('[aria-label="Open narration controls"]').element)
  })
  it('shows a restored session as a paused pill with the book and a play button', async () => {
    const wrapper = mountDock()
    const state = useMediaOverlay()
    state.currentBook.value = { title: 'Mistborn', author: 'Brandon Sanderson', coverUrl: null } as never
    state.isPlaying.value = false
    state.isBackground.value = true
    state.isActive.value = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="background-now-playing"]').text()).toContain('Mistborn')
    expect(wrapper.find('[aria-label="Play narration"]').exists()).toBe(true)
    await wrapper.find('[aria-label="Play narration"]').trigger('click')
    expect(state.toggle).toHaveBeenCalledOnce()
    state.currentBook.value = null
  })

  describe('on a narrow screen', () => {
    async function backgroundPill() {
      const wrapper = await startNarration()
      useMediaOverlay().isBackground.value = true
      await wrapper.vm.$nextTick()
      return wrapper
    }

    it('collapses to a mini player and expands back, remembering the choice', async () => {
      const wrapper = await backgroundPill()
      expect(wrapper.find('[data-dock="mini"]').exists()).toBe(false)

      await wrapper.find('[data-test="collapse-to-mini"]').trigger('click')
      expect(wrapper.find('[data-dock="pill"]').exists()).toBe(false)
      expect(wrapper.find('[data-dock="mini"]').exists()).toBe(true)
      expect(localStorage.getItem('bookorbit.narration.miniCollapsed')).toBe('1')

      await wrapper.find('[data-test="mini-toggle"]').trigger('click')
      expect(useMediaOverlay().toggle).toHaveBeenCalledOnce()

      await wrapper.find('[aria-label="Show narration player"]').trigger('click')
      expect(wrapper.find('[data-dock="mini"]').exists()).toBe(false)
      expect(wrapper.find('[data-dock="pill"]').exists()).toBe(true)
      expect(localStorage.getItem('bookorbit.narration.miniCollapsed')).toBe('0')
    })

    it('starts collapsed when it was left collapsed', async () => {
      useNarrationDockLayout().setMini(true)
      const wrapper = await backgroundPill()

      expect(wrapper.find('[data-dock="mini"]').exists()).toBe(true)
    })

    it('does not offer the mini player inside the reader', async () => {
      useNarrationDockLayout().setMini(true)
      const wrapper = await startNarration()

      expect(wrapper.find('[data-dock="pill"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="collapse-to-mini"]').exists()).toBe(false)
    })

    it("does not offer the mini player in another book's reader, but still names the narrated book", async () => {
      useNarrationDockLayout().setMini(true)
      useTtsMiniPlayerUi().setReaderOpen(true)
      const wrapper = await backgroundPill()
      useMediaOverlay().currentBook.value = { title: 'Other Book', author: 'Someone', coverUrl: null } as never
      await wrapper.vm.$nextTick()

      expect(wrapper.find('[data-dock="mini"]').exists()).toBe(false)
      expect(wrapper.find('[data-dock="pill"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="collapse-to-mini"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="background-now-playing"]').text()).toContain('Other Book')
      useMediaOverlay().currentBook.value = null
    })
  })

  describe('on a wide screen', () => {
    beforeEach(() => {
      vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: query.includes('min-width'),
            media: query,
            addEventListener: vi.fn<() => void>(),
            removeEventListener: vi.fn<() => void>(),
          }) as unknown as MediaQueryList,
      )
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    async function backgroundPill() {
      const wrapper = await startNarration()
      useMediaOverlay().isBackground.value = true
      await wrapper.vm.$nextTick()
      const dock = wrapper.find('[data-dock="pill"]').element
      vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue({
        left: 400,
        width: 300,
        right: 700,
        top: 0,
        bottom: 0,
        height: 0,
        x: 400,
        y: 0,
      } as DOMRect)
      return wrapper
    }

    function firePointer(target: { element: Element }, type: string, x: number) {
      target.element.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x }))
    }

    it('offers no mini player and keeps the pill centred by default', async () => {
      const wrapper = await backgroundPill()

      expect(wrapper.find('[data-test="collapse-to-mini"]').exists()).toBe(false)
      expect(wrapper.find('[data-dock="pill"]').classes()).toContain('left-1/2')
    })

    it('snaps to the nearest side after a drag and remembers it', async () => {
      const wrapper = await backgroundPill()
      const play = wrapper.find('[aria-label="Pause narration"]')

      firePointer(play, 'pointerdown', 500)
      firePointer(play, 'pointermove', 900)
      firePointer(play, 'pointerup', 900)
      await flushPromises()

      expect(wrapper.find('[data-dock="pill"]').classes()).toContain('right-6')
      expect(localStorage.getItem('bookorbit.narration.dockSide')).toBe('right')

      firePointer(play, 'pointerdown', 900)
      firePointer(play, 'pointermove', 100)
      firePointer(play, 'pointerup', 100)
      await flushPromises()

      expect(wrapper.find('[data-dock="pill"]').classes()).toContain('left-6')
      expect(localStorage.getItem('bookorbit.narration.dockSide')).toBe('left')
    })

    it('follows a drag whose pointer leaves the pill before the threshold', async () => {
      const wrapper = await backgroundPill()
      const play = wrapper.find('[aria-label="Pause narration"]')
      const outside = { element: document.body }

      firePointer(play, 'pointerdown', 500)
      firePointer(outside, 'pointermove', 900)
      firePointer(outside, 'pointerup', 900)
      await flushPromises()

      expect(wrapper.find('[data-dock="pill"]').classes()).toContain('right-6')
    })

    it('does not treat a drag as a click on the button it started on', async () => {
      const wrapper = await backgroundPill()
      const play = wrapper.find('[aria-label="Pause narration"]')

      firePointer(play, 'pointerdown', 500)
      firePointer(play, 'pointermove', 900)
      firePointer(play, 'pointerup', 900)
      await play.trigger('click')

      expect(useMediaOverlay().toggle).not.toHaveBeenCalled()
    })

    it('still treats a press without movement as a click', async () => {
      const wrapper = await backgroundPill()
      const play = wrapper.find('[aria-label="Pause narration"]')

      firePointer(play, 'pointerdown', 500)
      firePointer(play, 'pointermove', 503)
      firePointer(play, 'pointerup', 503)
      await play.trigger('click')

      expect(useMediaOverlay().toggle).toHaveBeenCalledOnce()
      expect(localStorage.getItem('bookorbit.narration.dockSide')).toBeNull()
    })

    it('opens the player on the same side as the pill', async () => {
      useNarrationDockLayout().side.value = 'right'
      const wrapper = await backgroundPill()

      expect(wrapper.find('[data-dock="pill"]').classes()).toContain('right-6')
      await wrapper.find('[data-test="background-now-playing"]').trigger('click')
      expect(wrapper.find('[data-test="full-player"]').exists()).toBe(true)
    })

    it('never moves the pill inside the reader', async () => {
      useNarrationDockLayout().side.value = 'right'
      const wrapper = await startNarration()

      expect(wrapper.find('[data-dock="pill"]').classes()).toContain('left-1/2')
    })

    it("keeps the pill fixed, in the reader frame and without page clearance in another book's reader", async () => {
      useNarrationDockLayout().side.value = 'right'
      useTtsMiniPlayerUi().setReaderOpen(true)
      const wrapper = await backgroundPill()
      const dock = wrapper.find('[data-dock="pill"]')

      expect(dock.classes()).toContain('left-1/2')
      expect(dock.classes()).not.toContain('right-6')
      expect(dock.find('.cursor-grab').exists()).toBe(false)
      expect(dock.find('.bg-card').exists()).toBe(true)
      expect(document.documentElement.style.getPropertyValue('--narration-dock-clearance')).toBe('')
      expect(document.documentElement.style.getPropertyValue('--narration-dock-right-clearance')).toBe('')
    })

    it('does not swallow a later keyboard activation after a drag that produced no click', async () => {
      vi.useFakeTimers()
      try {
        const wrapper = await backgroundPill()
        const play = wrapper.find('[aria-label="Pause narration"]')

        firePointer(play, 'pointerdown', 500)
        firePointer(play, 'pointermove', 900)
        firePointer(play, 'pointerup', 900)
        await vi.advanceTimersByTimeAsync(10)
        await play.trigger('click')

        expect(useMediaOverlay().toggle).toHaveBeenCalledOnce()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
