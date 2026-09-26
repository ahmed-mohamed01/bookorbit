import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import type { ReadAlongOutputBook, ReadAlongStatusResponse } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  api: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))

vi.mock('@/lib/api', () => ({
  api: mocks.api,
}))

import { useReadAlong } from '../useReadAlong'

function response(data: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  const { ok = true, status = ok ? 200 : 500 } = options
  return {
    ok,
    status,
    json: async () => data,
  } as Response
}

function statusResponse(overrides: Partial<ReadAlongStatusResponse> = {}): ReadAlongStatusResponse {
  return {
    status: 'none',
    blocked: null,
    phase: null,
    transport: null,
    remoteTask: null,
    remoteProgress: null,
    outputBook: null,
    targetLibraryId: null,
    targetLibraryName: null,
    remoteCopyBytes: { epub: null, audio: null, readAlong: null },
    keepRemoteCopyByDefault: true,
    remoteCopyReclaimable: true,
    error: null,
    startedAt: null,
    builtAt: null,
    ...overrides,
  }
}

describe('useReadAlong', () => {
  beforeEach(() => {
    mocks.api.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('fetchStatus', () => {
    it('applies a ready status, including the output book and the target library', async () => {
      mocks.api.mockResolvedValueOnce(
        response(
          statusResponse({
            status: 'ready',
            transport: 'shared-paths',
            outputBook: { id: 30, title: 'Dune (read-along)' },
            targetLibraryId: 4,
            targetLibraryName: 'Readalouds',
          }),
        ),
      )

      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)

      expect(mocks.api).toHaveBeenCalledExactlyOnceWith('/api/v1/storyteller/read-along/books/10/status')
      expect(readAlong.status.value).toBe('ready')
      expect(readAlong.outputBook.value).toEqual({ id: 30, title: 'Dune (read-along)' })
      expect(readAlong.targetLibraryId.value).toBe(4)
      expect(readAlong.targetLibraryName.value).toBe('Readalouds')
      expect(readAlong.transport.value).toBe('shared-paths')
      expect(readAlong.error.value).toBeNull()
    })

    it('keeps the failure message of a failed build and surfaces the block reason of a blocked one', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'failed', phase: 'wait', error: 'provider timeout' })))
      const failed = useReadAlong()
      await failed.fetchStatus(10)
      expect(failed.status.value).toBe('failed')
      expect(failed.phase.value).toBe('wait')
      expect(failed.error.value).toBe('provider timeout')

      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'none', blocked: 'not_configured' })))
      const blocked = useReadAlong()
      await blocked.fetchStatus(10)
      expect(blocked.blocked.value).toBe('not_configured')
      expect(blocked.error.value).toBeNull()
    })

    it('normalizes unknown enum values and clamps the remote progress', async () => {
      mocks.api.mockResolvedValueOnce(
        response({ ...statusResponse({ status: 'building', remoteProgress: 1.4 }), status: 'weird', phase: 'nonsense', transport: 'carrier-pigeon' }),
      )

      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)

      expect(readAlong.status.value).toBe('none')
      expect(readAlong.phase.value).toBeNull()
      expect(readAlong.transport.value).toBeNull()
      expect(readAlong.remoteProgress.value).toBe(1)
    })

    it('clamps a negative remote progress and drops a non-numeric one', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'ready', remoteProgress: -0.5 })))
      const negative = useReadAlong()
      await negative.fetchStatus(10)
      expect(negative.remoteProgress.value).toBe(0)

      mocks.api.mockResolvedValueOnce(response({ ...statusResponse({ status: 'ready' }), remoteProgress: 'half' }))
      const nonsense = useReadAlong()
      await nonsense.fetchStatus(10)
      expect(nonsense.remoteProgress.value).toBeNull()
    })

    it('degrades to an unknown state on a failed request without throwing', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 500 }))

      const readAlong = useReadAlong()
      await expect(readAlong.fetchStatus(10)).resolves.toBeUndefined()

      expect(readAlong.status.value).toBe('none')
      expect(readAlong.error.value).toBe('Failed to load read-along status')
    })

    it('adopts the instance default for keeping the Storyteller copy rather than assuming "keep"', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ keepRemoteCopyByDefault: false })))

      const readAlong = useReadAlong()
      expect(readAlong.keepRemoteCopy.value).toBe(false)
      await readAlong.fetchStatus(10)
      expect(readAlong.keepRemoteCopy.value).toBe(false)

      mocks.api.mockResolvedValueOnce(response(statusResponse({ keepRemoteCopyByDefault: true })))
      const keeping = useReadAlong()
      await keeping.fetchStatus(10)
      expect(keeping.keepRemoteCopy.value).toBe(true)
    })

    it('lets the user choice outlive later polls that still carry the instance default', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ keepRemoteCopyByDefault: false })))
      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)
      expect(readAlong.keepRemoteCopy.value).toBe(false)

      readAlong.setKeepRemoteCopy(true)

      mocks.api.mockResolvedValueOnce(response(statusResponse({ keepRemoteCopyByDefault: false })))
      await readAlong.fetchStatus(10)
      expect(readAlong.keepRemoteCopy.value).toBe(true)
    })
  })

  describe('status polling resilience', () => {
    it('holds the build row and keeps polling through a single failed read', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building', phase: 'wait' })))
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 502 }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building', phase: 'collect' })))

      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)

      await vi.advanceTimersByTimeAsync(5000)
      expect(readAlong.status.value).toBe('building')
      expect(readAlong.phase.value).toBe('wait')
      expect(readAlong.error.value).toBeNull()

      // The timer has to survive the failure, or the build view never recovers.
      await vi.advanceTimersByTimeAsync(5000)
      expect(readAlong.status.value).toBe('building')
      expect(readAlong.phase.value).toBe('collect')
    })

    it('resets the failure budget once a read succeeds again', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building' })))
      for (let i = 0; i < 4; i += 1) mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 502 }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building' })))
      for (let i = 0; i < 4; i += 1) mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 502 }))

      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)

      await vi.advanceTimersByTimeAsync(45000)
      expect(readAlong.status.value).toBe('building')
    })

    it('gives up on the build view only after several reads in a row have failed', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building' })))
      mocks.api.mockResolvedValue(response(null, { ok: false, status: 502 }))

      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)

      await vi.advanceTimersByTimeAsync(20000)
      expect(readAlong.status.value).toBe('building')

      await vi.advanceTimersByTimeAsync(5000)
      expect(readAlong.status.value).toBe('none')
      expect(readAlong.error.value).toBe('Failed to load read-along status')
    })

    it('does not wait on a failure when nothing is building', async () => {
      mocks.api.mockRejectedValueOnce(new Error('network down'))

      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)

      expect(readAlong.status.value).toBe('none')
      expect(readAlong.error.value).toBe('Failed to load read-along status')
    })

    it('keeps a finished read-along through a single failed status read', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'ready', outputBook: { id: 30, title: 'Read-along' } })))
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 502 }))

      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)
      expect(readAlong.status.value).toBe('ready')

      // A reopened popover re-reads status even though nothing is polling a ready row, and one bad
      // read from that must not replace the finished row with "Generate read-along".
      await readAlong.fetchStatus(10)
      expect(readAlong.status.value).toBe('ready')
      expect(readAlong.outputBook.value).toEqual({ id: 30, title: 'Read-along' })
    })

    it('still clears a finished read-along once enough status reads have failed in a row', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'ready', outputBook: { id: 30, title: 'Read-along' } })))
      mocks.api.mockResolvedValue(response(null, { ok: false, status: 502 }))

      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)
      expect(readAlong.status.value).toBe('ready')

      for (let i = 0; i < 5; i += 1) await readAlong.fetchStatus(10)

      expect(readAlong.status.value).toBe('none')
      expect(readAlong.error.value).toBe('Failed to load read-along status')
    })
  })

  describe('build', () => {
    it('posts the request body, shows building optimistically and polls every 5s until ready', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building', phase: 'register' })))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building', phase: 'wait', remoteTask: 'transcribe', remoteProgress: 0.5 })))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'ready', outputBook: { id: 30, title: 'Read-along' } })))

      const readAlong = useReadAlong()
      const ready = vi.fn<(book: ReadAlongOutputBook | null) => void>()
      readAlong.onReady(ready)

      await readAlong.build(10, { targetLibraryId: 4 })

      expect(mocks.api).toHaveBeenNthCalledWith(1, '/api/v1/storyteller/read-along/books/10/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLibraryId: 4 }),
      })
      expect(readAlong.status.value).toBe('building')
      expect(readAlong.phase.value).toBe('register')
      expect(readAlong.mutating.value).toBe(false)

      await vi.advanceTimersByTimeAsync(5000)
      expect(readAlong.remoteTask.value).toBe('transcribe')
      expect(readAlong.remoteProgress.value).toBe(0.5)

      await vi.advanceTimersByTimeAsync(5000)
      expect(readAlong.status.value).toBe('ready')
      expect(ready).toHaveBeenCalledExactlyOnceWith({ id: 30, title: 'Read-along' })

      // Terminal status stops the loop: no further reads once the build is done.
      await vi.advanceTimersByTimeAsync(20000)
      expect(mocks.api).toHaveBeenCalledTimes(4)
    })

    it('holds the optimistic building state through a stale read of the row that does not exist yet', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'none' })))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building', phase: 'prepare' })))

      const readAlong = useReadAlong()
      await readAlong.build(10)

      expect(readAlong.status.value).toBe('building')

      await vi.advanceTimersByTimeAsync(5000)
      expect(readAlong.status.value).toBe('building')
      expect(readAlong.phase.value).toBe('prepare')
    })

    it('adopts a terminal status from the build response instead of spinning on a job that never started', async () => {
      // The server answers an unforced build of an already-ready pair with 'ready' and no block: it
      // starts nothing, so there is no build row to wait for.
      const ready = statusResponse({ status: 'ready', outputBook: { id: 30, title: 'Read-along' }, builtAt: '2026-09-20T10:00:00.000Z' })
      mocks.api.mockResolvedValueOnce(response(ready))
      mocks.api.mockResolvedValueOnce(response({ status: 'ready', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(ready))

      const readAlong = useReadAlong()
      const onReady = vi.fn<(book: ReadAlongOutputBook | null) => void>()
      readAlong.onReady(onReady)
      await readAlong.fetchStatus(10)

      await readAlong.build(10)

      expect(readAlong.status.value).toBe('ready')
      expect(readAlong.outputBook.value).toEqual({ id: 30, title: 'Read-along' })
      expect(onReady).toHaveBeenCalledExactlyOnceWith({ id: 30, title: 'Read-along' })

      await vi.advanceTimersByTimeAsync(30000)
      expect(mocks.api).toHaveBeenCalledTimes(3)
    })

    it('reports every terminal outcome to its caller, so none of them can be applied in silence', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building' })))
      const started = useReadAlong()
      await expect(started.build(10)).resolves.toBe('started')

      mocks.api.mockReset()
      mocks.api.mockResolvedValueOnce(response({ status: 'ready', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'ready', outputBook: { id: 30, title: 'Read-along' } })))
      const alreadyReady = useReadAlong()
      await expect(alreadyReady.build(10)).resolves.toBe('ready')

      mocks.api.mockReset()
      mocks.api.mockResolvedValueOnce(response({ status: 'none', blocked: 'busy' }))
      const refused = useReadAlong()
      await expect(refused.build(10)).resolves.toBe('blocked')

      mocks.api.mockReset()
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 403 }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'none' })))
      const failed = useReadAlong()
      await expect(failed.build(10)).resolves.toBe('failed')
    })

    it('sends cleanUpRemote only once the user has chosen, so an untouched build follows the instance setting', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building' })))
      const untouched = useReadAlong()
      await untouched.build(10)
      expect(mocks.api).toHaveBeenNthCalledWith(1, '/api/v1/storyteller/read-along/books/10/build', expect.objectContaining({ body: '{}' }))

      mocks.api.mockReset()
      mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building' })))
      const chosen = useReadAlong()
      chosen.setKeepRemoteCopy(false)
      await chosen.build(10, { force: true })
      expect(mocks.api).toHaveBeenNthCalledWith(
        1,
        '/api/v1/storyteller/read-along/books/10/build',
        expect.objectContaining({ body: '{"force":true,"cleanUpRemote":true}' }),
      )

      mocks.api.mockReset()
      mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building' })))
      const keeping = useReadAlong()
      keeping.setKeepRemoteCopy(true)
      await keeping.build(10)
      expect(mocks.api).toHaveBeenNthCalledWith(
        1,
        '/api/v1/storyteller/read-along/books/10/build',
        expect.objectContaining({ body: '{"cleanUpRemote":false}' }),
      )
    })

    it('watches a build it was refused a share of, instead of spinning on a row nothing updates', async () => {
      // Two people press Generate: the first claims the pair, the second is answered 'busy' over the
      // build that is now running. The second row shows the spinning building layout, and neither
      // host starts a timer of its own, so the refusal has to keep the row alive itself.
      mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: 'busy' }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building', phase: 'wait' })))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'ready', outputBook: { id: 30, title: 'Read-along' } })))

      const readAlong = useReadAlong()
      await expect(readAlong.build(10)).resolves.toBe('blocked')
      expect(readAlong.status.value).toBe('building')
      expect(readAlong.blocked.value).toBe('busy')
      expect(mocks.api).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(5000)
      expect(readAlong.phase.value).toBe('wait')

      await vi.advanceTimersByTimeAsync(5000)
      expect(readAlong.status.value).toBe('ready')
    })

    it('leaves no timer behind for a refusal that started nothing', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'none', blocked: 'no_epub' }))

      const readAlong = useReadAlong()
      await readAlong.build(10)

      await vi.advanceTimersByTimeAsync(30000)
      expect(mocks.api).toHaveBeenCalledOnce()
    })

    it('records the block reason instead of starting a build', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'none', blocked: 'busy' }))

      const readAlong = useReadAlong()
      await readAlong.build(10)

      expect(mocks.api).toHaveBeenCalledOnce()
      expect(readAlong.blocked.value).toBe('busy')
      expect(readAlong.status.value).toBe('none')
    })

    it('keeps the ready row and records the reason when a rebuild is refused', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'ready', blocked: 'previous_output_not_deletable' }))

      const readAlong = useReadAlong()
      await readAlong.build(10, { force: true })

      expect(readAlong.status.value).toBe('ready')
      expect(readAlong.blocked.value).toBe('previous_output_not_deletable')
      expect(mocks.api).toHaveBeenCalledOnce()
    })

    it('sets a build error and refreshes the real status when the request fails', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 403 }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'none' })))

      const readAlong = useReadAlong()
      await expect(readAlong.build(10)).resolves.toBe('failed')

      expect(readAlong.status.value).toBe('none')
      expect(readAlong.error.value).toBe('Failed to start the read-along build')
      expect(readAlong.mutating.value).toBe(false)
    })

    it('omits absent options from the request body so the DTO never rejects an extra field', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building' })))

      const readAlong = useReadAlong()
      await readAlong.build(10, { force: true })

      expect(mocks.api).toHaveBeenNthCalledWith(
        1,
        '/api/v1/storyteller/read-along/books/10/build',
        expect.objectContaining({ body: '{"force":true}' }),
      )
    })
  })

  describe('cancel', () => {
    it('sends DELETE to the build route and reads the status again once the server accepts', async () => {
      mocks.api.mockResolvedValueOnce(response({}))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'none' })))
      const readAlong = useReadAlong()

      const cancelled = await readAlong.cancel(10)

      expect(cancelled).toBe(true)
      expect(mocks.api).toHaveBeenNthCalledWith(1, '/api/v1/storyteller/read-along/books/10/build', { method: 'DELETE' })
      expect(mocks.api).toHaveBeenNthCalledWith(2, '/api/v1/storyteller/read-along/books/10/status')
      expect(readAlong.mutating.value).toBe(false)
    })

    it('reports a server without the cancel route as not cancelled, and leaves the status alone', async () => {
      mocks.api.mockResolvedValueOnce(response({}, { ok: false, status: 404 }))
      const readAlong = useReadAlong()

      const cancelled = await readAlong.cancel(10)

      expect(cancelled).toBe(false)
      expect(mocks.api).toHaveBeenCalledTimes(1)
      expect(readAlong.mutating.value).toBe(false)
    })

    it('applies the status after a cancel instead of holding a build that was still awaiting its row', async () => {
      mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: null }))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'none' })))
      const readAlong = useReadAlong()
      await readAlong.build(10)
      expect(readAlong.status.value).toBe('building')

      mocks.api.mockResolvedValueOnce(response({}))
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'none' })))
      expect(await readAlong.cancel(10)).toBe(true)

      expect(readAlong.status.value).toBe('none')
      await vi.advanceTimersByTimeAsync(20000)
      expect(mocks.api).toHaveBeenCalledTimes(4)
    })

    it('reports a network failure as not cancelled', async () => {
      mocks.api.mockRejectedValueOnce(new Error('offline'))
      const readAlong = useReadAlong()

      expect(await readAlong.cancel(10)).toBe(false)
    })
  })

  describe('reset', () => {
    it('forgets the previous pair, including its matches and target library', async () => {
      mocks.api.mockResolvedValueOnce(
        response(
          statusResponse({
            status: 'ready',
            blocked: 'previous_output_not_deletable',
            outputBook: { id: 30, title: 'Dune (read-along)' },
            targetLibraryId: 4,
            targetLibraryName: 'Readalouds',
          }),
        ),
      )
      mocks.api.mockResolvedValueOnce(response({ matches: [{ uuid: 'uuid-1', title: 'Dune', authors: [], aligned: true, score: 90 }] }))
      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)
      await readAlong.fetchExisting(10)

      readAlong.reset()

      expect(readAlong.status.value).toBe('none')
      expect(readAlong.blocked.value).toBeNull()
      expect(readAlong.outputBook.value).toBeNull()
      expect(readAlong.targetLibraryId.value).toBeNull()
      expect(readAlong.targetLibraryName.value).toBeNull()
      expect(readAlong.existingMatches.value).toEqual([])
      expect(readAlong.error.value).toBeNull()
    })

    it('stops polling and drops a read that was in flight for the previous pair', async () => {
      let resolveLate!: (value: Response) => void
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building', phase: 'wait' })))
      mocks.api.mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveLate = resolve)))
      const readAlong = useReadAlong()
      await readAlong.fetchStatus(10)
      await vi.advanceTimersByTimeAsync(5000)
      expect(mocks.api).toHaveBeenCalledTimes(2)

      readAlong.reset()
      resolveLate(response(statusResponse({ status: 'ready', outputBook: { id: 30, title: 'Dune (read-along)' } })))
      await vi.advanceTimersByTimeAsync(20000)

      expect(readAlong.status.value).toBe('none')
      expect(readAlong.phase.value).toBeNull()
      expect(readAlong.outputBook.value).toBeNull()
      expect(mocks.api).toHaveBeenCalledTimes(2)
    })
  })

  describe('onReady', () => {
    it('does not fire for a read-along that was already ready when the page opened', async () => {
      mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'ready', outputBook: { id: 30, title: 'Read-along' } })))

      const readAlong = useReadAlong()
      const ready = vi.fn<(book: ReadAlongOutputBook | null) => void>()
      readAlong.onReady(ready)
      await readAlong.fetchStatus(10)

      expect(readAlong.status.value).toBe('ready')
      expect(ready).not.toHaveBeenCalled()
    })
  })

  describe('fetchExisting', () => {
    it('loads the Storyteller matches', async () => {
      const matches = [{ uuid: 'uuid-1', title: 'Forward the Foundation', authors: ['Isaac Asimov'], aligned: true, score: 94 }]
      mocks.api.mockResolvedValueOnce(response({ matches }))

      const readAlong = useReadAlong()
      await readAlong.fetchExisting(10)

      expect(mocks.api).toHaveBeenCalledExactlyOnceWith('/api/v1/storyteller/read-along/books/10/existing')
      expect(readAlong.existingMatches.value).toEqual(matches)
    })

    it('empties the list on failure and leaves the build error alone', async () => {
      mocks.api.mockRejectedValueOnce(new Error('network down'))

      const readAlong = useReadAlong()
      await expect(readAlong.fetchExisting(10)).resolves.toBeUndefined()

      expect(readAlong.existingMatches.value).toEqual([])
      expect(readAlong.error.value).toBeNull()
    })
  })

  describe('polling lifecycle', () => {
    it('stops polling when the owning scope disposes', async () => {
      mocks.api.mockResolvedValue(response(statusResponse({ status: 'building' })))

      const scope = effectScope()
      await scope.run(async () => {
        const readAlong = useReadAlong()
        await readAlong.fetchStatus(10)
      })
      expect(mocks.api).toHaveBeenCalledOnce()

      scope.stop()
      await vi.advanceTimersByTimeAsync(20000)

      expect(mocks.api).toHaveBeenCalledOnce()
    })
  })

  it('shows the server default again once a choice is dropped, and sends no choice for the next build', async () => {
    const readAlong = useReadAlong()
    mocks.api.mockResolvedValueOnce(response(statusResponse({ keepRemoteCopyByDefault: false })))
    await readAlong.fetchStatus(10)
    readAlong.setKeepRemoteCopy(true)

    readAlong.resetKeepRemoteCopy()
    expect(readAlong.keepRemoteCopy.value).toBe(false)

    mocks.api.mockResolvedValueOnce(response({ status: 'building', blocked: null }))
    mocks.api.mockResolvedValueOnce(response(statusResponse({ status: 'building' })))
    await readAlong.build(10)
    expect(mocks.api).toHaveBeenNthCalledWith(2, '/api/v1/storyteller/read-along/books/10/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  })

  // One control instance can be reused for a different book, and the per-book choice must not ride
  // along: a "keep" chosen for one pair would otherwise silently apply to the next.
  it('forgets a keep-copy choice when the status moves to another book', async () => {
    const readAlong = useReadAlong()
    mocks.api.mockResolvedValue(response(statusResponse({ keepRemoteCopyByDefault: false })))

    await readAlong.fetchStatus(10)
    readAlong.setKeepRemoteCopy(true)
    expect(readAlong.keepRemoteCopy.value).toBe(true)

    await readAlong.fetchStatus(11)

    expect(readAlong.keepRemoteCopy.value).toBe(false)
  })
})
