import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import Component from '../components/preview/acquisition/LnRequesterPanel.vue'

it('renders acquisition states and emits controlled interactions', async () => {
  const wrapper = mount(Component, {
    props: {
      volumes: [
        { volume: 1, state: 'owned', bookId: 1, error: null },
        { volume: 2, state: 'missing', bookId: null, error: null },
        { volume: 3, state: 'requested', bookId: null, error: null },
      ],
      selected: new Set<number>(),
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.text()).toContain('No volumes selected')
  await wrapper.findAll('button')[0]!.trigger('click')
  expect(wrapper.emitted('update:selected')).toEqual([[new Set([2])]])
  await wrapper.setProps({ selected: new Set([1, 2, 3]) })
  await wrapper.findAll('button')[1]!.trigger('click')
  expect(wrapper.emitted('request')).toEqual([[[2]]])
})
