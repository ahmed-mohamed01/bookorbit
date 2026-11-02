import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, type EffectScope } from 'vue'
import type { EditionSyncAdminSettings, EditionSyncAdminStatus } from '@bookorbit/types'
import { adminStatus } from '../../lib/__tests__/list-fixtures'

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn<() => Promise<EditionSyncAdminStatus>>(),
  fetchSettings: vi.fn<() => Promise<EditionSyncAdminSettings>>(),
  start: vi.fn<() => Promise<EditionSyncAdminStatus>>(),
  stop: vi.fn<() => Promise<EditionSyncAdminStatus>>(),
  toastError: vi.fn<(message: string) => void>(),
}))

vi.mock('../../api/edition-sync.api', () => ({
  fetchEditionSyncAdminStatus: mocks.fetchStatus,
  fetchEditionSyncAdminSettings: mocks.fetchSettings,
  updateEditionSyncAdminSettings: vi.fn<() => Promise<EditionSyncAdminSettings>>(),
  startEditionSyncRun: mocks.start,
  stopEditionSyncRun: mocks.stop,
  clearUnusedEditionSyncData: vi.fn<() => Promise<{ deleted: number; freedBytes: number }>>(),
}))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<(message: string) => void>(), error: mocks.toastError } }))

import EditionSyncIndexingCard from '../EditionSyncIndexingCard.vue'
import { EDITION_SYNC_ADMIN_KEY, useEditionSyncAdmin } from '../../composables/useEditionSyncAdmin'

