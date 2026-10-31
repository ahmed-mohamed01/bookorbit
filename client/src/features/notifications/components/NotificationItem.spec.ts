import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import { NotificationType, Permission, type NotificationItem } from '@bookorbit/types'
import en from '@/locales/en.json'
import NotificationItemVue from './NotificationItem.vue'

const mockApi = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => mockApi(...args) }))

const toastError = vi.fn<(message: string) => void>()
vi.mock('vue-sonner', () => ({ toast: { error: (message: string) => toastError(message) } }))

const permissions = vi.hoisted(() => ({ granted: new Set<string>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: (name: string) => permissions.granted.has(name) }),
}))

function notification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    type: NotificationType.BookRequestSubmitted,
    title: 'New book request',
    message: 'Reader requested "Dune"',
    actionUrl: '/requests',
    meta: { requestId: 42 },
    read: false,
    count: 1,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  }
}

async function mountItem(item: NotificationItem, options: { locale?: string; messages?: Record<string, unknown> } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      {
        path: '/requests',
        component: { template: '<router-view />' },
        children: [
          { path: ':id', name: 'book-request-detail', component: { template: '<div />' } },
          { path: ':id/releases', name: 'book-request-releases', component: { template: '<div />' } },
        ],
      },
      { path: '/book/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  const locale = options.locale ?? 'en'
  const i18n = createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages: { en, ...(options.messages ? { [locale]: options.messages } : {}) },
  })

  const wrapper = mount(NotificationItemVue, {
    props: { notification: item },
    global: { plugins: [router, i18n] },
  })

  return { router, wrapper }
}

