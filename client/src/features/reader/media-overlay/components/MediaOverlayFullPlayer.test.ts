import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import type { TocItem } from '@/features/reader/epub/composables/useToc'
import MediaOverlayFullPlayer from './MediaOverlayFullPlayer.vue'
import { useMediaOverlay } from '../composables/useMediaOverlay'
import { registerNarrationChapters } from '../composables/useNarrationChapters'
import { useNarrationSleep } from '../composables/useNarrationSleep'

const push = vi.fn<(to: unknown) => Promise<void>>().mockResolvedValue(undefined)
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

vi.mock('../composables/useMediaOverlay', async () => {
  const { ref } = await import('vue')
  const state = {
    isActive: ref(true),
    isPlaying: ref(true),
    isWaitingForAudio: ref(false),
    isDetached: ref(false),
    isBackground: ref(false),
    rate: ref(1),
    currentBook: ref({ bookId: 7, bookFileId: 9, title: 'Book', author: 'Author' }),
    error: ref<string | null>(null),
    currentFragment: ref<string | null>('c1.xhtml#s1'),
    positionSeconds: ref<number | null>(null),
    durationSeconds: ref<number | null>(null),
    seekTo: vi.fn<(seconds: number) => void>(),
    toggle: vi.fn<() => void>(),
    pause: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
    nextSentence: vi.fn<() => void>(),
    prevSentence: vi.fn<() => void>(),
    setRate: vi.fn<(rate: number) => void>(),
    narrateFromHere: vi.fn<() => void>(),
    returnToNarration: vi.fn<() => void>(),
    sleepTimer: {
      activeMinutes: ref<number | null>(null),
      remainingSeconds: ref<number | null>(null),
      presets: [5, 15],
      startTimer: vi.fn<(minutes: number) => void>(),
      cancelTimer: vi.fn<() => void>(),
    },
  }
  return { useMediaOverlay: () => state }
})

// Reka menus portal their content and only open on real pointer sequences; these stand-ins render
// every item and select it on click so the player's own wiring is what gets exercised.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const { defineComponent, h, inject, provide } = await import('vue')
  const passthrough = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h('div', slots.default?.()),
  })
  const GROUP = Symbol('group')
  const DropdownMenuRadioGroup = defineComponent({
    props: { modelValue: { type: String, default: undefined } },
    emits: ['update:modelValue'],
    setup(_, { emit, slots }) {
      provide(GROUP, (value: string) => emit('update:modelValue', value))
      return () => h('div', slots.default?.())
    },
  })
  const DropdownMenuRadioItem = defineComponent({
    props: { value: { type: String, required: true } },
    emits: ['select'],
    setup(props, { emit, slots }) {
      const update = inject<(value: string) => void>(GROUP)!
      return () =>
        h(
          'div',
          {
            role: 'menuitemradio',
            onClick: () => {
              emit('select', new Event('select'))
              update(props.value)
            },
          },
          slots.default?.(),
        )
    },
  })
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuLabel: passthrough,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
  }
})

const TOC: TocItem[] = [
  { label: 'Chapter 1', href: 'c1.xhtml' },
  { label: 'Chapter 2', href: 'c2.xhtml' },
]
const SECTIONS: Record<string, number> = { 'c1.xhtml': 1, 'c2.xhtml': 2 }

enableAutoUnmount(afterEach)

function menuItem(wrapper: VueWrapper, text: string) {
  const item = wrapper.findAll('[role="menuitemradio"]').find((candidate) => candidate.text() === text)
  if (!item) throw new Error(`No menu item "${text}"`)
  return item
}

