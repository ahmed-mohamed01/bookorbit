import { invalidateProviderLinkSettings } from '@/features/book/composables/useProviderLinkSettings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))

import { api } from '@/lib/api'
import { useProviderLinkSettings } from '../useProviderLinkSettings'

const apiMock = vi.mocked(api)

describe('useProviderLinkSettings', () => {
  beforeEach(() => {
    invalidateProviderLinkSettings()
    apiMock.mockReset()
    useProviderLinkSettings().settings.value = { amazonDomain: 'amazon.com' }
  })

  it('loads the sanitized provider-link settings', async () => {
    apiMock.mockResolvedValue({
      ok: true,
      json: async () => ({ amazonDomain: 'amazon.de' }),
    } as Response)

    const { settings, loadSettings } = useProviderLinkSettings()
    await loadSettings()

    expect(apiMock).toHaveBeenCalledWith('/api/v1/metadata-preferences/provider-links')
    expect(settings.value).toEqual({ amazonDomain: 'amazon.de' })
  })

  it('reuses loaded settings across consumers until invalidated', async () => {
    apiMock.mockResolvedValue({ ok: true, json: async () => ({ amazonDomain: 'amazon.de' }) } as Response)
    const first = useProviderLinkSettings().loadSettings()
    await first
    expect(useProviderLinkSettings().loadSettings()).toBe(first)
    expect(apiMock).toHaveBeenCalledTimes(1)

    invalidateProviderLinkSettings()
    apiMock.mockResolvedValue({ ok: true, json: async () => ({ amazonDomain: 'amazon.co.uk' }) } as Response)
    await useProviderLinkSettings().loadSettings()
    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(useProviderLinkSettings().settings.value.amazonDomain).toBe('amazon.co.uk')
  })

  it('keeps the default when the settings request fails', async () => {
    apiMock.mockResolvedValue({ ok: false } as Response)

    const { settings, loadSettings } = useProviderLinkSettings()
    await loadSettings()

    expect(settings.value).toEqual({ amazonDomain: 'amazon.com' })
  })

  it('deduplicates concurrent settings requests', async () => {
    let resolveRequest!: (response: Response) => void
    apiMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveRequest = resolve
      }),
    )

    const { loadSettings } = useProviderLinkSettings()
    const first = loadSettings()
    const second = loadSettings()
    resolveRequest({ ok: false } as Response)
    await Promise.all([first, second])

    expect(apiMock).toHaveBeenCalledOnce()
  })
})
