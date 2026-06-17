import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api } from '@/lib/api'
import {
  browseEntities,
  scanDuplicates,
  mergeEntities,
  renameEntity,
  deleteEntity,
  bulkDeleteEntities,
  splitEntity,
  dismissPair,
  undismissPair,
  getDismissedPairs,
  getDuplicateScanStatus,
  refreshDuplicates,
  getEntityInfo,
} from './entity-manager'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const mockedApi = vi.mocked(api)

function mockOkResponse(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) } as Response
}

function mockErrorResponse(status = 500) {
  return { ok: false, status, json: () => Promise.resolve({}) } as Response
}

const BASE = '/api/v1/entity-manager'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('browseEntities', () => {
  it('returns browse response on ok response', async () => {
    const data = { items: [], total: 0 }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await browseEntities('genre', { page: 1, pageSize: 20, sortBy: 'name' })

    const url = mockedApi.mock.calls[0][0] as string
    expect(url).toContain(`${BASE}/genre/browse`)
    expect(url).toContain('page=1')
    expect(url).toContain('pageSize=20')
    expect(url).toContain('sortBy=name')
    expect(result).toEqual(data)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(browseEntities('genre', {})).rejects.toThrow('Failed to browse genre')
  })
})

describe('scanDuplicates', () => {
  it('returns duplicate scan response on ok response', async () => {
    const data = { pairs: [], total: 0 }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await scanDuplicates('author', { page: 1, pageSize: 10, minSimilarity: 0.8 })

    const url = mockedApi.mock.calls[0][0] as string
    expect(url).toContain(`${BASE}/author/duplicates/scan`)
    expect(url).toContain('page=1')
    expect(url).toContain('minSimilarity=0.8')
    expect(result).toEqual(data)
  })

  it('passes AbortSignal to api', async () => {
    mockedApi.mockResolvedValue(mockOkResponse({ pairs: [], total: 0 }))

    const controller = new AbortController()
    await scanDuplicates('author', {}, controller.signal)

    const [, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(opts.signal).toBe(controller.signal)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(scanDuplicates('author', {})).rejects.toThrow('Failed to scan author duplicates')
  })
})

describe('mergeEntities', () => {
  it('returns merge result on ok response', async () => {
    const data = { mergedCount: 1, targetEntityId: 10 }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await mergeEntities('tag', { targetEntityId: 10, sourceEntityIds: [11, 12] })

    const [url, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/tag/merge`)
    expect(opts.method).toBe('POST')
    expect(result).toEqual(data)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(mergeEntities('tag', { targetEntityId: 10, sourceEntityIds: [11] })).rejects.toThrow('Failed to merge tag')
  })
})

describe('renameEntity', () => {
  it('returns rename result on ok response', async () => {
    const data = { entityId: 5, newName: 'Fantasy' }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await renameEntity('genre', { entityId: 5, newName: 'Fantasy' })

    const [url, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/genre/rename`)
    expect(opts.method).toBe('POST')
    expect(result).toEqual(data)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(renameEntity('genre', { newName: 'Fantasy' })).rejects.toThrow('Failed to rename genre')
  })
})

describe('deleteEntity', () => {
  it('returns delete result on ok response', async () => {
    const data = { deletedCount: 1 }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await deleteEntity('tag', { entityId: 3, mode: 'soft' })

    const [url, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/tag/delete`)
    expect(opts.method).toBe('POST')
    expect(result).toEqual(data)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(deleteEntity('tag', { entityId: 3 })).rejects.toThrow('Failed to delete tag')
  })
})

describe('bulkDeleteEntities', () => {
  it('returns bulk delete result on ok response', async () => {
    const data = { deletedCount: 3, failedIds: [] }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await bulkDeleteEntities('genre', { entityIds: [1, 2, 3], mode: 'hard' })

    const [url, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/genre/bulk-delete`)
    expect(opts.method).toBe('POST')
    expect(result).toEqual(data)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(bulkDeleteEntities('genre', { entityIds: [1] })).rejects.toThrow('Failed to bulk delete genre')
  })
})

describe('splitEntity', () => {
  it('returns split result on ok response', async () => {
    const data = { originalEntityId: 7, newEntityIds: [8, 9] }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await splitEntity('author', { entityId: 7, newNames: ['Alice', 'Bob'] })

    const [url, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/author/split`)
    expect(opts.method).toBe('POST')
    expect(result).toEqual(data)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(splitEntity('author', { entityId: 7, newNames: ['Alice', 'Bob'] })).rejects.toThrow('Failed to split author')
  })
})

describe('dismissPair', () => {
  it('resolves void on ok response', async () => {
    mockedApi.mockResolvedValue(mockOkResponse(null))

    const result = await dismissPair('author', { entityIdA: 1, entityIdB: 2, reason: 'different people' })

    const [url, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/author/duplicates/dismiss`)
    expect(opts.method).toBe('POST')
    expect(result).toBeUndefined()
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(dismissPair('author', { entityIdA: 1, entityIdB: 2 })).rejects.toThrow('Failed to dismiss author duplicate pair')
  })
})

describe('undismissPair', () => {
  it('resolves void on ok response', async () => {
    mockedApi.mockResolvedValue(mockOkResponse(null))

    const result = await undismissPair('genre', { entityIdA: 3, entityIdB: 4 })

    const [url, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/genre/duplicates/undismiss`)
    expect(opts.method).toBe('POST')
    expect(result).toBeUndefined()
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(undismissPair('genre', { entityIdA: 3, entityIdB: 4 })).rejects.toThrow('Failed to undismiss genre duplicate pair')
  })
})

describe('getDismissedPairs', () => {
  it('returns dismissed pairs on ok response', async () => {
    const data = [{ entityIdA: 1, entityIdB: 2, reason: 'different' }]
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await getDismissedPairs('tag')

    expect(mockedApi).toHaveBeenCalledWith(`${BASE}/tag/duplicates/dismissed`)
    expect(result).toEqual(data)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(getDismissedPairs('tag')).rejects.toThrow('Failed to get dismissed tag pairs')
  })
})

describe('getDuplicateScanStatus', () => {
  it('returns scan status on ok response', async () => {
    const data = { status: 'idle', lastScannedAt: null }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await getDuplicateScanStatus('publisher')

    expect(mockedApi).toHaveBeenCalledWith(`${BASE}/publisher/duplicates/status`)
    expect(result).toEqual(data)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(getDuplicateScanStatus('publisher')).rejects.toThrow('Failed to get publisher duplicate scan status')
  })
})

describe('refreshDuplicates', () => {
  it('returns updated scan status on ok response', async () => {
    const data = { status: 'running', lastScannedAt: null }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await refreshDuplicates('series', { minSimilarity: 0.9 })

    const [url, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/series/duplicates/refresh`)
    expect(opts.method).toBe('POST')
    expect(result).toEqual(data)
  })

  it('uses empty object body when params are omitted', async () => {
    mockedApi.mockResolvedValue(mockOkResponse({ status: 'running' }))

    await refreshDuplicates('series')

    const [, opts] = mockedApi.mock.calls[0] as [string, RequestInit]
    expect(opts.body).toBe(JSON.stringify({}))
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(refreshDuplicates('series')).rejects.toThrow('Failed to refresh series duplicates')
  })
})

describe('getEntityInfo', () => {
  it('returns entity info on ok response', async () => {
    const data = { entityId: 42, name: 'Fantasy', bookCount: 10 }
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await getEntityInfo('genre', 42)

    expect(mockedApi).toHaveBeenCalledWith(`${BASE}/genre/info/42`)
    expect(result).toEqual(data)
  })

  it('accepts string entityId', async () => {
    mockedApi.mockResolvedValue(mockOkResponse({ entityId: 'abc', name: 'Sci-Fi' }))

    await getEntityInfo('genre', 'abc')

    expect(mockedApi).toHaveBeenCalledWith(`${BASE}/genre/info/abc`)
  })

  it('throws with entityType in message on non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse())

    await expect(getEntityInfo('genre', 99)).rejects.toThrow('Failed to get genre info')
  })
})
