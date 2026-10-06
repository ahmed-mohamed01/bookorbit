import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import MediaOverlayDock from './MediaOverlayDock.vue'
import { useMediaOverlay } from '../composables/useMediaOverlay'
import { useTtsMiniPlayerUi } from '@/features/tts/composables/useTtsMiniPlayerUi'

vi.mock('../composables/useMediaOverlay', async () => {
  const { ref } = await import('vue')
  const state = {
    isActive: ref(false),
    isPlaying: ref(false),
    isDetached: ref(false),
    error: ref<string | null>(null),
    currentFragment: ref<string | null>(null),
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
    state.isDetached.value = false
    state.error.value = null
    vi.mocked(state.toggle).mockClear()
    useTtsMiniPlayerUi().setReaderFooterVisible(true)
  })

  async function startNarration() {
    const wrapper = mountDock()
    useMediaOverlay().isActive.value = true
    await wrapper.vm.$nextTick()
    return wrapper
  }

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
})
