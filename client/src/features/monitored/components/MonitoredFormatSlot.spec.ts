import { describe, expect, it, vi } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import type { MonitoredWork } from '@bookorbit/types'
import type { MonitoredReleaseRow } from '../composables/useReleaseRows'
import MonitoredFormatSlot from './MonitoredFormatSlot.vue'

vi.mock('../composables/useMonitoredRequestProgress', async () => {
  const { ref: reactiveRef } = await import('vue')
  return {
    useMonitoredRequestProgress: () => ({
      request: reactiveRef(null),
      loading: reactiveRef(false),
      error: reactiveRef(null),
      live: reactiveRef(null),
      status: reactiveRef(null),
      settled: reactiveRef(false),
    }),
  }
})

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

const row: MonitoredReleaseRow = {
  format: 'ebook',
  label: 'Ebook',
  value: 'Not announced',
  date: null,
  muted: true,
  unconfirmed: false,
  unconfirmedHint: '',
  source: null,
  details: [],
  suggestion: null,
  suggestionHint: '',
  editable: false,
  dates: {} as MonitoredReleaseRow['dates'],
}

function mountSlot(overrides: Record<string, unknown> = {}) {
  return mount(MonitoredFormatSlot, {
    props: {
      work,
      format: 'ebook',
      status: 'upcoming',
      canEdit: true,
      authorWatches: true,
      canManage: true,
      mode: 'notify',
      row,
      datesOpen: false,
      refreshing: false,
      requesting: false,
      releasesOpen: false,
      ...overrides,
    },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

const TOGGLE = '[data-testid="auto-download-toggle"]'
const RESET = '[data-testid="auto-download-reset"]'

describe('MonitoredFormatSlot auto-download switch', () => {
  it('is hidden for a viewer, an owned format, a request in flight and an author that is off', () => {
    expect(mountSlot({ canEdit: false }).find(TOGGLE).exists()).toBe(false)
    expect(
      mountSlot({ work: { ...work, ownedFormats: ['ebook'] }, status: 'owned' })
        .find(TOGGLE)
        .exists(),
    ).toBe(false)
    expect(mountSlot({ requesting: true }).find(TOGGLE).exists()).toBe(false)
    expect(mountSlot({ mode: 'off' }).find(TOGGLE).exists()).toBe(false)
  })

  it('shows a disabled switch with an explaining hint while watching is off', async () => {
    const wrapper = mountSlot({ mode: 'auto-all', work: { ...work, monitorFormats: { ebook: false } } })
    const toggle = wrapper.get(TOGGLE)
    expect(toggle.attributes('disabled')).toBeDefined()
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(wrapper.text()).toContain('Auto-download is unavailable while watching is off.')
    await toggle.trigger('click')
    expect(wrapper.emitted('toggle-auto-download')).toBeUndefined()
    expect(wrapper.find(RESET).exists()).toBe(false)
  })

  it('follows the author mode when there is no override', () => {
    expect(mountSlot({ mode: 'notify' }).get(TOGGLE).attributes('aria-checked')).toBe('false')
    expect(mountSlot({ mode: 'auto-all' }).get(TOGGLE).attributes('aria-checked')).toBe('true')
    expect(mountSlot({ mode: 'auto-upcoming' }).get(TOGGLE).attributes('aria-checked')).toBe('true')
  })

  it('lets the override win over the author mode', () => {
    const on = mountSlot({ mode: 'notify', work: { ...work, autoDownload: { ebook: true } } })
    expect(on.get(TOGGLE).attributes('aria-checked')).toBe('true')
    const off = mountSlot({ mode: 'auto-all', work: { ...work, autoDownload: { ebook: false } } })
    expect(off.get(TOGGLE).attributes('aria-checked')).toBe('false')
  })

  it('emits an explicit boolean on click', async () => {
    const wrapper = mountSlot({ mode: 'notify' })
    await wrapper.get(TOGGLE).trigger('click')
    expect(wrapper.emitted('toggle-auto-download')).toEqual([['ebook', true]])

    const auto = mountSlot({ mode: 'auto-all' })
    await auto.get(TOGGLE).trigger('click')
    expect(auto.emitted('toggle-auto-download')).toEqual([['ebook', false]])
  })

  it('offers the reset only with an override, and emits null', async () => {
    expect(mountSlot({ mode: 'notify' }).find(RESET).exists()).toBe(false)
    const wrapper = mountSlot({ mode: 'notify', work: { ...work, autoDownload: { ebook: true } } })
    await wrapper.get(RESET).trigger('click')
    expect(wrapper.emitted('toggle-auto-download')).toEqual([['ebook', null]])
  })

  it('words the hint by whether the format is released', () => {
    const upcoming = mountSlot({ mode: 'auto-all', status: 'upcoming' })
    expect(upcoming.text()).toContain('Will auto-download when it is released.')
    const released = mountSlot({
      mode: 'auto-all',
      status: 'missing',
      work: { ...work, ebookReleaseDate: '2026-01-10', ebookDatePrecision: 'day' },
    })
    expect(released.text()).toContain('Will auto-download on the next refresh.')
    const off = mountSlot({ mode: 'notify', status: 'upcoming' })
    expect(off.text()).toContain('Auto-download is off. You will be notified when it is released.')
  })

  it('does not promise a grab the server will skip', () => {
    const backCatalog = mountSlot({
      mode: 'auto-upcoming',
      status: 'missing',
      work: { ...work, ebookReleaseDate: '2026-01-10', ebookDatePrecision: 'day' },
    })
    expect(backCatalog.text()).toContain('Auto-download is on, but nothing will be requested for this book right now.')
    const forced = mountSlot({
      mode: 'auto-upcoming',
      status: 'missing',
      work: { ...work, ebookReleaseDate: '2026-01-10', ebookDatePrecision: 'day', autoDownload: { ebook: true } },
    })
    expect(forced.text()).toContain('Will auto-download on the next refresh.')
  })

  it('disables the switch while the author is paused', async () => {
    const wrapper = mountSlot({ mode: 'auto-all', authorPaused: true })
    const toggle = wrapper.get(TOGGLE)
    expect(toggle.attributes('disabled')).toBeDefined()
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(wrapper.text()).toContain('Auto-download is unavailable while this author is paused.')
    await toggle.trigger('click')
    expect(wrapper.emitted('toggle-auto-download')).toBeUndefined()
  })

  it('describes the switch itself for assistive tech', () => {
    const toggle = mountSlot({ mode: 'notify' }).get(TOGGLE)
    expect(toggle.attributes('aria-describedby')).toMatch(/auto-download-hint$/)
  })
})
