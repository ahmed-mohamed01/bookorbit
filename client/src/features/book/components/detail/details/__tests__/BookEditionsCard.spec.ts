import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import type { BookDetail } from '@bookorbit/types'

const state = vi.hoisted(() => ({
  api: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  work: null as unknown,
}))

vi.mock('@/lib/api', () => ({ api: state.api }))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('@/features/book-requests/composables/useBookRequestVisibility', () => ({
  useBookRequestVisibility: () => ({ showBookRequests: computed(() => true) }),
}))

import BookEditionsCard from '../BookEditionsCard.vue'
import BookMissingFormatRequest from '@/features/book-requests/components/BookMissingFormatRequest.vue'

const book = {
  id: 42,
  title: 'Dune',
  authors: [{ id: 1, name: 'Frank Herbert', sortName: null }],
  isbn10: null,
  isbn13: null,
  seriesName: null,
  publishedYear: 1965,
  language: 'en',
  formatPriority: [],
  files: [{ id: 1, format: 'epub', role: 'primary', filename: 'dune.epub', sizeBytes: 1000 }],
} as unknown as BookDetail

function entry(work: Record<string, unknown>) {
  return {
    monitorAuthorId: 'monitor-1',
    authorModes: { ebook: 'notify', audiobook: 'auto-upcoming' },
    work: {
      id: 'monitor-1:hardcover:1',
      title: 'Dune',
      ebookReleaseDate: null,
      ebookDatePrecision: null,
      audioReleaseDate: null,
      audioDatePrecision: null,
      ownedFormats: ['ebook'],
      matchedBookIds: { ebook: 42 },
      requestIds: {},
      requestStatuses: {},
      formatReleases: {},
      monitorFormats: {},
      ...work,
    },
  }
}

async function render() {
  const wrapper = mount(
    {
      components: { BookEditionsCard, BookMissingFormatRequest },
      props: { book: Object },
      template: '<BookEditionsCard :book="book"><template #missing><BookMissingFormatRequest :book="book" /></template></BookEditionsCard>',
    },
    { props: { book }, global: { stubs: { RouterLink: RouterLinkStub } } },
  )
  await flushPromises()
  return wrapper
}

describe('BookEditionsCard watchlist row', () => {
  beforeEach(() => {
    state.work = null
    state.api.mockReset().mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('/monitored/works/by-book/')
          ? state.work
            ? ({ ok: true, status: 200, json: async () => state.work } as Response)
            : ({ ok: false, status: 404, json: async () => ({}) } as Response)
          : ({
              ok: true,
              status: 200,
              json: async () => [{ ownedBookId: null, existingRequestId: null, existingRequestStatus: null, alreadySubscribed: false }],
            } as Response),
      ),
    )
  })

  it("keeps today's row when the book is not on the watchlist", async () => {
    const wrapper = await render()

    expect(wrapper.text()).toContain('No audiobook yet')
    expect(wrapper.find('[data-test="watch-line"]').exists()).toBe(false)
  })

  it('shows an upcoming format with its date and a bell that is not a link', async () => {
    state.work = entry({ audioReleaseDate: '2099-11-04', audioDatePrecision: 'day' })
    const wrapper = await render()

    expect(wrapper.text()).toContain('Audiobook out Nov 4, 2099')
    const bell = wrapper.get('[data-test="watch-line"] [aria-label]')
    expect(bell.attributes('aria-label')).toBe('On your watchlist · requested automatically on release')
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('shows a released format and keeps the request button', async () => {
    state.work = entry({ audioReleaseDate: '2025-08-12', audioDatePrecision: 'day' })
    const wrapper = await render()

    expect(wrapper.text()).toContain('Released Aug 12, 2025')
    expect(wrapper.find('button').exists()).toBe(true)
  })

  it('shows a watched format with no date as not announced yet', async () => {
    state.work = entry({})
    const wrapper = await render()

    expect(wrapper.text()).toContain('Audiobook not announced yet')
    expect(wrapper.find('button').exists()).toBe(true)
  })

  it('keeps a request in flight and adds the watchlist line beneath it', async () => {
    state.work = entry({
      audioReleaseDate: '2025-08-12',
      audioDatePrecision: 'day',
      requestIds: { audiobook: 8 },
      requestStatuses: { audiobook: 'downloading' },
    })
    const wrapper = await render()

    expect(wrapper.text()).toContain('No audiobook yet')
    expect(wrapper.text()).toContain('Released Aug 12, 2025')
  })
})
