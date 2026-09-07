import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { MonitoredWork } from '@bookorbit/types'
import MonitoredWorkCard from './MonitoredWorkCard.vue'

vi.mock('@/composables/useDisplaySettings', () => ({
  useDisplaySettings: () => ({ cardInfoMode: ref('off') }),
}))

const passthrough = { template: '<div><slot /></div>' }

function work(overrides: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'work-1',
    title: 'A Book',
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: null,
    ebookReleaseDate: null,
    ebookDatePrecision: null,
    audioReleaseDate: null,
    audioDatePrecision: null,
    coverUrl: null,
    description: null,
    verdict: 'verified',
    flags: [],
    sources: [],
    providerWorkIds: {},
    monitorState: 'monitoring',
    matchedBookId: null,
    ownedFormats: [],
    requestIds: {},
    ...overrides,
  }
}

function mountCard(cardWork: MonitoredWork, ebookQueued = false) {
  return mount(MonitoredWorkCard, {
    props: {
      work: cardWork,
      queued: ebookQueued,
      ebookQueued,
      audiobookQueued: false,
      canManage: true,
    },
    global: {
      stubs: {
        DropdownMenu: passthrough,
        DropdownMenuTrigger: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuItem: passthrough,
        DropdownMenuSeparator: true,
      },
    },
  })
}

describe('MonitoredWorkCard queued badge', () => {
  it('does not show queued when a requested ebook is owned', () => {
    const wrapper = mountCard(work({ requestIds: { ebook: 41 }, ownedFormats: ['ebook'] }))

    expect(wrapper.text()).not.toContain('Queued')
    wrapper.unmount()
  })

  it('shows queued while a requested ebook is not owned', () => {
    const wrapper = mountCard(work({ requestIds: { ebook: 41 }, requestStatuses: { ebook: 'grabbed' } }))

    expect(wrapper.text()).toContain('Queued')
    wrapper.unmount()
  })

  it('shows the current transfer phase instead of a generic queued badge', () => {
    const wrapper = mountCard(work({ requestIds: { ebook: 41 }, requestStatuses: { ebook: 'downloading' } }))

    expect(wrapper.text()).toContain('Downloading')
    expect(wrapper.text()).not.toContain('Queued')
    wrapper.unmount()
  })

  it('does not treat a terminal request id as queued', () => {
    const wrapper = mountCard(work({ requestIds: { ebook: 41 }, requestStatuses: { ebook: 'failed' } }))

    expect(wrapper.text()).not.toContain('Queued')
    wrapper.unmount()
  })

  it('does not show queued when the optimistic ebook flag is set after ownership lands', () => {
    const wrapper = mountCard(work({ ownedFormats: ['ebook'] }), true)

    expect(wrapper.text()).not.toContain('Queued')
    wrapper.unmount()
  })
})

describe('MonitoredWorkCard review kind badge', () => {
  it('names what a review work is, so a comic and a box set are not both just suspect', () => {
    const wrapper = mountCard(work({ verdict: 'suspect', kind: 'graphic_novel' }))

    expect(wrapper.text()).toContain('Comic')
    wrapper.unmount()
  })

  it('says nothing on a work the default list already shows', () => {
    // A kind can survive a promotion, and shouting a stale judgement over an accepted book is noise.
    const wrapper = mountCard(work({ verdict: 'suspect', kind: 'collection', userVisibility: 'visible' }))

    expect(wrapper.text()).not.toContain('Collection')
    wrapper.unmount()
  })

  it('marks an unnamed review work as unverified rather than leaving it bare', () => {
    const wrapper = mountCard(work({ verdict: 'probable' }))

    expect(wrapper.text()).toContain('Unverified')
    wrapper.unmount()
  })

  it('says nothing on a work the owner hid, whatever its verdict was', () => {
    // Hiding is the owner's own call and has its own switch; badging it from the review
    // vocabulary reads as a verdict the reconciler never reached.
    const wrapper = mountCard(work({ verdict: 'verified', userVisibility: 'hidden' }))

    expect(wrapper.text()).not.toContain('Unverified')
    wrapper.unmount()
  })

  it('says nothing on a placeholder, which has a switch of its own too', () => {
    const wrapper = mountCard(work({ verdict: 'probable', flags: ['placeholder'] }))

    expect(wrapper.text()).not.toContain('Unverified')
    wrapper.unmount()
  })
})