const SETTINGS: EditionSyncAdminSettings = { enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run', updatedAt: null }
const RUNNING = adminStatus({
  run: {
    active: true,
    trigger: 'manual',
    startedAt: '2026-11-02T01:00:00.000Z',
    windowUntil: null,
    current: { bookId: 3, title: 'Mistborn', stage: 'aligning', progress: 42 },
  },
})

let scope: EffectScope

async function mountCard(status: EditionSyncAdminStatus, settings: EditionSyncAdminSettings = SETTINGS) {
  mocks.fetchStatus.mockResolvedValue(status)
  mocks.fetchSettings.mockResolvedValue(settings)
  scope = effectScope()
  const admin = scope.run(() => useEditionSyncAdmin())!
  await admin.load()
  const wrapper = mount(EditionSyncIndexingCard, { global: { provide: { [EDITION_SYNC_ADMIN_KEY as symbol]: admin } } })
  await flushPromises()
  return wrapper
}

type Wrapper = Awaited<ReturnType<typeof mountCard>>

function summary(wrapper: Wrapper, key: string): string {
  return wrapper.get(`[data-summary="${key}"] dd`).text()
}

describe('EditionSyncIndexingCard', () => {
  beforeEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()))
  afterEach(() => scope.stop())

  it('shows the running book with its cover, percent, progress bar and stage, and a Stop button', async () => {
    mocks.stop.mockResolvedValue(adminStatus())
    const wrapper = await mountCard(RUNNING)
    const current = wrapper.get('[data-testid="edition-sync-indexing-current"]')
    expect(current.text()).toContain('Mistborn')
    expect(current.text()).toMatch(/42\s?%/)
    expect(current.text()).toMatch(/· started /)
    expect(current.get('img').attributes('src')).toContain('/api/v1/books/3/thumbnail')
    expect(current.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('42')
    expect(wrapper.find('[data-testid="edition-sync-indexing-run"]').exists()).toBe(false)
    await wrapper.get('[data-testid="edition-sync-indexing-stop"]').trigger('click')
    await flushPromises()
    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })

  it('shows the online worker with its version in muted text', async () => {
    const wrapper = await mountCard(adminStatus())
    const worker = wrapper.get('[data-testid="edition-sync-indexing-worker"]')
    expect(worker.text()).toBe('Worker online · 1.4.0')
    expect(worker.classes()).toContain('text-muted-foreground')
    expect(worker.find('svg').exists()).toBe(false)
  })

  it('shows an online worker without a version as plain text', async () => {
    const wrapper = await mountCard(adminStatus({ worker: { configured: true, state: 'ok', version: null, device: null, rebuildSupported: true } }))
    expect(wrapper.get('[data-testid="edition-sync-indexing-worker"]').text()).toBe('Worker online')
  })

  it('says when the next scheduled run starts while idle, and runs the queue', async () => {
    mocks.start.mockResolvedValue(RUNNING)
    const status = adminStatus({
      schedule: { ...adminStatus().schedule, nextRunAt: '2030-01-05T02:00:00.000Z' },
      backlogEstimate: { books: 12, hoursAtRecentRate: 3.5 },
    })
    const wrapper = await mountCard(status)
    expect(wrapper.get('[data-testid="edition-sync-indexing-body"]').text()).toMatch(/^Nothing is running\. The next scheduled run starts .+\.$/)
    expect(summary(wrapper, 'queue')).toBe('12 books · about 3.5 h')
    expect(summary(wrapper, 'nextRun')).not.toBe('No run is scheduled')
    const run = wrapper.get('[data-testid="edition-sync-indexing-run"]')
    expect(run.attributes('disabled')).toBeUndefined()
    await run.trigger('click')
    await flushPromises()
    expect(mocks.start).toHaveBeenCalledTimes(1)
  })

  it('says no run is scheduled without a cron, and counts the queue without a rate', async () => {
    const wrapper = await mountCard(adminStatus({ backlogEstimate: { books: 1, hoursAtRecentRate: null } }), { ...SETTINGS, cronExpression: null })
    expect(wrapper.get('[data-testid="edition-sync-indexing-body"]').text()).toBe('Nothing is running. No run is scheduled.')
    expect(summary(wrapper, 'nextRun')).toBe('No run is scheduled')
    expect(summary(wrapper, 'queue')).toBe('1 book')
  })

  it('pauses with a warning when the worker is down, and cannot run', async () => {
    const wrapper = await mountCard(
      adminStatus({ worker: { configured: true, state: 'unreachable', version: null, device: null, rebuildSupported: false } }),
    )
    const worker = wrapper.get('[data-testid="edition-sync-indexing-worker"]')
    expect(worker.text()).toBe('Worker unreachable')
    expect(worker.classes()).toContain('text-muted-foreground')
    expect(worker.find('svg.lucide-circle-alert, svg.lucide-alert-circle').exists()).toBe(true)
    expect(worker.find('.rounded-full').exists()).toBe(false)
    expect(wrapper.get('[data-testid="edition-sync-indexing-body"]').text()).toBe("The read-aloud worker can't be reached, so the queue is paused.")
    expect(wrapper.get('[data-testid="edition-sync-indexing-run"]').attributes('disabled')).toBeDefined()
  })

  it('says edition sync is off for the server, and cannot run', async () => {
    const wrapper = await mountCard(adminStatus(), { ...SETTINGS, enabled: false })
    expect(wrapper.get('[data-testid="edition-sync-indexing-body"]').text()).toBe('Edition sync is off for this server.')
    expect(wrapper.get('[data-testid="edition-sync-indexing-run"]').attributes('disabled')).toBeDefined()
  })

  it('words the last run by its outcome', async () => {
    const endedAt = new Date(Date.now() - 3 * 3_600_000).toISOString()
    const base = { trigger: 'scheduled' as const, startedAt: endedAt, endedAt, booksIndexed: 14, booksFailed: 2 }
    let wrapper = await mountCard(adminStatus({ lastRun: { ...base, stopReason: 'window_closed' } }))
    expect(summary(wrapper, 'lastRun')).toBe('3 hours ago · 14 indexed, 2 failed')
    scope.stop()

    wrapper = await mountCard(adminStatus({ lastRun: { ...base, stopReason: 'stopped' } }))
    expect(summary(wrapper, 'lastRun')).toBe('3 hours ago · Stopped')
    scope.stop()

    wrapper = await mountCard(adminStatus({ lastRun: { ...base, stopReason: 'worker_unavailable' } }))
    expect(summary(wrapper, 'lastRun')).toBe('3 hours ago · Worker unavailable')
    scope.stop()

    wrapper = await mountCard(adminStatus())
    expect(summary(wrapper, 'lastRun')).toBe('None yet')
  })

  it('shows the load failure when the status cannot be read', async () => {
    mocks.fetchStatus.mockRejectedValue(new Error('down'))
    mocks.fetchSettings.mockResolvedValue(SETTINGS)
    scope = effectScope()
    const admin = scope.run(() => useEditionSyncAdmin())!
    await admin.load()
    const wrapper = mount(EditionSyncIndexingCard, { global: { provide: { [EDITION_SYNC_ADMIN_KEY as symbol]: admin } } })
    expect(wrapper.get('[role="alert"]').text()).toContain('Failed to load edition sync status.')
  })
})
