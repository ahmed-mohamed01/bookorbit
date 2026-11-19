import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const socket = vi.hoisted(() => ({
  listener: null as null | { changed: (event: { type: string; state: boolean }) => void; live: (live: boolean) => void },
  connected: true,
  stop: vi.fn<() => void>(),
}))

vi.mock('../jobs-socket', () => ({
  listenToJobs: (listener: NonNullable<typeof socket.listener>) => {
    socket.listener = listener
    if (socket.connected) listener.live(true)
    return socket.stop
  },
}))

import { JOB_TYPE_FALLBACK_POLL_MS, JOB_TYPE_REFRESH_GAP_MS, followJobType } from '../follow-job-type'

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  socket.listener = null
  socket.connected = true
  setVisibility('visible')
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('followJobType', () => {
  it('keeps the Jobs area cadence', () => {
    expect(JOB_TYPE_REFRESH_GAP_MS).toBe(2_000)
    expect(JOB_TYPE_FALLBACK_POLL_MS).toBe(15_000)
  })

  it('refreshes on a status change of its own type, at most once a gap', async () => {
    const refresh = vi.fn<() => unknown>()
    const stop = followJobType('web-serial', refresh)

    socket.listener?.changed({ type: 'web-serial', state: true })
    socket.listener?.changed({ type: 'web-serial', state: true })
    socket.listener?.changed({ type: 'audio-convert', state: true })
    await vi.advanceTimersByTimeAsync(JOB_TYPE_REFRESH_GAP_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
  })

  it('follows progress only while the caller says a job runs', async () => {
    const refresh = vi.fn<() => unknown>()
    let running = false
    const stop = followJobType('audio-convert', refresh, () => running)

    socket.listener?.changed({ type: 'audio-convert', state: false })
    await vi.advanceTimersByTimeAsync(JOB_TYPE_REFRESH_GAP_MS)
    expect(refresh).not.toHaveBeenCalled()

    running = true
    socket.listener?.changed({ type: 'audio-convert', state: false })
    await vi.advanceTimersByTimeAsync(JOB_TYPE_REFRESH_GAP_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
  })

  it('polls slowly while the socket is down, catches up when it connects, then stops polling', async () => {
    socket.connected = false
    const refresh = vi.fn<() => unknown>()
    const stop = followJobType('web-serial', refresh)

    await vi.advanceTimersByTimeAsync(JOB_TYPE_FALLBACK_POLL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(1)

    socket.listener?.live(true)
    await vi.advanceTimersByTimeAsync(JOB_TYPE_REFRESH_GAP_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(JOB_TYPE_FALLBACK_POLL_MS * 3)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
  })

  it('holds a push while the tab is hidden and refreshes once it is shown', async () => {
    const refresh = vi.fn<() => unknown>()
    const stop = followJobType('web-serial', refresh)
    setVisibility('hidden')

    socket.listener?.changed({ type: 'web-serial', state: true })
    await vi.advanceTimersByTimeAsync(JOB_TYPE_REFRESH_GAP_MS * 2)
    expect(refresh).not.toHaveBeenCalled()

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(JOB_TYPE_REFRESH_GAP_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stops listening and drops a pending refresh when stopped', async () => {
    const refresh = vi.fn<() => unknown>()
    const stop = followJobType('web-serial', refresh)
    socket.listener?.changed({ type: 'web-serial', state: true })
    stop()

    await vi.advanceTimersByTimeAsync(JOB_TYPE_FALLBACK_POLL_MS * 2)
    expect(refresh).not.toHaveBeenCalled()
    expect(socket.stop).toHaveBeenCalledTimes(1)
  })
})
