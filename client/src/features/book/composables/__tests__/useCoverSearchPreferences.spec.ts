import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn<(...args: [RequestInfo | URL, RequestInit?]) => Promise<unknown>>())

vi.mock('@/lib/api', () => ({ api: apiMock }))

function response(body: unknown, ok = true): Pick<Response, 'json' | 'ok'> {
  return {
    ok,
    json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body),
  }
}

async function freshComposable() {
  vi.resetModules()
  const { useCoverSearchPreferences } = await import('../useCoverSearchPreferences')
  return useCoverSearchPreferences()
}

describe('useCoverSearchPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads the saved default provider', async () => {
    apiMock.mockResolvedValueOnce(response({ settings: { defaultProvider: 'itunes' } }))
    const preferences = await freshComposable()

    await expect(preferences.load()).resolves.toBe(true)

    expect(apiMock).toHaveBeenCalledWith('/api/v1/user-preferences/cover-search')
    expect(preferences.defaultProvider.value).toBe('itunes')
  })

  it('falls back to DuckDuckGo when the response is malformed', async () => {
    apiMock.mockResolvedValueOnce(response({ settings: { defaultProvider: 'unknown' } }))
    const preferences = await freshComposable()

    await preferences.load()

    expect(preferences.defaultProvider.value).toBe('duckduckgo')
  })

  it('fetches once and serves later loads from cache', async () => {
    apiMock.mockResolvedValueOnce(response({ settings: { defaultProvider: 'itunes' } }))
    const preferences = await freshComposable()

    await preferences.load()
    await expect(preferences.load()).resolves.toBe(true)

    expect(apiMock).toHaveBeenCalledOnce()
  })

  it('shares a single request between concurrent loads', async () => {
    apiMock.mockResolvedValueOnce(response({ settings: { defaultProvider: 'all' } }))
    const preferences = await freshComposable()

    await Promise.all([preferences.load(), preferences.load(), preferences.load()])

    expect(apiMock).toHaveBeenCalledOnce()
    expect(preferences.defaultProvider.value).toBe('all')
  })

  it('retries after a failed load instead of caching the failure', async () => {
    apiMock.mockRejectedValueOnce(new Error('offline'))
    const preferences = await freshComposable()

    await expect(preferences.load()).resolves.toBe(false)

    apiMock.mockResolvedValueOnce(response({ settings: { defaultProvider: 'itunes' } }))
    await expect(preferences.load()).resolves.toBe(true)

    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(preferences.defaultProvider.value).toBe('itunes')
  })

  it('persists a new default provider', async () => {
    apiMock.mockResolvedValueOnce(response(undefined))
    const preferences = await freshComposable()

    await expect(preferences.update('all')).resolves.toBe(true)

    expect(preferences.defaultProvider.value).toBe('all')
    expect(apiMock).toHaveBeenCalledWith('/api/v1/user-preferences/cover-search', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { defaultProvider: 'all' } }),
    })
  })

  it('treats a saved provider as loaded so no fetch follows', async () => {
    apiMock.mockResolvedValueOnce(response(undefined))
    const preferences = await freshComposable()

    await preferences.update('itunes')
    await preferences.load()

    expect(apiMock).toHaveBeenCalledOnce()
    expect(preferences.defaultProvider.value).toBe('itunes')
  })

  it('restores the previous provider when saving fails', async () => {
    apiMock.mockResolvedValueOnce(response(undefined, false))
    const preferences = await freshComposable()
    preferences.defaultProvider.value = 'itunes'

    await expect(preferences.update('all')).resolves.toBe(false)

    expect(preferences.defaultProvider.value).toBe('itunes')
    expect(preferences.isSaving.value).toBe(false)
  })

  it('keeps the current default when loading fails', async () => {
    apiMock.mockRejectedValueOnce(new Error('offline'))
    const preferences = await freshComposable()
    preferences.defaultProvider.value = 'itunes'

    await expect(preferences.load()).resolves.toBe(false)

    expect(preferences.defaultProvider.value).toBe('itunes')
    expect(preferences.isLoading.value).toBe(false)
  })
})
