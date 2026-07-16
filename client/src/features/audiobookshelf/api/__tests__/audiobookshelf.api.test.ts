import { beforeEach, describe, expect, it, vi } from 'vitest'

type ApiFn = (input: RequestInfo | URL, init?: RequestInit & { _isRetry?: boolean }) => Promise<Response>

vi.mock('@/lib/api', () => ({ api: vi.fn<ApiFn>() }))

import { api } from '@/lib/api'
import {
  disconnectAudiobookshelf,
  fetchAudiobookshelfSettings,
  testAudiobookshelfConnection,
  updateAudiobookshelfSettings,
} from '../audiobookshelf.api'

const mockApi = vi.mocked(api)

function jsonResponse(body: unknown): Response {
  return { ok: true, json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body) } as unknown as Response
}

describe('audiobookshelf.api settings contract', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  it('fetches settings from the verified server route', async () => {
    const settings = { serverUrl: 'https://abs.example.com', tokenConfigured: true, effectiveEnabled: true }
    mockApi.mockResolvedValue(jsonResponse(settings))

    await expect(fetchAudiobookshelfSettings()).resolves.toEqual(settings)
    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/settings')
  })

  it('sends only the provided settings fields', async () => {
    mockApi.mockResolvedValue(jsonResponse({ enabled: false }))

    await updateAudiobookshelfSettings({ enabled: false })

    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/audiobookshelf/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
    )
  })

  it('uses the verified disconnect and connection-test routes', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse(null)).mockResolvedValueOnce(jsonResponse({ success: true, username: 'listener' }))

    await expect(disconnectAudiobookshelf()).resolves.toBeUndefined()
    await expect(testAudiobookshelfConnection({ serverUrl: 'https://abs.example.com' })).resolves.toEqual({
      success: true,
      username: 'listener',
    })

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/v1/audiobookshelf/settings', { method: 'DELETE' })
    expect(mockApi).toHaveBeenNthCalledWith(
      2,
      '/api/v1/audiobookshelf/test-connection',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ serverUrl: 'https://abs.example.com' }) }),
    )
  })
})
