import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import type { BookDetail } from '@bookorbit/types'

const state = vi.hoisted(() => ({
  api: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  hasPermission: vi.fn<(permission: string) => boolean>(),
  showBookRequests: true,
  availability: [] as unknown[],
  work: null as unknown,
  toastSuccess: vi.fn<(message: string) => void>(),
  toastError: vi.fn<(message: string) => void>(),
}))

vi.mock('@/lib/api', () => ({ api: state.api }))
vi.mock('vue-sonner', () => ({ toast: { success: state.toastSuccess, error: state.toastError } }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: state.hasPermission }) }))
vi.mock('../composables/useBookRequestVisibility', () => ({
  useBookRequestVisibility: () => ({ showBookRequests: computed(() => state.showBookRequests) }),
}))

import BookMissingFormatRequest from '../components/BookMissingFormatRequest.vue'

function book(formats: string[]): BookDetail {
  return {
    id: 42,
    title: 'Dune',
    authors: [{ id: 1, name: 'Frank Herbert', sortName: null }],
    isbn10: null,
    isbn13: '9780441013593',
    seriesName: null,
    publishedYear: 1965,
    language: 'en',
    files: formats.map((format, index) => ({ id: index + 1, format, role: 'content', filename: `dune.${format}` })),
  } as unknown as BookDetail
}

