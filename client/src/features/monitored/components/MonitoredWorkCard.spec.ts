import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { MonitoredWork } from '@bookorbit/types'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import MonitoredWorkCard from './MonitoredWorkCard.vue'

const passthrough = { template: '<div><slot /></div>' }

function work(overrides: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'work-1',
    title: 'A Book',
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: null,
    ebookReleaseDate: null,
    ebookDatePrecision: null,
    audioReleaseDate: null,
    audioDatePrecision: null,
    coverUrl: null,
    description: null,
    verdict: 'verified',
    flags: [],
    sources: [],
    providerWorkIds: {},
    monitorState: 'monitoring',
    matchedBookId: null,
    ownedFormats: [],
    requestIds: {},
    ...overrides,
  }
}

function mountCard(cardWork: MonitoredWork, ebookQueued = false) {
  return mount(MonitoredWorkCard, {
    props: {
      work: cardWork,
      queued: ebookQueued,
      ebookQueued,
      audiobookQueued: false,
      canManage: true,
    },
    global: {
      stubs: {
        DropdownMenu: passthrough,
        DropdownMenuTrigger: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuItem: passthrough,
        DropdownMenuSeparator: true,
      },
    },
  })
}

describe('MonitoredWorkCard queued badge', () => {
  it('does not show queued when a requested ebook is owned', () => {
    const wrapper = mountCard(work({ requestIds: { ebook: 41 }, ownedFormats: ['ebook'] }))

    expect(wrapper.text()).not.toContain('Queued')
    wrapper.unmount()
  })

  it('shows queued while a requested ebook is not owned', () => {
    const wrapper = mountCard(work({ requestIds: { ebook: 41 }, requestStatuses: { ebook: 'grabbed' } }))

    expect(wrapper.text()).toContain('Queued')
    wrapper.unmount()
  })

  it('shows the current transfer phase instead of a generic queued badge', () => {
    const wrapper = mountCard(work({ requestIds: { ebook: 41 }, requestStatuses: { ebook: 'downloading' } }))

    expect(wrapper.text()).toContain('Downloading')
    expect(wrapper.text()).not.toContain('Queued')
    wrapper.unmount()
  })

  it('does not treat a terminal request id as queued', () => {
    const wrapper = mountCard(work({ requestIds: { ebook: 41 }, requestStatuses: { ebook: 'failed' } }))

    expect(wrapper.text()).not.toContain('Queued')
    wrapper.unmount()
  })

  it('does not show queued when the optimistic ebook flag is set after ownership lands', () => {
    const wrapper = mountCard(work({ ownedFormats: ['ebook'] }), true)

    expect(wrapper.text()).not.toContain('Queued')
    wrapper.unmount()
  })
})

describe('MonitoredWorkCard review kind badge', () => {
  it('names what a review work is, so a comic and a box set are not both just suspect', () => {
    const wrapper = mountCard(work({ verdict: 'suspect', kind: 'graphic_novel' }))

    expect(wrapper.text()).toContain('Comic')
    wrapper.unmount()
  })

  it('says nothing on a work the default list already shows', () => {
    // A kind can survive a promotion, and shouting a stale judgement over an accepted book is noise.
    const wrapper = mountCard(work({ verdict: 'suspect', kind: 'collection', userVisibility: 'visible' }))

    expect(wrapper.text()).not.toContain('Collection')
    wrapper.unmount()
  })

  it('marks an unnamed review work as unverified rather than leaving it bare', () => {
    const wrapper = mountCard(work({ verdict: 'probable' }))

    expect(wrapper.text()).toContain('Unverified')
    wrapper.unmount()
  })

  it('says nothing on a work the owner hid, whatever its verdict was', () => {
    // Hiding is the owner's own call and has its own switch; badging it from the review
    // vocabulary reads as a verdict the reconciler never reached.
    const wrapper = mountCard(work({ verdict: 'verified', userVisibility: 'hidden' }))

    expect(wrapper.text()).not.toContain('Unverified')
    wrapper.unmount()
  })

  it('says nothing on a placeholder, which has a switch of its own too', () => {
    const wrapper = mountCard(work({ verdict: 'probable', flags: ['placeholder'] }))

    expect(wrapper.text()).not.toContain('Unverified')
    wrapper.unmount()
  })
})

