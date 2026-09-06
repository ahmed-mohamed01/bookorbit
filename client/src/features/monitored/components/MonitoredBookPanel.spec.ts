import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { MonitoredWork, ReleaseCandidateItem } from '@bookorbit/types'
import MonitoredBookPanel from './MonitoredBookPanel.vue'
import MonitoredFormatPill from './MonitoredFormatPill.vue'
import MonitoredRequestProgress from './MonitoredRequestProgress.vue'
import ReleaseResultRow from './ReleaseResultRow.vue'
import { useMonitoredReleases } from '../composables/useMonitoredReleases'

vi.mock('../composables/useMonitoredReleases', () => ({ useMonitoredReleases: vi.fn<() => unknown>() }))
const bookDetailFetchMocks = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>)
vi.mock('@/features/book/composables/useBookDetail', async () => {
  const { ref: reactiveRef } = await import('vue')
  return {
    useBookDetail: () => {
      const fetch = vi.fn<() => Promise<void>>()
      bookDetailFetchMocks.push(fetch)
      return {
        detail: reactiveRef(null),
        loading: reactiveRef(false),
        error: reactiveRef(null),
        notFound: reactiveRef(false),
        fetch,
      }
    },
  }
})

const useReleasesMock = vi.mocked(useMonitoredReleases)
const grabMock = vi.fn<(release: ReleaseCandidateItem) => Promise<number | null>>()

const baseWork: MonitoredWork = {
  id: 'work-1',
  title: 'The Long Wait',
  subtitle: null,
  seriesName: null,
  seriesIndex: null,
  seriesMemberships: [],
  releaseYear: 2026,
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
}

const releasedWork: MonitoredWork = {
  ...baseWork,
  ebookReleaseDate: '2020-01-02',
  ebookDatePrecision: 'day',
  audioReleaseDate: '2020-01-03',
  audioDatePrecision: 'day',
}

const release: ReleaseCandidateItem = {
  indexerId: 7,
  indexerName: 'An Indexer',
  guid: 'release-1',
  title: 'The Long Wait (2026) [EPUB]',
  sizeBytes: 1024,
  seeders: 12,
  leechers: 1,
  format: 'epub',
  formats: ['epub'],
  language: 'en',
  fileCount: 1,
  freeleech: false,
  vipOnly: false,
  alreadyGrabbed: false,
  publishedAt: null,
  audio: null,
  score: 71,
  tier: null,
  tierName: null,
  reasons: [],
}

/** Stand-in for the composable the panel drives, with the release list already searched. */
function fakeReleases() {
  return {
    releases: ref<ReleaseCandidateItem[]>([]),
    loading: ref(false),
    searched: ref(true),
    error: ref<string | null>(null),
    isGrabbing: () => false,
    isGrabbed: () => false,
    search: vi.fn<() => Promise<void>>(),
    grab: grabMock,
  }
}

// The sheet teleports its content out of the wrapper, and none of this test is about the overlay.
const passthrough = { template: '<div><slot /></div>' }

/**
 * The progress block is stubbed so the panel's own wiring is what is under test: which request id
 * it hands over, and where it puts the block. What the block then renders is its own business, and
 * it opens a socket to do it.
 */
async function mountPanel(work: MonitoredWork = baseWork, releases: ReleaseCandidateItem[] = [release], tabLabel: string | null = 'Ebook releases') {
  const wrapper = mount(MonitoredBookPanel, {
    props: { work, authorName: 'A Writer', canManage: true, open: true },
    global: {
      stubs: {
        Sheet: passthrough,
        SheetContent: passthrough,
        SheetTitle: passthrough,
        SheetDescription: passthrough,
        MonitoredRequestProgress: true,
        RouterLink: true,
      },
    },
  })
  // The work watcher clears the release state on mount, so the list is filled after that runs.
  if (tabLabel) {
    const tab = wrapper.findAll('button').find((button) => button.text() === tabLabel)
    await tab?.trigger('click')
  }
  const source = useReleasesMock.mock.results[0]?.value as ReturnType<typeof fakeReleases>
  source.releases.value = releases
  await nextTick()
  return wrapper
}

