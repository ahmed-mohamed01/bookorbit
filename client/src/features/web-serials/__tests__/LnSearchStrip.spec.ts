import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import Component from '../components/preview/acquisition/LnSearchStrip.vue'

it('renders acquisition states and emits controlled interactions', async () => {
  const wrapper = mount(Component, {
    props: {
      query: { title: 'Novel', author: '' },
      altTitles: [],
      searching: true,
      indexers: [],
      pending: [{ indexerId: 1, indexerName: 'Nyaa', color: null }],
      resultCount: 0,
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.text()).toContain('Searching 1 indexer')
  expect(wrapper.find('[data-testid="search-sweep"]').exists()).toBe(true)
  expect(wrapper.find('.motion-safe\\:animate-pulse').exists()).toBe(true)
  await wrapper.setProps({
    searching: false,
    pending: [],
    indexers: [
      { indexerId: 1, indexerName: 'Nyaa', color: null, ok: false, count: 0, filtered: 0, failure: 'timeout', seedsBack: true, delivery: 'torrent' },
    ],
  })
  expect(wrapper.find('[data-testid="search-sweep"]').exists()).toBe(false)
  expect(wrapper.text()).toContain('timed out, retry')
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('search')).toHaveLength(1)
})

it('prefills the active query and submits the form on Enter', async () => {
  const wrapper = mount(Component, {
    props: { query: { title: 'Novel', author: 'Writer' }, altTitles: [], searching: false, indexers: [], pending: [], resultCount: 0 },
    global: { plugins: [i18n] },
  })
  const inputs = wrapper.findAll('input')
  expect(inputs[0]!.element.value).toBe('Novel')
  expect(inputs[1]!.element.value).toBe('Writer')
  await inputs[0]!.setValue('Custom')
  // Native Enter submission dispatches the form submit event.
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('search')).toEqual([[{ title: 'Custom', author: 'Writer' }]])
  await wrapper.setProps({ query: { title: 'Active', author: '' } })
  expect(inputs[0]!.element.value).toBe('Active')
  expect(inputs[1]!.element.value).toBe('')
})
it('deduplicates and limits other titles and fills without searching', async () => {
  const wrapper = mount(Component, {
    props: {
      query: { title: 'Novel', author: '' },
      altTitles: ['Novel', 'Romaji', 'romaji', 'B', 'C', 'D', 'E', 'F', 'G'],
      searching: false,
      indexers: [],
      pending: [],
      resultCount: 0,
    },
    global: { plugins: [i18n] },
  })
  const chips = wrapper.findAll('button[type="button"]')
  expect(chips).toHaveLength(6)
  await chips[0]!.trigger('click')
  expect(wrapper.get('input').element.value).toBe('Romaji')
  expect(wrapper.emitted('search')).toBeUndefined()
})