describe('MediaOverlayFullPlayer', () => {
  const playSection = vi.fn<(section: number) => void>()
  let unregister: () => void

  beforeEach(() => {
    const state = useMediaOverlay()
    playSection.mockClear()
    vi.mocked(state.setRate).mockClear()
    vi.mocked(state.sleepTimer.startTimer).mockClear()
    vi.mocked(state.sleepTimer.cancelTimer).mockClear()
    useNarrationSleep().select('off')
    unregister = registerNarrationChapters({
      toc: ref(TOC),
      resolveSectionIndex: (href) => SECTIONS[href.split('#')[0]!],
      hasNarration: () => true,
      playSection,
    })
  })

  afterEach(() => {
    unregister()
  })

  it('plays the picked chapter, including the one already playing', async () => {
    const wrapper = mount(MediaOverlayFullPlayer)

    await menuItem(wrapper, 'Chapter 2').trigger('click')
    await menuItem(wrapper, 'Chapter 1').trigger('click')

    expect(playSection.mock.calls).toEqual([[2], [1]])
  })

  it('sets the picked speed', async () => {
    const wrapper = mount(MediaOverlayFullPlayer)

    await menuItem(wrapper, '1.5x').trigger('click')

    expect(useMediaOverlay().setRate).toHaveBeenCalledWith(1.5)
  })

  it('sets a sleep timer, end of chapter, or off', async () => {
    const wrapper = mount(MediaOverlayFullPlayer)
    const timer = useMediaOverlay().sleepTimer

    await menuItem(wrapper, '15 minutes').trigger('click')
    expect(timer.startTimer).toHaveBeenCalledWith(15)

    await menuItem(wrapper, 'End of chapter').trigger('click')
    expect(useNarrationSleep().mode.value).toBe('chapter')
    expect(wrapper.find('[aria-label="Sleep timer: End of chapter"]').exists()).toBe(true)

    vi.mocked(timer.cancelTimer).mockClear()
    await menuItem(wrapper, 'Off').trigger('click')
    expect(timer.cancelTimer).toHaveBeenCalledOnce()
    expect(useNarrationSleep().mode.value).toBe('off')
    expect(wrapper.find('[aria-label="Sleep timer"]').exists()).toBe(true)
  })

  it('shows a spinner on the play button while audio is loading', async () => {
    const waiting = useMediaOverlay().isWaitingForAudio as Ref<boolean>
    waiting.value = true
    const wrapper = mount(MediaOverlayFullPlayer)

    const button = wrapper.find('[aria-label="Loading narration audio"]')
    expect(button.exists()).toBe(true)
    expect(button.find('.animate-spin').exists()).toBe(true)
    waiting.value = false
  })

  it('shows where narration is in the whole book and how long is left at the chosen speed', async () => {
    const state = useMediaOverlay()
    const wrapper = mount(MediaOverlayFullPlayer)
    expect(wrapper.find('[aria-label="Position in book"]').exists()).toBe(false)

    state.positionSeconds.value = 600
    state.durationSeconds.value = 3600
    state.rate.value = 1.5
    await wrapper.vm.$nextTick()
    const scrubber = wrapper.find('[aria-label="Position in book"]')
    expect(scrubber.exists()).toBe(true)
    expect(wrapper.text()).toContain('10:00')
    expect(wrapper.text()).toContain('33:20 left')

    await scrubber.trigger('keydown', { key: 'End' })
    expect(state.seekTo).toHaveBeenCalledWith(3600)
    state.positionSeconds.value = null
    state.durationSeconds.value = null
    state.rate.value = 1
  })

  it('offers to open the book only while narrating in the background', async () => {
    const background = useMediaOverlay().isBackground as Ref<boolean>
    push.mockClear()
    const wrapper = mount(MediaOverlayFullPlayer)
    expect(wrapper.find('[aria-label="Open book"]').exists()).toBe(false)

    background.value = true
    await wrapper.vm.$nextTick()
    await wrapper.find('[aria-label="Open book"]').trigger('click')

    expect(push).toHaveBeenCalledWith({ name: 'reader', params: { bookId: '7', fileId: '9' } })
    expect(wrapper.emitted('minimise')).toHaveLength(1)
    background.value = false
  })

  it('asks to be minimised', async () => {
    const wrapper = mount(MediaOverlayFullPlayer)

    await wrapper.find('[aria-label="Minimise player"]').trigger('click')

    expect(wrapper.emitted('minimise')).toHaveLength(1)
  })
})
