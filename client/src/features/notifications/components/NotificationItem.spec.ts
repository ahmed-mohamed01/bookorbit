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

async function mountItem(item: NotificationItem) {
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
  const i18n = createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: { en } })

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

  describe('progress', () => {
    it('renders a bar for a notification that reports progress', async () => {
      const { wrapper } = await mountItem(
        notification({ type: NotificationType.ReadAlongBuild, title: 'Building read-along: Dune', meta: { buildId: 7, progress: 0.42 } }),
      )

      const bar = wrapper.get('[data-testid="notification-progress"]')
      expect(bar.attributes('aria-hidden')).toBe('true')
      expect(bar.attributes('role')).toBeUndefined()
      expect(bar.attributes('aria-valuenow')).toBeUndefined()
      expect(bar.get('div').attributes('style')).toContain('width: 42%')
    })

    it('drops the bar once the operation is done', async () => {
      const { wrapper } = await mountItem(notification({ type: NotificationType.ReadAlongBuild, meta: { buildId: 7, progress: 1, done: true } }))

      expect(wrapper.find('[data-testid="notification-progress"]').exists()).toBe(false)
    })

    it('renders no bar without a numeric progress', async () => {
      const { wrapper } = await mountItem(notification({ meta: { requestId: 42 } }))

      expect(wrapper.find('[data-testid="notification-progress"]').exists()).toBe(false)
    })
  })

  // Read-along build notifications live in the bulk rename category, so its description has to say so
  // or a user silencing it would not know what else goes quiet.
  it('names read-along builds in the category that carries them', () => {
    expect(en.notifications.preferences.categories.bulkRename.description).toContain('read-along build')
  })

  describe('a read-along build still running', () => {
    const running = (meta: Record<string, unknown>) =>
      notification({
        type: NotificationType.ReadAlongBuild,
        title: 'Building read-along: Dune',
        message: 'Transcribing',
        actionUrl: '/book/10?tab=details',
        meta: { buildId: 7, bookId: 10, locked: true, cancellable: true, ...meta },
      })

    beforeEach(() => {
      mockApi.mockReset()
      toastError.mockReset()
    })

    it('offers Cancel build and no dismiss while it can still be cancelled', async () => {
      const { wrapper } = await mountItem(running({}))

      const cancel = wrapper.get('[data-testid="notification-cancel-build"]')
      expect(cancel.attributes('aria-label')).toBe('Cancel the read-along build')
      expect(cancel.text()).toContain('Cancel build')
      expect(wrapper.find('button[aria-label="Dismiss notification"]').exists()).toBe(false)
    })

    it('hides Cancel build once importing, and keeps it undismissable while locked', async () => {
      const { wrapper } = await mountItem(running({ cancellable: false }))

      expect(wrapper.find('[data-testid="notification-cancel-build"]').exists()).toBe(false)
      expect(wrapper.find('button[aria-label="Dismiss notification"]').exists()).toBe(false)
    })

    it('can be dismissed again once the build ended', async () => {
      const { wrapper } = await mountItem(running({ locked: false, cancellable: false, done: true }))

      expect(wrapper.find('[data-testid="notification-cancel-build"]').exists()).toBe(false)
      expect(wrapper.find('button[aria-label="Dismiss notification"]').exists()).toBe(true)
    })

    it('cancels through the build route without opening the notification', async () => {
      mockApi.mockResolvedValue({ ok: true, status: 204 })
      const { router, wrapper } = await mountItem(running({}))
      const push = vi.spyOn(router, 'push')

      await wrapper.get('[data-testid="notification-cancel-build"]').trigger('click')
      await flushPromises()

      expect(mockApi).toHaveBeenCalledExactlyOnceWith('/api/v1/storyteller/read-along/books/10/build?buildId=7', { method: 'DELETE' })
      expect(push).not.toHaveBeenCalled()
      expect(wrapper.emitted('read')).toBeUndefined()
      expect(toastError).not.toHaveBeenCalled()
    })

    it('says so when the build is already being imported', async () => {
      mockApi.mockResolvedValue({ ok: false, status: 409 })
      const { wrapper } = await mountItem(running({}))

      await wrapper.get('[data-testid="notification-cancel-build"]').trigger('click')
      await flushPromises()

      expect(toastError).toHaveBeenCalledWith(en.book.detail.editionLink.readAlong.cancelTooLate)
    })

    it('says so when the cancel fails', async () => {
      mockApi.mockResolvedValue({ ok: false, status: 500 })
      const { wrapper } = await mountItem(running({}))

      await wrapper.get('[data-testid="notification-cancel-build"]').trigger('click')
      await flushPromises()

      expect(toastError).toHaveBeenCalledWith(en.book.detail.editionLink.readAlong.cancelUnavailable)
    })
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
})