function json(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

const NOTHING = { ownedBookId: null, existingRequestId: null, existingRequestStatus: null, alreadySubscribed: false }

async function render(formats: string[]) {
  const wrapper = mount(BookMissingFormatRequest, { props: { book: book(formats) }, global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return wrapper
}

describe('BookMissingFormatRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.showBookRequests = true
    state.hasPermission.mockReturnValue(true)
    state.availability = [NOTHING]
    state.work = null
    state.api.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('/monitored/works/by-book/')
          ? state.work
            ? json(state.work)
            : ({ ok: false, status: 404, json: async () => ({}) } as Response)
          : json(state.availability),
      ),
    )
  })

  it('offers the audiobook an ebook is missing, and asks whether anybody has it already', async () => {
    const wrapper = await render(['epub'])

    expect(wrapper.text()).toContain('No audiobook yet')
    const [path, init] = state.api.mock.calls.find(([called]) => called === '/api/v1/book-requests/availability')!
    expect(path).toBe('/api/v1/book-requests/availability')
    expect(JSON.parse(init!.body as string).items[0]).toMatchObject({ title: 'Dune', mediaKind: 'audiobook', isbn13: '9780441013593' })
  })

  it('offers the ebook an audiobook is missing', async () => {
    const wrapper = await render(['m4b'])

    expect(wrapper.text()).toContain('No e-book yet')
    expect(wrapper.get('button').attributes('aria-label')).toBe('Request e-book')
  })

  it.each(['cbz', 'cbr', 'cb7', 'CBZ'])('recognizes %s as the non-audio half', async (format) => {
    const wrapper = await render([format])
    expect(wrapper.get('button').attributes('aria-label')).toBe('Request audiobook')
    const [, init] = state.api.mock.calls.find(([called]) => called === '/api/v1/book-requests/availability')!
    expect(JSON.parse(init!.body as string).items[0]).toMatchObject({ mediaKind: 'audiobook' })
  })

  it('asks for the format against this book, so it joins it rather than becoming another', async () => {
    const wrapper = await render(['epub'])
    state.api.mockResolvedValueOnce(json({ request: { id: 77, status: 'pending' }, subscribed: false }))

    await wrapper.get('button').trigger('click')
    await flushPromises()

    const [path, init] = state.api.mock.calls.find(([called]) => called === '/api/v1/book-requests')!
    expect(path).toBe('/api/v1/book-requests')
    expect(JSON.parse(init!.body as string)).toMatchObject({ mediaKind: 'audiobook', targetBookId: 42, title: 'Dune', language: 'en' })
    expect(state.toastSuccess).toHaveBeenCalledWith('Requested. The audiobook will join this book when it arrives')
    expect(wrapper.text()).toContain('Requested')
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toMatchObject({ name: 'book-request-detail', params: { id: 77 } })
  })

  it('says the translated reason when the server refuses', async () => {
    const wrapper = await render(['epub'])
    state.api.mockResolvedValueOnce(json({ errorCode: 'SUBMIT_TARGET_BOOK_HAS_MEDIUM', message: 'That book already has a audiobook' }, false))

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(state.toastError).toHaveBeenCalledWith('Could not submit that request', { description: 'That book already has this format' })
  })

  it('offers to join a request somebody else already made', async () => {
    state.availability = [{ ...NOTHING, existingRequestId: 9, existingRequestStatus: 'pending' }]
    const wrapper = await render(['epub'])

    expect(wrapper.text()).toContain('Requested by someone else')
    expect(wrapper.get('button').text()).toBe('Add me too')
  })

  it.each([
    ['a book holding both formats', ['epub', 'm4b'], true, true],
    ['a comic holding audio too', ['cbz', 'mp3'], true, true],
    ['somebody without request access', ['epub'], false, true],
    ['somebody who hid requests', ['epub'], true, false],
  ])('stays out of the way for %s', async (_label, formats, permitted, visible) => {
    state.hasPermission.mockReturnValue(permitted)
    state.showBookRequests = visible

    const wrapper = await render(formats)

    expect(wrapper.find('[role="group"]').exists()).toBe(false)
    expect(state.api).not.toHaveBeenCalled()
  })

  describe('with the book on the watchlist', () => {
    function entry(work: Record<string, unknown>, authorModes = { ebook: 'notify', audiobook: 'notify' }) {
      return {
        monitorAuthorId: 'monitor-1',
        authorModes,
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

    function bell(wrapper: Awaited<ReturnType<typeof render>>) {
      return wrapper.get('[data-test="watch-line"] [aria-label]')
    }

    it('says when an upcoming audiobook is out, with the bell after the text and no link', async () => {
      state.work = entry({ audioReleaseDate: '2099-11-04', audioDatePrecision: 'day' })
      const wrapper = await render(['epub'])

      expect(wrapper.text()).toContain('Audiobook out Nov 4, 2099')
      expect(wrapper.text()).not.toContain('On your watchlist')
      expect(wrapper.text()).not.toContain('No audiobook yet')
      expect(bell(wrapper).element.tagName).toBe('SPAN')
      expect(bell(wrapper).attributes('tabindex')).toBe('0')
      expect(bell(wrapper).attributes('aria-label')).toBe('On your watchlist · you get a notification on release')
      expect(wrapper.findAllComponents(RouterLinkStub)).toHaveLength(0)
      expect(wrapper.get('button').attributes('aria-label')).toBe('Request audiobook')
    })

    it('names the automatic request in the bell text when the author is grabbed on release', async () => {
      state.work = entry({ audioReleaseDate: '2099-11-04', audioDatePrecision: 'day' }, { ebook: 'notify', audiobook: 'auto-all' })
      const wrapper = await render(['epub'])

      expect(bell(wrapper).attributes('aria-label')).toBe('On your watchlist · requested automatically on release')
    })

    it('states a year-only release as "in 2099"', async () => {
      state.work = entry({ audioReleaseDate: '2099', audioDatePrecision: 'year' })
      const wrapper = await render(['epub'])

      expect(wrapper.text()).toContain('Audiobook out in 2099')
    })

    it('says the ebook for an audiobook that is out soon', async () => {
      state.work = entry({
        ebookReleaseDate: '2099-03-01',
        ebookDatePrecision: 'day',
        ownedFormats: ['audiobook'],
        matchedBookIds: { audiobook: 42 },
      })
      const wrapper = await render(['m4b'])

      expect(wrapper.text()).toContain('Ebook out Mar 1, 2099')
    })

    it('states a released format and keeps the request button', async () => {
      state.work = entry({ audioReleaseDate: '2025-08-12', audioDatePrecision: 'day' })
      const wrapper = await render(['epub'])

      expect(wrapper.text()).toContain('Released Aug 12, 2025')
      expect(wrapper.get('button').attributes('aria-label')).toBe('Request audiobook')
      expect(bell(wrapper).attributes('aria-label')).toBe('On your watchlist · you get a notification on release')
    })

    it('says the format is not announced yet when the watched work has no date', async () => {
      state.work = entry({})
      const wrapper = await render(['epub'])

      expect(wrapper.text()).toContain('Audiobook not announced yet')
      expect(wrapper.find('[data-test="watch-line"] [aria-label]').exists()).toBe(true)
      expect(wrapper.get('button').attributes('aria-label')).toBe('Request audiobook')
    })

    it.each(['pending', 'searching', 'grabbed', 'downloading', 'importing', 'needs_review', 'failed'])(
      'keeps a %s request as the upstream row shows it and adds the watchlist line beneath',
      async (status) => {
        state.work = entry({
          audioReleaseDate: '2025-08-12',
          audioDatePrecision: 'day',
          requestIds: { audiobook: 31 },
          requestStatuses: { audiobook: status },
        })
        const wrapper = await render(['epub'])

        expect(wrapper.text()).toBe('No audiobook yetReleased Aug 12, 2025 Request')
        expect(wrapper.get('button').attributes('aria-label')).toBe('Request audiobook')
        expect(wrapper.findAll('[data-test="watch-line"]')).toHaveLength(1)
        expect(wrapper.findAllComponents(RouterLinkStub)).toHaveLength(0)
      },
    )

    it('adds the watchlist line under an upstream following request without replacing it', async () => {
      state.availability = [{ ...NOTHING, existingRequestId: 9, existingRequestStatus: 'pending', alreadySubscribed: true }]
      state.work = entry({ audioReleaseDate: '2099-11-04', audioDatePrecision: 'day' })
      const wrapper = await render(['epub'])

      expect(wrapper.text()).toContain('Requested')
      expect(wrapper.text()).toContain('Audiobook out Nov 4, 2099')
      expect(wrapper.findAll('[data-test="watch-line"]')).toHaveLength(1)
    })

    it('leaves the row as it is when the author is not watching the format', async () => {
      state.work = entry({ audioReleaseDate: '2099-11-04', audioDatePrecision: 'day' }, { ebook: 'notify', audiobook: 'off' })
      const wrapper = await render(['epub'])

      expect(wrapper.text()).toContain('No audiobook yet')
      expect(wrapper.find('[data-test="watch-line"]').exists()).toBe(false)
    })

    it('does not ask the watchlist without request access', async () => {
      state.hasPermission.mockReturnValue(false)
      await render(['epub'])

      expect(state.api).not.toHaveBeenCalled()
    })
  })
})
