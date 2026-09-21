import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { toast } from 'vue-sonner'
import { TriangleAlert } from '@lucide/vue'
import type { MonitoredReleaseDateLookup, MonitoredWork, ReleaseCandidateItem } from '@bookorbit/types'
import MonitoredBookPanel from './MonitoredBookPanel.vue'
import MonitoredFormatPill from './MonitoredFormatPill.vue'
import MonitoredReleaseDatePopover from './MonitoredReleaseDatePopover.vue'
import MonitoredRequestProgress from './MonitoredRequestProgress.vue'
import ReleaseResultRow from './ReleaseResultRow.vue'
import { useMonitoredReleases } from '../composables/useMonitoredReleases'
import { fetchWorkReleaseDateCandidates, refreshWorkReleaseDates, setWorkReleaseDate } from '../api/monitored'
import { MonitoredApiError } from '../lib/api-error'

vi.mock('../composables/useMonitoredReleases', () => ({ useMonitoredReleases: vi.fn<() => unknown>() }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn<(message: string) => void>(), success: vi.fn<(message: string) => void>() } }))
vi.mock('../api/monitored', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/monitored')>()),
  fetchWorkReleaseDateCandidates: vi.fn<() => Promise<MonitoredReleaseDateLookup>>(),
  setWorkReleaseDate: vi.fn<() => Promise<MonitoredWork>>(),
  refreshWorkReleaseDates: vi.fn<() => Promise<MonitoredWork>>(),
}))
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
const candidatesMock = vi.mocked(fetchWorkReleaseDateCandidates)
const setDateMock = vi.mocked(setWorkReleaseDate)
const refreshDatesMock = vi.mocked(refreshWorkReleaseDates)
const toastErrorMock = vi.mocked(toast.error)

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
  profileMismatch: null,
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
    deliveryFor: () => 'torrent',
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
async function mountPanel(
  work: MonitoredWork = baseWork,
  releases: ReleaseCandidateItem[] = [release],
  tabLabel: string | null = 'Ebook releases',
  canManage = true,
) {
  const wrapper = mount(MonitoredBookPanel, {
    props: { work, authorName: 'A Writer', canManage, open: true },
    global: {
      stubs: {
        Sheet: passthrough,
        SheetContent: passthrough,
        SheetTitle: passthrough,
        SheetDescription: passthrough,
        // Tooltip bodies only exist once a pointer opens them, so they are rendered inline here to
        // keep what they say under test rather than only that something is there.
        TooltipContent: passthrough,
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

function resetPanelMocks() {
  grabMock.mockReset()
  bookDetailFetchMocks.length = 0
  candidatesMock.mockReset()
  candidatesMock.mockResolvedValue({ format: 'ebook', candidates: [], unavailable: [], empty: [] })
  setDateMock.mockReset()
  refreshDatesMock.mockReset()
  toastErrorMock.mockReset()
  useReleasesMock.mockReset()
  const shared = fakeReleases()
  useReleasesMock.mockImplementation(() => shared as unknown as ReturnType<typeof useMonitoredReleases>)
}

describe('MonitoredBookPanel release grab', () => {
  beforeEach(resetPanelMocks)

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

  it('reads the date columns for a work the probe has never seen', async () => {
    const wrapper = await mountPanel(releasedWork, [], null)

    expect(wrapper.text()).toContain('Ebook release')
    expect(wrapper.text()).toContain('2020')
    expect(wrapper.text()).not.toContain('Not announced yet')
    wrapper.unmount()
  })

  it('falls back to TBA when nothing at all is known about a format', async () => {
    const wrapper = await mountPanel(baseWork, [], null)

    expect(wrapper.text()).toContain('Audiobook release')
    expect(wrapper.text()).toContain('TBA')
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

describe('MonitoredBookPanel format release rows', () => {
  beforeEach(resetPanelMocks)

  function probed(formatReleases: MonitoredWork['formatReleases']): MonitoredWork {
    return { ...baseWork, formatReleases }
  }

  it('says where a date came from and how fresh it is on hover rather than in the row', async () => {
    const wrapper = await mountPanel(
      probed({
        ebook: {
          status: 'dated',
          releaseDate: '2026-07-15',
          precision: 'day',
          source: 'apple',
          checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
    )

    expect(wrapper.text()).toContain('Ebook release')
    expect(wrapper.text()).toContain('2026')
    const hint = wrapper.get('[data-testid="release-date-hint"]').text()
    expect(hint).toContain('Release date as per Apple Books.')
    expect(hint).toContain('Checked 2 hours ago')
    expect(hint).toContain('Click to search other providers.')
    wrapper.unmount()
  })

  it('tells a viewer who cannot edit where the date came from without offering the lookup', async () => {
    const wrapper = await mountPanel(
      probed({
        ebook: {
          status: 'dated',
          releaseDate: '2026-07-15',
          precision: 'day',
          source: 'apple',
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
      false,
    )

    expect(wrapper.text()).toContain('Release date as per Apple Books.')
    expect(wrapper.text()).not.toContain('Click to search')
    wrapper.unmount()
  })

  it('marks a hinted date with an explained warning rather than a bare pill', async () => {
    const wrapper = await mountPanel(
      probed({
        ebook: {
          status: 'expected',
          releaseDate: '2027-01-10',
          precision: 'day',
          source: 'hardcover_edition',
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
    )

    expect(wrapper.text()).toContain('Expected')
    expect(wrapper.text()).toContain('2027')
    expect(wrapper.text()).toContain('Expected date as per Hardcover, not confirmed yet.')
    expect(wrapper.findComponent(TriangleAlert).exists()).toBe(true)
    expect(wrapper.text()).toContain('Not confirmed')
    expect(wrapper.text()).toContain('Click the date to look it up or set your own.')
    wrapper.unmount()
  })

  it('names a date the owner set as their own', async () => {
    const wrapper = await mountPanel(
      probed({
        audiobook: {
          status: 'dated',
          releaseDate: '2027-01-10',
          precision: 'day',
          source: 'user',
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
    )

    expect(wrapper.text()).toContain('You set this date.')
    expect(wrapper.text()).toContain('Click to change or clear it.')
    expect(wrapper.findComponent(TriangleAlert).exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not claim a date the owner typed was checked against anything', async () => {
    const wrapper = await mountPanel(
      probed({
        audiobook: {
          status: 'dated',
          releaseDate: '2027-01-10',
          precision: 'day',
          source: 'user',
          checkedAt: new Date().toISOString(),
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
    )

    expect(wrapper.text()).toContain('You set this date.')
    expect(wrapper.text()).not.toContain('Checked')
    wrapper.unmount()
  })

  it('tells a viewer who cannot manage the work that the owner set the date, not them', async () => {
    const wrapper = await mountPanel(
      probed({
        audiobook: {
          status: 'dated',
          releaseDate: '2027-01-10',
          precision: 'day',
          source: 'user',
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
      false,
    )

    expect(wrapper.text()).toContain('The owner set this date.')
    expect(wrapper.text()).not.toContain('You set this date.')
    wrapper.unmount()
  })

  it('keeps a date the owner set on a format they own clearable', async () => {
    const wrapper = await mountPanel(
      {
        ...probed({
          ebook: {
            status: 'dated',
            releaseDate: '2027-01-10',
            precision: 'day',
            source: 'user',
            checkedAt: null,
            dateChangedAt: null,
            previousReleaseDate: null,
            previousPrecision: null,
            suggested: null,
          },
        }),
        ownedFormats: ['ebook'],
      },
      [],
      null,
    )

    const ebook = wrapper.findAllComponents(MonitoredReleaseDatePopover).find((popover) => popover.props('format') === 'ebook')
    expect(ebook?.props('source')).toBe('user')
    expect(ebook?.props('details')).toEqual(['You set this date.'])
    wrapper.unmount()
  })

  it('says what a date moved from and when, so a slipped release is visible', async () => {
    const wrapper = await mountPanel(
      probed({
        ebook: {
          status: 'dated',
          releaseDate: '2026-10-20',
          precision: 'day',
          source: 'apple',
          checkedAt: null,
          dateChangedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          previousReleaseDate: '2026-10',
          previousPrecision: 'month',
          suggested: null,
        },
      }),
      [],
      null,
    )

    const hint = wrapper.get('[data-testid="release-date-hint"]').text()
    expect(hint).toMatch(/Changed from October 2026 to .*20.* 2 days ago\./)
    expect(hint).not.toContain('Unchanged since')
    wrapper.unmount()
  })

  it('says how long a date has stood when it has never moved, so a stale placeholder shows', async () => {
    const wrapper = await mountPanel(
      probed({
        ebook: {
          status: 'expected',
          releaseDate: '2027-01-10',
          precision: 'day',
          source: 'hardcover_edition',
          checkedAt: null,
          dateChangedAt: '2026-09-12T10:00:00.000Z',
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
    )

    const hint = wrapper.get('[data-testid="release-date-hint"]').text()
    expect(hint).toMatch(/Unchanged since first seen on .*2026\./)
    expect(hint).toContain('12')
    wrapper.unmount()
  })

  it('does not report the automatic date an owner replaced as a release that moved', async () => {
    const wrapper = await mountPanel(
      probed({
        ebook: {
          status: 'dated',
          releaseDate: '2027-07-07',
          precision: 'day',
          source: 'user',
          checkedAt: null,
          dateChangedAt: new Date().toISOString(),
          previousReleaseDate: '2027-03-05',
          previousPrecision: 'day',
          suggested: null,
        },
      }),
      [],
      null,
    )

    expect(wrapper.text()).toContain('You set this date.')
    expect(wrapper.text()).not.toContain('Changed from')
    wrapper.unmount()
  })

  it('does not call a date the owner typed unchanged since a sighting', async () => {
    const wrapper = await mountPanel(
      probed({
        ebook: {
          status: 'dated',
          releaseDate: '2027-01-10',
          precision: 'day',
          source: 'user',
          checkedAt: null,
          dateChangedAt: '2026-09-12T10:00:00.000Z',
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
    )

    expect(wrapper.text()).toContain('You set this date.')
    expect(wrapper.text()).not.toContain('Unchanged since')
    wrapper.unmount()
  })

  function chosenWithSuggestion(precision: 'day' | 'month' = 'day'): MonitoredWork {
    return probed({
      ebook: {
        status: 'dated',
        releaseDate: '2026-10-06',
        precision: 'day',
        source: 'user',
        checkedAt: null,
        dateChangedAt: null,
        previousReleaseDate: null,
        previousPrecision: null,
        suggested: {
          releaseDate: precision === 'day' ? '2026-10-20' : '2026-11',
          precision,
          source: 'amazon',
          changedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    })
  }

  it('raises an alert beside a date the owner chose when a store now lists another one', async () => {
    const wrapper = await mountPanel(chosenWithSuggestion(), [], null)

    const alert = wrapper.get('[data-testid="release-date-suggestion"]')
    expect(alert.text()).toContain('A store lists a different date')
    expect(wrapper.text()).toMatch(/Amazon now lists .*20.*, found 2 days ago\./)
    expect(wrapper.text()).toContain('Click the date to use it or keep yours.')
    wrapper.unmount()
  })

  it('shows no alert while nothing disagrees with the date the owner chose', async () => {
    const wrapper = await mountPanel(
      probed({
        ebook: {
          status: 'dated',
          releaseDate: '2026-10-06',
          precision: 'day',
          source: 'user',
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
    )

    expect(wrapper.find('[data-testid="release-date-suggestion"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps every date editable for a manager, monitored format or not, so no marker or alert is a dead end', async () => {
    const wrapper = mount(MonitoredBookPanel, {
      props: { work: chosenWithSuggestion(), authorName: 'A Writer', canManage: true, monitoredFormats: ['audiobook'], open: true },
      global: {
        stubs: {
          Sheet: passthrough,
          SheetContent: passthrough,
          SheetTitle: passthrough,
          SheetDescription: passthrough,
          TooltipContent: passthrough,
          MonitoredRequestProgress: true,
          RouterLink: true,
        },
      },
    })
    await nextTick()

    const popovers = wrapper.findAllComponents(MonitoredReleaseDatePopover)
    expect(popovers.map((popover) => popover.props('format'))).toEqual(['ebook', 'audiobook'])
    expect(wrapper.find('[data-testid="release-date-suggestion"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('raises no alert for a viewer who has no way to settle it', async () => {
    const wrapper = await mountPanel(chosenWithSuggestion(), [], null, false)

    expect(wrapper.find('[data-testid="release-date-suggestion"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not tell a viewer who cannot edit to click an unconfirmed date', async () => {
    const wrapper = await mountPanel(
      probed({
        ebook: {
          status: 'expected',
          releaseDate: '2027-01-10',
          precision: 'day',
          source: 'hardcover_edition',
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
      false,
    )

    expect(wrapper.text()).toContain('No store listing confirms this date for this format yet.')
    expect(wrapper.text()).not.toContain('Click the date')
    wrapper.unmount()
  })

  it('takes the listed date when the owner chooses to use it', async () => {
    setDateMock.mockResolvedValueOnce({ ...baseWork })
    const wrapper = await mountPanel(chosenWithSuggestion(), [], null)

    const ebook = wrapper.findAllComponents(MonitoredReleaseDatePopover).find((popover) => popover.props('format') === 'ebook')
    expect(ebook?.props('suggestion')).toMatchObject({ releaseDate: '2026-10-20', applicableDate: '2026-10-20' })
    ebook?.vm.$emit('set', 'ebook', '2026-10-20')
    await flushPromises()

    expect(setDateMock).toHaveBeenCalledWith(baseWork.id, 'ebook', '2026-10-20')
    wrapper.unmount()
  })

  it('does not promise "use it" for a listing that cannot be applied as it stands', async () => {
    const wrapper = await mountPanel(chosenWithSuggestion('month'), [], null)

    expect(wrapper.text()).toContain('Click the date to review it.')
    expect(wrapper.text()).not.toContain('Click the date to use it or keep yours.')
    wrapper.unmount()
  })

  it('offers nothing to apply directly when the listing is only known to the month', async () => {
    const wrapper = await mountPanel(chosenWithSuggestion('month'), [], null)

    const ebook = wrapper.findAllComponents(MonitoredReleaseDatePopover).find((popover) => popover.props('format') === 'ebook')
    expect(ebook?.props('suggestion')).toMatchObject({ releaseDate: '2026-11', applicableDate: null })
    wrapper.unmount()
  })

  it('has no print row to show', async () => {
    const wrapper = await mountPanel(baseWork, [], null)

    expect(wrapper.text()).toContain('Ebook release')
    expect(wrapper.text()).toContain('Audiobook release')
    expect(wrapper.findAllComponents(MonitoredReleaseDatePopover)).toHaveLength(2)
    wrapper.unmount()
  })

  it('says a format no source lists is not announced yet', async () => {
    const wrapper = await mountPanel(
      probed({
        audiobook: {
          status: 'unlisted',
          releaseDate: null,
          precision: null,
          source: null,
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      }),
      [],
      null,
    )

    expect(wrapper.text()).toContain('Audiobook release')
    expect(wrapper.text()).toContain('Not announced yet')
    wrapper.unmount()
  })

  it('opens the lookup on the date and asks the providers what they have', async () => {
    const wrapper = await mountPanel(baseWork, [], null)
    const trigger = wrapper.find('button[aria-label^="Ebook release date"]')

    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('TBA')

    await trigger.trigger('click')
    await nextTick()

    expect(candidatesMock).toHaveBeenCalledWith('work-1', 'ebook')
    expect(wrapper.findComponent(MonitoredReleaseDatePopover).props('open')).toBe(true)
    wrapper.unmount()
  })

  it('leaves the date as plain text for a viewer who cannot edit', async () => {
    const wrapper = await mountPanel(baseWork, [], null, false)

    expect(wrapper.findAllComponents(MonitoredReleaseDatePopover)).toHaveLength(0)
    expect(wrapper.find('button[aria-label="Check release dates now"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Ebook release')
    expect(wrapper.text()).toContain('TBA')
    wrapper.unmount()
  })

  it('saves a chosen date and hands the fresh work to the page', async () => {
    const updated: MonitoredWork = {
      ...baseWork,
      formatReleases: {
        ebook: {
          status: 'dated',
          releaseDate: '2026-11-03',
          precision: 'day',
          source: 'user',
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      },
    }
    setDateMock.mockResolvedValue(updated)
    const wrapper = await mountPanel(baseWork, [], null)

    wrapper.findComponent(MonitoredReleaseDatePopover).vm.$emit('set', 'ebook', '2026-11-03')
    await nextTick()
    await nextTick()

    expect(setDateMock).toHaveBeenCalledWith('work-1', 'ebook', '2026-11-03')
    expect(wrapper.emitted('work-updated')).toEqual([[updated]])
    expect(wrapper.findComponent(MonitoredReleaseDatePopover).props('open')).toBe(false)
    wrapper.unmount()
  })

  it('clears the owner date back to the automatic check', async () => {
    setDateMock.mockResolvedValue(baseWork)
    const wrapper = await mountPanel(baseWork, [], null)

    wrapper.findComponent(MonitoredReleaseDatePopover).vm.$emit('clear', 'audiobook')
    await nextTick()
    await nextTick()

    expect(setDateMock).toHaveBeenCalledWith('work-1', 'audiobook', null)
    expect(wrapper.emitted('work-updated')).toEqual([[baseWork]])
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel release date refresh', () => {
  beforeEach(resetPanelMocks)

  async function clickRefresh(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
    await wrapper.find('button[aria-label="Check release dates now"]').trigger('click')
    await nextTick()
    await nextTick()
  }

  it('checks the dates again and hands the fresh work to the page', async () => {
    const updated: MonitoredWork = { ...baseWork, audioReleaseDate: '2026-12-01', audioDatePrecision: 'day' }
    refreshDatesMock.mockResolvedValue(updated)
    const wrapper = await mountPanel(baseWork, [], null)

    await clickRefresh(wrapper)

    expect(refreshDatesMock).toHaveBeenCalledWith('work-1')
    expect(wrapper.emitted('work-updated')).toEqual([[updated]])
    wrapper.unmount()
  })

  it('asks the owner to wait when the check was only just run', async () => {
    refreshDatesMock.mockRejectedValue(new MonitoredApiError(429, null))
    const wrapper = await mountPanel(baseWork, [], null)

    await clickRefresh(wrapper)

    expect(toastErrorMock).toHaveBeenCalledWith('Just checked, try again in a moment')
    expect(wrapper.emitted('work-updated')).toBeUndefined()
    wrapper.unmount()
  })

  it('says where release checking was switched off', async () => {
    refreshDatesMock.mockRejectedValue(new MonitoredApiError(409, null))
    const wrapper = await mountPanel(baseWork, [], null)

    await clickRefresh(wrapper)

    expect(toastErrorMock).toHaveBeenCalledWith('Release date checking is switched off in settings')
    wrapper.unmount()
  })
})
