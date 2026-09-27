import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApi = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => mockApi(...args) }))

import { cancelReadAlongBuild } from '../read-along-cancel'

describe('cancelReadAlongBuild', () => {
  beforeEach(() => mockApi.mockReset())

  it('sends the cancel to the build route of the book', async () => {
    mockApi.mockResolvedValue({ ok: true, status: 204 })

    await expect(cancelReadAlongBuild(10)).resolves.toBe('cancelled')

    expect(mockApi).toHaveBeenCalledWith('/api/v1/storyteller/read-along/books/10/build', { method: 'DELETE' })
  })

  it('names the build when given one', async () => {
    mockApi.mockResolvedValue({ ok: true, status: 204 })

    await cancelReadAlongBuild(10, 7)

    expect(mockApi).toHaveBeenCalledWith('/api/v1/storyteller/read-along/books/10/build?buildId=7', { method: 'DELETE' })
  })

  it('answers too_late when the server is already importing the read-along', async () => {
    mockApi.mockResolvedValue({ ok: false, status: 409 })

    await expect(cancelReadAlongBuild(10)).resolves.toBe('too_late')
  })

  it('answers failed on any other refusal or a network error', async () => {
    mockApi.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(cancelReadAlongBuild(10)).resolves.toBe('failed')

    mockApi.mockRejectedValueOnce(new Error('offline'))
    await expect(cancelReadAlongBuild(10)).resolves.toBe('failed')
  })
})
