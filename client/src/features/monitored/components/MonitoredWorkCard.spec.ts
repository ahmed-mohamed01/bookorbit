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
    const wrapper = mountCard(work({ requestIds: { ebook: 41 } }))

    expect(wrapper.text()).toContain('Queued')
    wrapper.unmount()
  })

  it('does not show queued when the optimistic ebook flag is set after ownership lands', () => {
    const wrapper = mountCard(work({ ownedFormats: ['ebook'] }), true)

    expect(wrapper.text()).not.toContain('Queued')
    wrapper.unmount()
  })
})
