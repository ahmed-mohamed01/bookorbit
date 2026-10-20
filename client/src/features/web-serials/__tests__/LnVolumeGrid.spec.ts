import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import Component from '../components/preview/acquisition/LnVolumeGrid.vue'

it('renders acquisition states and emits controlled interactions', async () => {
  const wrapper = mount(Component, {
    props: {
      volumes: [
        { volume: 1, state: 'owned', bookId: 1, error: null },
        { volume: 2, state: 'missing', bookId: null, error: null },
      ],
      selected: new Set([2]),
      planned: new Set([2]),
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.findAll('button')[0]!.classes()).toContain('text-success')
  const cell = wrapper.get('[aria-label="Volume 2: Missing, Will download"]')
  expect(cell.attributes('aria-pressed')).toBe('true')
  expect(cell.classes()).toEqual(expect.arrayContaining(['h-11', 'flex', 'items-center', 'justify-center', 'border-dashed']))
  await cell.trigger('click')
  expect(wrapper.emitted('toggle')).toEqual([[2]])
  await wrapper.setProps({ role: 'requester' })
  expect(wrapper.get('[aria-label="Volume 1: In library"]').attributes('disabled')).toBeDefined()
})
