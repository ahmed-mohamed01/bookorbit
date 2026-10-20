import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import Component from '../components/preview/acquisition/LnDownloadProgress.vue'

it('renders acquisition states and emits controlled interactions', async () => {
  const wrapper = mount(Component, {
    props: {
      downloads: [
        { key: 'a', title: 'Vol. 1', kind: 'single', volumes: [1], status: 'filing', percent: null, error: null },
        { key: 'b', title: 'Vol. 2', kind: 'single', volumes: [2], status: 'downloading', percent: 42, error: null },
      ],
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.text()).toContain('Downloading 2 volumes')
  expect(wrapper.text()).toContain('Filing into library')
  expect(wrapper.findAll('[role="progressbar"]')).toHaveLength(2)
  expect(wrapper.findAll('[role="progressbar"]')[1]!.attributes('aria-valuenow')).toBe('42')
})

it('shows held review reasons', () => {
  const wrapper = mount(Component, {
    props: { downloads: [{ key: 'held', title: 'Vol. 3', kind: 'batch', volumes: [3], status: 'held', percent: null, error: 'Uncertain match' }] },
    global: { plugins: [i18n] },
  })
  expect(wrapper.text()).toContain('Needs review in Book Dock')
  expect(wrapper.text()).toContain('Uncertain match')
})
