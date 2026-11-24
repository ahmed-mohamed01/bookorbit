import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { START_LOCATION, routeLocationKey } from 'vue-router'
import type { JobListItem } from '@bookorbit/types'

import JobTableRow from './JobTableRow.vue'

const url = '/book/7'
const name = 'The Hound of the Baskervilles'
const subject = { label: name, byline: null, url, image: null }
const openLink = '[data-testid="job-open"]'

function mountRow(overrides: Partial<JobListItem> = {}, labelFirst = true, busy = true) {
  const item: JobListItem = {
    id: 'story-guide:1',
    type: 'story-guide',
    kind: 'build',
    shape: 'job',
    status: 'needs-you',
    reason: null,
    phase: null,
    done: null,
    total: null,
    percent: null,
    position: null,
    subject,
    requester: null,
    cost: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    pausedAt: null,
    finishedAt: null,
    actions: [],
    actionNote: null,
    extra: null,
    ...overrides,
  }
  return mount(JobTableRow, {
    attachTo: document.body,
    props: { item, labelFirst, selected: false, showRequester: false, showCost: false, busy },
    global: {
      provide: { [routeLocationKey as symbol]: START_LOCATION },
      stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
    },
  })
}

enableAutoUnmount(afterEach)

describe('JobTableRow overflow actions', () => {
  it.each([
    ['edition-sync', 'move-to-top', ['move-to-top'], 'Move to top'],
    ['audio-convert', 'move-to-top', ['cancel', 'move-to-top'], 'Move to top'],
    ['web-serial', 'prioritize', ['cancel', 'prioritize'], 'Move ahead of everyone'],
  ] as const)('offers %s %s only in More actions', async (type, action, actions, label) => {
    const row = mountRow({ type, status: 'queued', actions: [...actions] }, false, false)
    expect(row.find(`[data-testid="job-action-${action}"]`).exists()).toBe(false)
    await row.get('[data-testid="job-more"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const menuItem = document.body.querySelector<HTMLElement>(`[data-testid="job-menu-${action}"]`)
    expect(menuItem?.textContent?.trim()).toBe(label)
    menuItem?.click()
    expect(row.emitted('act')).toEqual([[action, expect.objectContaining({ type })]])
  })
})

describe('JobTableRow subject link', () => {
  it('shows a labelled Review link for a job that needs attention', () => {
    const link = mountRow().get(`a${openLink}`)

    expect(link.text()).toBe('Review')
    expect(link.attributes('href')).toBe(url)
    expect(link.attributes('aria-label')).toBe(`Review ${name}`)
    expect(link.attributes('disabled')).toBeUndefined()
  })

  it.each(['failed', 'paused'] as const)('shows an icon-only Open link when the job is %s', (status) => {
    const link = mountRow({ status }, false).get(`a${openLink}`)

    expect(link.attributes('href')).toBe(url)
    expect(link.attributes('title')).toBe('Open')
    expect(link.attributes('aria-label')).toBe(`Open ${name}`)
    expect(link.text()).toBe('')
  })

  it('omits the link when the subject has no URL', () => {
    expect(
      mountRow({ subject: { ...subject, url: null } })
        .find(openLink)
        .exists(),
    ).toBe(false)
  })

  it('omits the link when a job action is available', () => {
    const row = mountRow({ status: 'failed', actions: ['retry'] })

    expect(row.find(openLink).exists()).toBe(false)
    expect(row.find('[data-testid="job-action-retry"]').exists()).toBe(true)
  })

  it.each(['running', 'completed'] as const)('omits the link when the job is %s', (status) => {
    expect(mountRow({ status }).find(openLink).exists()).toBe(false)
  })
})

describe('JobTableRow reorder handle', () => {
  const handle = '[data-job-reorder-handle]'

  it('shows a labelled grip before the checkbox and preserves the other actions', () => {
    const row = mountRow({ status: 'queued', actions: ['start', 'move-to-top', 'move-up', 'cancel'] }, false, false)
    const grip = row.get(handle)
    expect(grip.attributes('aria-label')).toBe(`Drag to reorder: ${name}`)
    expect(grip.attributes('title')).toBe('Drag to reorder')
    expect(grip.classes()).toContain('touch-none')
    expect(grip.element.closest('td')?.nextElementSibling?.querySelector('[data-testid="job-select"]')).not.toBeNull()
    expect(row.find('[data-testid="job-action-start"]').exists()).toBe(true)
    expect(row.find('[data-testid="job-more"]').exists()).toBe(true)
    expect(
      mountRow({ status: 'queued', actions: ['start'] })
        .find(handle)
        .exists(),
    ).toBe(false)
  })

  it.each([
    ['ArrowUp', 'ArrowDown', 'move-up'],
    ['ArrowDown', 'ArrowUp', 'move-down'],
  ] as const)('dispatches %s when offered and ignores %s', async (offeredKey, unavailableKey, action) => {
    const row = mountRow({ status: 'queued', actions: [action] }, false, false)
    const grip = row.get(handle)
    await grip.trigger('keydown', { key: unavailableKey })
    expect(row.emitted('act')).toBeUndefined()
    await grip.trigger('keydown', { key: offeredKey })
    expect(row.emitted('act')).toEqual([[action, expect.objectContaining({ id: 'story-guide:1' })]])
  })
})
