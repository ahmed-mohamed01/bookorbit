import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MonitoredSortOptions from './MonitoredSortOptions.vue'

const options = [
  { value: 'releaseDate', label: 'Release date' },
  { value: 'title', label: 'Title' },
] as const

function mountOptions(props: { modelValue: 'releaseDate' | 'title'; order: 'asc' | 'desc' }) {
  return mount(MonitoredSortOptions, { props: { options, ...props } })
}

function radio(wrapper: ReturnType<typeof mountOptions>, text: string) {
  return wrapper.findAll('[role="radio"]').find((candidate) => candidate.text().startsWith(text))!
}

describe('MonitoredSortOptions', () => {
  it('marks the selected field and direction for assistive tech', () => {
    const wrapper = mountOptions({ modelValue: 'releaseDate', order: 'asc' })

    expect(radio(wrapper, 'Release date').attributes('aria-checked')).toBe('true')
    expect(radio(wrapper, 'Title').attributes('aria-checked')).toBe('false')
    expect(radio(wrapper, 'Ascending').attributes('aria-checked')).toBe('true')
    expect(radio(wrapper, 'Descending').attributes('aria-checked')).toBe('false')
  })

  it('emits a new field or direction and ignores the one already selected', async () => {
    const wrapper = mountOptions({ modelValue: 'releaseDate', order: 'asc' })

    await radio(wrapper, 'Release date').trigger('click')
    await radio(wrapper, 'Ascending').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.emitted('update:order')).toBeUndefined()

    await radio(wrapper, 'Title').trigger('click')
    await radio(wrapper, 'Descending').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['title'])
    expect(wrapper.emitted('update:order')?.[0]).toEqual(['desc'])
  })
})
