import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import WebSerialSourceFilter from '../components/WebSerialSourceFilter.vue'

const OPTIONS = [
  { sourceName: 'MangaDex', count: 2 },
  { sourceName: 'AllManga', count: 1 },
]

function make(selected: string | null = null) {
  return mount(WebSerialSourceFilter, { props: { options: OPTIONS, selected, total: 3 } })
}

describe('WebSerialSourceFilter', () => {
  it('renders All plus one radio per source with counts', () => {
    const wrapper = make()
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(true)
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map((radio) => radio.text().replace(/\s+/g, ' '))).toEqual(['All 3', 'MangaDex 2', 'AllManga 1'])
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual(['true', 'false', 'false'])
  })

  it('emits the clicked source, and null for All', async () => {
    const wrapper = make('MangaDex')
    const radios = wrapper.findAll('[role="radio"]')
    await radios[2]!.trigger('click')
    await radios[0]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['AllManga'], [null]])
  })

  it('moves selection with arrow keys, wrapping at the ends', async () => {
    const wrapper = make()
    await wrapper.get('[role="radiogroup"]').trigger('keydown', { key: 'ArrowRight' })
    await wrapper.get('[role="radiogroup"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('select')).toEqual([['MangaDex'], ['AllManga']])
  })

  it('keeps only the checked radio in the tab order and scrolls inside its own container', () => {
    const wrapper = make('AllManga')
    expect(wrapper.findAll('[role="radio"]').map((radio) => radio.attributes('tabindex'))).toEqual(['-1', '-1', '0'])
    expect(wrapper.get('[data-testid="source-filter"]').classes()).toContain('overflow-x-auto')
    expect(wrapper.findAll('[role="radio"]').every((radio) => radio.classes().includes('whitespace-nowrap'))).toBe(true)
  })
})