describe('MonitoredWorkCard cover badges', () => {
  function badges(cardWork: MonitoredWork) {
    const wrapper = mountCard(cardWork)
    const found = wrapper
      .findAll('[data-badge]')
      .map((badge) => ({ kind: badge.attributes('data-badge'), format: badge.attributes('data-format'), text: badge.text() }))
    wrapper.unmount()
    return found
  }

  it('shows an icon badge for every watched format, upcoming ones included', () => {
    const found = badges(
      work({ ebookReleaseDate: '2099-04-10', ebookDatePrecision: 'day', audioReleaseDate: '2020-05-06', audioDatePrecision: 'day' }),
    )

    expect(found).toHaveLength(2)
    expect(found[0]).toMatchObject({ kind: 'upcoming', format: 'ebook' })
    expect(found[1]).toMatchObject({ kind: 'missing', format: 'audiobook' })
  })

  it('marks owned and in-flight formats', () => {
    const [ebook, audiobook] = badges(
      work({
        ownedFormats: ['ebook'],
        matchedBookIds: { ebook: 1 },
        requestIds: { audiobook: 3 },
        requestStatuses: { audiobook: 'downloading' },
      }),
    )

    expect(ebook?.kind).toBe('owned')
    expect(audiobook?.kind).toBe('downloading')
  })

  it('wears no badge for a format nobody watches', () => {
    const found = badges(work({ ebookReleaseDate: '2020-01-01', monitorFormats: { ebook: false } }))

    expect(found.find((badge) => badge.format === 'ebook')).toBeUndefined()
  })

  it('does not dim a work that is fully in the library', () => {
    const wrapper = mountCard(work({ ownedFormats: ['ebook', 'audiobook'], matchedBookIds: { ebook: 1, audiobook: 2 } }))

    expect(wrapper.get('article').attributes('data-owned')).toBe('true')
    expect(wrapper.html()).not.toContain('brightness-75')
    wrapper.unmount()
  })

  it('dims a work whose every format is not watched', () => {
    const wrapper = mountCard(work({ monitorFormats: { ebook: false, audiobook: false } }))

    expect(wrapper.get('article').attributes('data-not-watched')).toBe('true')
    expect(wrapper.html()).toContain('brightness-75')
    wrapper.unmount()
  })

  it('fades a hidden work and swaps the time pill for the eye-off mark', () => {
    const wrapper = mountCard(work({ userVisibility: 'hidden' }))

    expect(wrapper.get('article').classes()).toContain('opacity-45')
    expect(wrapper.find('[data-testid="hidden-mark"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="time-badge"]').exists()).toBe(false)
    wrapper.unmount()
  })

  function mountCover(props: { work: MonitoredWork } & Record<string, unknown>) {
    return mount(MonitoredWorkCard, {
      props: {
        queued: false,
        ebookQueued: false,
        audiobookQueued: false,
        canManage: false,
        timeBadge: { label: 'in 106 days', upcoming: true },
        authorName: 'A Writer',
        ...props,
      },
      global: {
        stubs: { DropdownMenu: passthrough, DropdownMenuTrigger: passthrough, DropdownMenuContent: passthrough, DropdownMenuItem: passthrough },
      },
    })
  }

  it('names the series on the cover outside a series group, and shows title, author and series on hover', () => {
    const wrapper = mountCover({ work: work({ seriesIndex: '6', seriesMemberships: [{ name: 'Ends of Magic', index: '6' }] }) })

    expect(wrapper.get('[data-testid="time-badge"]').text()).toBe('in 106 days')
    expect(wrapper.find('[data-testid="series-badge"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="series-line"]').text()).toBe('#6 · Ends of Magic')
    expect(wrapper.get('[data-testid="hover-title"]').text()).toBe('A Book')
    expect(wrapper.get('[data-testid="hover-author"]').text()).toBe('A Writer')
    expect(wrapper.get('[data-testid="hover-series"]').text()).toBe('#6 · Ends of Magic')
    expect(wrapper.text()).not.toMatch(/\d{4}/)
    wrapper.unmount()
  })

  it('always names the series with its number, even when the title repeats it', () => {
    const wrapper = mountCover({ work: work({ title: 'The Primal Hunter 15', seriesMemberships: [{ name: 'The Primal Hunter', index: '15' }] }) })

    expect(wrapper.get('[data-testid="series-line"]').text()).toBe('#15 · The Primal Hunter')
    wrapper.unmount()
  })

  it('keeps only the number inside a series group, where the heading names the series', () => {
    const wrapper = mountCover({
      work: work({ seriesIndex: '3', seriesMemberships: [{ name: 'Ends of Magic', index: '3' }] }),
      seriesMembership: { name: 'Ends of Magic', index: '3' },
    })

    expect(wrapper.get('[data-testid="series-badge"]').text()).toBe('#3')
    expect(wrapper.find('[data-testid="series-line"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('MonitoredWorkCard time pill', () => {
  function mountWith(timeBadge: { label: string; upcoming: boolean } | undefined, cardWork: MonitoredWork = work()) {
    return mount(MonitoredWorkCard, {
      props: { work: cardWork, queued: false, ebookQueued: false, audiobookQueued: false, canManage: false, timeBadge },
      global: {
        stubs: { DropdownMenu: passthrough, DropdownMenuTrigger: passthrough, DropdownMenuContent: passthrough, DropdownMenuItem: passthrough },
      },
    })
  }

  it('takes its colour from the badge it was handed, not from the work the card shows', () => {
    const past = work({ ebookReleaseDate: '2020-01-01', ebookDatePrecision: 'day' })
    const upcoming = mountWith({ label: 'in 7 days', upcoming: true }, past)
    const released = mountWith({ label: '80 days ago', upcoming: false }, work({ ebookReleaseDate: '2099-01-01', ebookDatePrecision: 'day' }))

    expect(upcoming.get('[data-testid="time-badge"]').classes()).toContain('bg-[var(--pill-warning)]')
    expect(upcoming.get('[data-testid="time-badge"]').attributes('data-tone')).toBe('upcoming')
    expect(released.get('[data-testid="time-badge"]').classes()).toContain('bg-[var(--pill-info)]')
    expect(released.get('[data-testid="time-badge"]').attributes('data-tone')).toBe('released')
    upcoming.unmount()
    released.unmount()
  })

  it('works label and colour out of the same date when no badge is handed in', () => {
    const wrapper = mountWith(undefined, work({ ebookReleaseDate: '2099-01-01', ebookDatePrecision: 'day' }))
    const badge = wrapper.get('[data-testid="time-badge"]')

    expect(badge.text()).toMatch(/^in [\d,]+ days$/)
    expect(badge.classes()).toContain('bg-[var(--pill-warning)]')
    wrapper.unmount()
  })
})

describe('MonitoredWorkCard card info mode', () => {
  const { cardInfoMode } = useDisplaySettings()

  afterEach(() => {
    cardInfoMode.value = 'hover-overlay'
    vi.unstubAllGlobals()
  })

  function mountInfo(authorName: string | null = 'A Writer') {
    return mount(MonitoredWorkCard, {
      props: { work: work(), queued: false, ebookQueued: false, audiobookQueued: false, canManage: true, authorName },
      global: {
        stubs: { DropdownMenu: passthrough, DropdownMenuTrigger: passthrough, DropdownMenuContent: passthrough, DropdownMenuItem: passthrough },
      },
    })
  }

  function stubPointer(coarse: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: coarse && query.includes('coarse'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
  }

  it('stays cover-only with hover info by default, and respects reduced motion on the hover scale', () => {
    stubPointer(false)
    const wrapper = mountInfo()

    expect(wrapper.find('[data-testid="below-cover-label"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="info-overlay"]').exists()).toBe(true)
    expect(wrapper.get('article > div').classes()).toContain('motion-reduce:group-hover:scale-100')
    wrapper.unmount()
  })

  it('puts the title and author under the cover in below-cover mode and drops the hover overlay', () => {
    stubPointer(false)
    cardInfoMode.value = 'below-cover'
    const wrapper = mountInfo()

    expect(wrapper.get('[data-testid="below-cover-label"]').text()).toContain('A Book')
    expect(wrapper.get('[data-testid="below-cover-label"]').text()).toContain('A Writer')
    expect(wrapper.find('[data-testid="info-overlay"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens the panel straight from the cover with a mouse', async () => {
    stubPointer(false)
    const wrapper = mountInfo()

    await wrapper.get('[data-testid="cover-button"]').trigger('click')

    expect(wrapper.emitted('preview')).toHaveLength(1)
    wrapper.unmount()
  })

  it('opens the panel on a single tap with a finger, with no overlay step in between', async () => {
    stubPointer(true)
    const wrapper = mountInfo()

    await wrapper.get('[data-testid="cover-button"]').trigger('click')

    expect(wrapper.emitted('preview')).toHaveLength(1)
    expect(wrapper.find('[data-testid="overlay-open"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lets a finger open the panel directly in below-cover mode, where the title is already visible', async () => {
    stubPointer(true)
    cardInfoMode.value = 'below-cover'
    const wrapper = mountInfo()

    await wrapper.get('[data-testid="cover-button"]').trigger('click')

    expect(wrapper.emitted('preview')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('MonitoredWorkCard select mode', () => {
  function mountSelectable(props: { selected?: boolean; selectable?: boolean } = {}) {
    const wrapper = mountCard(work({ title: 'Revenger', seriesMemberships: [], seriesIndex: '2' }))
    return wrapper.setProps({ selectionMode: true, ...props }).then(() => wrapper)
  }

  it('emits select with the click event from anywhere on the cover', async () => {
    const wrapper = await mountSelectable()

    await wrapper.get('[data-testid="cover-button"]').trigger('click', { shiftKey: true })

    const emitted = wrapper.emitted('select') ?? []
    const [picked, event] = emitted[0] as [MonitoredWork, MouseEvent]
    expect(picked.id).toBe('work-1')
    expect(event.shiftKey).toBe(true)
    expect(wrapper.emitted('preview')).toBeUndefined()
    wrapper.unmount()
  })

  it('labels the cover for select mode and reflects the state', async () => {
    const wrapper = await mountSelectable()
    const cover = wrapper.get('[data-testid="cover-button"]')
    expect(cover.attributes('aria-label')).toBe('Select Revenger')
    expect(cover.attributes('aria-pressed')).toBe('false')

    await wrapper.setProps({ selected: true })

    expect(cover.attributes('aria-label')).toBe('Deselect Revenger')
    expect(cover.attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="select-box"] svg').exists()).toBe(true)
    wrapper.unmount()
  })

  it('swaps the time pill and menus for the checkbox overlay and keeps the series pill', async () => {
    const wrapper = mountCard(work({ ebookReleaseDate: '2999-01-01' }))
    await wrapper.setProps({ seriesMembership: { name: 'Series', index: '2' } })
    expect(wrapper.find('[data-testid="time-badge"]').exists()).toBe(true)

    await wrapper.setProps({ selectionMode: true })

    expect(wrapper.find('[data-testid="time-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="select-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="series-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="info-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label^="Actions for"], [aria-label*="menu"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the format badges in select mode and drops only the time pill and kind label', async () => {
    const wrapper = mountCard(work({ ebookReleaseDate: '2099-04-10', ebookDatePrecision: 'day', verdict: 'probable' }))
    expect(wrapper.find('[data-testid="time-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-badge]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Unverified')

    await wrapper.setProps({ selectionMode: true })

    expect(wrapper.find('[data-testid="time-badge"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Unverified')
    expect(wrapper.find('[data-badge]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps the hidden mark in select mode', async () => {
    const wrapper = mountCard(work({ userVisibility: 'hidden' }))

    await wrapper.setProps({ selectionMode: true })

    expect(wrapper.find('[data-testid="hidden-mark"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('ignores clicks on a card the viewer cannot select', async () => {
    const wrapper = await mountSelectable({ selectable: false })
    const cover = wrapper.get('[data-testid="cover-button"]')

    expect(cover.attributes('disabled')).toBeDefined()
    await cover.trigger('click')

    expect(wrapper.emitted('select')).toBeUndefined()
    wrapper.unmount()
  })

  it('still opens the preview outside select mode', async () => {
    const wrapper = mountCard(work())

    await wrapper.get('[data-testid="cover-button"]').trigger('click')

    expect(wrapper.emitted('preview')).toHaveLength(1)
    expect(wrapper.get('[data-testid="cover-button"]').attributes('aria-pressed')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('MonitoredWorkCard long press select', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function mountLongPress(props: { longPressSelect?: boolean; selectionMode?: boolean } = {}) {
    return mount(MonitoredWorkCard, {
      props: {
        work: work(),
        queued: false,
        ebookQueued: false,
        audiobookQueued: false,
        canManage: true,
        longPressSelect: true,
        ...props,
      },
      global: {
        stubs: { DropdownMenu: passthrough, DropdownMenuTrigger: passthrough, DropdownMenuContent: passthrough, DropdownMenuItem: passthrough },
      },
    })
  }

  async function pressAndRelease(wrapper: ReturnType<typeof mountLongPress>, holdMs: number) {
    // onLongPress attaches its pointer listeners in a post-flush watcher, so the mount must flush first.
    await wrapper.vm.$nextTick()
    const cover = wrapper.get('[data-testid="cover-button"]')
    await cover.trigger('pointerdown')
    vi.advanceTimersByTime(holdMs)
    await cover.trigger('pointerup')
    await cover.trigger('click')
  }

  it('emits longPress on a 500ms press and swallows the click the release produces', async () => {
    const wrapper = mountLongPress()

    await pressAndRelease(wrapper, 500)

    expect(wrapper.emitted('longPress')).toHaveLength(1)
    expect(wrapper.emitted('preview')).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps working in select mode when a touch long press ends without a click', async () => {
    const wrapper = mountLongPress()
    await wrapper.vm.$nextTick()
    const cover = wrapper.get('[data-testid="cover-button"]')

    await cover.trigger('pointerdown')
    vi.advanceTimersByTime(500)
    await cover.trigger('pointerup')
    expect(wrapper.emitted('longPress')).toHaveLength(1)

    // The long press entered select mode with this card picked; a click straight after the release
    // is still the same gesture and must not toggle the card back off.
    await wrapper.setProps({ selectionMode: true, selected: true })
    await cover.trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()

    vi.advanceTimersByTime(301)
    await cover.trigger('click')

    expect(wrapper.emitted('select')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps a short click opening the preview', async () => {
    const wrapper = mountLongPress()

    await pressAndRelease(wrapper, 100)

    expect(wrapper.emitted('longPress')).toBeUndefined()
    expect(wrapper.emitted('preview')).toHaveLength(1)
    wrapper.unmount()
  })

  it('stays inert on a long press when the prop is off, and the release still opens the preview', async () => {
    const wrapper = mountLongPress({ longPressSelect: false })

    await pressAndRelease(wrapper, 500)

    expect(wrapper.emitted('longPress')).toBeUndefined()
    expect(wrapper.emitted('preview')).toHaveLength(1)
    wrapper.unmount()
  })

  it('does not emit longPress in select mode', async () => {
    const wrapper = mountLongPress({ selectionMode: true })

    await pressAndRelease(wrapper, 500)

    expect(wrapper.emitted('longPress')).toBeUndefined()
    expect(wrapper.emitted('select')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps the browser callout off the cover only while the prop is on', () => {
    const on = mountLongPress()
    const prevented = new MouseEvent('contextmenu', { cancelable: true })
    on.get('[data-testid="cover-button"]').element.dispatchEvent(prevented)
    expect(prevented.defaultPrevented).toBe(true)
    on.unmount()

    const off = mountLongPress({ longPressSelect: false })
    const untouched = new MouseEvent('contextmenu', { cancelable: true })
    off.get('[data-testid="cover-button"]').element.dispatchEvent(untouched)
    expect(untouched.defaultPrevented).toBe(false)
    off.unmount()
  })
})
