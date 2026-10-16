import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { formatBytes } from '@/lib/formatting'
import type { SlotRequestKind } from '../lib/slot-request'
import MonitoredSlotFooter from './MonitoredSlotFooter.vue'

const REQUEST_ROUTE = { name: 'book-request-detail', params: { id: 11 } }

function mountFooter(overrides: Record<string, unknown> = {}) {
  return mount(MonitoredSlotFooter, {
    props: {
      format: 'ebook',
      owned: false,
      availableSince: null,
      releasesOpen: false,
      canEdit: true,
      canManage: true,
      checkedAt: null,
      checking: false,
      requestKind: null,
      requestRoute: REQUEST_ROUTE,
      canRequest: true,
      releasesToggleLabel: 'Search ebook releases',
      download: null,
      ...overrides,
    },
  })
}

describe('MonitoredSlotFooter', () => {
  it('offers the replacement search on an owned format, and only to someone who can edit', async () => {
    const wrapper = mountFooter({ owned: true, availableSince: { date: 'Mar 4, 2025' }, releasesOpen: false })

    expect(wrapper.text()).toContain('Available since Mar 4, 2025')
    const toggle = wrapper.get('[data-testid="owned-releases-toggle"]')
    expect(toggle.text()).toBe('Search replacement')
    await toggle.trigger('click')
    expect(wrapper.emitted('toggle-releases')).toEqual([['ebook']])

    await wrapper.setProps({ releasesOpen: true })
    expect(wrapper.get('[data-testid="owned-releases-toggle"]').text()).toBe('Hide releases')
    wrapper.unmount()

    const viewer = mountFooter({ owned: true, canEdit: false })
    expect(viewer.find('[data-testid="owned-releases-toggle"]').exists()).toBe(false)
    viewer.unmount()
  })

  it('draws no empty footer for a viewer on an owned format with nothing to state', () => {
    const wrapper = mountFooter({ owned: true, canEdit: false, availableSince: null, releasedLabel: null })

    expect(wrapper.find('[data-testid="slot-footer"]').exists()).toBe(false)
  })

  it("states an owned format's release date under when it joined the library", () => {
    const wrapper = mountFooter({ owned: true, availableSince: { date: 'Mar 4, 2025' }, releasedLabel: 'Released Jan 2, 2020' })

    expect(wrapper.text()).toContain('Available since Mar 4, 2025')
    expect(wrapper.get('[data-testid="footer-released"]').text()).toBe('Released Jan 2, 2020')
  })

  it('says when the disk was last checked and runs the check from the button', async () => {
    const checkedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const wrapper = mountFooter({ checkedAt })

    expect(wrapper.text()).toContain('Checked 2 hours ago')
    expect(wrapper.text()).toContain('No file found on disk')
    const check = wrapper.get('[data-testid="check-library"]')
    await check.trigger('click')
    expect(wrapper.emitted('check')).toHaveLength(1)
    wrapper.unmount()
  })

  it('drops the checked line before the first check and for a viewer who cannot run one', () => {
    const never = mountFooter()
    expect(never.text()).toContain('No file found on disk')
    expect(never.text()).not.toContain('Checked')
    never.unmount()

    const viewer = mountFooter({ checkedAt: new Date().toISOString(), canManage: false })
    expect(viewer.find('[data-testid="check-library"]').exists()).toBe(false)
    viewer.unmount()
  })

  it('spins the Check button while a check runs', () => {
    const wrapper = mountFooter({ checkedAt: new Date().toISOString(), checking: true })

    const check = wrapper.get('[data-testid="check-library"]')
    expect(check.attributes('disabled')).toBeDefined()
    expect(check.find('svg').classes()).toContain('motion-safe:animate-spin')
    wrapper.unmount()
  })

  it('reports a live download with its progress bar instead of the Check button', () => {
    const wrapper = mountFooter({
      requestKind: 'downloading',
      checkedAt: new Date().toISOString(),
      download: { percent: 24, downloadedBytes: 2400, totalBytes: 10_000 },
    })

    expect(wrapper.text()).toContain('Downloading · 24%')
    expect(wrapper.text()).toContain(`${formatBytes(2400)} of ${formatBytes(10_000)}`)
    expect(wrapper.text()).not.toContain('No file found on disk')
    const progress = wrapper.get('[data-testid="slot-progress"]')
    expect(progress.attributes('aria-valuenow')).toBe('24')
    expect(wrapper.find('[data-testid="check-library"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it.each([
    ['requested', 'Requested', 'text-[var(--pill-warning)]'],
    ['searching', 'Searching', 'text-[var(--pill-warning)]'],
    ['importing', 'Importing', 'text-[var(--pill-info)]'],
    ['review', 'Needs review', 'text-[var(--pill-warning)]'],
  ] as const)('follows a %s request without giving up the Check button', (kind, label, tone) => {
    const checkedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const wrapper = mountFooter({ requestKind: kind as SlotRequestKind, checkedAt })

    const line = wrapper.get('[data-testid="slot-footer"]')
    expect(line.text()).toContain(label)
    expect(line.text()).toContain('Checked 2 hours ago')
    expect(wrapper.find('[data-testid="check-library"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="slot-progress"]').exists()).toBe(false)
    expect(wrapper.html()).toContain(tone)
    wrapper.unmount()
  })

  it('keeps the Search button for a failed request and blocks it only while one moves', async () => {
    const failed = mountFooter({ requestKind: 'failed' })
    expect(failed.get('[data-testid="releases-toggle"]').attributes('disabled')).toBeUndefined()
    expect(failed.find('[data-testid="check-library"]').exists()).toBe(true)
    failed.unmount()

    const blocked = mountFooter({
      requestKind: 'downloading',
      download: { percent: 10, downloadedBytes: null, totalBytes: null },
      releasesBlockedHint: 'A download is already in progress',
    })
    const search = blocked.get('[data-testid="releases-toggle"]')
    expect(search.text()).toBe('Search')
    expect(search.attributes('disabled')).toBeDefined()
    expect(search.attributes('title')).toBe('A download is already in progress')
    blocked.unmount()
  })

  it('leaves the action row out for a viewer who cannot edit', () => {
    const wrapper = mountFooter({ canEdit: false })

    expect(wrapper.find('[data-testid="releases-toggle"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'MonitoredSlotRequest' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('hands the request button the format it asks for', async () => {
    const wrapper = mountFooter({})

    await wrapper.get('button[aria-label="Request ebook"]').trigger('click')
    expect(wrapper.emitted('request')).toEqual([['ebook']])
    wrapper.unmount()
  })
})