describe('MonitoredBookPanel release grab', () => {
  beforeEach(() => {
    grabMock.mockReset()
    bookDetailFetchMocks.length = 0
    useReleasesMock.mockReset()
    const shared = fakeReleases()
    useReleasesMock.mockImplementation(() => shared as unknown as ReturnType<typeof useMonitoredReleases>)
  })

  it('expands the grabbed row with its progress instead of navigating away', async () => {
    grabMock.mockResolvedValue(4242)
    const wrapper = await mountPanel()

    expect(wrapper.findComponent(MonitoredRequestProgress).exists()).toBe(false)

    await wrapper.findComponent(ReleaseResultRow).vm.$emit('grab', release)
    await nextTick()

    expect(grabMock).toHaveBeenCalledWith(release)
    const row = wrapper.findComponent(ReleaseResultRow)
    expect(row.props('expanded')).toBe(true)
    const progress = row.findComponent(MonitoredRequestProgress)
    expect(progress.exists()).toBe(true)
    expect(progress.props('requestId')).toBe(4242)
    // The list behind the panel reads as queued, but the panel itself stays open on the release.
    expect(wrapper.emitted('grabbed')).toEqual([[baseWork, 'ebook', 4242]])
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })

  it('shows progress for a request the work already had when the panel opened', async () => {
    const queued: MonitoredWork = { ...baseWork, id: 'work-2', requestIds: { ebook: 99 }, requestStatuses: { ebook: 'downloading' } }
    const wrapper = await mountPanel(queued)

    // No row can be named for a grab this panel did not make, so the block leads the tab instead.
    const progress = wrapper.findComponent(MonitoredRequestProgress)
    expect(progress.exists()).toBe(true)
    expect(progress.props('requestId')).toBe(99)
    expect(wrapper.findComponent(ReleaseResultRow).props('expanded')).toBe(false)
    expect(grabMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps the pre-existing request visible while its row is off the list', async () => {
    const queued: MonitoredWork = { ...baseWork, id: 'work-3', requestIds: { audiobook: 7 }, requestStatuses: { audiobook: 'grabbed' } }
    const wrapper = await mountPanel(queued, [])

    const tab = wrapper.findAll('button').find((button) => button.text() === 'Audiobook releases')
    await tab?.trigger('click')
    await nextTick()

    expect(wrapper.findComponent(MonitoredRequestProgress).props('requestId')).toBe(7)
    wrapper.unmount()
  })

  it('stays put when the grab fails', async () => {
    grabMock.mockResolvedValue(null)
    const wrapper = await mountPanel()

    await wrapper.findComponent(ReleaseResultRow).vm.$emit('grab', release)
    await nextTick()

    expect(wrapper.findComponent(MonitoredRequestProgress).exists()).toBe(false)
    expect(wrapper.findComponent(ReleaseResultRow).props('expanded')).toBe(false)
    expect(wrapper.emitted('grabbed')).toBeUndefined()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })

  it('requests an ebook from the footer with auto-download enabled', async () => {
    const wrapper = await mountPanel(releasedWork)
    const checkbox = wrapper.get('input[type="checkbox"]')
    const requestButton = wrapper.findAll('button').find((button) => button.text() === 'Request ebook')

    expect((checkbox.element as HTMLInputElement).checked).toBe(true)
    await requestButton?.trigger('click')

    expect(wrapper.emitted('request')).toEqual([[releasedWork, 'ebook', true]])
    wrapper.unmount()
  })

  it('requests an ebook from the footer with auto-download disabled', async () => {
    const wrapper = await mountPanel(releasedWork)
    await wrapper.get('input[type="checkbox"]').setValue(false)
    const requestButton = wrapper.findAll('button').find((button) => button.text() === 'Request ebook')

    await requestButton?.trigger('click')

    expect(wrapper.emitted('request')).toEqual([[releasedWork, 'ebook', false]])
    wrapper.unmount()
  })

  it('shows per-format request labels and requests an audiobook', async () => {
    const wrapper = await mountPanel(releasedWork)
    const requestButton = wrapper.findAll('button').find((button) => button.text() === 'Request audiobook')

    expect(wrapper.findAll('button').some((button) => button.text() === 'Request ebook')).toBe(true)
    await requestButton?.trigger('click')

    expect(wrapper.emitted('request')).toEqual([[releasedWork, 'audiobook', true]])
    wrapper.unmount()
  })

  it('uses owned and queued labels and hides the checkbox when neither format is actionable', async () => {
    const unavailable: MonitoredWork = {
      ...releasedWork,
      ownedFormats: ['ebook'],
      requestIds: { audiobook: 83 },
      requestStatuses: { audiobook: 'grabbed' },
    }
    const wrapper = await mountPanel(unavailable)

    expect(wrapper.findAll('button').some((button) => button.text() === 'Ebook in library')).toBe(true)
    expect(wrapper.findAll('button').some((button) => button.text() === 'Audiobook queued')).toBe(true)
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows a filed requested format as owned instead of queued', async () => {
    const filed: MonitoredWork = { ...releasedWork, ownedFormats: ['ebook'], requestIds: { ebook: 83 } }
    const wrapper = await mountPanel(filed)

    expect(wrapper.findAll('button').some((button) => button.text() === 'Ebook in library')).toBe(true)
    expect(wrapper.text()).not.toContain('Ebook queued')
    expect(wrapper.findAll('button').some((button) => button.text() === 'Request ebook')).toBe(false)
    wrapper.unmount()
  })

  it('disables an unreleased footer request with a tooltip', async () => {
    const upcoming: MonitoredWork = {
      ...baseWork,
      ebookReleaseDate: '2099-04-10',
      ebookDatePrecision: 'day',
      audioReleaseDate: '2099-04-11',
      audioDatePrecision: 'day',
    }
    const wrapper = await mountPanel(upcoming)
    const requestButton = wrapper.findAll('button').find((button) => button.text() === 'Request ebook')

    expect(requestButton?.attributes('disabled')).toBeDefined()
    expect(requestButton?.attributes('title')).toBe('Not released yet')
    expect(wrapper.findAllComponents(MonitoredFormatPill)).toHaveLength(2)
    wrapper.unmount()
  })

  it('uses the queued label for a format that already has a request', async () => {
    const queued: MonitoredWork = { ...releasedWork, requestIds: { ebook: 83 }, requestStatuses: { ebook: 'grabbed' } }
    const wrapper = await mountPanel(queued)

    expect(wrapper.findAll('button').some((button) => button.text() === 'Ebook queued')).toBe(true)
    expect(wrapper.emitted('request')).toBeUndefined()
    wrapper.unmount()
  })

  it('has no grab emit after moving requests to the footer', async () => {
    const wrapper = await mountPanel(releasedWork)
    const requestButton = wrapper.findAll('button').find((button) => button.text() === 'Request ebook')

    await requestButton?.trigger('click')

    expect(wrapper.emitted('grab')).toBeUndefined()
    expect(wrapper.vm.$options.emits).not.toContain('grab')
    wrapper.unmount()
  })

  it('leaves the release toolbar with only its search action', async () => {
    const wrapper = await mountPanel(releasedWork)
    const searchButton = wrapper.findAll('button').find((button) => button.text() === 'Search for releases')

    expect(searchButton?.element.parentElement?.textContent).not.toContain('Request')
    wrapper.unmount()
  })

  it('does not expose library, request or monitor actions in the header', async () => {
    const owned: MonitoredWork = { ...releasedWork, matchedBookId: 12, ownedFormats: ['ebook'] }
    const wrapper = await mountPanel(owned, [release], null)

    expect(wrapper.text()).not.toContain('In library')
    expect(wrapper.text()).not.toContain('Monitor this book')
    expect(wrapper.vm.$options.emits).not.toContain('monitor')
    wrapper.unmount()
  })

  it('loads file details when the same work gains matched library book ids', async () => {
    const wrapper = await mountPanel(releasedWork, [], null)

    await wrapper.setProps({
      work: { ...releasedWork, matchedBookId: 71, matchedBookIds: { ebook: 71, audiobook: 72 }, ownedFormats: ['ebook', 'audiobook'] },
    })
    await nextTick()

    expect(bookDetailFetchMocks[0]).toHaveBeenCalledWith(71)
    expect(bookDetailFetchMocks[1]).toHaveBeenCalledWith(72)
    wrapper.unmount()
  })
})
