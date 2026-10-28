import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getEditionLinkSettings, updateEditionLinkSettings } from '../../api/work'
import { DEFAULT_EDITION_LINK_SETTINGS, useEditionLinkSettings } from '../useEditionLinkSettings'

vi.mock('../../api/work', () => ({
  getEditionLinkSettings: vi.fn<(...args: unknown[]) => unknown>(),
  updateEditionLinkSettings: vi.fn<(...args: unknown[]) => unknown>(),
}))

describe('useEditionLinkSettings', () => {
  beforeEach(() => {
    vi.mocked(getEditionLinkSettings)
      .mockReset()
      .mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS })
    vi.mocked(updateEditionLinkSettings).mockReset()
  })

  it('is clean after loading and dirty after an edit', async () => {
    const settings = useEditionLinkSettings()
    await settings.fetchSettings()
    expect(settings.dirty.value).toBe(false)

    settings.draft.value.positionSync = 'precise'
    expect(settings.dirty.value).toBe(true)
  })

  it('saves only the changed fields and adopts the server response', async () => {
    vi.mocked(updateEditionLinkSettings).mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS, autoLinkStrong: true })
    const settings = useEditionLinkSettings()
    await settings.fetchSettings()
    settings.draft.value.autoLinkStrong = true

    expect(await settings.save()).toBe(true)
    expect(updateEditionLinkSettings).toHaveBeenCalledWith({ autoLinkStrong: true })
    expect(settings.dirty.value).toBe(false)
  })

  it('reports a failed save and stays dirty', async () => {
    vi.mocked(updateEditionLinkSettings).mockRejectedValue(new Error('nope'))
    const settings = useEditionLinkSettings()
    await settings.fetchSettings()
    settings.draft.value.enabled = false

    expect(await settings.save()).toBe(false)
    expect(settings.error.value).toBe('edition_link_settings_save_failed')
    expect(settings.dirty.value).toBe(true)
  })
})
