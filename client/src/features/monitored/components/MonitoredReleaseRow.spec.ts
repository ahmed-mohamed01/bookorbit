import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('toggles the selection instead of opening the panel in select mode, with the Get button hidden', async () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: true, selectionMode: true, selected: true } })

    expect(wrapper.find('[data-testid="release-row-check"]').exists()).toBe(true)
    expect(wrapper.get('article').attributes('data-selected')).toBe('true')
    expect(wrapper.get('article').classes()).toContain('bg-primary/10')
    expect(wrapper.text()).not.toContain('Get automatically')
    await wrapper.get('[data-testid="release-row-open"]').trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
    expect(wrapper.emitted('preview')).toBeUndefined()
    wrapper.unmount()
  })

  it('dims a row with nothing left to act on and keeps it out of the selection', async () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: true, selectionMode: true, selectable: false } })

    expect(wrapper.get('article').classes()).toContain('opacity-50')
    expect(wrapper.get('[data-testid="release-row-check"]').classes()).toContain('border-dashed')
    expect(wrapper.get('[data-testid="release-row-open"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
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

describe('MonitoredReleaseRow long press select', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function pressAndRelease(wrapper: ReturnType<typeof mount>, holdMs: number) {
    // onLongPress attaches its pointer listeners in a post-flush watcher, so the mount must flush first.
    await wrapper.vm.$nextTick()
    const open = wrapper.get('[data-testid="release-row-open"]')
    await open.trigger('pointerdown')
    vi.advanceTimersByTime(holdMs)
    await open.trigger('pointerup')
    await open.trigger('click')
  }

  it('starts select mode on a 500ms press and swallows the click the release produces', async () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: true, longPressSelect: true } })

    await pressAndRelease(wrapper, 500)

    expect(wrapper.emitted('longPress')).toHaveLength(1)
    expect(wrapper.emitted('preview')).toBeUndefined()
    wrapper.unmount()
  })

  it('ignores a long press on a row that cannot be picked', async () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item(), canManage: true, longPressSelect: true, selectable: false } })

    await pressAndRelease(wrapper, 500)

    expect(wrapper.emitted('longPress')).toBeUndefined()
    wrapper.unmount()
  })

  it('shows reason chips under the title for an unconfirmed work', () => {
    const flagged = { ...work, verdict: 'probable' as const, flags: ['audio_episode' as never] }
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item({ work: flagged }), canManage: true } })
    expect(wrapper.get('[data-testid="review-reasons"]').text()).toContain('Probable match')
    expect(wrapper.get('[data-testid="review-reasons"]').text()).toContain('Audio episode')
    wrapper.unmount()
  })

  it('shows no reason chips for a verified work and no date for an undated row', () => {
    const wrapper = mount(MonitoredReleaseRow, { props: { item: item({ releaseDate: null }), canManage: true } })
    expect(wrapper.find('[data-testid="review-reasons"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('NaN')
    wrapper.unmount()
  })
})
