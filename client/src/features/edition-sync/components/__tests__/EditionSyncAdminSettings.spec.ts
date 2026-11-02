import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, type EffectScope } from 'vue'
import type { EditionSyncAdminSettings, EditionSyncAdminStatus, UpdateEditionSyncAdminSettingsPayload } from '@bookorbit/types'
import { adminStatus } from '../../lib/__tests__/list-fixtures'

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

import EditionSyncAdminSettingsSection from '../EditionSyncAdminSettings.vue'
import { EDITION_SYNC_ADMIN_KEY, useEditionSyncAdmin } from '../../composables/useEditionSyncAdmin'

const DEFAULTS: EditionSyncAdminSettings = { enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run', updatedAt: null }

let scope: EffectScope

async function mountSection() {
  scope = effectScope()
  const admin = scope.run(() => useEditionSyncAdmin())!
  await admin.load()
  const wrapper = mount(EditionSyncAdminSettingsSection, { global: { provide: { [EDITION_SYNC_ADMIN_KEY as symbol]: admin } } })
  await flushPromises()
  return wrapper
}

function saveButton(wrapper: Awaited<ReturnType<typeof mountSection>>) {
  return wrapper.findAll('button').find((button) => button.text() === 'Save')!
}

describe('EditionSyncAdminSettings', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.fetchStatus.mockResolvedValue(adminStatus())
    mocks.fetchSettings.mockResolvedValue(DEFAULTS)
    mocks.update.mockImplementation(async (payload) => ({ ...DEFAULTS, ...payload }))
  })

  afterEach(() => scope.stop())

  it('cannot save an invalid run window', async () => {
    const wrapper = await mountSection()
    await wrapper.get('#edition-sync-hours').setValue('99')
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.get('#edition-sync-hours').setValue('6')
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('renders the saved files-changed mode and saves a change in the PATCH payload', async () => {
    mocks.fetchSettings.mockResolvedValue({ ...DEFAULTS, onFilesChanged: 'immediate' })
    const wrapper = await mountSection()
    const select = wrapper.get('#edition-sync-files-changed')
    expect((select.element as HTMLSelectElement).value).toBe('immediate')
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
    await select.setValue('next_run')
    await saveButton(wrapper).trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith({ enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run' })
  })

  it('leads with the server switch, which saves with the other settings', async () => {
    mocks.fetchSettings.mockResolvedValue({ ...DEFAULTS, enabled: false })
    const wrapper = await mountSection()
    expect(wrapper.text().startsWith('Edition sync on this server')).toBe(true)
    const toggle = wrapper.get('[data-testid="edition-sync-admin-enabled"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    await saveButton(wrapper).trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith({ enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run' })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Settings saved.')
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('shows the unused timing files and clears them, with the singular for one file', async () => {
    mocks.clear.mockResolvedValue({ deleted: 1, freedBytes: 100 })
    const wrapper = await mountSection()
    expect(wrapper.get('[data-testid="edition-sync-admin-unused"]').text()).toMatch(/^1 unused timing file,/)
    const component = wrapper.vm as unknown as { confirmClear: () => Promise<void> }
    await component.confirmClear()
    expect(mocks.toastSuccess.mock.calls[0]![0]).toMatch(/^Removed 1 timing file,/)
  })

  it('does not show the worker, run controls or counts, which live in the Indexing card', async () => {
    const wrapper = await mountSection()
    expect(wrapper.text()).not.toContain('Run queue')
    expect(wrapper.text()).not.toContain('Worker')
  })
})
