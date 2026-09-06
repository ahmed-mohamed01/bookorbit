import { mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Permission } from '@bookorbit/types'
import MonitoredHardcoverNotice from './MonitoredHardcoverNotice.vue'

const state = vi.hoisted(() => ({
  hasPermission: vi.fn<(permission: string) => boolean>(),
  messages: {
    'monitored.hardcoverNotice.title': 'Monitoring needs Hardcover.',
    'monitored.hardcoverNotice.connect': 'Connect your Hardcover account so authors can be added and their catalogs and release dates refreshed.',
    'monitored.hardcoverNotice.connectHardcover': 'Connect Hardcover',
    'monitored.hardcoverNotice.hint':
      'Enable the Hardcover metadata source with an API key so authors can be added and their catalogs and release dates refreshed.',
    'monitored.hardcoverNotice.askAdmin':
      'Ask an administrator to grant Hardcover sync or enable the Hardcover metadata source. Until then, authors cannot be added or refreshed.',
    'monitored.hardcoverNotice.openSettings': 'Open metadata sources',
  } as Record<string, string>,
}))

vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: state.hasPermission }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => state.messages[key] ?? key }),
}))

function mountNotice() {
  return mount(MonitoredHardcoverNotice, {
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('MonitoredHardcoverNotice', () => {
  beforeEach(() => state.hasPermission.mockReset())

  it('shows configuration guidance and a metadata settings link to users who can manage providers', () => {
    state.hasPermission.mockImplementation((permission) => permission === Permission.ManageMetadataConfig)

    const wrapper = mountNotice()

    expect(wrapper.text()).toContain(state.messages['monitored.hardcoverNotice.hint'])
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({ name: 'settings-metadata-providers' })
  })

  it('shows connection guidance and a Hardcover settings link to users who can sync Hardcover', () => {
    state.hasPermission.mockImplementation((permission) => permission === Permission.HardcoverSync)

    const wrapper = mountNotice()

    expect(wrapper.text()).toContain(state.messages['monitored.hardcoverNotice.connect'])
    expect(wrapper.text()).toContain(state.messages['monitored.hardcoverNotice.connectHardcover'])
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({ name: 'settings-hardcover' })
  })

  it('prefers the connection link when a user can sync Hardcover and manage providers', () => {
    state.hasPermission.mockImplementation((permission) => permission === Permission.HardcoverSync || permission === Permission.ManageMetadataConfig)

    const wrapper = mountNotice()

    expect(wrapper.text()).toContain(state.messages['monitored.hardcoverNotice.connect'])
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({ name: 'settings-hardcover' })
  })

  it('asks users without provider permission to contact an administrator and shows no link', () => {
    state.hasPermission.mockReturnValue(false)

    const wrapper = mountNotice()

    expect(wrapper.text()).toContain(state.messages['monitored.hardcoverNotice.askAdmin'])
    expect(wrapper.findComponent(RouterLinkStub).exists()).toBe(false)
  })
})
