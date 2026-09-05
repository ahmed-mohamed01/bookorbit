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
  it('offers the request action to users who may request books', () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: true } })

    expect(wrapper.findAll('button')).toHaveLength(2)
    expect(wrapper.text()).toContain('Get automatically')
  })

  it('shows the status instead of the request action without the permission', () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: false } })

    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.text()).toContain('Available')
  })

  it('renders a year-precision release date instead of an invalid one', () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item({ releaseDate: '2026' }), canManage: true } })

    expect(wrapper.text()).toContain('01')
    expect(wrapper.text()).not.toContain('NaN')
  })
})
