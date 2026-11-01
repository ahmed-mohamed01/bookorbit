import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Permission } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({ hasPermission: vi.fn<(name: string) => boolean>() }))

vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: mocks.hasPermission }) }))
vi.mock('@/features/edition-sync/components/EditionSyncSettings.vue', () => ({ default: { template: '<div data-test="user" />' } }))
vi.mock('@/features/edition-sync/components/EditionSyncAdminSection.vue', () => ({ default: { template: '<div data-test="admin" />' } }))

import ForkSettings from '@/features/settings/ForkSettings.vue'

function allow(...granted: string[]) {
  mocks.hasPermission.mockImplementation((name) => granted.includes(name))
}

describe('ForkSettings', () => {
  beforeEach(() => mocks.hasPermission.mockReset())

  it('shows only the user section with the edition sync permission', () => {
    allow(Permission.EditionSync)
    const wrapper = mount(ForkSettings)

    expect(wrapper.find('[data-test="user"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="admin"]').exists()).toBe(false)
  })

  it('shows only the admin section with the manage settings permission', () => {
    allow(Permission.ManageAppSettings)
    const wrapper = mount(ForkSettings)

    expect(wrapper.find('[data-test="user"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="admin"]').exists()).toBe(true)
  })

  it('says there is nothing to configure when neither permission is held', () => {
    allow()
    const wrapper = mount(ForkSettings)

    expect(wrapper.find('[data-test="user"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="admin"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('nothing to configure')
  })

  it('shows both sections to someone holding both permissions', () => {
    allow(Permission.EditionSync, Permission.ManageAppSettings)
    const wrapper = mount(ForkSettings)

    expect(wrapper.find('[data-test="user"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="admin"]').exists()).toBe(true)
  })
})
