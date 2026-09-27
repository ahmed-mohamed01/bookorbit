import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import { NotificationType, type NotificationItem } from '@bookorbit/types'
import en from '@/locales/en.json'
import NotificationItemVue from './NotificationItem.vue'

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
      { path: '/requests', component: { template: '<div />' } },
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
})
