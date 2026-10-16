import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { workFixture } from '../testing/work-fixture'
import MonitoredQuickSelect from './MonitoredQuickSelect.vue'

const works = [
  workFixture({ id: 'a' }),
  workFixture({ id: 'b', ownedFormats: ['ebook'] }),
  workFixture({ id: 'c', ebookReleaseDate: '2999-01-01', audioReleaseDate: '2999-01-01' }),
  workFixture({ id: 'd', monitorFormats: { audiobook: false } }),
]

function mountQuick(selected: string[] = [], format: 'ebook' | 'audiobook' | 'both' = 'ebook', list = works) {
  return mount(MonitoredQuickSelect, { props: { works: list, selectedIds: new Set(selected), format } })
}

describe('MonitoredQuickSelect', () => {
  it('shows the count of missing works per format and adds them on click', async () => {
    const wrapper = mountQuick()

    expect(wrapper.get('[data-testid="quick-missing-ebooks"]').text()).toContain('2')
    expect(wrapper.get('[data-testid="quick-missing-audiobooks"]').text()).toContain('2')

    await wrapper.get('[data-testid="quick-missing-audiobooks"]').trigger('click')

    expect(wrapper.emitted('add')?.[0]?.[0]).toEqual(['a', 'b'])
  })

  it('hides a missing-works button when none qualify', () => {
    const wrapper = mountQuick([], 'ebook', [workFixture({ ownedFormats: ['ebook', 'audiobook'] })])

    expect(wrapper.find('[data-testid="quick-missing-ebooks"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quick-missing-audiobooks"]').exists()).toBe(false)
  })

  it('disables released-only until something is selected', () => {
    const wrapper = mountQuick()

    expect(wrapper.get('[data-testid="quick-released-only"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="quick-released-only"]').attributes('title')).toBeTruthy()
  })

  it('narrows the selection to works whose chosen format is out', async () => {
    const wrapper = mountQuick(['a', 'c'])

    await wrapper.get('[data-testid="quick-released-only"]').trigger('click')

    expect(wrapper.emitted('keep')?.[0]?.[0]).toEqual(['a'])
  })

  it('counts a work as released for Both when either format is out', async () => {
    const mixed = workFixture({ id: 'm', ebookReleaseDate: '2999-01-01', audioReleaseDate: '2020-01-01' })
    const wrapper = mountQuick(['m'], 'both', [mixed])

    await wrapper.get('[data-testid="quick-released-only"]').trigger('click')

    expect(wrapper.emitted('keep')?.[0]?.[0]).toEqual(['m'])
  })
})
