import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import Component from '../components/preview/acquisition/LnSuggestionCard.vue'

it('renders acquisition states and emits controlled interactions', async () => {
  const wrapper = mount(Component, {
    props: {
      suggestion: {
        releases: [
          { indexerId: 1, guid: 'a' },
          { indexerId: 2, guid: 'b' },
        ],
        volumes: [1, 2, 3],
        sizeBytes: 1024,
      },
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.text()).toContain('All 3 missing volumes from 2 releases')
  expect(wrapper.get('button').text()).toBe('Select these 2')
  await wrapper.get('button').trigger('click')
  expect(wrapper.emitted('select')).toHaveLength(1)
})
