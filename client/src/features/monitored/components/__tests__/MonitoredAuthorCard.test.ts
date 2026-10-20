import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import type { MonitoredAuthorItem, MonitoredFetchState } from '@bookorbit/types'
import en from '@/locales/en.json'
import { compileIcuCatalog } from '@/i18n/icu'
import MonitoredAuthorCard from '../MonitoredAuthorCard.vue'
function setup(state: MonitoredFetchState, lastRefreshedAt: string | null = null) {
  return mount(MonitoredAuthorCard, {
    props: {
      canManage: true,
      author: {
        id: 'a',
        authorName: 'Author',
        portraitAuthorId: 1,
        lastRefreshedAt,
        fetch: { state, errorKind: 'timeout', errorAt: null, retryAt: null },
        counts: { total: 12, ebookOwned: 1, audioOwned: 2 },
      } as MonitoredAuthorItem,
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: compileIcuCatalog(en, 'en') } })],
      stubs: {
        Tooltip: { template: '<div><slot /></div>' },
        TooltipTrigger: { template: '<div><slot /></div>' },
        TooltipContent: { template: '<div><slot /></div>' },
        DropdownMenu: { template: '<div><slot /></div>' },
        DropdownMenuTrigger: { template: '<div><slot /></div>' },
        DropdownMenuContent: { template: '<div><slot /></div>' },
        DropdownMenuSeparator: true,
        DropdownMenuItem: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
      },
    },
  })
}
it.each(['queued', 'fetching'] as const)('dims the portrait, shows a spinner and hides counts for %s', (state) => {
  const wrapper = setup(state)
  expect(wrapper.get('img').classes()).toContain('opacity-50')
  expect(wrapper.find('[data-testid="fetch-spinner"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="count-pills"]').exists()).toBe(false)
  expect(wrapper.text()).toContain(en.monitored.fetch[state])
  expect(wrapper.get('[data-testid="refresh-author"]').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
it('shows the failure tooltip and Retry but no counts without a catalog', () => {
  const wrapper = setup('failed')
  expect(wrapper.find('[data-testid="fetch-failed"]').exists()).toBe(true)
  expect(wrapper.text()).toContain('Hardcover timed out')
  expect(wrapper.text()).toContain('Use Refresh to try again')
  expect(wrapper.text()).toContain('Retry')
  expect(wrapper.find('[data-testid="count-pills"]').exists()).toBe(false)
  wrapper.unmount()
})
it('keeps the count pills with a previous catalog', () => {
  const wrapper = setup('failed', '2026-10-19T12:00:00Z')
  expect(wrapper.find('[data-testid="fetch-failed"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="count-pills"]').exists()).toBe(true)
  expect(wrapper.text()).toContain('Showing books from')
  wrapper.unmount()
})