describe('NotificationItem', () => {
  it('renders a persisted notification type that is no longer in the registry', async () => {
    const { wrapper } = await mountItem(
      notification({
        type: 'legacy_notification_type' as NotificationItem['type'],
        title: 'Legacy notification',
        message: null,
        actionUrl: null,
        meta: null,
      }),
    )

    expect(wrapper.text()).toContain('Legacy notification')
  })

  /**
   * The stored URL verbatim, query and all. The tab used to be re-derived here from the type,
   * which was a second copy of a decision the server had already made and sent.
   */
  it('follows the action URL the server stored, including its query', async () => {
    const { router, wrapper } = await mountItem(notification({ actionUrl: '/requests?tab=all' }))
    const push = vi.spyOn(router, 'push')

    await wrapper.findAll('button')[0].trigger('click')

    expect(push).toHaveBeenCalledExactlyOnceWith('/requests?tab=all')
  })

  it.each([
    [NotificationType.BookRequestSubmitted, 'text-success'],
    [NotificationType.BookRequestRejected, 'text-warning'],
    [NotificationType.BookRequestFailed, 'text-destructive'],
  ])('renders %s with the request icon and its registered severity', async (type, severityClass) => {
    const { wrapper } = await mountItem(notification({ type }))

    expect(wrapper.find('.lucide-book-plus').exists()).toBe(true)
    expect(wrapper.find('.lucide-book-plus').classes()).toContain(severityClass)
  })

  it('exposes separate native controls for opening and dismissing the notification', async () => {
    const { wrapper } = await mountItem(notification())

    expect(wrapper.findAll('button')).toHaveLength(2)
    expect(wrapper.find('button[aria-label="Dismiss notification"]').exists()).toBe(true)
    expect(wrapper.findAll('button')[0].element.tagName).toBe('BUTTON')
  })

  describe('expandable text', () => {
    const CLAMP = '[-webkit-line-clamp:2]'
    const long = () =>
      notification({
        title: 'He Who Fights with Monsters 13: A LitRPG Adventure is out now',
        message: 'The ebook and audiobook of He Who Fights with Monsters 13: A LitRPG Adventure by Shirtaloon released on 2026-10-06.',
      })

    it('clamps the message to two lines and offers a collapsed toggle for long text', async () => {
      const { wrapper } = await mountItem(long())

      expect(wrapper.get('[data-testid="notification-message"]').classes()).toContain(CLAMP)
      const toggle = wrapper.get('[data-testid="notification-expand"]')
      expect(toggle.element.tagName).toBe('BUTTON')
      expect(toggle.attributes('type')).toBe('button')
      expect(toggle.attributes('aria-expanded')).toBe('false')
      expect(toggle.attributes('aria-label')).toBe('Show more')
    })

    it('expands the text without opening the notification', async () => {
      const { router, wrapper } = await mountItem(long())
      const push = vi.spyOn(router, 'push')

      await wrapper.get('[data-testid="notification-expand"]').trigger('click')

      const toggle = wrapper.get('[data-testid="notification-expand"]')
      expect(toggle.attributes('aria-expanded')).toBe('true')
      expect(toggle.attributes('aria-label')).toBe('Show less')
      expect(wrapper.get('[data-testid="notification-message"]').classes()).not.toContain(CLAMP)
      expect(push).not.toHaveBeenCalled()
      expect(wrapper.emitted('read')).toBeUndefined()
    })

    it('opens a cut-off item in place on the first tap and leaves the sheet on the second', async () => {
      const { router, wrapper } = await mountItem(long())
      const push = vi.spyOn(router, 'push')

      await wrapper.get('button').trigger('click')

      expect(wrapper.get('[data-testid="notification-expand"]').attributes('aria-expanded')).toBe('true')
      expect(wrapper.get('[data-testid="notification-message"]').classes()).not.toContain(CLAMP)
      expect(wrapper.emitted('read')).toEqual([[1]])
      expect(push).not.toHaveBeenCalled()

      await wrapper.get('button').trigger('click')

      expect(push).toHaveBeenCalledWith({ name: 'book-request-detail', params: { id: 42 } })
    })

    it('offers no toggle when the title and message fit', async () => {
      const { wrapper } = await mountItem(notification())

      expect(wrapper.find('[data-testid="notification-expand"]').exists()).toBe(false)
      expect(wrapper.find('button button').exists()).toBe(false)
    })

    it('offers a toggle for a long title alone', async () => {
      const { wrapper } = await mountItem(notification({ title: 'He Who Fights with Monsters 13: A LitRPG Adventure is out now', message: null }))

      expect(wrapper.find('[data-testid="notification-expand"]').exists()).toBe(true)
    })
  })

  describe('a monitored release announcement', () => {
    const release = () =>
      notification({
        type: NotificationType.MonitoredReleaseAvailable,
        title: 'New release: Dune',
        message: 'Dune is out as an ebook and an audiobook',
        actionUrl: '/monitored/authors/a1',
        meta: { monitorAuthorId: 'a1', workId: 'w 1', formats: ['ebook', 'audiobook'], releaseDates: {} },
      })

    beforeEach(() => {
      mockApi.mockReset()
      toastError.mockReset()
      permissions.granted = new Set([Permission.BookRequestAccess])
    })

    it('marks the announcement with the new-release icon', async () => {
      const { wrapper } = await mountItem(release())

      expect(wrapper.find('svg.lucide-party-popper').exists()).toBe(true)
      expect(wrapper.find('svg.lucide-bell').exists()).toBe(false)
    })

    it('offers one request button per format', async () => {
      const { wrapper } = await mountItem(release())

      expect(wrapper.get('[data-testid="notification-request-ebook"]').text()).toBe('Request ebook')
      expect(wrapper.get('[data-testid="notification-request-audiobook"]').text()).toBe('Request audiobook')
    })

    it('requests the format with auto-download without opening the notification', async () => {
      let resolve!: (value: unknown) => void
      mockApi.mockReturnValue(new Promise((r) => (resolve = r)))
      const { router, wrapper } = await mountItem(release())
      const push = vi.spyOn(router, 'push')

      await wrapper.get('[data-testid="notification-request-ebook"]').trigger('click')

      expect(mockApi).toHaveBeenCalledExactlyOnceWith('/api/v1/monitored/works/w%201/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'ebook', autoDownload: true }),
      })
      const pending = wrapper.get('[data-testid="notification-request-ebook"]')
      expect(pending.attributes('disabled')).toBeDefined()
      expect(pending.find('.animate-spin').exists()).toBe(true)

      resolve({ ok: true, status: 200, json: () => Promise.resolve({ requestIds: { ebook: 9 } }) })
      await flushPromises()

      const done = wrapper.get('[data-testid="notification-request-ebook"]')
      expect(done.text()).toBe('Requested')
      expect(done.attributes('disabled')).toBeDefined()
      expect(done.find('.lucide-check').exists()).toBe(true)
      expect(wrapper.get('[data-testid="notification-request-audiobook"]').text()).toBe('Request audiobook')
      expect(push).not.toHaveBeenCalled()
      expect(wrapper.emitted('read')).toBeUndefined()
    })

    it('says so and returns to idle when the request fails', async () => {
      mockApi.mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({ message: 'Work is not monitored' }) })
      const { wrapper } = await mountItem(release())

      await wrapper.get('[data-testid="notification-request-ebook"]').trigger('click')
      await flushPromises()

      expect(toastError).toHaveBeenCalledExactlyOnceWith('Work is not monitored')
      const button = wrapper.get('[data-testid="notification-request-ebook"]')
      expect(button.text()).toBe('Request ebook')
      expect(button.attributes('disabled')).toBeUndefined()
    })

    it('offers no request buttons without the request permission', async () => {
      permissions.granted = new Set()
      const { wrapper } = await mountItem(release())

      expect(wrapper.find('[data-testid="notification-request-ebook"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="notification-request-audiobook"]').exists()).toBe(false)
    })
  })

  describe('request deep links', () => {
    it('opens the release picker for a request that needs a release', async () => {
      const { router, wrapper } = await mountItem(notification({ type: NotificationType.BookRequestNeedsRelease, meta: { requestId: 42 } }))

      await wrapper.findAll('button')[0].trigger('click')
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/requests/42/releases')
      expect(wrapper.emitted('read')).toEqual([[1]])
    })

    it('opens the request detail for any other request notification', async () => {
      const { router, wrapper } = await mountItem(notification({ type: NotificationType.BookRequestFailed, meta: { requestId: 42 } }))

      await wrapper.findAll('button')[0].trigger('click')
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/requests/42')
    })

    it('falls back to the request list without a request id', async () => {
      const { router, wrapper } = await mountItem(notification({ meta: null }))

      await wrapper.findAll('button')[0].trigger('click')
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/requests')
    })
  })

  describe('read-aloud notifications', () => {
    const readAloud = (overrides: Partial<NotificationItem> = {}) =>
      notification({
        type: NotificationType.ReadAloudReady,
        title: 'Server fallback title',
        message: 'Server fallback message',
        actionUrl: '/book/12/files',
        meta: { jobId: 'job-1', bookId: 12, bookTitle: 'Dune', errorCode: null },
        ...overrides,
      })

    it('renders the title in the reader’s locale from the stored book title', async () => {
      const { wrapper } = await mountItem(readAloud())

      expect(wrapper.text()).toContain('Read-aloud ready: Dune')
      expect(wrapper.text()).not.toContain('Server fallback')
    })

    it('follows the active locale rather than the language the server wrote in', async () => {
      const { wrapper } = await mountItem(readAloud(), {
        locale: 'fr',
        messages: { notifications: { readAloud: { readyTitle: 'Lecture synchronisée prête : {title}' } } },
      })

      expect(wrapper.text()).toContain('Lecture synchronisée prête : Dune')
    })

    it('explains a failure with the localized reason for its error code', async () => {
      const { wrapper } = await mountItem(
        readAloud({
          type: NotificationType.ReadAloudFailed,
          meta: { jobId: 'job-1', bookId: 12, bookTitle: 'Dune', errorCode: 'insufficient_storage' },
        }),
      )

      expect(wrapper.text()).toContain('Read-aloud failed: Dune')
      expect(wrapper.text()).toContain(String(en.book.detail.files.readAloud.errors.job.insufficient_storage))
    })

    it('keeps the server copy for a notification stored before the title was sent', async () => {
      const { wrapper } = await mountItem(readAloud({ meta: { jobId: 'job-1', bookId: 12, errorCode: null } }))

      expect(wrapper.text()).toContain('Server fallback title')
      expect(wrapper.text()).toContain('Server fallback message')
    })

    it('leaves every other type to the server copy', async () => {
      const { wrapper } = await mountItem(notification({ meta: { bookTitle: 'Dune' } }))

      expect(wrapper.text()).toContain('New book request')
      expect(wrapper.text()).toContain('Reader requested "Dune"')
    })
  })
})
