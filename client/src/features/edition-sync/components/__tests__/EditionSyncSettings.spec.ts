import { invalidateEditionSyncSettings } from '../../composables/useEditionSyncSettings'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditionSyncSettings } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<EditionSyncSettings>>(),
  updateSettings: vi.fn<(payload: unknown) => Promise<EditionSyncSettings>>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  toastError: vi.fn<(message: string) => void>(),
}))

vi.mock('../../api/edition-sync.api', () => ({
  fetchEditionSyncSettings: mocks.fetchSettings,
  updateEditionSyncSettings: mocks.updateSettings,
}))
vi.mock('vue-sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))

import EditionSyncSettingsForm from '../EditionSyncSettings.vue'
import { useEditionSyncSettings } from '../../composables/useEditionSyncSettings'

const SETTINGS: EditionSyncSettings = { enabled: true, effectiveEnabled: true, disabledReason: null, bookSyncMode: 'selected_only' }

describe('EditionSyncSettings', () => {
  beforeEach(() => {
    invalidateEditionSyncSettings()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    useEditionSyncSettings().settings.value = null
  })

  it('shows the saved values and saves them once loaded', async () => {
    mocks.fetchSettings.mockResolvedValue(SETTINGS)
    mocks.updateSettings.mockResolvedValue(SETTINGS)
    const wrapper = mount(EditionSyncSettingsForm)
    await flushPromises()

    const save = wrapper.findAll('button').find((button) => button.text() === 'Save')!
    expect(save.attributes('disabled')).toBeUndefined()
    await save.trigger('click')
    expect(mocks.updateSettings).toHaveBeenCalledWith({ enabled: true, bookSyncMode: 'selected_only' })
  })

  it('tells the page it saved, and not after a failed save', async () => {
    mocks.fetchSettings.mockResolvedValue(SETTINGS)
    mocks.updateSettings.mockResolvedValue({ ...SETTINGS, bookSyncMode: 'all_eligible' })
    const wrapper = mount(EditionSyncSettingsForm)
    await flushPromises()
    const save = wrapper.findAll('button').find((button) => button.text() === 'Save')!

    await save.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('saved')).toHaveLength(1)

    mocks.updateSettings.mockRejectedValue(new Error('nope'))
    await save.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('cannot save defaults over the real settings while the load is in flight', async () => {
    mocks.fetchSettings.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(EditionSyncSettingsForm)
    await flushPromises()

    const save = wrapper.findAll('button').find((button) => button.text() === 'Save')!
    expect(save.attributes('disabled')).toBeDefined()
    await save.trigger('click')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('says sync is on by default and can be turned off per book', async () => {
    mocks.fetchSettings.mockResolvedValue(SETTINGS)
    const wrapper = mount(EditionSyncSettingsForm)
    await flushPromises()

    expect(wrapper.text()).toContain('Sync my books')
    expect(wrapper.text()).toContain('On by default. You can still turn it off for single books.')
  })

  it('shows only a muted note instead of the controls when an admin has turned edition sync off', async () => {
    mocks.fetchSettings.mockResolvedValue({ ...SETTINGS, effectiveEnabled: false, disabledReason: 'server_disabled' })
    const wrapper = mount(EditionSyncSettingsForm)
    await flushPromises()

    expect(wrapper.get('[data-testid="edition-sync-server-disabled"]').text()).toBe('An admin has turned edition sync off for this server.')
    expect(wrapper.find('button[role="switch"]').exists()).toBe(false)
    expect(wrapper.findAll('button').some((button) => button.text() === 'Save')).toBe(false)
  })

  it('stays locked and shows the failure when the load failed', async () => {
    mocks.fetchSettings.mockRejectedValue(new Error('server down'))
    const wrapper = mount(EditionSyncSettingsForm)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('server down')
    const save = wrapper.findAll('button').find((button) => button.text() === 'Save')!
    expect(save.attributes('disabled')).toBeDefined()
    expect(wrapper.get('button[role="switch"]').attributes('disabled')).toBeDefined()
    expect(useEditionSyncSettings().settings.value).toBeNull()
  })
})
