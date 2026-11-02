import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { Permission, type EditionSyncAdminStatus } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn<(name: string) => boolean>(),
  adminLoad: vi.fn<() => Promise<void>>(),
  booksLoad: vi.fn<() => Promise<void>>(),
}))

vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: mocks.hasPermission }) }))
vi.mock('@/features/edition-sync/composables/useEditionSyncAdmin', () => ({
  provideEditionSyncAdmin: () => ({ status: ref<EditionSyncAdminStatus | null>(null), runActive: ref(false), load: mocks.adminLoad }),
}))
vi.mock('@/features/edition-sync/components/EditionSyncIndexingCard.vue', () => ({
  default: { template: '<div data-section="indexing" />' },
}))
vi.mock('@/features/edition-sync/components/EditionSyncBooksList.vue', () => ({
  default: {
    props: ['runActive'],
    setup: (_: unknown, { expose }: { expose: (exposed: Record<string, unknown>) => void }) => expose({ load: mocks.booksLoad }),
    template: '<div data-section="books" />',
  },
}))
vi.mock('@/features/edition-sync/components/EditionSyncSettings.vue', () => ({
  default: { emits: ['saved'], template: `<button data-section="user" @click="$emit('saved')" />` },
}))
vi.mock('@/features/edition-sync/components/EditionSyncAdminSettings.vue', () => ({
  default: { template: '<div data-section="server" />' },
}))

import ForkSettings from '@/features/settings/ForkSettings.vue'
import { useEditionSyncSettings } from '@/features/edition-sync/composables/useEditionSyncSettings'

function allow(...granted: string[]) {
  mocks.hasPermission.mockImplementation((name) => granted.includes(name))
}

function sections(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[data-section]').map((node) => node.attributes('data-section')!)
}

describe('ForkSettings', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    useEditionSyncSettings().settings.value = { enabled: true, effectiveEnabled: true, disabledReason: null, bookSyncMode: 'all_eligible' }
  })

  afterEach(() => {
    useEditionSyncSettings().settings.value = null
  })

  it('orders preferences, Server, Indexing and Books for someone holding both permissions', () => {
    allow(Permission.EditionSync, Permission.ManageAppSettings)
    const wrapper = mount(ForkSettings)
    expect(sections(wrapper)).toEqual(['user', 'server', 'indexing', 'books'])
    expect(wrapper.text()).toContain('Your preferences')
    expect(wrapper.text()).toContain('Server')
    expect(mocks.adminLoad).toHaveBeenCalledTimes(1)
  })

  it('shows only the preferences and books with the edition sync permission, and loads no admin state', () => {
    allow(Permission.EditionSync)
    const wrapper = mount(ForkSettings)
    expect(sections(wrapper)).toEqual(['user', 'books'])
    expect(mocks.adminLoad).not.toHaveBeenCalled()
  })

  it('shows only Server and Indexing with the manage settings permission', () => {
    allow(Permission.ManageAppSettings)
    const wrapper = mount(ForkSettings)
    expect(sections(wrapper)).toEqual(['server', 'indexing'])
  })

  it('hides the books until the settings load, and while the server switch is off', async () => {
    allow(Permission.EditionSync)
    useEditionSyncSettings().settings.value = null
    const wrapper = mount(ForkSettings)
    expect(sections(wrapper)).toEqual(['user'])
    useEditionSyncSettings().settings.value = {
      enabled: true,
      effectiveEnabled: false,
      disabledReason: 'server_disabled',
      bookSyncMode: 'all_eligible',
    }
    await wrapper.vm.$nextTick()
    expect(sections(wrapper)).toEqual(['user'])
  })

  it('reloads the books list after the preferences are saved', async () => {
    allow(Permission.EditionSync)
    const wrapper = mount(ForkSettings)
    await wrapper.get('[data-section="user"]').trigger('click')
    expect(mocks.booksLoad).toHaveBeenCalledTimes(1)
  })

  it('says there is nothing to configure when neither permission is held', () => {
    allow()
    const wrapper = mount(ForkSettings)
    expect(sections(wrapper)).toEqual([])
    expect(wrapper.text()).toContain('nothing to configure')
  })
})
