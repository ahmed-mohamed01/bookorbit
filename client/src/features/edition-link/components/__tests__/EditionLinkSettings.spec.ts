import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { getActiveMatchScan, getEditionLinkSettings, updateEditionLinkSettings } from '../../api/work'
import { DEFAULT_EDITION_LINK_SETTINGS } from '../../composables/useEditionLinkSettings'
import EditionLinkSettings from '../EditionLinkSettings.vue'
import { scanStatus } from '../../composables/__tests__/fixtures'

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => false }) }))
vi.mock('@/features/audiobookshelf/composables/useAudiobookshelfSettings', () => ({
  useAudiobookshelfSettings: () => ({ settings: ref({ syncPosition: true, pushPosition: false }), fetchSettings: vi.fn<() => void>() }),
}))
vi.mock('../../api/work', () => ({
  getEditionLinkSettings: vi.fn<(...args: unknown[]) => unknown>(),
  updateEditionLinkSettings: vi.fn<(...args: unknown[]) => unknown>(),
  getActiveMatchScan: vi.fn<(...args: unknown[]) => unknown>(),
}))

async function render() {
  const wrapper = mount(EditionLinkSettings, { props: { embedded: true }, global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return wrapper
}

describe('EditionLinkSettings', () => {
  beforeEach(() => {
    vi.mocked(getEditionLinkSettings)
      .mockReset()
      .mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS })
    vi.mocked(updateEditionLinkSettings).mockReset()
    vi.mocked(getActiveMatchScan).mockReset().mockResolvedValue(scanStatus())
  })

  it('renders the diagram from Audiobookshelf settings and the latest scan counts', async () => {
    const wrapper = await render()

    expect(wrapper.text()).toContain('pulls in')
    expect(wrapper.get('[data-testid="scan-line"]').text()).toBe('3 to fix · 8 to review · 5 ready')
    expect(wrapper.find('[data-testid="history-preview"]').exists()).toBe(false)
  })

  it('greys the diagram arrows as the master toggle is switched off and saves the change', async () => {
    vi.mocked(updateEditionLinkSettings).mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS, enabled: false })
    const wrapper = await render()

    await wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.get('[data-testid="diagram-link-text"] [data-active]').attributes('data-active')).toBe('false')

    const save = wrapper.findAll('button').find((button) => button.text() === 'Save settings')!
    await save.trigger('click')
    await flushPromises()

    expect(updateEditionLinkSettings).toHaveBeenCalledWith({ enabled: false })
  })
})
