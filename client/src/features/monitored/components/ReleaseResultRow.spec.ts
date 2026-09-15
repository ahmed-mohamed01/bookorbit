import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { DownloadDelivery, ReleaseCandidateItem } from '@bookorbit/types'
import ReleaseResultRow from './ReleaseResultRow.vue'

const release: ReleaseCandidateItem = {
  indexerId: 7,
  indexerName: 'An Indexer',
  guid: 'release-1',
  title: 'The Long Wait (2026) [EPUB]',
  sizeBytes: 1024,
  seeders: null,
  leechers: null,
  format: 'epub',
  formats: ['epub'],
  language: 'en',
  fileCount: 1,
  freeleech: false,
  vipOnly: false,
  alreadyGrabbed: false,
  publishedAt: null,
  audio: null,
  score: 71,
  tier: null,
  tierName: null,
  profileMismatch: null,
  reasons: [],
}

function mountRow(delivery: DownloadDelivery, overrides: Partial<ReleaseCandidateItem> = {}) {
  return mount(ReleaseResultRow, { props: { release: { ...release, ...overrides }, delivery } })
}

describe('ReleaseResultRow protocol chip', () => {
  it.each([
    ['usenet' as const, 'Usenet', '--pill-usenet'],
    ['torrent' as const, 'Torrent', '--pill-torrent'],
    ['file' as const, 'Direct', '--pill-direct'],
  ])('renders the %s delivery its indexer stated', (delivery, label, token) => {
    const wrapper = mountRow(delivery)

    const chip = wrapper.get('span.inline-flex.rounded-full')
    expect(chip.text()).toBe(label)
    expect(chip.classes().join(' ')).toContain(token)
    wrapper.unmount()
  })

  it('states the swarm position of a torrent that published no seeder count', () => {
    const wrapper = mountRow('torrent')

    expect(wrapper.text()).toContain('Seeders unknown')
    wrapper.unmount()
  })

  it('says nothing about seeders for a source that serves the file itself', () => {
    const wrapper = mountRow('usenet', { seeders: 4 })

    expect(wrapper.text()).not.toContain('seeder')
    wrapper.unmount()
  })
})
