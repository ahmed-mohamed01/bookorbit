import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MonitoredFiltersMenu from './MonitoredFiltersMenu.vue'
import MonitoredFiltersPanel from './MonitoredFiltersPanel.vue'
import { DEFAULT_MONITORED_DISPLAY, countWorkClasses } from '../lib/work-visibility'
import { defaultAuthorStatusFilters } from '../lib/status-filter'

function menu(statusFilters = defaultAuthorStatusFilters(), extra: Record<string, unknown> = {}) {
  return mount(MonitoredFiltersMenu, {
    props: {
      modelValue: { ...DEFAULT_MONITORED_DISPLAY },
      counts: countWorkClasses([]),
      canCurate: true,
      statusFilters,
      sections: { status: true, release: false, kind: true, more: false },
      ...extra,
    },
    global: {
      stubs: {
        Popover: { name: 'Popover', template: '<div><slot /></div>', emits: ['update:open'] },
        PopoverTrigger: { template: '<div><slot /></div>' },
        PopoverContent: { template: '<div><slot /></div>' },
      },
    },
  })
}
describe('MonitoredFiltersMenu', () => {
  it('passes status edits straight through on each tick', () => {
    const wrapper = menu()
    const panel = wrapper.findComponent(MonitoredFiltersPanel)
    panel.vm.$emit('update:statusFilters', ['missing'])
    panel.vm.$emit('update:statusFilters', [])
    expect(wrapper.emitted('update:statusFilters')).toEqual([[['missing']], [[]]])
  })
  it('resets without touching section state or the status selection', () => {
    const wrapper = menu()
    wrapper.findComponent(MonitoredFiltersPanel).vm.$emit('reset')
    expect(wrapper.emitted('reset')).toEqual([[]])
    expect(wrapper.emitted('update:statusFilters')).toBeUndefined()
    expect(wrapper.emitted('toggle-section')).toBeUndefined()
  })
  it('marks the trigger changed only when the filters differ from the author default', async () => {
    const wrapper = menu()
    expect(wrapper.find('button').classes()).not.toContain('border-primary/55')
    await wrapper.setProps({ modelValue: { ...DEFAULT_MONITORED_DISPLAY, hidden: true } })
    expect(wrapper.find('button').classes()).toContain('border-primary/55')
    await wrapper.setProps({ modelValue: { ...DEFAULT_MONITORED_DISPLAY }, statusFilters: ['missing'] })
    expect(wrapper.find('button').classes()).toContain('border-primary/55')
  })
  it('holds ticks as a draft and commits once when the popover closes', async () => {
    const wrapper = menu(defaultAuthorStatusFilters(), { commitOnClose: true })
    const panel = wrapper.findComponent(MonitoredFiltersPanel)
    wrapper.findComponent({ name: 'Popover' }).vm.$emit('update:open', true)
    panel.vm.$emit('update:statusFilters', ['missing'])
    panel.vm.$emit('update:modelValue', { ...DEFAULT_MONITORED_DISPLAY, hidden: true })
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:statusFilters')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.findComponent({ name: 'Popover' }).vm.$emit('update:open', false)
    expect(wrapper.emitted('update:statusFilters')).toEqual([[['missing']]])
    expect(wrapper.emitted('update:modelValue')).toEqual([[{ ...DEFAULT_MONITORED_DISPLAY, hidden: true }]])
    expect(wrapper.emitted('open-change')).toEqual([[true], [false]])
  })
  it('keeps the last status ticked and resets the draft without emitting reset in commit mode', async () => {
    const wrapper = menu(['missing'], { commitOnClose: true })
    const popover = wrapper.findComponent({ name: 'Popover' })
    popover.vm.$emit('update:open', true)
    const panel = wrapper.findComponent(MonitoredFiltersPanel)
    panel.vm.$emit('update:statusFilters', [])
    panel.vm.$emit('update:modelValue', { ...DEFAULT_MONITORED_DISPLAY, hidden: true })
    panel.vm.$emit('reset')
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reset')).toBeUndefined()
    popover.vm.$emit('update:open', false)
    expect(wrapper.emitted('update:statusFilters')?.[0]?.[0]).toEqual(expect.arrayContaining(['missing']))
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
