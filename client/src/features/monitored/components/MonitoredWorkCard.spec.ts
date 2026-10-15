import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('shows the title on a first tap with a finger and opens the panel from the overlay', async () => {
    stubPointer(true)
    const wrapper = mountInfo()

    await wrapper.get('[data-testid="cover-button"]').trigger('click')
    expect(wrapper.emitted('preview')).toBeUndefined()
    expect(wrapper.get('[data-testid="info-overlay"]').classes()).toContain('opacity-100')

    await wrapper.get('[data-testid="overlay-open"]').trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(1)
    wrapper.unmount()
  })

  it('hides the overlay again on a second tap or a tap outside the card', async () => {
    stubPointer(true)
    const wrapper = mount(MonitoredWorkCard, {
      attachTo: document.body,
      props: { work: work(), queued: false, ebookQueued: false, audiobookQueued: false, canManage: true },
      global: {
        stubs: { DropdownMenu: passthrough, DropdownMenuTrigger: passthrough, DropdownMenuContent: passthrough, DropdownMenuItem: passthrough },
      },
    })

    await wrapper.get('[data-testid="cover-button"]').trigger('click')
    await wrapper.get('[data-testid="cover-button"]').trigger('click')
    expect(wrapper.get('[data-testid="info-overlay"]').classes()).toContain('opacity-0')

    await wrapper.get('[data-testid="cover-button"]').trigger('click')
    document.body.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="info-overlay"]').classes()).toContain('opacity-0')
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
