import { mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Permission } from '@bookorbit/types'
import MonitoredAudibleNotice from './MonitoredAudibleNotice.vue'

const state = vi.hoisted(() => ({
  hasPermission: vi.fn<(permission: string) => boolean>(),
  messages: {
    'monitored.audibleNotice.title': 'Only Ebook release dates displayed as no audiobook metadata providers configured.',
    'monitored.audibleNotice.hint': 'Enable Audiobook metadata source and refresh to display audiobook release dates.',
    'monitored.audibleNotice.askAdmin': 'Ask an administrator to enable an audiobook metadata source to display audiobook release dates.',
    'monitored.audibleNotice.openSettings': 'Open metadata sources',
  } as Record<string, string>,
}))

vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: state.hasPermission }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => state.messages[key] ?? key }),
}))

function mountNotice() {
  return mount(MonitoredAudibleNotice, {
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('MonitoredAudibleNotice', () => {
  beforeEach(() => state.hasPermission.mockReset())

  it('shows configuration guidance and a metadata settings link to users who can manage providers', () => {
    state.hasPermission.mockImplementation((permission) => permission === Permission.ManageMetadataConfig)

    const wrapper = mountNotice()

    expect(wrapper.text()).toContain(state.messages['monitored.audibleNotice.title'])
    expect(wrapper.text()).toContain(state.messages['monitored.audibleNotice.hint'])
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({ name: 'settings-metadata-providers' })
  })

  it('asks users without provider permission to contact an administrator and shows no link', () => {
    state.hasPermission.mockReturnValue(false)

    const wrapper = mountNotice()

    expect(wrapper.text()).toContain(state.messages['monitored.audibleNotice.askAdmin'])
    expect(wrapper.findComponent(RouterLinkStub).exists()).toBe(false)
  })

  // Vue condenses the newline between the two spans away, so the separator has to be explicit.
  it('separates the bold title from the message', () => {
    state.hasPermission.mockReturnValue(false)

    const text = mountNotice().text().replace(/ /g, ' ')

    expect(text).toContain(`${state.messages['monitored.audibleNotice.title']} ${state.messages['monitored.audibleNotice.askAdmin']}`)
  })
})
