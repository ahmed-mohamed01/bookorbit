import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorytellerConnectionTestResult, StorytellerSettings } from '@bookorbit/types'

const apiMock = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>())

vi.mock('@/lib/api', () => ({ api: apiMock }))

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

function makeSettings(overrides: Partial<StorytellerSettings> = {}): StorytellerSettings {
  return {
    serverUrl: 'https://storyteller.example.com',
    username: 'bookorbit',
    passwordConfigured: true,
    pathMappings: [],
    targetLibraryId: null,
    targetFolderId: null,
    transport: 'auto',
    deleteRemoteAfterImport: false,
    collectionName: null,
    lastCheckedAt: null,
    lastCheck: null,
    ...overrides,
  }
}

function makeDraft(overrides: Partial<import('../useStorytellerSettings').StorytellerSettingsDraft> = {}) {
  return {
    serverUrl: 'https://storyteller.example.com',
    username: 'bookorbit',
    password: '',
    pathMappings: [],
    targetLibraryId: null,
    targetFolderId: null,
    transport: 'auto' as const,
    deleteRemoteAfterImport: false,
    collectionName: '',
    ...overrides,
  }
}

async function loadComposable() {
  const { useStorytellerSettings } = await import('../useStorytellerSettings')
  return useStorytellerSettings()
}

describe('useStorytellerSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetchSettings populates the shared ref on success', async () => {
    const settings = makeSettings()
    apiMock.mockResolvedValue(jsonResponse(settings))
    const c = await loadComposable()

    await c.fetchSettings()

    expect(apiMock).toHaveBeenCalledWith('/api/v1/storyteller/settings')
    expect(c.settings.value).toEqual(settings)
    expect(c.loading.value).toBe(false)
    expect(c.error.value).toBeNull()
  })

  it('fetchSettings records the error message on failure', async () => {
    apiMock.mockResolvedValue(jsonResponse({ message: 'Server unreachable' }, false))
    const c = await loadComposable()

    await c.fetchSettings()

    expect(c.settings.value).toBeNull()
    expect(c.error.value).toBe('Server unreachable')
    expect(c.loading.value).toBe(false)
  })

  it('saveSettings sends only the fields that changed from the loaded settings', async () => {
    const c = await loadComposable()
    apiMock.mockResolvedValueOnce(jsonResponse(makeSettings()))
    await c.fetchSettings()
    apiMock.mockResolvedValueOnce(jsonResponse(makeSettings({ collectionName: 'BookOrbit' })))

    const ok = await c.saveSettings(makeDraft({ collectionName: 'BookOrbit' }))

    expect(ok).toBe(true)
    expect(apiMock).toHaveBeenLastCalledWith(
      '/api/v1/storyteller/settings',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ collectionName: 'BookOrbit' }) }),
    )
  })

  it('saveSettings includes the password only when the user typed one', async () => {
    const c = await loadComposable()
    apiMock.mockResolvedValueOnce(jsonResponse(makeSettings()))
    await c.fetchSettings()
    apiMock.mockResolvedValueOnce(jsonResponse(makeSettings()))

    await c.saveSettings(makeDraft({ password: '  new-secret  ' }))

    expect(apiMock).toHaveBeenLastCalledWith(
      '/api/v1/storyteller/settings',
      expect.objectContaining({ body: JSON.stringify({ password: 'new-secret' }) }),
    )
  })

  it('saveSettings sends an empty payload when nothing changed', async () => {
    const c = await loadComposable()
    apiMock.mockResolvedValueOnce(jsonResponse(makeSettings()))
    await c.fetchSettings()
    apiMock.mockResolvedValueOnce(jsonResponse(makeSettings()))

    await c.saveSettings(makeDraft())

    expect(apiMock).toHaveBeenLastCalledWith('/api/v1/storyteller/settings', expect.objectContaining({ body: JSON.stringify({}) }))
  })

  it('diffs deleteRemoteAfterImport against the instance default before any settings have loaded', async () => {
    const { buildStorytellerSettingsPayload } = await import('../useStorytellerSettings')

    // The instance deletes the Storyteller copy by default, so a draft that agrees carries nothing.
    expect(buildStorytellerSettingsPayload(makeDraft({ deleteRemoteAfterImport: true }), null)).not.toHaveProperty('deleteRemoteAfterImport')
    expect(buildStorytellerSettingsPayload(makeDraft({ deleteRemoteAfterImport: false }), null)).toMatchObject({ deleteRemoteAfterImport: false })
  })

  it('saveSettings clears a collection name by sending null rather than an empty string', async () => {
    const c = await loadComposable()
    apiMock.mockResolvedValueOnce(jsonResponse(makeSettings({ collectionName: 'BookOrbit' })))
    await c.fetchSettings()
    apiMock.mockResolvedValueOnce(jsonResponse(makeSettings({ collectionName: null })))

    await c.saveSettings(makeDraft({ collectionName: '' }))

    expect(apiMock).toHaveBeenLastCalledWith(
      '/api/v1/storyteller/settings',
      expect.objectContaining({ body: JSON.stringify({ collectionName: null }) }),
    )
  })

  it('saveSettings returns false and records the error message on failure', async () => {
    const c = await loadComposable()
    apiMock.mockResolvedValueOnce(jsonResponse({ message: 'Invalid server URL' }, false))

    const ok = await c.saveSettings(makeDraft())

    expect(ok).toBe(false)
    expect(c.error.value).toBe('Invalid server URL')
    expect(c.saving.value).toBe(false)
  })

  it('the composable never exposes the raw password in its settings ref', async () => {
    const c = await loadComposable()
    apiMock.mockResolvedValueOnce(jsonResponse(makeSettings()))

    await c.saveSettings(makeDraft({ password: 'super-secret-password' }))

    expect(JSON.stringify(c.settings.value)).not.toContain('super-secret-password')
    expect(c.settings.value).not.toHaveProperty('password')
  })

  it('testConnection returns the result on success', async () => {
    const result: StorytellerConnectionTestResult = {
      ok: true,
      checkedAt: '2026-09-22T00:00:00.000Z',
      serverVersion: '1.4.0',
      capabilities: ['read-along'],
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/read-along',
      importMode: 'reference',
      aligner: 'ctc',
      sharedPathsReady: true,
      effectiveTransport: 'shared-paths',
      problems: [],
      error: null,
    }
    apiMock.mockResolvedValue(jsonResponse(result))
    const c = await loadComposable()

    const returned = await c.testConnection(makeDraft())

    expect(apiMock).toHaveBeenCalledWith('/api/v1/storyteller/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: 'https://storyteller.example.com', username: 'bookorbit' }),
    })
    expect(returned).toEqual(result)
    expect(c.testing.value).toBe(false)
  })

  it('testConnection sends a typed password so an unsaved connection can be verified', async () => {
    apiMock.mockResolvedValue(jsonResponse({ ok: true }))
    const c = await loadComposable()

    await c.testConnection(makeDraft({ serverUrl: '  https://draft.example.com  ', password: '  typed  ' }))

    expect(JSON.parse(String(apiMock.mock.calls[0]?.[1]?.body))).toEqual({
      serverUrl: 'https://draft.example.com',
      username: 'bookorbit',
      password: 'typed',
    })
  })

  it('testConnection returns null and records the error message on an HTTP failure', async () => {
    apiMock.mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, false))
    const c = await loadComposable()

    const returned = await c.testConnection(makeDraft())

    expect(returned).toBeNull()
    expect(c.error.value).toBe('Unauthorized')
    expect(c.testing.value).toBe(false)
  })
})
