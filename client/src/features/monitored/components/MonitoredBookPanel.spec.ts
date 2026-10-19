import MonitoredMarkAsMenu from './MonitoredMarkAsMenu.vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import type { Library } from '@bookorbit/types'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { toast } from 'vue-sonner'
import { TriangleAlert } from '@lucide/vue'
import type { MonitoredReleaseDateLookup, MonitoredWork, ReleaseCandidateItem } from '@bookorbit/types'
import MonitoredBookPanel from './MonitoredBookPanel.vue'
import MonitoredFormatSlot from './MonitoredFormatSlot.vue'
import MonitoredMatchFilePicker from './MonitoredMatchFilePicker.vue'
import MonitoredReleaseDatePopover from './MonitoredReleaseDatePopover.vue'
import MonitoredVisibilityBanner from './MonitoredVisibilityBanner.vue'
import MonitoredSlotReleases from './MonitoredSlotReleases.vue'
import ReleaseResultRow from './ReleaseResultRow.vue'
import { useMonitoredReleases } from '../composables/useMonitoredReleases'
import { fetchWorkReleaseDateCandidates, refreshWorkReleaseDates, setMonitoredWorkMatch, setWorkReleaseDate } from '../api/monitored'
import { MonitoredApiError } from '../lib/api-error'

