import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchEbookCrossFormatResume } from '../useCrossFormatResume'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: vi.fn<() => Promise<Response>>() }))
const mockApi = vi.mocked(api)

function response(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response
}

describe('fetchEbookCrossFormatResume', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the resume point for an available audio-source result', async () => {
    mockApi.mockResolvedValue(response({ available: true, source: 'audio', spineIndex: 5, phrase: 'the room lit up', percentage: 95.4 }))

    const result = await fetchEbookCrossFormatResume(42)

    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/reading-alignment/books/42/cross-format-resume?target=ebook',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(result).toEqual({ spineIndex: 5, phrase: 'the room lit up', percentage: 95.4 })
  })

  it('returns null when the audiobook is not ahead (unavailable)', async () => {
    mockApi.mockResolvedValue(response({ available: false }))
    expect(await fetchEbookCrossFormatResume(42)).toBeNull()
  })

  it('returns null for a non-audio source', async () => {
    mockApi.mockResolvedValue(response({ available: true, source: 'ebook', currentFileId: 1, positionSeconds: 10 }))
    expect(await fetchEbookCrossFormatResume(42)).toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    mockApi.mockResolvedValue(response({}, false))
    expect(await fetchEbookCrossFormatResume(42)).toBeNull()
  })

  it('returns null on a malformed payload', async () => {
    mockApi.mockResolvedValue(response({ available: true, source: 'audio', spineIndex: 'x', phrase: 5, percentage: null }))
    expect(await fetchEbookCrossFormatResume(42)).toBeNull()
  })

  it('returns null when the phrase is blank', async () => {
    mockApi.mockResolvedValue(response({ available: true, source: 'audio', spineIndex: 5, phrase: '   ', percentage: 95.4 }))
    expect(await fetchEbookCrossFormatResume(42)).toBeNull()
  })

  it('returns null when the request throws', async () => {
    mockApi.mockRejectedValue(new Error('network'))
    expect(await fetchEbookCrossFormatResume(42)).toBeNull()
  })

  // Regression guard: even if api() never settles (e.g. a 401 triggers a token refresh that hangs -
  // a path the AbortSignal does not reach), the deadline must resolve so reader-open never hangs.
  it('resolves to null within the deadline when the request never settles', async () => {
    vi.useFakeTimers()
    try {
      mockApi.mockReturnValue(new Promise<Response>(() => {})) // never settles
      const pending = fetchEbookCrossFormatResume(42)
      await vi.advanceTimersByTimeAsync(2600)
      await expect(pending).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
