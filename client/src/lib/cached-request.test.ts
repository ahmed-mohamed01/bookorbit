import { describe, expect, it, vi } from 'vitest'
import { createCachedRequest } from './cached-request'

describe('createCachedRequest', () => {
  it('marks an in-flight load stale after invalidation', async () => {
    let resolve!: () => void
    let current!: () => boolean
    const cache = createCachedRequest(async (isCurrent) => {
      current = isCurrent
      await new Promise<void>((done) => {
        resolve = done
      })
      return isCurrent()
    })
    const pending = cache.get()
    expect(current()).toBe(true)
    cache.invalidate()
    resolve()
    expect(await pending).toBe(false)
  })

  it('shares an in-flight load and reuses its resolved value', async () => {
    let resolve!: (value: number) => void
    const load = vi.fn<() => Promise<number>>(
      () =>
        new Promise<number>((done) => {
          resolve = done
        }),
    )
    const cache = createCachedRequest(load)
    const first = cache.get()
    expect(cache.get()).toBe(first)
    resolve(42)
    expect(await first).toBe(42)
    expect(await cache.get()).toBe(42)
    expect(load).toHaveBeenCalledOnce()
  })
  it('retries after rejection', async () => {
    const load = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(42)
    const cache = createCachedRequest(load)
    await expect(cache.get()).rejects.toThrow('offline')
    expect(await cache.get()).toBe(42)
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('force reloads', async () => {
    const load = vi.fn<() => Promise<number>>(async () => 42)
    const cache = createCachedRequest(load)
    await cache.get()
    await cache.get({ force: true })
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('invalidate reloads', async () => {
    const load = vi.fn<() => Promise<number>>(async () => 42)
    const cache = createCachedRequest(load)
    await cache.get()
    cache.invalidate()
    await cache.get()
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('an invalidated rejection does not clear a newer request', async () => {
    let reject!: (reason: Error) => void
    const load = vi
      .fn<() => Promise<number>>()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail
          }),
      )
      .mockResolvedValue(42)
    const cache = createCachedRequest(load)
    const old = cache.get()
    const next = cache.get({ force: true })
    reject(new Error('old'))
    await expect(old).rejects.toThrow('old')
    await next
    expect(cache.get()).toBe(next)
  })
})
