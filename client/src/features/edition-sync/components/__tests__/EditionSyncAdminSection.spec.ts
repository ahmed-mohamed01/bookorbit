import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditionSyncAdminSettings, EditionSyncAdminStatus, UpdateEditionSyncAdminSettingsPayload } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn<() => Promise<EditionSyncAdminStatus>>(),
  fetchSettings: vi.fn<() => Promise<EditionSyncAdminSettings>>(),
  update: vi.fn<(payload: UpdateEditionSyncAdminSettingsPayload) => Promise<EditionSyncAdminSettings>>(),
  clear: vi.fn<() => Promise<{ deleted: number; freedBytes: number }>>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  toastError: vi.fn<(message: string) => void>(),
}))

vi.mock('../../api/edition-sync.api', () => ({
  fetchEditionSyncAdminStatus: mocks.fetchStatus,
  fetchEditionSyncAdminSettings: mocks.fetchSettings,
  updateEditionSyncAdminSettings: mocks.update,
  startEditionSyncRun: vi.fn<() => Promise<EditionSyncAdminStatus>>(),
  stopEditionSyncRun: vi.fn<() => Promise<EditionSyncAdminStatus>>(),
  clearUnusedEditionSyncData: mocks.clear,
}))
vi.mock('vue-sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))

import EditionSyncAdminSection from '../EditionSyncAdminSection.vue'

const STATUS: EditionSyncAdminStatus = {
  worker: { configured: true, state: 'ok', version: '1', device: 'cpu', rebuildSupported: true },
  schedule: { enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run', updatedAt: null, nextRunAt: null },
  run: { active: false, trigger: null, startedAt: null, windowUntil: null, current: null },
  counts: { indexed: 1, queued: 2, failed: 0, stale: 0, unusedIndexes: 1, unusedBytes: 100 },
  backlogEstimate: { books: 0, hoursAtRecentRate: null },
}

describe('EditionSyncAdminSection', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.fetchStatus.mockResolvedValue(STATUS)
    mocks.fetchSettings.mockResolvedValue({ enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run', updatedAt: null })
  })

  it('does not flash the load failure before the first load settles', async () => {
    mocks.fetchStatus.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(EditionSyncAdminSection)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('cannot save an invalid run window', async () => {
    const wrapper = mount(EditionSyncAdminSection)
    await flushPromises()
    await wrapper.get('#edition-sync-hours').setValue('99')

    const save = wrapper.findAll('button').find((button) => button.text() === 'Save')!
    expect(save.attributes('disabled')).toBeDefined()
    await wrapper.get('#edition-sync-hours').setValue('6')
    expect(save.attributes('disabled')).toBeUndefined()
  })

  it('renders the saved files-changed mode and saves a change in the PATCH payload', async () => {
    mocks.fetchSettings.mockResolvedValue({ enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'immediate', updatedAt: null })
    mocks.update.mockImplementation(async (payload) => ({
      enabled: true,
      cronExpression: '0 2 * * *',
      runHours: 8,
      onFilesChanged: 'immediate',
      updatedAt: null,
      ...payload,
    }))
    const wrapper = mount(EditionSyncAdminSection)
    await flushPromises()
    const select = wrapper.get('#edition-sync-files-changed')
    expect((select.element as HTMLSelectElement).value).toBe('immediate')

    const save = wrapper.findAll('button').find((button) => button.text() === 'Save')!
    expect(save.attributes('disabled')).toBeDefined()
    await select.setValue('next_run')
    expect(save.attributes('disabled')).toBeUndefined()

    await save.trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith({ enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run' })
  })

  it('leads with the server switch, which saves with the other settings', async () => {
    mocks.fetchSettings.mockResolvedValue({ enabled: false, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run', updatedAt: null })
    mocks.update.mockImplementation(async (payload) => ({
      enabled: false,
      cronExpression: '0 2 * * *',
      runHours: 8,
      onFilesChanged: 'next_run',
      updatedAt: null,
      ...payload,
    }))
    const wrapper = mount(EditionSyncAdminSection)
    await flushPromises()

    const settingsCard = wrapper.findAll('section').find((section) => section.find('[data-testid="edition-sync-admin-enabled"]').exists())!
    expect(settingsCard.text().startsWith('Edition sync on this server')).toBe(true)
    expect(settingsCard.text()).toContain("Off: no indexing runs and users don't see the option.")
    const toggle = wrapper.get('[data-testid="edition-sync-admin-enabled"]')
    expect(toggle.attributes('aria-checked')).toBe('false')

    const save = wrapper.findAll('button').find((button) => button.text() === 'Save')!
    expect(save.attributes('disabled')).toBeDefined()
    await toggle.trigger('click')
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(save.attributes('disabled')).toBeUndefined()

    await save.trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith({ enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run' })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Settings saved.')
    expect(save.attributes('disabled')).toBeDefined()
  })

  it('uses the singular in the cleared toast for one file', async () => {
    mocks.clear.mockResolvedValue({ deleted: 1, freedBytes: 100 })
    const wrapper = mount(EditionSyncAdminSection)
    await flushPromises()
    const component = wrapper.vm as unknown as { confirmClear: () => Promise<void> }
    await component.confirmClear()

    expect(mocks.toastSuccess.mock.calls[0]![0]).toMatch(/^Removed 1 timing file,/)
  })
})
