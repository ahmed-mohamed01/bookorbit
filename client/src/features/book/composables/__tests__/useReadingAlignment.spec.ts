import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

const mocks = vi.hoisted(() => ({
  api: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))

vi.mock('@/lib/api', () => ({
  api: mocks.api,
}))

import { useReadingAlignment } from '../useReadingAlignment'

function response(data: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  const { ok = true, status = ok ? 200 : 500 } = options
  return {
    ok,
    status,
    json: async () => data,
  } as Response
}

const STATUS_URL = '/api/v1/reading-alignment/books/10/alignment'
const BUILD_URL = '/api/v1/reading-alignment/books/10/build'
const FORCE_BUILD_URL = '/api/v1/reading-alignment/books/10/build?force=true'

describe('useReadingAlignment', () => {
  beforeEach(() => {
    mocks.api.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('fetchStatus', () => {
    it('maps a full status response onto the reactive fields', async () => {
      mocks.api.mockResolvedValueOnce(
        response({ status: 'ready', samplesDone: 40, samplesTotal: 40, anchorCount: 12, builtAt: '2026-02-02T00:00:00.000Z' }),
      )

      const { status, samplesDone, samplesTotal, anchorCount, builtAt, loading, fetchStatus } = useReadingAlignment()
      await fetchStatus(10)

      expect(mocks.api).toHaveBeenCalledExactlyOnceWith(STATUS_URL)
      expect(status.value).toBe('ready')
      expect(samplesDone.value).toBe(40)
      expect(samplesTotal.value).toBe(40)
      expect(anchorCount.value).toBe(12)
      expect(builtAt.value).toBe('2026-02-02T00:00:00.000Z')
      expect(loading.value).toBe(false)
    })

    it('clears progress fields for a none response', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'none' }))

      const { status, samplesDone, samplesTotal, anchorCount, builtAt, fetchStatus } = useReadingAlignment()
      await fetchStatus(10)

      expect(status.value).toBe('none')
      expect(samplesDone.value).toBeNull()
      expect(samplesTotal.value).toBeNull()
      expect(anchorCount.value).toBeNull()
      expect(builtAt.value).toBeNull()
    })

    it('falls back to none for a status value the client does not recognize', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'some_future_status', samplesDone: 1, samplesTotal: 2, anchorCount: 0, builtAt: null }))

      const { status, samplesDone, fetchStatus } = useReadingAlignment()
      await fetchStatus(10)

      expect(status.value).toBe('none')
      expect(samplesDone.value).toBeNull()
    })

    it('degrades to none without throwing on a non-ok response', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 500 }))

      const { status, error, fetchStatus } = useReadingAlignment()
      await expect(fetchStatus(10)).resolves.toBeUndefined()

      expect(status.value).toBe('none')
      expect(error.value).toBe('Failed to load alignment status')
    })

    it('degrades to none without throwing on a network exception', async () => {
      mocks.api.mockRejectedValueOnce(new Error('network down'))

      const { status, error, fetchStatus } = useReadingAlignment()
      await expect(fetchStatus(10)).resolves.toBeUndefined()

      expect(status.value).toBe('none')
      expect(error.value).toBe('Failed to load alignment status')
    })
  })

  describe('build', () => {
    it('posts a build request and then fetches the refreshed status', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building' }))
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesDone: 0, samplesTotal: 40, anchorCount: 0, builtAt: null }))

      const { status, samplesTotal, mutating, build } = useReadingAlignment()
      await build(10)

      expect(mocks.api).toHaveBeenNthCalledWith(1, BUILD_URL, { method: 'POST' })
      expect(mocks.api).toHaveBeenNthCalledWith(2, STATUS_URL)
      expect(status.value).toBe('building')
      expect(samplesTotal.value).toBe(40)
      expect(mutating.value).toBe(false)
    })

    it('still fetches status but reports the build error when the POST fails', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 500 }))
      mocks.api.mockResolvedValueOnce(response({ status: 'none' }))

      const { status, mutating, error, build } = useReadingAlignment()
      await expect(build(10)).resolves.toBeUndefined()

      expect(mocks.api).toHaveBeenCalledTimes(2)
      expect(status.value).toBe('none')
      expect(mutating.value).toBe(false)
      // The recovery status refresh must not swallow the build failure, or the UI shows no error toast.
      expect(error.value).toBe('Failed to start alignment build')
    })

    it('still fetches status but reports the build error on a POST network exception', async () => {
      mocks.api.mockRejectedValueOnce(new Error('boom'))
      mocks.api.mockResolvedValueOnce(response({ status: 'none' }))

      const { mutating, error, build } = useReadingAlignment()
      await expect(build(10)).resolves.toBeUndefined()

      expect(mocks.api).toHaveBeenCalledTimes(2)
      expect(mutating.value).toBe(false)
      // The recovery status refresh clears error transiently; build must re-set it last so the toast fires.
      expect(error.value).toBe('Failed to start alignment build')
    })

    it('does not append force=true to the POST for a first-time build', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building' }))
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesDone: 0, samplesTotal: 40, anchorCount: 0, builtAt: null }))

      const { build } = useReadingAlignment()
      await build(10)

      expect(mocks.api).toHaveBeenNthCalledWith(1, BUILD_URL, { method: 'POST' })
    })

    it('appends force=true to the POST when a rebuild is requested', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building' }))
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesDone: 0, samplesTotal: 40, anchorCount: 0, builtAt: null }))

      const { build } = useReadingAlignment()
      await build(10, true)

      expect(mocks.api).toHaveBeenNthCalledWith(1, FORCE_BUILD_URL, { method: 'POST' })
    })
  })

  describe('polling', () => {
    it('starts polling every ~3s once status is building, and stops once it leaves building', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesDone: 0, samplesTotal: 4, anchorCount: 0, builtAt: null }))
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesDone: 1, samplesTotal: 4, anchorCount: 0, builtAt: null }))
      mocks.api.mockResolvedValueOnce(
        response({ status: 'ready', samplesDone: 4, samplesTotal: 4, anchorCount: 3, builtAt: '2026-02-02T00:00:00.000Z' }),
      )

      const { status, samplesDone, fetchStatus } = useReadingAlignment()
      await fetchStatus(10)
      expect(status.value).toBe('building')
      expect(mocks.api).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(3000)
      expect(mocks.api).toHaveBeenCalledTimes(2)
      expect(samplesDone.value).toBe(1)
      expect(status.value).toBe('building')

      await vi.advanceTimersByTimeAsync(3000)
      expect(mocks.api).toHaveBeenCalledTimes(3)
      expect(status.value).toBe('ready')

      // Polling must have stopped: advancing further should trigger no more requests.
      await vi.advanceTimersByTimeAsync(9000)
      expect(mocks.api).toHaveBeenCalledTimes(3)
    })

    it('does not poll when the fetched status is not building', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'ready', samplesDone: 4, samplesTotal: 4, anchorCount: 3, builtAt: null }))

      const { fetchStatus } = useReadingAlignment()
      await fetchStatus(10)

      await vi.advanceTimersByTimeAsync(9000)
      expect(mocks.api).toHaveBeenCalledTimes(1)
    })

    it('stops polling on scope dispose so no requests fire after the owner unmounts', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesDone: 0, samplesTotal: 4, anchorCount: 0, builtAt: null }))
      mocks.api.mockResolvedValue(response({ status: 'building', samplesDone: 1, samplesTotal: 4, anchorCount: 0, builtAt: null }))

      const scope = effectScope()
      await scope.run(async () => {
        const { fetchStatus } = useReadingAlignment()
        await fetchStatus(10)
      })

      expect(mocks.api).toHaveBeenCalledTimes(1)
      scope.stop()

      await vi.advanceTimersByTimeAsync(9000)
      expect(mocks.api).toHaveBeenCalledTimes(1)
    })

    it('does not recreate polling when an in-flight status response resolves after scope dispose', async () => {
      // A status request still pending when the scope disposes must not recreate the poll interval in
      // its finally block, or the interval leaks after the control has unmounted.
      let resolveApi: (r: Response) => void = () => {}
      mocks.api.mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveApi = resolve)))

      const scope = effectScope()
      let pending: Promise<void> = Promise.resolve()
      scope.run(() => {
        const { fetchStatus } = useReadingAlignment()
        pending = fetchStatus(10)
      })

      scope.stop() // dispose while the request is still in flight
      resolveApi(response({ status: 'building', samplesDone: 1, samplesTotal: 4, anchorCount: 0, builtAt: null }))
      await pending

      const callsAfterDispose = mocks.api.mock.calls.length
      await vi.advanceTimersByTimeAsync(9000)
      expect(mocks.api).toHaveBeenCalledTimes(callsAfterDispose)
    })

    it('serializes polling so a response slower than the interval is not lapped and starved', async () => {
      // Each poll waits for the previous request to settle. A fixed interval would start a new request
      // every tick while one is slow, and the request-id guard would discard them all as stale - leaving
      // a finished build stuck on 'building'. Serialized polling must instead apply the terminal read.
      let resolvePoll: (r: Response) => void = () => {}
      mocks.api.mockResolvedValueOnce(response({ status: 'building' })) // POST
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesTotal: 10, anchorCount: 0, builtAt: null })) // immediate fetch
      mocks.api.mockImplementationOnce(() => new Promise<Response>((resolve) => (resolvePoll = resolve))) // slow poll, stays pending

      const { status, build } = useReadingAlignment()
      await build(10)
      expect(mocks.api).toHaveBeenCalledTimes(2)
      expect(status.value).toBe('building')

      await vi.advanceTimersByTimeAsync(3000) // the poll fires (call 3) and stays pending
      expect(mocks.api).toHaveBeenCalledTimes(3)

      // No new request may start while the poll is in flight, even well past the interval.
      await vi.advanceTimersByTimeAsync(9000)
      expect(mocks.api).toHaveBeenCalledTimes(3)

      // When the slow poll finally settles terminal, it is applied (not discarded) and polling stops.
      resolvePoll(response({ status: 'ready', samplesTotal: 10, anchorCount: 5, builtAt: '2026-02-02T00:00:00.000Z' }))
      await vi.advanceTimersByTimeAsync(3000)
      expect(status.value).toBe('ready')
      expect(mocks.api).toHaveBeenCalledTimes(3)
    })

    it('masks the stale ready row after a rebuild until the new build is observed', async () => {
      // Rebuilding a ready alignment: the first status read after the accepted POST can still return the
      // OLD ready row before the worker flips it to building. That stale read must not stop polling.
      const T0 = '2026-01-01T00:00:00.000Z'
      mocks.api.mockResolvedValueOnce(response({ status: 'ready', anchorCount: 5, builtAt: T0 })) // initial fetch -> ready
      mocks.api.mockResolvedValueOnce(response({ status: 'building' })) // rebuild POST accepted
      mocks.api.mockResolvedValueOnce(response({ status: 'ready', anchorCount: 5, builtAt: T0 })) // stale pre-build row
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesDone: 1, samplesTotal: 10, anchorCount: 0, builtAt: T0 })) // rebuild started

      const { status, fetchStatus, build } = useReadingAlignment()
      await fetchStatus(10)
      expect(status.value).toBe('ready')

      await build(10, true)
      expect(status.value).toBe('building') // stale ready masked; optimistic building held

      await vi.advanceTimersByTimeAsync(3000)
      expect(status.value).toBe('building')
      expect(mocks.api).toHaveBeenCalledTimes(4)
    })

    it('keeps the optimistic building state and keeps polling past a stale empty read right after build()', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building' })) // POST
      mocks.api.mockResolvedValueOnce(response({ status: 'none' })) // row not created yet
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesDone: 2, samplesTotal: 10, anchorCount: 0, builtAt: null })) // row now exists

      const { status, samplesTotal, build } = useReadingAlignment()
      await build(10)

      expect(mocks.api).toHaveBeenCalledTimes(2)
      expect(status.value).toBe('building')

      await vi.advanceTimersByTimeAsync(3000)
      expect(mocks.api).toHaveBeenCalledTimes(3)
      expect(status.value).toBe('building')
      expect(samplesTotal.value).toBe(10)
    })

    it('gives up and falls back to none if the build row never appears within the bounded grace period', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building' })) // POST
      mocks.api.mockResolvedValue(response({ status: 'none' })) // row never appears

      const { status, build } = useReadingAlignment()
      await build(10)
      expect(status.value).toBe('building')

      await vi.advanceTimersByTimeAsync(3000 * 4)
      expect(status.value).toBe('none')

      const callsAtGiveUp = mocks.api.mock.calls.length
      await vi.advanceTimersByTimeAsync(9000)
      expect(mocks.api).toHaveBeenCalledTimes(callsAtGiveUp)
    })
  })

  describe('build block reasons', () => {
    it.each([
      ['disabled', 'disabled'],
      ['unavailable', 'unavailable'],
      ['busy', 'busy'],
    ] as const)('surfaces a %s block reason instead of entering the building state or polling', async (serverStatus, expected) => {
      mocks.api.mockResolvedValueOnce(response({ status: serverStatus }))

      const { status, buildBlocked, mutating, build } = useReadingAlignment()
      await build(10)

      expect(mocks.api).toHaveBeenCalledTimes(1)
      expect(status.value).not.toBe('building')
      expect(buildBlocked.value).toBe(expected)
      expect(mutating.value).toBe(false)

      await vi.advanceTimersByTimeAsync(9000)
      expect(mocks.api).toHaveBeenCalledTimes(1)
    })

    it('clears a previous block reason once a later build request is accepted', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'busy' }))
      mocks.api.mockResolvedValueOnce(response({ status: 'building' }))
      mocks.api.mockResolvedValueOnce(response({ status: 'building', samplesDone: 0, samplesTotal: 4, anchorCount: 0, builtAt: null }))

      const { buildBlocked, build } = useReadingAlignment()
      await build(10)
      expect(buildBlocked.value).toBe('busy')

      await build(10)
      expect(buildBlocked.value).toBeNull()
    })
  })
})
