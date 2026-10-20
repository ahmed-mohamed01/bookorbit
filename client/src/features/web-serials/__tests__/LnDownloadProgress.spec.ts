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

it('counts only unsettled volumes while anything is still moving', () => {
  const wrapper = mount(Component, {
    props: {
      downloads: [
        { key: 'a', title: 'Vol. 1', kind: 'single', volumes: [1], status: 'filed', percent: 100, error: null },
        { key: 'b', title: 'Vol. 2', kind: 'single', volumes: [2], status: 'waiting', percent: null, error: null },
      ],
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.get('h3').text()).toBe('Downloading 1 volume')
})

it('switches to a finished summary once every row is filed', () => {
  const wrapper = mount(Component, {
    props: { downloads: [{ key: 'a', title: 'Vol. 1', kind: 'single', volumes: [1], status: 'filed', percent: 100, error: null }] },
    global: { plugins: [i18n] },
  })
  expect(wrapper.get('h3').text()).toBe('Finished: 1 volume filed')
  expect(wrapper.text()).toContain('Filed into library')
})

it('lists failed and held volumes in the finished summary', () => {
  const wrapper = mount(Component, {
    props: {
      downloads: [
        { key: 'a', title: 'Vol. 1-2', kind: 'batch', volumes: [1, 2], status: 'filed', percent: 100, error: null },
        { key: 'b', title: 'Vol. 3', kind: 'single', volumes: [3], status: 'failed', percent: null, error: 'Tracker error' },
        { key: 'c', title: 'Vol. 4', kind: 'batch', volumes: [4], status: 'held', percent: null, error: null },
      ],
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.get('h3').text()).toBe('Finished: 2 volumes filed, 1 failed, 1 needs review')
})

it('counts a settled row with no parsed volumes as one', () => {
  const wrapper = mount(Component, {
    props: { downloads: [{ key: 'pack', title: 'Pack', kind: 'batch', volumes: [], status: 'failed', percent: null, error: 'Tracker error' }] },
    global: { plugins: [i18n] },
  })
  expect(wrapper.get('h3').text()).toBe('Finished: 1 failed')
})
