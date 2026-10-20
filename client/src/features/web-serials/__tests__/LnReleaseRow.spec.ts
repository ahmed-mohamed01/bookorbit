import type { ReleaseCandidateItem } from '@bookorbit/types'
import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { protocolChipClass } from '@/features/book-requests/sourceColors'
import { i18n } from '@/i18n'
import Component from '../components/preview/acquisition/LnReleaseRow.vue'

const release: ReleaseCandidateItem = {
  indexerId: 1,
  indexerName: 'Nyaa',
  guid: 'a',
  title: 'Novel Vol. 1',
  sizeBytes: 1024,
  seeders: 2,
  leechers: null,
  format: 'epub',
  formats: ['epub'],
  language: 'English',
  fileCount: 1,
  freeleech: true,
  vipOnly: false,
  alreadyGrabbed: false,
  publishedAt: '2026-10-01',
  audio: null,
  score: 90,
  tier: 0,
  tierName: null,
  inspectionWanted: false,
  profileMismatch: null,
  reasons: [],
}

it('renders acquisition states and emits controlled interactions', async () => {
  const wrapper = mount(Component, {
    props: { release, delivery: 'torrent', selected: false, volumes: [1, 3, 5], neededCount: 1 },
    global: { plugins: [i18n] },
  })
  const chip = wrapper.get('.inline-flex.rounded-full')
  expect(chip.text()).toBe(i18n.global.t('bookRequests.releases.protocol.torrent'))
  expect(chip.classes()).toEqual(expect.arrayContaining(protocolChipClass('torrent').split(' ')))
  expect(wrapper.text()).toContain('1, 3, 5')
  expect(wrapper.findAll('svg').every((icon) => icon.attributes('aria-hidden') === 'true')).toBe(true)
  expect(wrapper.text()).toContain('English · EPUB · 1 kB · 2 seeders · 2026-10-01')
  await wrapper.get('[aria-pressed]').trigger('click')
  expect(wrapper.emitted('select')).toHaveLength(1)
  await wrapper.setProps({ selected: true })
  expect(wrapper.get('[aria-pressed]').text()).toBe('Selected')
  expect(wrapper.get('[aria-pressed]').attributes('aria-pressed')).toBe('true')
})

it('renders Shelfmark releases with the Requests delivery label and direct chip colors', () => {
  const wrapper = mount(Component, {
    props: {
      release: { ...release, indexerId: 2, indexerName: 'Elscione' },
      delivery: 'shelfmark',
      selected: false,
    },
    global: { plugins: [i18n] },
  })
  const chip = wrapper.get('.inline-flex.rounded-full')
  expect(chip.text()).toBe(i18n.global.t('bookRequests.releases.protocol.shelfmark'))
  expect(chip.classes()).toEqual(expect.arrayContaining(protocolChipClass('shelfmark').split(' ')))
  expect(chip.text()).not.toContain('Torrent')
})
