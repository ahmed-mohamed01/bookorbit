import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MonitoredSortMenu from './MonitoredSortMenu.vue'

const options = [
  { value: 'releaseDate', label: 'Release date' },
  { value: 'title', label: 'Title' },
] as const

function mountMenu(props: { modelValue: 'releaseDate' | 'title'; order: 'asc' | 'desc' }) {
  return mount(MonitoredSortMenu, { props: { options, ...props }, attachTo: document.body })
}

describe('MonitoredSortMenu', () => {
  it('summarizes the active field and direction on the trigger', () => {
    const wrapper = mountMenu({ modelValue: 'title', order: 'desc' })
    const trigger = wrapper.get('button')

    expect(trigger.attributes('aria-label')).toBe('Sort')
    expect(trigger.attributes('title')).toBe('Title · Descending')
    wrapper.unmount()
  })

  it('marks the selected field and direction for assistive tech and emits changes', async () => {
    const wrapper = mountMenu({ modelValue: 'releaseDate', order: 'asc' })
    await wrapper.get('button').trigger('click')

    const radios = [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const byLabel = (text: string) => radios.find((radio) => radio.textContent?.trim().startsWith(text))

    expect(byLabel('Release date')?.getAttribute('aria-checked')).toBe('true')
    expect(byLabel('Title')?.getAttribute('aria-checked')).toBe('false')
    expect(byLabel('Ascending')?.getAttribute('aria-checked')).toBe('true')

    byLabel('Title')?.click()
    byLabel('Descending')?.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['title'])
    expect(wrapper.emitted('update:order')?.[0]).toEqual(['desc'])
    wrapper.unmount()
  })
})
