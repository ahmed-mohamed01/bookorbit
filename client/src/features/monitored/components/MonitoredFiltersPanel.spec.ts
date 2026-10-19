import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import MonitoredFiltersPanel from './MonitoredFiltersPanel.vue'
import { DEFAULT_MONITORED_DISPLAY, countWorkClasses } from '../lib/work-visibility'
import { RELEASE_STATUS_OPTIONS, defaultAuthorStatusFilters, defaultStatusFilters } from '../lib/status-filter'

function panel(overrides = {}) {
  return mount(MonitoredFiltersPanel, {
    props: {
      modelValue: { ...DEFAULT_MONITORED_DISPLAY },
      counts: countWorkClasses([]),
      canCurate: true,
      statusFilters: defaultAuthorStatusFilters(),
      sections: { status: true, release: false, kind: true, more: false },
      ...overrides,
    },
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
}
describe('MonitoredFiltersPanel', () => {
  it('renders four collapsible sections without In progress', async () => {
    const wrapper = panel()
    expect(wrapper.findAll('section')).toHaveLength(4)
    expect(wrapper.text()).not.toContain('In progress')
    await wrapper.get('[data-testid="section-kind"]').trigger('click')
    expect(wrapper.emitted('toggle-section')).toEqual([['kind']])
    await wrapper.setProps({ sections: { status: true, release: false, kind: false, more: false } })
    expect(wrapper.find('[data-testid="kind-book"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="section-kind"]').text()).toContain('Book')
  })
  it('summarizes all, none, two labels and larger selections', async () => {
    const wrapper = panel({ sections: { status: false, release: false, kind: false, more: false } })
    expect(wrapper.get('[data-testid="section-status"]').text()).toContain('All')
    expect(wrapper.get('[data-testid="section-more"]').text()).toContain('None')
    await wrapper.setProps({ modelValue: { ...DEFAULT_MONITORED_DISPLAY, kinds: ['book', 'collection'] } })
    expect(wrapper.get('[data-testid="section-kind"]').text()).toContain('Book, Collection')
    await wrapper.setProps({ modelValue: { ...DEFAULT_MONITORED_DISPLAY, kinds: ['book', 'collection', 'duplicate'] } })
    expect(wrapper.get('[data-testid="section-kind"]').text()).toContain('3 of 8')
  })
  it('allows the last kind and status to be unticked', async () => {
    const wrapper = panel({ statusFilters: ['missing'] })
    expect(wrapper.get('[data-testid="kind-book"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="status-missing"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="kind-book"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([{ ...DEFAULT_MONITORED_DISPLAY, kinds: [] }])
    await wrapper.get('[data-testid="status-missing"]').trigger('click')
    expect(wrapper.emitted('update:statusFilters')).toEqual([[[]]])
    await wrapper.get('[data-testid="kind-supplemental"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual([{ ...DEFAULT_MONITORED_DISPLAY, kinds: ['book', 'supplemental'] }])
  })
  it('offers the release statuses without Hidden and drops the Release section on the releases tab', () => {
    const wrapper = panel({ statusOptions: RELEASE_STATUS_OPTIONS, showRelease: false, statusFilters: defaultStatusFilters() })
    expect(wrapper.findAll('section')).toHaveLength(3)
    expect(wrapper.find('[data-testid="section-release"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="status-in_progress"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('In progress')
    expect(wrapper.find('[data-testid="status-hidden"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="reset"]').exists()).toBe(false)
  })
  it('hides More for non-curators and Status without a selection', () => {
    const wrapper = panel({ canCurate: false, statusFilters: undefined })
    expect(wrapper.find('[data-testid="section-more"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="section-status"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="section-kind"]').exists()).toBe(true)
  })
  it('offers reset only for changed filters', async () => {
    const wrapper = panel()
    expect(wrapper.find('[data-testid="reset"]').exists()).toBe(false)
    await wrapper.setProps({ modelValue: { ...DEFAULT_MONITORED_DISPLAY, hidden: true } })
    await wrapper.get('[data-testid="reset"]').trigger('click')
    expect(wrapper.emitted('reset')).toEqual([[]])
  })
})
