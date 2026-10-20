import { beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { defineComponent } from 'vue'
import type { MonitoredAuthorItem, MonitoredAuthorSearchResult } from '@bookorbit/types'
import en from '@/locales/en.json'
import { compileIcuCatalog } from '@/i18n/icu'
import AddMonitoredPanel from '../AddMonitoredPanel.vue'

const { search, events } = vi.hoisted(() => ({
  search: vi.fn<(query: string) => Promise<MonitoredAuthorSearchResult[]>>(),
  events: { current: null as null | { onItem: (item: MonitoredAuthorItem) => void; onReconnect: () => void } },
}))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))
vi.mock('../../api/monitored', () => ({
  searchMonitoredAuthors: search,
  deleteMonitoredAuthor: vi.fn<() => Promise<void>>(),
  fetchMonitoredAuthorDetail: vi.fn<() => Promise<unknown>>(),
}))
vi.mock('../../composables/useMonitoredFetchEvents', () => ({
  useMonitoredFetchEvents: (handlers: typeof events.current) => {
    events.current = handlers
  },
}))

const ModalStub = defineComponent({
  name: 'MonitorAuthorModal',
  props: ['initialFormats', 'open', 'result'],
  emits: ['created', 'close'],
  template: '<div />',
})

function result(name: string, alreadyMonitoredId: string | null): MonitoredAuthorSearchResult {
  return { name, providerIds: {}, localAuthorId: null, bookCount: 3, imageUrl: null, genres: [], alreadyMonitoredId }
}

function item(id: string, name: string, state: MonitoredAuthorItem['fetch']['state']): MonitoredAuthorItem {
  return { id, authorName: name, fetch: { state, errorKind: null, errorAt: null, retryAt: null } } as MonitoredAuthorItem
}

async function setup(results: MonitoredAuthorSearchResult[]) {
  search.mockResolvedValue(results)
  const wrapper = mount(AddMonitoredPanel, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: compileIcuCatalog(en, 'en') } })],
      stubs: {
        RouterLink: RouterLinkStub,
        Tooltip: { template: '<div><slot /></div>' },
        TooltipTrigger: { template: '<div><slot /></div>' },
        TooltipContent: { template: '<div><slot /></div>' },
        MonitorAuthorModal: ModalStub,
        ConfirmDialog: true,
      },
    },
  })
  await wrapper.get('input').setValue('Mark Lawrence')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  search.mockReset()
  events.current = null
})

it('has no format chips and opens the modal with both formats on', async () => {
  const wrapper = await setup([result('Mark Lawrence', null)])
  expect(wrapper.text()).not.toContain('Watch formats')
  expect(wrapper.getComponent(ModalStub).props('initialFormats')).toEqual(['ebook', 'audiobook'])
})

it('links a watched author to their watchlist page and leaves unwatched names as text', async () => {
  const wrapper = await setup([result('Mark Lawrence', 'm1'), result('Mark Lawrence Schrad', null)])
  const links = wrapper.findAllComponents(RouterLinkStub)
  expect(links).toHaveLength(1)
  expect(links[0].props('to')).toEqual({ name: 'monitored-author', params: { id: 'm1' } })
  expect(links[0].text()).toBe('Mark Lawrence')
})

it('shows a spinner over a just-added author until the fetch settles', async () => {
  const wrapper = await setup([result('Mark Lawrence', null)])
  wrapper.getComponent(ModalStub).vm.$emit('created', item('m1', 'Mark Lawrence', 'queued'))
  await flushPromises()
  expect(wrapper.find('[data-testid="result-fetching"]').exists()).toBe(true)
  expect(wrapper.findComponent(RouterLinkStub).props('to')).toEqual({ name: 'monitored-author', params: { id: 'm1' } })

  events.current!.onItem(item('m1', 'Mark Lawrence', 'fetching'))
  await flushPromises()
  expect(wrapper.find('[data-testid="result-fetching"]').exists()).toBe(true)

  events.current!.onItem(item('m1', 'Mark Lawrence', 'idle'))
  await flushPromises()
  expect(wrapper.find('[data-testid="result-fetching"]').exists()).toBe(false)
})

it('ignores fetch events for authors not added from this panel', async () => {
  const wrapper = await setup([result('Mark Lawrence', 'm1')])
  events.current!.onItem(item('m1', 'Mark Lawrence', 'fetching'))
  await flushPromises()
  expect(wrapper.find('[data-testid="result-fetching"]').exists()).toBe(false)
})
