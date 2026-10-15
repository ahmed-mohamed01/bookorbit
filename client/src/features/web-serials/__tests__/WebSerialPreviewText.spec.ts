import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import WebSerialSynopsis from '../components/preview/WebSerialSynopsis.vue'
import WebSerialTags from '../components/preview/WebSerialTags.vue'

const LONG = 'A very long synopsis. '.repeat(20)
const MANY = Array.from({ length: 50 }, (_unused, index) => `tag_${index}`)

describe('WebSerialSynopsis', () => {
  it('clamps to two lines and toggles More and Less', async () => {
    const wrapper = mount(WebSerialSynopsis, { props: { synopsis: LONG }, global: { plugins: [i18n] } })
    const copy = wrapper.get('[data-testid="synopsis-copy"]')
    expect(copy.classes()).toContain('line-clamp-2')
    const toggle = wrapper.get('button')
    expect(toggle.text()).toBe('More')
    await toggle.trigger('click')
    expect(copy.classes()).not.toContain('line-clamp-2')
    expect(toggle.text()).toBe('Less')
    expect(toggle.attributes('aria-expanded')).toBe('true')
  })

  it('shows no toggle for a short synopsis', () => {
    const wrapper = mount(WebSerialSynopsis, { props: { synopsis: 'Short.' }, global: { plugins: [i18n] } })
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('collapses again for a different series', async () => {
    const wrapper = mount(WebSerialSynopsis, { props: { synopsis: LONG }, global: { plugins: [i18n] } })
    await wrapper.get('button').trigger('click')
    await wrapper.setProps({ synopsis: `${LONG} more` })
    expect(wrapper.get('[data-testid="synopsis-copy"]').classes()).toContain('line-clamp-2')
  })
})

describe('WebSerialTags', () => {
  it('shows a single collapsed line with a +N control', () => {
    const wrapper = mount(WebSerialTags, { props: { genres: [], tags: MANY }, global: { plugins: [i18n] } })
    expect(wrapper.findAll('li')).toHaveLength(5)
    expect(wrapper.get('ul').classes()).not.toContain('flex-wrap')
    expect(wrapper.get('button').text()).toBe('+45')
  })

  it('expands to every tag and collapses again', async () => {
    const wrapper = mount(WebSerialTags, { props: { genres: [], tags: MANY }, global: { plugins: [i18n] } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.findAll('li')).toHaveLength(50)
    expect(wrapper.get('ul').classes()).toContain('flex-wrap')
    expect(wrapper.get('button').text()).toBe('Less')
    await wrapper.get('button').trigger('click')
    expect(wrapper.findAll('li')).toHaveLength(5)
  })

  it('cleans tags and lists genres first, with no control when few', () => {
    const wrapper = mount(WebSerialTags, { props: { genres: ['Action'], tags: ['theme:slice_of_life'] }, global: { plugins: [i18n] } })
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['Action', 'Slice Of Life'])
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('renders nothing without tags', () => {
    const wrapper = mount(WebSerialTags, { props: { genres: [], tags: [] }, global: { plugins: [i18n] } })
    expect(wrapper.find('ul').exists()).toBe(false)
  })
})
