import { describe, expect, it, vi } from 'vitest'
import { MonitoredApiError } from './api-error'
import { refreshAllAuthorsSequentially, refreshAuthorsSequentially } from './refresh-summary'
import type { MonitoredPage } from '@bookorbit/types'

describe('refreshAuthorsSequentially', () => {
  it('counts a cooldown as skipped and any other error as failed', async () => {
    const refresh = vi.fn<(id: string) => Promise<unknown>>(async (id) => {
      if (id === 'cooldown') throw new MonitoredApiError(429, 'Refreshed too recently')
      if (id === 'broken') throw new MonitoredApiError(500, 'Provider exploded')
      if (id === 'offline') throw new TypeError('Failed to fetch')
      return { ok: true }
    })

    const summary = await refreshAuthorsSequentially(['a', 'cooldown', 'broken', 'offline', 'b'], refresh)

    expect(summary).toEqual({ refreshed: 2, skipped: 1, failed: 2 })
    expect(refresh).toHaveBeenCalledTimes(5)
  })

  it('refreshes one author at a time and never leaves the rest stranded', async () => {
    const started: string[] = []
    let inFlight = 0
    const refresh = vi.fn<(id: string) => Promise<void>>(async (id) => {
      started.push(id)
      inFlight += 1
      expect(inFlight).toBe(1)
      await Promise.resolve()
      inFlight -= 1
      if (id === 'b') throw new MonitoredApiError(500, null)
    })

    const summary = await refreshAuthorsSequentially(['a', 'b', 'c'], refresh)

    expect(started).toEqual(['a', 'b', 'c'])
    expect(summary).toEqual({ refreshed: 2, skipped: 0, failed: 1 })
  })

  it('reports an empty summary when nothing is owned', async () => {
    const refresh = vi.fn<(id: string) => Promise<void>>()

    expect(await refreshAuthorsSequentially([], refresh)).toEqual({ refreshed: 0, skipped: 0, failed: 0 })
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('refreshAllAuthorsSequentially', () => {
  it('fetches and refreshes bounded id pages without retaining a full author list', async () => {
    const fetchPage = vi.fn<(page: number) => Promise<MonitoredPage<string>>>(async (page) => ({
      items: page === 0 ? ['a', 'b'] : ['c'],
      total: 3,
      page,
      size: 2,
    }))
    const refresh = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)

    await expect(refreshAllAuthorsSequentially(fetchPage, refresh)).resolves.toEqual({ refreshed: 3, skipped: 0, failed: 0 })
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
  })
})
