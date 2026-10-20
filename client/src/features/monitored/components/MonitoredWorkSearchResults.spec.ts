import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { MonitoredWork, MonitoredWorkSearchItem } from '@bookorbit/types'
import MonitoredWorkSearchResults from './MonitoredWorkSearchResults.vue'
import MonitoredWorkCard from './MonitoredWorkCard.vue'

function render(items: MonitoredWorkSearchItem[], canManage = true) {
  return mount(MonitoredWorkSearchResults, {
    props: { items, canManage, loading: false, error: null, cardSize: 122, gridGap: 16 },
    global: {
      stubs: {
        MonitoredVirtualGrid: { props: ['items'], template: '<div><slot v-for="item in items" :item="item" /></div>' },
        MonitoredWorkCard: true,
        MonitoredEmptyState: { props: ['title'], template: '<p>{{ title }}</p>' },
      },
    },
  })
}
const item = (id: string, isOwner: boolean) =>
  ({
    work: { id, requestStatuses: { ebook: 'grabbed' } } as unknown as MonitoredWork,
    monitorAuthorId: 'author-1',
    authorName: 'Writer',
    authorLastRefreshedAt: null,
    authorModes: { ebook: 'auto-all', audiobook: 'off' },
    isOwner,
  }) as MonitoredWorkSearchItem

describe('MonitoredWorkSearchResults', () => {
  it('renders cards with ownership, formats and queued flags', async () => {
    const wrapper = render([item('one', true), item('two', false)])
    const cards = wrapper.findAllComponents(MonitoredWorkCard)
    expect(cards).toHaveLength(2)
    expect(cards.map((card) => card.props('canManage'))).toEqual([true, false])
    expect(cards[0]!.props('monitoredFormats')).toEqual(['ebook'])
    expect(cards[0]!.props('ebookQueued')).toBe(true)
    cards[0]!.vm.$emit('preview')
    expect(wrapper.emitted('preview')?.[0]?.[0]).toMatchObject({ work: { id: 'one' } })
    await wrapper.setProps({ canManage: false })
    expect(cards[0]!.props('canManage')).toBe(false)
  })
  it('shows an empty state after settling', async () => {
    const wrapper = render([])
    expect(wrapper.text()).toContain('No watchlist books match')
    await wrapper.setProps({ loading: true })
    expect(wrapper.text()).toBe('')
  })
})