vi.mock('../composables/useMonitoredReleases', () => ({ useMonitoredReleases: vi.fn<() => unknown>() }))
const currentRoute = reactive({ path: '/watchlist' })
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRoute: () => currentRoute,
}))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn<(message: string) => void>(), success: vi.fn<(message: string) => void>() } }))
vi.mock('../api/monitored', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/monitored')>()),
  fetchWorkReleaseDateCandidates: vi.fn<() => Promise<MonitoredReleaseDateLookup>>(),
  setWorkReleaseDate: vi.fn<() => Promise<MonitoredWork>>(),
  refreshWorkReleaseDates: vi.fn<() => Promise<MonitoredWork>>(),
  setMonitoredWorkMatch: vi.fn<() => Promise<MonitoredWork>>(),
}))
// The edition rows watch a live download over the shared request socket; none of these tests are about it.
vi.mock('../composables/useMonitoredRequestProgress', async () => {
  const { ref: reactiveRef } = await import('vue')
  return {
    useMonitoredRequestProgress: () => ({
      request: reactiveRef(null),
      loading: reactiveRef(false),
      error: reactiveRef(null),
      live: reactiveRef(null),
      status: reactiveRef(null),
      settled: reactiveRef(false),
    }),
  }
})
const bookDetailState = vi.hoisted(() => ({ books: [] as unknown[], errors: [] as Array<string | null> }))
const bookDetailFetchMocks = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>)
vi.mock('@/features/book/composables/useBookDetail', async () => {
  const { ref: reactiveRef } = await import('vue')
  return {
    useBookDetail: () => {
      const fetch = vi.fn<() => Promise<void>>()
      bookDetailFetchMocks.push(fetch)
      return {
        detail: reactiveRef(bookDetailState.books[(bookDetailFetchMocks.length - 1) % 2] ?? null),
        loading: reactiveRef(false),
        error: reactiveRef<string | null>(bookDetailState.errors[(bookDetailFetchMocks.length - 1) % 2] ?? null),
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
    indexers: ref<unknown[]>([{}, {}]),
    pending: ref<unknown[]>([]),
    searchedAt: ref<Date | null>(new Date()),
    loading: ref(false),
    searched: ref(true),
    error: ref<string | null>(null),
    grabError: ref<string | null>(null),
    isGrabbing: () => false,
    isGrabbed: () => false,
    deliveryFor: () => 'torrent',
    search: vi.fn<() => Promise<void>>(),
    grab: grabMock,
  }
}

// The sheet teleports its content out of the wrapper, and none of this test is about the overlay.
const passthrough = { template: '<div><slot /></div>' }

type PanelProps = Partial<InstanceType<typeof MonitoredBookPanel>['$props']>

async function mountPanel(
  work: MonitoredWork = baseWork,
  releases: ReleaseCandidateItem[] = [release],
  canManage = true,
  extraProps: PanelProps = {},
) {
  const wrapper = mount(MonitoredBookPanel, {
    props: { work, authorName: 'A Writer', canManage, open: true, ...extraProps },
    global: {
      stubs: {
        Sheet: passthrough,
        SheetContent: passthrough,
        SheetTitle: passthrough,
        SheetDescription: passthrough,
        SheetClose: passthrough,
        DropdownMenu: passthrough,
        DropdownMenuTrigger: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuItem: { template: '<button type="button" @click="$emit(\'click\')"><slot /></button>', emits: ['click'] },
        // Tooltip bodies only exist once a pointer opens them, so they are rendered inline here to
        // keep what they say under test rather than only that something is there.
        TooltipContent: passthrough,
        RouterLink: RouterLinkStub,
      },
    },
  })
  // The work watcher clears the release state on mount, so the list is filled after that runs.
  const source = useReleasesMock.mock.results[0]?.value as ReturnType<typeof fakeReleases>
  source.releases.value = releases
  await nextTick()
  return wrapper
}

async function clickButton(wrapper: ReturnType<typeof mount>, label: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text() === label)
  expect(button, `button "${label}"`).toBeDefined()
  await button!.trigger('click')
  await nextTick()
}

function slot(wrapper: ReturnType<typeof mount>, format: 'ebook' | 'audiobook') {
  const found = wrapper.findAllComponents(MonitoredFormatSlot).find((candidate) => candidate.props('format') === format)
  expect(found).toBeDefined()
  return found!
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

function ebookBook(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    libraryName: 'Fiction',
    addedAt: '2025-03-04T12:00:00.000Z',
    genres: [],
    tags: [],
    formatPriority: ['epub'],
    files: [{ id: 1, format: 'epub', role: 'primary', sizeBytes: 10, filename: 'The Long Wait.epub', absolutePath: '/x', createdAt: '' }],
    ...overrides,
  }
}

const ownedEbook: MonitoredWork = { ...releasedWork, ownedFormats: ['ebook'], matchedBookId: 5, matchedBookIds: { ebook: 5 } }

describe('MonitoredBookPanel layout', () => {
  beforeEach(resetPanelMocks)

  it('has no tabs and shows both format slots, ebook first', async () => {
    const wrapper = await mountPanel(releasedWork)

    expect(wrapper.find('[role="tab"]').exists()).toBe(false)
    expect(wrapper.findAllComponents(MonitoredFormatSlot).map((found) => found.props('format'))).toEqual(['ebook', 'audiobook'])
    wrapper.unmount()
  })

  it('shows the Hide button until the work is hidden', async () => {
    const shown = await mountPanel(baseWork)
    expect(shown.findAll('button').some((button) => button.text() === 'Hide')).toBe(true)
    shown.unmount()

    const hidden = await mountPanel({ ...baseWork, userVisibility: 'hidden' })
    expect(hidden.findAll('button').some((button) => button.text() === 'Hide')).toBe(false)
    expect(hidden.findAll('button').some((button) => button.text() === 'Unhide')).toBe(true)
    hidden.unmount()
  })

  it('keeps the byline plain text on the author page itself', async () => {
    const wrapper = await mountPanel(baseWork, [], true, { authorId: 'monitor-9', linkAuthor: false })

    expect(wrapper.findAllComponents(RouterLinkStub).some((link) => link.text() === 'A Writer')).toBe(false)
    expect(wrapper.get('[data-testid="byline"]').text()).toContain('A Writer')
    wrapper.unmount()
  })

  it('no longer offers upgrade searches in the menu', async () => {
    const wrapper = await mountPanel(ownedEbook)

    expect(wrapper.text()).not.toContain('upgrade')
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel ratings', () => {
  beforeEach(resetPanelMocks)

  it('shows one chip per rated source with the count on hover', async () => {
    const wrapper = await mountPanel({
      ...baseWork,
      ratings: [
        { source: 'goodreads', average: 4.57, count: 12345 },
        { source: 'audible', average: 4.1, count: null },
      ],
    })

    const lines = wrapper.findAll('[data-testid="rating"]').map((line) => line.text())
    expect(lines).toEqual(['4.6Goodreads', '4.1Audible'])
    const labels = wrapper.findAll('[data-testid="rating"]').map((line) => line.attributes('aria-label'))
    expect(labels).toEqual(['Goodreads 4.6, 12.3K ratings', 'Audible 4.1'])
    expect(wrapper.text()).toContain('Goodreads · 12.3K ratings')
    wrapper.unmount()
  })

  it('hides the ratings line when no source reported one', async () => {
    const wrapper = await mountPanel(baseWork)

    expect(wrapper.find('[data-testid="ratings"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel synopsis card', () => {
  beforeEach(() => {
    resetPanelMocks()
    bookDetailState.books = []
  })

  it('renders the description in a titled card with the book page toggle', async () => {
    const wrapper = await mountPanel({ ...baseWork, description: '<p>A long wait.</p>' })
    const card = wrapper.get('[data-testid="synopsis-card"]')

    expect(card.text()).toContain('Synopsis')
    expect(card.text()).toContain('A long wait.')
    expect(card.text()).toContain('Show more')
    wrapper.unmount()
  })

  it('hides the card without a description', async () => {
    const wrapper = await mountPanel(baseWork)

    expect(wrapper.find('[data-testid="synopsis-card"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel tags', () => {
  beforeEach(resetPanelMocks)

  function tagTexts(wrapper: ReturnType<typeof mount>) {
    return wrapper.findAll('[data-testid="work-tag"]').map((tag) => tag.text())
  }

  it('prefers the owned book genres and caps them at three with a +N pill', async () => {
    bookDetailState.books = [ebookBook({ genres: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], tags: ['t'] })]
    const wrapper = await mountPanel(ownedEbook, [], true, { authorGenres: ['author-genre'] })

    expect(tagTexts(wrapper)).toEqual(['a', 'b', 'c'])
    expect(wrapper.get('[data-testid="work-tags-more"]').text()).toBe('+4')
    expect(wrapper.text()).toContain('d, e, f, g')
    wrapper.unmount()
  })

  it('falls back to the book tags when it has no genres', async () => {
    bookDetailState.books = [ebookBook({ genres: [], tags: ['cozy'] })]
    const wrapper = await mountPanel(ownedEbook)

    expect(tagTexts(wrapper)).toEqual(['cozy'])
    expect(wrapper.find('[data-testid="work-tags-more"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('uses the author genres when nothing is owned, and nothing otherwise', async () => {
    bookDetailState.books = []
    const wrapper = await mountPanel(baseWork, [], true, { authorGenres: ['Science', 'Nonfiction'] })
    expect(tagTexts(wrapper)).toEqual(['Science', 'Nonfiction'])
    wrapper.unmount()

    const bare = await mountPanel(baseWork)
    expect(bare.find('[data-testid="work-tags"]').exists()).toBe(false)
    bare.unmount()
  })
})

describe('MonitoredBookPanel owned slot', () => {
  beforeEach(() => {
    resetPanelMocks()
    bookDetailState.books = [ebookBook()]
  })

  it('draws the library tree with the library, the file and both dates', async () => {
    const wrapper = await mountPanel(ownedEbook)
    const ebook = slot(wrapper, 'ebook')

    expect(ebook.get('[data-testid="owned-library"]').text()).toBe('Fiction/')
    expect(ebook.get('[data-testid="slot-kind"]').text()).toBe('EPUB')
    expect(ebook.get('[data-testid="slot-stat"]').text()).toContain('1 file')
    expect(ebook.get('[data-testid="slot-library"]').text()).toBe('Fiction')
    expect(ebook.get('[data-testid="owned-file"]').text()).toBe('The Long Wait.epub')
    expect(ebook.find('[data-testid="not-in-library"]').exists()).toBe(false)
    expect(ebook.text()).toContain('In library')
    expect(ebook.text()).toContain('Released Jan 2, 2020')
    expect(ebook.text()).toContain('Available since Mar 4, 2025')
    expect(ebook.find('[data-testid="watch-toggle"]').exists()).toBe(true)
    expect(ebook.find('[data-testid="releases-toggle"]').exists()).toBe(false)
    const link = ebook.findAllComponents(RouterLinkStub).find((candidate) => JSON.stringify(candidate.props('to')).includes('"bookId":5'))
    expect(link).toBeDefined()
    wrapper.unmount()
  })

  it('holds the stat line back until the library book has loaded, rather than saying "0 files"', async () => {
    bookDetailState.books = []
    const wrapper = await mountPanel(ownedEbook)
    const ebook = slot(wrapper, 'ebook')

    expect(ebook.find('.animate-pulse').exists()).toBe(true)
    expect(ebook.text()).not.toContain('0 files')
    wrapper.unmount()
  })

  it('leaves the other format as a not-owned slot', async () => {
    const wrapper = await mountPanel(ownedEbook)

    expect(slot(wrapper, 'audiobook').find('[data-testid="owned-tree"]').exists()).toBe(false)
    expect(slot(wrapper, 'audiobook').find('[data-testid="watch-toggle"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel search replacement', () => {
  beforeEach(() => {
    resetPanelMocks()
    bookDetailState.books = [ebookBook()]
  })

  it('toggles the inline list from the owned row and explains the import', async () => {
    const wrapper = await mountPanel(ownedEbook)
    const ebook = slot(wrapper, 'ebook')
    const toggle = ebook.get('[data-testid="owned-releases-toggle"]')

    expect(toggle.text()).toBe('Search replacement')
    expect(ebook.find('[data-testid="slot-releases"]').exists()).toBe(false)
    await toggle.trigger('click')

    expect(slot(wrapper, 'ebook').get('[data-testid="owned-releases-toggle"]').text()).toBe('Hide releases')
    expect(slot(wrapper, 'ebook').get('[data-testid="owned-releases-note"]').text()).toBe(
      'You already have this ebook. A grab is imported next to it in Book Dock.',
    )
    expect(slot(wrapper, 'ebook').findComponent(MonitoredSlotReleases).exists()).toBe(true)
    await slot(wrapper, 'ebook').get('[data-testid="owned-releases-toggle"]').trigger('click')
    expect(slot(wrapper, 'ebook').find('[data-testid="slot-releases"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('is left out for a viewer who cannot edit the format', async () => {
    const wrapper = await mountPanel(ownedEbook, [], false)

    expect(wrapper.find('[data-testid="owned-releases-toggle"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel not-owned slot', () => {
  beforeEach(() => {
    resetPanelMocks()
    bookDetailState.books = []
  })

  it('words the date chip for released, upcoming and unannounced formats', async () => {
    const wrapper = await mountPanel({
      ...baseWork,
      ebookReleaseDate: '2099-04-10',
      ebookDatePrecision: 'day',
      audioReleaseDate: '2020-01-03',
      audioDatePrecision: 'day',
    })

    expect(slot(wrapper, 'ebook').text()).toContain('Out Apr 10, 2099')
    expect(slot(wrapper, 'audiobook').text()).toContain('Released Jan 3, 2020')
    expect(slot(wrapper, 'audiobook').text()).toContain('Not in library')
    wrapper.unmount()

    const empty = await mountPanel(baseWork)
    expect(slot(empty, 'ebook').text()).toContain('Not announced')
    empty.unmount()
  })

  it('draws an editable date as the dashed-underline stat value that opens the popover', async () => {
    const wrapper = await mountPanel(baseWork)
    const trigger = slot(wrapper, 'ebook').get('button.border-dashed')

    expect(trigger.classes()).toEqual(expect.arrayContaining(['text-[14px]', 'border-b', 'border-dashed']))
    // Flush with the card's content edge, so the underline lines up with the boxes beneath it.
    expect(trigger.classes().some((name) => /^-?m[xs]-|^px-/.test(name))).toBe(false)
    expect(trigger.find('.underline').exists()).toBe(false)
    expect(slot(wrapper, 'ebook').find('[data-testid="not-available-yet"]').exists()).toBe(false)
    await trigger.trigger('click')
    expect(slot(wrapper, 'ebook').findComponent(MonitoredReleaseDatePopover).props('open')).toBe(true)
    wrapper.unmount()
  })

  it('greys out the colour of a format that is not watched', async () => {
    const off: MonitoredWork = { ...releasedWork, monitorFormats: { audiobook: false } }
    const wrapper = await mountPanel(off)
    const bar = (format: 'ebook' | 'audiobook') => slot(wrapper, format).get('section > span').classes()

    expect(bar('ebook')).toContain('bg-[var(--pill-media-ebook)]/70')
    expect(bar('audiobook')).toContain('bg-muted-foreground/40')
    expect(slot(wrapper, 'audiobook').html()).not.toContain('--pill-media-audiobook')
    wrapper.unmount()
  })

  it('shows the watch pill pressed or not and toggles through the existing flow', async () => {
    const off: MonitoredWork = { ...releasedWork, monitorFormats: { audiobook: false } }
    const wrapper = await mountPanel(off)
    const ebookPill = slot(wrapper, 'ebook').get('[data-testid="watch-toggle"]')
    const audioPill = slot(wrapper, 'audiobook').get('[data-testid="watch-toggle"]')

    expect(ebookPill.attributes('role')).toBe('switch')
    expect(ebookPill.attributes('aria-checked')).toBe('true')
    expect(ebookPill.attributes('aria-pressed')).toBeUndefined()
    expect(ebookPill.attributes('aria-label')).toBe('Watch ebook')
    expect(ebookPill.text()).toBe('Watching')
    expect(audioPill.attributes('aria-checked')).toBe('false')
    expect(audioPill.attributes('aria-label')).toBe('Watch audiobook')
    expect(audioPill.text()).toBe('Not watching')
    expect(slot(wrapper, 'audiobook').text()).toContain('Never searched')

    await ebookPill.trigger('click')
    await audioPill.trigger('click')
    expect(wrapper.emitted('toggle-monitor')).toEqual([
      [off, 'ebook', false],
      [off, 'audiobook', true],
    ])
    wrapper.unmount()
  })

  it.each([
    [undefined, 'Request'],
    ['pending', 'Requested'],
    ['approved', 'Searching'],
    ['searching', 'Searching'],
    ['grabbed', 'Downloading'],
    ['downloading', 'Downloading'],
    ['importing', 'Importing'],
    ['needs_review', 'Needs review'],
    ['failed', 'Retry'],
  ] as const)('labels the request button for a %s request as "%s"', async (status, label) => {
    const work: MonitoredWork = status ? { ...releasedWork, requestIds: { ebook: 11 }, requestStatuses: { ebook: status } } : releasedWork
    const wrapper = await mountPanel(work)
    const ebook = slot(wrapper, 'ebook')

    expect(ebook.text()).toContain(label)
    expect(ebook.text()).not.toMatch(/\d+%/)
    const followLink = ebook
      .findAllComponents(RouterLinkStub)
      .find((link) => link.props('to') && JSON.stringify(link.props('to')).includes('book-request-detail'))
    expect(Boolean(followLink)).toBe(status !== undefined && status !== 'failed')
    wrapper.unmount()
  })

  it('requests the best match from the main button and reads as requested until the page answers', async () => {
    const wrapper = await mountPanel(releasedWork)

    await slot(wrapper, 'ebook').get('button[aria-label="Request ebook"]').trigger('click')

    expect(wrapper.emitted('request')).toEqual([[releasedWork, 'ebook', true]])
    expect(slot(wrapper, 'ebook').text()).toContain('Requested')
    wrapper.unmount()
  })

  it('retries a failed request with the main button', async () => {
    const failed: MonitoredWork = { ...releasedWork, requestIds: { ebook: 4 }, requestStatuses: { ebook: 'failed' } }
    const wrapper = await mountPanel(failed)

    await slot(wrapper, 'ebook').get('button[aria-label="Retry the ebook"]').trigger('click')

    expect(wrapper.emitted('request')).toEqual([[failed, 'ebook', true]])
    wrapper.unmount()
  })

  it('keeps the request button for a format that is not announced', async () => {
    const wrapper = await mountPanel(baseWork)

    expect(wrapper.find('button[aria-label="Request ebook"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('leaves every action out for a viewer who cannot manage the work', async () => {
    const wrapper = await mountPanel(releasedWork, [], false)

    expect(wrapper.find('[data-testid="watch-toggle"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Request ebook"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="popover-refresh"]').exists()).toBe(false)
    expect(slot(wrapper, 'ebook').get('[data-testid="slot-empty"]').text()).toBe('No file for this format yet')
    wrapper.unmount()
  })

  it('offers nothing to act on for a format the author does not monitor', async () => {
    const wrapper = await mountPanel(releasedWork, [], true, { monitoredFormats: ['ebook'] })
    const audiobook = slot(wrapper, 'audiobook')

    expect(audiobook.text()).toContain("This author's audiobooks are not watched")
    expect(audiobook.find('[data-testid="slot-author-link"]').exists()).toBe(false)
    expect(audiobook.find('[data-testid="watch-toggle"]').exists()).toBe(false)
    expect(audiobook.find('[data-testid="releases-toggle"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel inline releases', () => {
  beforeEach(() => {
    resetPanelMocks()
    bookDetailState.books = []
  })

  function releaseList(count: number): ReleaseCandidateItem[] {
    return Array.from({ length: count }, (_, index) => ({ ...release, guid: `release-${index}`, score: 90 - index }))
  }

  it('opens under the slot with the chevron and searches on first open', async () => {
    const wrapper = await mountPanel(releasedWork, releaseList(5))
    const source = useReleasesMock.mock.results[0]?.value as ReturnType<typeof fakeReleases>
    source.searched.value = false

    expect(slot(wrapper, 'ebook').find('[data-testid="slot-releases"]').exists()).toBe(false)
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')

    expect(source.search).toHaveBeenCalledTimes(1)
    const list = slot(wrapper, 'ebook').findComponent(MonitoredSlotReleases)
    expect(list.exists()).toBe(true)
    const toggle = slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.text()).toBe('Hide releases')
    source.searched.value = true
    await nextTick()
    expect(list.get('[data-testid="releases-heading"]').text()).toMatch(/^Releases \u00b7 2 indexers \u00b7 \S/)
    wrapper.unmount()
  })

  it('folds the other card while results are open, and a hand fold or unfold wins', async () => {
    const wrapper = await mountPanel(releasedWork, releaseList(2))
    const isFolded = (format: 'ebook' | 'audiobook') =>
      slot(wrapper, format).get('[data-testid="slot-collapse"]').attributes('aria-expanded') === 'false'

    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')
    expect(isFolded('audiobook')).toBe(true)
    expect(slot(wrapper, 'audiobook').find('[data-testid="slot-footer"]').exists()).toBe(false)
    expect(slot(wrapper, 'audiobook').get('[data-testid="slot-collapse"]').attributes('aria-label')).toBe('Expand')

    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')
    expect(isFolded('audiobook')).toBe(false)

    await slot(wrapper, 'audiobook').get('[data-testid="slot-collapse"]').trigger('click')
    expect(isFolded('audiobook')).toBe(true)
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')
    expect(isFolded('audiobook')).toBe(true)

    await slot(wrapper, 'ebook').get('[data-testid="slot-collapse"]').trigger('click')
    expect(isFolded('ebook')).toBe(true)
    expect(slot(wrapper, 'ebook').find('[data-testid="slot-footer"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('unfolds the other card when the results card is folded by hand', async () => {
    const wrapper = await mountPanel(releasedWork, releaseList(2))
    const isFolded = (format: 'ebook' | 'audiobook') =>
      slot(wrapper, format).get('[data-testid="slot-collapse"]').attributes('aria-expanded') === 'false'

    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')
    expect(isFolded('audiobook')).toBe(true)
    await slot(wrapper, 'ebook').get('[data-testid="slot-collapse"]').trigger('click')
    expect(isFolded('ebook')).toBe(true)
    expect(isFolded('audiobook')).toBe(false)
    wrapper.unmount()
  })

  it('shows the best three, highlights the first, and expands the rest in place', async () => {
    const wrapper = await mountPanel(releasedWork, releaseList(5))
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')

    const rows = () => slot(wrapper, 'ebook').findAllComponents(ReleaseResultRow)
    expect(rows()).toHaveLength(3)
    expect(rows().map((row) => row.props('best'))).toEqual([true, false, false])

    await slot(wrapper, 'ebook').get('[data-testid="releases-show-all"]').trigger('click')
    expect(rows()).toHaveLength(5)
    wrapper.unmount()
  })

  it('keeps the Releases button after a request, and disables it only while a download runs', async () => {
    const approved: MonitoredWork = { ...releasedWork, requestIds: { ebook: 11 }, requestStatuses: { ebook: 'approved' } }
    const wrapper = await mountPanel(approved, releaseList(2))
    const toggle = slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]')

    expect(slot(wrapper, 'ebook').text()).toContain('Searching')
    expect(toggle.attributes('disabled')).toBeUndefined()
    await toggle.trigger('click')
    expect(slot(wrapper, 'ebook').findAllComponents(ReleaseResultRow)).toHaveLength(2)
    wrapper.unmount()

    const busy = await mountPanel({ ...releasedWork, requestIds: { ebook: 11 }, requestStatuses: { ebook: 'downloading' } }, releaseList(2))
    const disabled = busy.getComponent(MonitoredFormatSlot).get('[data-testid="releases-toggle"]')
    expect(disabled.attributes('disabled')).toBeDefined()
    expect(disabled.attributes('title')).toBe('A download is already in progress')
    busy.unmount()
  })

  it.each([
    ['pending', 'Waiting for approval before a release can be picked'],
    ['grabbed', 'A download is already in progress'],
    ['needs_review', 'Resolve the current download first'],
  ] as const)('blocks picking a release while the request is %s, as the grab endpoint would', async (status, hint) => {
    const wrapper = await mountPanel({ ...releasedWork, requestIds: { ebook: 11 }, requestStatuses: { ebook: status } }, releaseList(2))
    const toggle = slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]')
    expect(toggle.attributes('disabled')).toBeDefined()
    expect(toggle.attributes('title')).toBe(hint)
    wrapper.unmount()
  })

  it('lets a failed request pick a release again', async () => {
    const wrapper = await mountPanel({ ...releasedWork, requestIds: { ebook: 11 }, requestStatuses: { ebook: 'failed' } }, releaseList(2))
    expect(slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('grabs a release without leaving the panel', async () => {
    grabMock.mockResolvedValue(4242)
    const wrapper = await mountPanel(releasedWork, releaseList(1))
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')

    slot(wrapper, 'ebook').findComponent(ReleaseResultRow).vm.$emit('grab', release)
    await flushPromises()

    expect(grabMock).toHaveBeenCalledWith(release)
    expect(wrapper.emitted('grabbed')).toEqual([[releasedWork, 'ebook', 4242]])
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps the approval request as the last item of the list', async () => {
    const wrapper = await mountPanel(releasedWork, releaseList(1))
    await slot(wrapper, 'audiobook').get('[data-testid="releases-toggle"]').trigger('click')

    await slot(wrapper, 'audiobook').get('[data-testid="ask-approval"]').trigger('click')

    expect(wrapper.emitted('request')?.[0]).toEqual([expect.objectContaining({ id: releasedWork.id }), 'audiobook', false])
    wrapper.unmount()
  })

  it('loads file details when the same work gains matched library book ids', async () => {
    const wrapper = await mountPanel(releasedWork, [])

    await wrapper.setProps({
      work: { ...releasedWork, matchedBookId: 71, matchedBookIds: { ebook: 71, audiobook: 72 }, ownedFormats: ['ebook', 'audiobook'] },
    })
    await nextTick()

    expect(bookDetailFetchMocks[0]).toHaveBeenCalledWith(71)
    expect(bookDetailFetchMocks[1]).toHaveBeenCalledWith(72)
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel header', () => {
  beforeEach(resetPanelMocks)

  it('links the byline to the monitored author and lists each series in its own row', async () => {
    bookDetailState.books = [ebookBook({ seriesMemberships: [{ seriesId: 77, seriesName: 'first', seriesIndex: '1', displayOrder: 0 }] })]
    const wrapper = await mountPanel(
      {
        ...ownedEbook,
        releaseYear: 2026,
        seriesMemberships: [
          { name: 'First', index: '1' },
          { name: 'Second', index: null },
          { name: 'Third', index: '3' },
        ],
      },
      [],
      true,
      { authorId: 'monitor-9' },
    )

    const byline = wrapper.findAllComponents(RouterLinkStub).find((link) => link.text() === 'A Writer')
    expect(byline?.props('to')).toEqual({ name: 'monitored-author', params: { id: 'monitor-9' } })
    expect(wrapper.get('[data-testid="byline"]').text()).not.toContain('First')
    expect(wrapper.get('[data-testid="byline"]').text()).toContain('2026')
    const row = wrapper.get('[data-testid="series-row"]')
    expect(row.text()).toBe('First #1\u00b7Second+1')
    expect(wrapper.get('[data-testid="series-more"]').attributes('title')).toBe('Third #3')
    expect(wrapper.get('[data-testid="series-more"]').text()).toBe('+1')
    const links = wrapper.findAllComponents(RouterLinkStub).filter((link) => link.attributes('data-testid') === 'series-link')
    expect(links.map((link) => link.props('to'))).toEqual([
      { name: 'series-detail', params: { seriesId: 77 } },
      { name: 'monitored-author', params: { id: 'monitor-9' }, query: { group: 'series' } },
    ])
    wrapper.unmount()
  })

  it('shows series as plain text on the author page itself when they are not in the library', async () => {
    bookDetailState.books = []
    const wrapper = await mountPanel({ ...baseWork, seriesMemberships: [{ name: 'First', index: '1' }] }, [], true, {
      authorId: 'monitor-9',
      linkAuthor: false,
    })

    expect(wrapper.get('[data-testid="series-row"]').text()).toBe('First #1')
    expect(wrapper.find('[data-testid="series-link"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('no longer claims formats are "available" or lists monitoring chips', async () => {
    const wrapper = await mountPanel({ ...releasedWork, ownedFormats: ['ebook'], matchedBookIds: { ebook: 5 } }, [])

    expect(wrapper.text()).not.toContain('Available:')
    expect(wrapper.text()).not.toContain('Monitoring:')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hides from the toolbar and offers the way back once hidden', async () => {
    const shown = await mountPanel(baseWork, [])
    await clickButton(shown, 'Hide')
    expect(shown.emitted('toggle-hidden')).toEqual([[baseWork, true]])
    shown.unmount()

    const hidden: MonitoredWork = { ...baseWork, userVisibility: 'hidden' }
    const wrapper = await mountPanel(hidden, [])
    const unhideButtons = wrapper.findAll('button').filter((button) => button.text() === 'Unhide')
    expect(unhideButtons.length).toBeGreaterThan(0)
    await unhideButtons[0]!.trigger('click')
    expect(wrapper.emitted('set-automatic')).toEqual([[hidden]])
    wrapper.unmount()
  })

  it('offers no curation menu to a viewer who cannot manage the work', async () => {
    const wrapper = await mountPanel(baseWork, [], false)

    expect(wrapper.find('[aria-label="More actions"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel visibility banner', () => {
  beforeEach(resetPanelMocks)

  it('stays out of the way for a work in its normal state', async () => {
    const wrapper = await mountPanel(baseWork, [])

    expect(wrapper.findComponent(MonitoredVisibilityBanner).find('[role="status"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lets the reader close a notice that only restates their own choice, and remembers it', async () => {
    localStorage.clear()
    const kept: MonitoredWork = { ...baseWork, verdict: 'suspect', userVisibility: 'visible' }
    const wrapper = await mountPanel(kept, [])
    const banner = () => wrapper.findComponent(MonitoredVisibilityBanner)

    expect(banner().text()).toContain('You kept this book')
    await banner().get('[data-testid="banner-dismiss"]').trigger('click')
    expect(banner().find('[role="status"]').exists()).toBe(false)
    wrapper.unmount()

    const again = await mountPanel(kept, [])
    expect(again.findComponent(MonitoredVisibilityBanner).find('[role="status"]').exists()).toBe(false)
    again.unmount()

    const review = await mountPanel({ ...baseWork, verdict: 'probable' }, [])
    expect(review.findComponent(MonitoredVisibilityBanner).find('[data-testid="banner-dismiss"]').exists()).toBe(false)
    review.unmount()
    localStorage.clear()
  })

  it('shows a closed notice again once the reader leaves that choice and makes it again', async () => {
    localStorage.clear()
    const kept: MonitoredWork = { ...baseWork, verdict: 'suspect', userVisibility: 'visible' }
    const wrapper = await mountPanel(kept, [])
    const banner = () => wrapper.findComponent(MonitoredVisibilityBanner)
    await banner().get('[data-testid="banner-dismiss"]').trigger('click')

    await wrapper.setProps({ work: { ...kept, userVisibility: undefined } })
    await wrapper.setProps({ work: kept })

    expect(banner().text()).toContain('You kept this book')
    wrapper.unmount()
    localStorage.clear()
  })

  it('names the owner mark instead of the verdict when the owner sent the work to review', async () => {
    const marked: MonitoredWork = { ...baseWork, verdict: 'probable', userKind: 'split_part', kind: 'split_part' }
    const wrapper = await mountPanel(marked, [])

    const banner = wrapper.findComponent(MonitoredVisibilityBanner)
    expect(banner.text()).toContain('Marked as part of a book')
    expect(banner.text()).not.toContain('probable match')
    wrapper.unmount()
  })

  it('says why a work is in review and lets the owner keep or hide it', async () => {
    const review: MonitoredWork = { ...baseWork, verdict: 'probable', flags: ['compilation'] }
    const wrapper = await mountPanel(review, [])

    const banner = wrapper.findComponent(MonitoredVisibilityBanner)
    expect(banner.text()).toContain('probable match')
    expect(banner.text()).toContain('compilation')
    await banner
      .findAll('button')
      .find((button) => button.text() === 'Keep and watch')!
      .trigger('click')
    await banner
      .findAll('button')
      .find((button) => button.text() === 'Hide')!
      .trigger('click')
    expect(wrapper.emitted('toggle-hidden')).toEqual([
      [review, false],
      [review, true],
    ])
    wrapper.unmount()
  })

  it('explains an owned flagged listing and reuses the review actions', async () => {
    const owned: MonitoredWork = { ...ownedEbook, flags: ['wrong_contributor'] }
    const wrapper = await mountPanel(owned, [])
    const banner = wrapper.findComponent(MonitoredVisibilityBanner)

    expect(banner.text()).toContain('Listed because you own it. Its missing formats are not watched until you keep it.')
    expect(banner.get('[role="status"]').attributes('data-state')).toBe('owned')
    expect(wrapper.findComponent(MonitoredMarkAsMenu).exists()).toBe(true)
    await banner
      .findAll('button')
      .find((button) => button.text() === 'Keep and watch')!
      .trigger('click')
    await banner
      .findAll('button')
      .find((button) => button.text() === 'Hide')!
      .trigger('click')
    expect(wrapper.emitted('toggle-hidden')).toEqual([
      [owned, false],
      [owned, true],
    ])
    wrapper.unmount()
  })

  it('names a detected kind without claiming an owner mark', async () => {
    const wrapper = await mountPanel({ ...baseWork, verdict: 'suspect', kind: 'supplemental' }, [])
    const banner = wrapper.findComponent(MonitoredVisibilityBanner)
    expect(banner.text()).toContain('Detected as supplemental, so it is hidden by default and not auto-downloaded. You can still request it.')
    wrapper.unmount()
  })

  it('hands a kept review work back to automatic', async () => {
    const kept: MonitoredWork = { ...baseWork, verdict: 'suspect', userVisibility: 'visible' }
    const wrapper = await mountPanel(kept, [])

    const banner = wrapper.findComponent(MonitoredVisibilityBanner)
    await banner
      .findAll('button')
      .find((button) => button.text() === 'Back to automatic')!
      .trigger('click')
    expect(wrapper.emitted('set-automatic')).toEqual([[kept]])
    wrapper.unmount()
  })

  it('resumes a paused author where the page can, and links to it where it cannot', async () => {
    const resumable = await mountPanel(baseWork, [], true, { authorPaused: true, canResumeAuthor: true, authorId: 'monitor-1' })
    await resumable
      .findAll('button')
      .find((button) => button.text() === 'Resume author')!
      .trigger('click')
    expect(resumable.emitted('resume-author')).toHaveLength(1)
    resumable.unmount()

    const elsewhere = await mountPanel(baseWork, [], true, { authorPaused: true, authorId: 'monitor-1' })
    const link = elsewhere.findAllComponents(RouterLinkStub).find((candidate) => candidate.text() === 'Open author')
    expect(link?.props('to')).toEqual({ name: 'monitored-author', params: { id: 'monitor-1' } })
    elsewhere.unmount()
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
    )

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
      false,
    )

    expect(wrapper.text()).toContain('The owner set this date.')
    expect(wrapper.text()).not.toContain('You set this date.')
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
    const wrapper = await mountPanel(chosenWithSuggestion(), [])

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
    )

    expect(wrapper.find('[data-testid="release-date-suggestion"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps every date editable for a manager, monitored format or not, so no marker or alert is a dead end', async () => {
    const wrapper = await mountPanel(chosenWithSuggestion(), [], true, { monitoredFormats: ['audiobook'] })

    const popovers = wrapper.findAllComponents(MonitoredReleaseDatePopover)
    expect(popovers.map((popover) => popover.props('format'))).toEqual(['ebook', 'audiobook'])
    expect(wrapper.find('[data-testid="release-date-suggestion"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('raises no alert for a viewer who has no way to settle it', async () => {
    const wrapper = await mountPanel(chosenWithSuggestion(), [], false)

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
      false,
    )

    expect(wrapper.text()).toContain('No store listing confirms this date for this format yet.')
    expect(wrapper.text()).not.toContain('Click the date')
    wrapper.unmount()
  })

  it('takes the listed date when the owner chooses to use it', async () => {
    setDateMock.mockResolvedValueOnce({ ...baseWork })
    const wrapper = await mountPanel(chosenWithSuggestion(), [])

    const ebook = wrapper.findAllComponents(MonitoredReleaseDatePopover).find((popover) => popover.props('format') === 'ebook')
    expect(ebook?.props('suggestion')).toMatchObject({ releaseDate: '2026-10-20', applicableDate: '2026-10-20' })
    ebook?.vm.$emit('set', 'ebook', '2026-10-20')
    await flushPromises()

    expect(setDateMock).toHaveBeenCalledWith(baseWork.id, 'ebook', '2026-10-20')
    wrapper.unmount()
  })

  it('does not promise "use it" for a listing that cannot be applied as it stands', async () => {
    const wrapper = await mountPanel(chosenWithSuggestion('month'), [])

    expect(wrapper.text()).toContain('Click the date to review it.')
    expect(wrapper.text()).not.toContain('Click the date to use it or keep yours.')
    wrapper.unmount()
  })

  it('offers nothing to apply directly when the listing is only known to the month', async () => {
    const wrapper = await mountPanel(chosenWithSuggestion('month'), [])

    const ebook = wrapper.findAllComponents(MonitoredReleaseDatePopover).find((popover) => popover.props('format') === 'ebook')
    expect(ebook?.props('suggestion')).toMatchObject({ releaseDate: '2026-11', applicableDate: null })
    wrapper.unmount()
  })

  it('has no print row to show', async () => {
    const wrapper = await mountPanel(baseWork, [])

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
    )

    expect(wrapper.text()).toContain('Not announced')
    wrapper.unmount()
  })

  it('opens the lookup on the date and asks the providers what they have', async () => {
    const wrapper = await mountPanel(baseWork, [])
    const trigger = wrapper.find('button[aria-label^="Ebook release date"]')

    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('Not announced')

    await trigger.trigger('click')
    await nextTick()

    expect(candidatesMock).toHaveBeenCalledWith('work-1', 'ebook')
    expect(wrapper.findComponent(MonitoredReleaseDatePopover).props('open')).toBe(true)
    wrapper.unmount()
  })

  it('leaves the date as plain text for a viewer who cannot edit', async () => {
    const wrapper = await mountPanel(baseWork, [], false)

    expect(wrapper.findAllComponents(MonitoredReleaseDatePopover)).toHaveLength(0)
    expect(wrapper.find('button[aria-label="Check release dates now"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Not announced')
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
    const wrapper = await mountPanel(baseWork, [])

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
    const wrapper = await mountPanel(baseWork, [])

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
    wrapper.findComponent(MonitoredReleaseDatePopover).vm.$emit('refresh')
    await nextTick()
    await nextTick()
  }

  it('checks the dates again and hands the fresh work to the page', async () => {
    const updated: MonitoredWork = { ...baseWork, audioReleaseDate: '2026-12-01', audioDatePrecision: 'day' }
    refreshDatesMock.mockResolvedValue(updated)
    const wrapper = await mountPanel(baseWork, [])

    await clickRefresh(wrapper)

    expect(refreshDatesMock).toHaveBeenCalledWith('work-1')
    expect(wrapper.emitted('work-updated')).toEqual([[updated]])
    wrapper.unmount()
  })

  it('asks the owner to wait when the check was only just run', async () => {
    refreshDatesMock.mockRejectedValue(new MonitoredApiError(429, null))
    const wrapper = await mountPanel(baseWork, [])

    await clickRefresh(wrapper)

    expect(toastErrorMock).toHaveBeenCalledWith('Just checked, try again in a moment')
    expect(wrapper.emitted('work-updated')).toBeUndefined()
    wrapper.unmount()
  })

  it('says where release checking was switched off', async () => {
    refreshDatesMock.mockRejectedValue(new MonitoredApiError(409, null))
    const wrapper = await mountPanel(baseWork, [])

    await clickRefresh(wrapper)

    expect(toastErrorMock).toHaveBeenCalledWith('Release date checking is switched off in settings')
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel owned slot failure states', () => {
  beforeEach(() => {
    resetPanelMocks()
    bookDetailState.errors = []
  })

  it('says the library files could not load and retries the lookup instead of an endless skeleton', async () => {
    bookDetailState.books = []
    bookDetailState.errors = ['HTTP 500']
    const wrapper = await mountPanel(ownedEbook)
    const ebook = slot(wrapper, 'ebook')

    expect(ebook.get('[data-testid="owned-error"]').text()).toContain('Could not load the library files')
    expect(ebook.find('.animate-pulse').exists()).toBe(false)

    await ebook.get('[data-testid="owned-retry"]').trigger('click')
    expect(bookDetailFetchMocks[0]).toHaveBeenLastCalledWith(5)
    wrapper.unmount()
  })

  it('keeps the skeleton while the book is still loading', async () => {
    bookDetailState.books = []
    const wrapper = await mountPanel(ownedEbook)

    expect(slot(wrapper, 'ebook').find('.animate-pulse').exists()).toBe(true)
    expect(slot(wrapper, 'ebook').find('[data-testid="owned-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('states that a loaded book has no file for the format', async () => {
    bookDetailState.books = [ebookBook({ files: [] })]
    const wrapper = await mountPanel(ownedEbook)

    expect(slot(wrapper, 'ebook').get('[data-testid="owned-no-file"]').text()).toBe('No file found for this format')
    await slot(wrapper, 'ebook').get('[data-testid="owned-check"]').trigger('click')
    expect(wrapper.emitted('check-library')).toHaveLength(1)
    wrapper.unmount()
  })

  it('reads an owned format the author does not watch as not watched, and greys it', async () => {
    bookDetailState.books = [ebookBook()]
    const wrapper = await mountPanel(ownedEbook, [], true, { monitoredFormats: ['audiobook'] })
    const ebook = slot(wrapper, 'ebook')

    expect(ebook.text()).toContain('Not watching')
    expect(ebook.get('section > span').classes()).toContain('bg-muted-foreground/40')
    wrapper.unmount()
  })

  it('carries the full file name in a title for when it is truncated', async () => {
    bookDetailState.books = [ebookBook()]
    const wrapper = await mountPanel(ownedEbook)

    expect(slot(wrapper, 'ebook').get('[data-testid="owned-toggle"]').attributes('title')).toBe('/x')
    wrapper.unmount()
  })

  it('expands the file line to the real path and collapses it again', async () => {
    bookDetailState.books = [
      ebookBook({
        libraryId: 1,
        files: [
          {
            id: 1,
            format: 'epub',
            role: 'primary',
            sizeBytes: 10,
            filename: 'The Long Wait.epub',
            absolutePath: '/mnt/books/Fiction/A Writer/The Long Wait/The Long Wait.epub',
            createdAt: '',
          },
        ],
      }),
    ]
    useLibraries().libraries.value = [
      { id: 1, name: 'Fiction', folders: [{ id: 1, path: '/mnt/books/Fiction', role: 'local' }] } as unknown as Library,
    ]
    const wrapper = await mountPanel(ownedEbook)
    const ebook = slot(wrapper, 'ebook')
    const toggle = ebook.get('[data-testid="owned-toggle"]')

    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.attributes('title')).toBe('/mnt/books/Fiction/A Writer/The Long Wait/The Long Wait.epub')
    expect(ebook.findAll('[data-testid="owned-folder"]')).toHaveLength(0)

    await toggle.trigger('click')
    expect(ebook.get('[data-testid="owned-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(ebook.findAll('[data-testid="owned-folder"]').map((line) => line.text())).toEqual(['A Writer/', 'The Long Wait/'])
    expect(ebook.get('[data-testid="owned-library"]').text()).toBe('Fiction/')

    await ebook.get('[data-testid="owned-toggle"]').trigger('click')
    expect(ebook.get('[data-testid="owned-toggle"]').attributes('aria-expanded')).toBe('false')
    expect(ebook.findAll('[data-testid="owned-folder"]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('prefers the book full date over a year-only monitored date', async () => {
    bookDetailState.books = [ebookBook({ publishedDate: '2026-03-14' })]
    const work: MonitoredWork = { ...ownedEbook, ebookReleaseDate: '2026', ebookDatePrecision: 'year' }
    const wrapper = await mountPanel(work)

    expect(slot(wrapper, 'ebook').text()).toContain('Released Mar 14, 2026')
    wrapper.unmount()
  })

  it('says "Released in 2026" when no full date is known', async () => {
    bookDetailState.books = [ebookBook({ publishedDate: '2025-03-14' })]
    const work: MonitoredWork = { ...ownedEbook, ebookReleaseDate: '2026', ebookDatePrecision: 'year' }
    const wrapper = await mountPanel(work)

    expect(slot(wrapper, 'ebook').text()).toContain('Released in 2026')
    expect(slot(wrapper, 'ebook').text()).not.toContain('Released 2026')
    wrapper.unmount()
  })

  it('lays an unowned format out with an editable date', async () => {
    const wrapper = await mountPanel(ownedEbook)
    const audiobook = slot(wrapper, 'audiobook')

    expect(audiobook.get('[data-testid="not-in-library"]').text()).toBe('Not in library')
    expect(audiobook.find('[data-testid="not-available-yet"]').exists()).toBe(false)
    expect(audiobook.findComponent(MonitoredReleaseDatePopover).exists()).toBe(true)
    expect(audiobook.text()).not.toContain('Not in your library yet')
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel slot accessibility and reasons', () => {
  beforeEach(() => {
    resetPanelMocks()
    bookDetailState.books = []
  })

  it('names the Releases button and the request link after their format', async () => {
    const wrapper = await mountPanel({ ...releasedWork, requestIds: { audiobook: 9 }, requestStatuses: { audiobook: 'downloading' } })

    expect(slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').attributes('aria-label')).toBe('Search ebook releases')
    expect(slot(wrapper, 'audiobook').get('[data-testid="releases-toggle"]').attributes('aria-label')).toBe('Search audiobook releases')
    expect(slot(wrapper, 'audiobook').get('[data-request-kind="downloading"]').text()).toBe('Audiobook request: Downloading')

    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')
    expect(slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').attributes('aria-label')).toBe('Hide ebook releases')
    wrapper.unmount()
  })

  it('titles a disabled Search button with the reason it is blocked', async () => {
    const wrapper = await mountPanel({ ...releasedWork, requestIds: { ebook: 11 }, requestStatuses: { ebook: 'pending' } })

    expect(slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').attributes('title')).toBe(
      'Waiting for approval before a release can be picked',
    )
    expect(slot(wrapper, 'audiobook').get('[data-testid="releases-toggle"]').attributes('title')).toBe('Search audiobook releases')
    wrapper.unmount()
  })

  it('offers an enabled request for upcoming and unannounced formats with the right hint', async () => {
    const wrapper = await mountPanel({ ...baseWork, ebookReleaseDate: '2099-04-10', ebookDatePrecision: 'day' })

    const upcoming = slot(wrapper, 'ebook').get('button[aria-label="Request ebook"]')
    expect(upcoming.attributes('title')).toBeUndefined()
    const unannounced = slot(wrapper, 'audiobook').get('button[aria-label="Request audiobook"]')
    expect(unannounced.attributes('disabled')).toBeUndefined()
    expect(unannounced.attributes('title')).toBe('No release date known. Requesting searches now; if nothing is found it waits in Requests.')
    wrapper.unmount()
  })

  it('says what the watch switch does without a request, by the author mode', async () => {
    const auto = await mountPanel(baseWork, [], true, { formatModes: { ebook: 'auto-upcoming', audiobook: 'notify' } })
    expect(auto.text()).toContain('Requested automatically once it is released')
    expect(auto.text()).toContain('You get a notification once it is released')
    auto.unmount()

    const plain = await mountPanel(baseWork)
    expect(plain.text()).toContain('Searched automatically')
    plain.unmount()
  })

  it('links a format the author does not watch to the author page', async () => {
    const wrapper = await mountPanel(releasedWork, [], true, { monitoredFormats: ['ebook'], authorId: 'monitor-9' })
    const link = slot(wrapper, 'audiobook')
      .findAllComponents(RouterLinkStub)
      .find((candidate) => candidate.attributes('data-testid') === 'slot-author-link')

    expect(link?.props('to')).toEqual({ name: 'monitored-author', params: { id: 'monitor-9' } })
    wrapper.unmount()
  })

  it('offers the date refresh from the popovers only, not from the header', async () => {
    const wrapper = await mountPanel(releasedWork)

    expect(wrapper.findAll('button').filter((button) => button.text() === 'Check release dates now')).toHaveLength(0)
    expect(wrapper.find('[data-testid="refresh-dates"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel inline release actions', () => {
  beforeEach(() => {
    resetPanelMocks()
    bookDetailState.books = []
  })

  it('words the approval request the same for everyone who can request, beside the Request button rule', async () => {
    const wrapper = await mountPanel(releasedWork, [release])
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')

    expect(slot(wrapper, 'ebook').get('[data-testid="ask-approval"]').text()).toBe('Request without picking a release')
    wrapper.unmount()
  })

  it('hides the approval request when the Request button is not on offer', async () => {
    const wrapper = await mountPanel({ ...releasedWork, requestIds: { ebook: 11 }, requestStatuses: { ebook: 'approved' } }, [release])
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')

    expect(slot(wrapper, 'ebook').find('[data-testid="ask-approval"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('offers it for a format with a known future date, as the Request button does', async () => {
    const wrapper = await mountPanel({ ...baseWork, ebookReleaseDate: '2099-04-10', ebookDatePrecision: 'day' }, [])
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')

    expect(slot(wrapper, 'ebook').find('[data-testid="ask-approval"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps the results when a grab fails and says so above them', async () => {
    const wrapper = await mountPanel(releasedWork, [release])
    const source = useReleasesMock.mock.results[0]?.value as ReturnType<typeof fakeReleases>
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')

    source.grabError.value = 'Failed to grab this release.'
    await nextTick()

    expect(slot(wrapper, 'ebook').get('[data-testid="grab-error"]').text()).toBe('Failed to grab this release.')
    expect(slot(wrapper, 'ebook').findAllComponents(ReleaseResultRow)).toHaveLength(1)
    wrapper.unmount()
  })

  it('still lets a failed search replace the list', async () => {
    const wrapper = await mountPanel(releasedWork, [release])
    const source = useReleasesMock.mock.results[0]?.value as ReturnType<typeof fakeReleases>
    await slot(wrapper, 'ebook').get('[data-testid="releases-toggle"]').trigger('click')

    source.error.value = 'Search failed.'
    await nextTick()

    expect(slot(wrapper, 'ebook').findAllComponents(ReleaseResultRow)).toHaveLength(0)
    expect(slot(wrapper, 'ebook').text()).toContain('Search failed.')
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel drawer header', () => {
  beforeEach(resetPanelMocks)

  it('puts Hide, the mark-as menu and close together in the corner, Hide labelled only in the wide drawer', async () => {
    const wrapper = await mountPanel(baseWork, [])

    const corner = wrapper.get('[data-testid="panel-corner"]')
    const hide = corner.get('[data-testid="visibility-toggle"]')
    expect(hide.attributes('aria-label')).toBe('Hide')
    expect(hide.get('span').classes()).toEqual(expect.arrayContaining(['hidden', '@lg:inline']))
    expect(corner.find('[data-testid="mark-as-trigger"]').exists()).toBe(true)
    expect(corner.find('[aria-label="Close"]').exists()).toBe(true)
    const menu = wrapper.get('[data-testid="mark-as-trigger"]')
    expect(menu.classes()).toContain('size-8')
    expect(menu.classes()).not.toContain('border')
    for (const target of [hide, menu, wrapper.get('[aria-label="Close"]')]) {
      expect(target.classes()).toContain('[@media(pointer:coarse)]:min-h-11')
      expect(target.classes()).toContain('[@media(pointer:coarse)]:min-w-11')
    }
    wrapper.unmount()
  })

  it('leaves Hide and the mark-as menu out for a viewer who cannot manage the work', async () => {
    const wrapper = await mountPanel(baseWork, [], false)

    expect(wrapper.find('[data-testid="visibility-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mark-as-trigger"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('marks the work as another kind through the overflow menu', async () => {
    const wrapper = await mountPanel(baseWork, [])

    await wrapper.get('[data-testid="mark-as-duplicate"]').trigger('click')

    expect(wrapper.emitted('set-kind')).toEqual([[baseWork, 'duplicate']])
    wrapper.unmount()
  })

  it('re-checks the author behind the check button and says when the author was last checked', async () => {
    const checkedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const wrapper = await mountPanel(releasedWork, [], true, { checkedAt })
    const ebook = slot(wrapper, 'ebook')

    expect(ebook.text()).toContain('Checked 3 hours ago')
    await wrapper.getComponent(MonitoredFormatSlot).vm.$emit('check-library', 'ebook')
    expect(wrapper.emitted('check-library')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel navigation', () => {
  beforeEach(() => {
    resetPanelMocks()
    currentRoute.path = '/watchlist'
  })

  it('closes when a link inside it leaves the page', async () => {
    const wrapper = await mountPanel()
    currentRoute.path = '/book/277'
    await nextTick()
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    wrapper.unmount()
  })
})

describe('MonitoredBookPanel library matches', () => {
  beforeEach(resetPanelMocks)
  const matchMock = vi.mocked(setMonitoredWorkMatch)
  const toastSuccessMock = vi.mocked(toast.success)

  const flagged: MonitoredWork = {
    ...releasedWork,
    title: 'Inhibitor Phase',
    seriesName: 'Revelation Space',
    seriesIndex: '4',
    possibleMatches: { ebook: { bookId: 31, title: 'Inhibitor Phase', seriesName: 'Revelation Space', seriesIndex: '5' } },
  }

  it('flags a possible match on its format only, and links it on Accept', async () => {
    const linked: MonitoredWork = {
      ...flagged,
      possibleMatches: undefined,
      matchedBookId: 31,
      matchedBookIds: { ebook: 31 },
      ownedFormats: ['ebook'],
    }
    matchMock.mockResolvedValue(linked)
    const wrapper = await mountPanel(flagged, [])

    expect(slot(wrapper, 'ebook').find('[data-testid="possible-match"]').exists()).toBe(true)
    expect(slot(wrapper, 'audiobook').find('[data-testid="possible-match"]').exists()).toBe(false)
    expect(slot(wrapper, 'ebook').get('[data-testid="possible-match"]').find('[data-testid="match-file"]').exists()).toBe(true)
    await slot(wrapper, 'ebook').get('[data-testid="possible-match-same"]').trigger('click')
    await flushPromises()

    expect(matchMock).toHaveBeenCalledWith('work-1', 'ebook', { decision: 'link', bookId: 31 })
    expect(wrapper.emitted('work-updated')).toEqual([[linked]])
    wrapper.unmount()
  })

  it('turns the re-check icon into a Fix match picker for the current file, and an unlink from it offers an undo', async () => {
    bookDetailState.books = [ebookBook()]
    matchMock.mockResolvedValue(releasedWork)
    const wrapper = await mountPanel(ownedEbook, [])

    expect(slot(wrapper, 'ebook').find('[data-testid="owned-recheck"]').exists()).toBe(false)
    const picker = slot(wrapper, 'ebook').findComponent(MonitoredMatchFilePicker)
    expect(picker.props('currentBookId')).toBe(5)
    expect(picker.find('[data-testid="fix-match"]').exists()).toBe(true)
    picker.vm.$emit('answer', 'ebook', { decision: 'reject', bookId: 5 })
    await flushPromises()

    expect(matchMock).toHaveBeenCalledWith('work-1', 'ebook', { decision: 'reject', bookId: 5 })
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: expect.any(Object) }))
    expect(slot(wrapper, 'audiobook').find('[data-testid="fix-match"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('marks a hand-linked format and links the book picked in Fix match', async () => {
    bookDetailState.books = [ebookBook()]
    const linked: MonitoredWork = { ...ownedEbook, linkedFormats: ['ebook'] }
    matchMock.mockResolvedValue(releasedWork)
    const wrapper = await mountPanel(linked, [])

    expect(slot(wrapper, 'ebook').find('[data-testid="linked-by-hand"]').exists()).toBe(true)
    const picker = slot(wrapper, 'ebook').findComponent(MonitoredMatchFilePicker)
    expect(picker.props('linkedByHand')).toBe(true)
    picker.vm.$emit('answer', 'ebook', { decision: 'link', bookId: 9 })
    await flushPromises()

    expect(matchMock).toHaveBeenCalledWith('work-1', 'ebook', { decision: 'link', bookId: 9 })
    wrapper.unmount()
  })

  it('offers no answers to a viewer who cannot manage the work', async () => {
    const wrapper = await mountPanel({ ...flagged, matchedBookIds: {} }, [], false)

    expect(slot(wrapper, 'ebook').find('[data-testid="possible-match-same"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
