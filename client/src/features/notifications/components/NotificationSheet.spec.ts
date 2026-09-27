import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { NotificationType, type NotificationItem } from '@bookorbit/types'
import NotificationSheet from './NotificationSheet.vue'

const feed = vi.hoisted(() => ({ inProgress: [] as unknown[], settled: [] as unknown[] }))

vi.mock('../composables/useNotifications', () => ({
  useNotifications: () => ({
    notifications: ref([...feed.inProgress, ...feed.settled]),
    inProgressNotifications: ref(feed.inProgress),
    settledNotifications: ref(feed.settled),
    unreadCount: ref(0),
    loading: ref(false),
    hasMore: ref(false),
    fetchNotifications: vi.fn<(reset?: boolean) => Promise<void>>().mockResolvedValue(undefined),
    markAsRead: vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined),
    markAllAsRead: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    dismiss: vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined),
    clearAll: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }),
}))

const stubs = {
  Button: { template: '<button type="button"><slot /></button>' },
  Sheet: { template: '<div><slot /></div>' },
  SheetTrigger: { template: '<div><slot /></div>' },
  SheetContent: { template: '<div><slot /></div>' },
  SheetDescription: { template: '<div><slot /></div>' },
  SheetHeader: { template: '<div><slot /></div>' },
  SheetTitle: { template: '<div><slot /></div>' },
  Tooltip: { template: '<div><slot /></div>' },
  TooltipTrigger: { template: '<div><slot /></div>' },
  TooltipContent: { template: '<div data-testid="tooltip-content"><slot /></div>' },
  NotificationItemVue: { props: ['notification'], template: '<div data-testid="item">{{ notification.title }}</div>' },
}

function item(id: number, title: string, locked: boolean): NotificationItem {
  return {
    id,
    type: NotificationType.ReadAlongBuild,
    title,
    message: null,
    actionUrl: null,
    meta: { buildId: id, bookId: 10, locked, cancellable: locked },
    read: false,
    count: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('NotificationSheet trigger', () => {
  it('provides an accessible name and matching tooltip', () => {
    const wrapper = mount(NotificationSheet, {
      props: { iconRadiusClass: 'rounded-md' },
      global: { stubs },
    })

    expect(wrapper.get('button').attributes('aria-label')).toBe('Notifications')
    expect(wrapper.get('[data-testid="tooltip-content"]').text()).toBe('Notifications')
  })
})

describe('NotificationSheet feed', () => {
  it('lists the builds still running under In progress, above the rest', () => {
    feed.inProgress = [item(2, 'Building read-along: Dune', true)]
    feed.settled = [item(1, 'Read-along ready: Emma', false)]

    const wrapper = mount(NotificationSheet, {
      props: { iconRadiusClass: 'rounded-md' },
      global: { stubs },
    })

    const group = wrapper.get('[data-testid="notifications-in-progress"]')
    expect(group.get('h3').text()).toBe('In progress')
    expect(group.findAll('[data-testid="item"]').map((node) => node.text())).toEqual(['Building read-along: Dune'])
    expect(wrapper.findAll('[data-testid="item"]').map((node) => node.text())).toEqual(['Building read-along: Dune', 'Read-along ready: Emma'])
  })

  it('shows no group heading when nothing is running', () => {
    feed.inProgress = []
    feed.settled = [item(1, 'Read-along ready: Emma', false)]

    const wrapper = mount(NotificationSheet, {
      props: { iconRadiusClass: 'rounded-md' },
      global: { stubs },
    })

    expect(wrapper.find('[data-testid="notifications-in-progress"]').exists()).toBe(false)
  })
})
