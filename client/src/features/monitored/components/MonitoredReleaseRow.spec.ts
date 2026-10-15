import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { MonitoredReleaseItem, MonitoredWork } from '@bookorbit/types'
import MonitoredReleaseRow from './MonitoredReleaseRow.vue'

const work: MonitoredWork = {
  id: 'work-1',
  title: 'The Long Wait',
  subtitle: null,
  seriesName: null,
  seriesIndex: null,
  seriesMemberships: [],
  releaseYear: 2026,
  ebookReleaseDate: null,
  ebookDatePrecision: null,
  audioReleaseDate: '2026-03-14',
  audioDatePrecision: 'day',
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
}

function item(overrides: Partial<MonitoredReleaseItem> = {}): MonitoredReleaseItem {
  return {
    workId: work.id,
    work,
    monitorAuthorId: 'author-1',
    isOwner: true,
    title: work.title,
    authorName: 'A Writer',
    coverUrl: null,
    format: 'audiobook',
    releaseDate: '2026-03-14',
    status: 'available',
    requestId: null,
    ...overrides,
  }
}

describe('MonitoredReleaseRow', () => {
  it('uses the comfortable layout by default', () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: true } })

    expect(wrapper.get('article').classes()).toContain('p-3')
    expect(wrapper.find('.h-\\[63px\\]').exists()).toBe(true)
  })

  it('tightens padding and the cover in the compact density', () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: true, density: 'compact' } })

    expect(wrapper.get('article').classes()).toContain('p-1.5')
    expect(wrapper.get('article').classes()).not.toContain('p-3')
    expect(wrapper.find('.h-\\[42px\\]').exists()).toBe(true)
    expect(wrapper.find('.h-\\[63px\\]').exists()).toBe(false)
  })

  it('offers the request action to users who may request books', () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: true } })

    expect(wrapper.findAll('button:not([data-testid="release-row-open"])')).toHaveLength(2)
    expect(wrapper.text()).toContain('Get automatically')
  })

  it('shows the status instead of the request action without the permission', () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: false } })

    expect(wrapper.findAll('button:not([data-testid="release-row-open"])')).toHaveLength(0)
    expect(wrapper.find('[data-status="missing"]').exists()).toBe(true)
  })

  it('states both formats with the shared status, row format first', () => {
    const wrapper = mount(MonitoredReleaseRow, {
      props: { item: item({ work: { ...work, ownedFormats: ['ebook'], matchedBookIds: { ebook: 4 } } }), canManage: true },
    })

    const statuses = wrapper.findAll('[data-status]').map((chip) => chip.attributes('data-status'))
    expect(statuses).toEqual(['missing', 'owned'])
    expect(wrapper.text()).toContain('Get automatically')
  })

  it('offers no request for a format the owner switched off, and never calls it missing', () => {
    const wrapper = mount(MonitoredReleaseRow, {
      props: { item: item({ work: { ...work, monitorFormats: { audiobook: false } } }), canManage: true },
    })

    expect(wrapper.find('[data-status="not_watching"]').exists()).toBe(true)
    expect(wrapper.find('[data-status="missing"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Get automatically')
  })

  it('offers no request while one is already on its way', () => {
    const wrapper = mount(MonitoredReleaseRow, {
      props: { item: item({ work: { ...work, requestIds: { audiobook: 3 }, requestStatuses: { audiobook: 'downloading' } } }), canManage: true },
    })

    expect(wrapper.find('[data-status="downloading"]').exists()).toBe(true)
    expect(wrapper.findAll('button:not([data-testid="release-row-open"])')).toHaveLength(0)
  })

  it('renders a year-precision release date instead of an invalid one', () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item({ releaseDate: '2026' }), canManage: true } })

    expect(wrapper.text()).toContain('01')
    expect(wrapper.text()).not.toContain('NaN')
  })
})

describe('MonitoredReleaseRow opening the panel', () => {
  it('asks to open the work when the row title is clicked, and keeps the request button separate', async () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: true } })
    await wrapper.get('[data-testid="release-row-open"]').trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(1)
    expect(wrapper.emitted('request')).toBeUndefined()
  })
})
