import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import type { EditionSyncAdminSettings, EditionSyncAdminStatus, EditionSyncClearUnusedResult } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn<() => void>(),
  fetchStatus: vi.fn<() => Promise<EditionSyncAdminStatus>>(),
  fetchSettings: vi.fn<() => Promise<EditionSyncAdminSettings>>(),
  updateSettings: vi.fn<(payload: unknown) => Promise<EditionSyncAdminSettings>>(),
  start: vi.fn<() => Promise<EditionSyncAdminStatus>>(),
  stop: vi.fn<() => Promise<EditionSyncAdminStatus>>(),
  clear: vi.fn<() => Promise<EditionSyncClearUnusedResult>>(),
}))

const socket = vi.hoisted(() => ({
  listener: null as null | { changed: (event: { type: string; state: boolean }) => void; live: (live: boolean) => void },
  live: true,
  stop: vi.fn<() => void>(),
}))

vi.mock('@/features/jobs/lib/jobs-socket', () => ({
  listenToJobs: (listener: NonNullable<typeof socket.listener>) => {
    socket.listener = listener
    if (socket.live) listener.live(true)
    return () => {
      socket.listener = null
      socket.stop()
    }
  },
}))

vi.mock('../../api/edition-sync.api', () => ({
  fetchEditionSyncAdminStatus: mocks.fetchStatus,
  fetchEditionSyncAdminSettings: mocks.fetchSettings,
  updateEditionSyncAdminSettings: mocks.updateSettings,
  startEditionSyncRun: mocks.start,
  stopEditionSyncRun: mocks.stop,
  clearUnusedEditionSyncData: mocks.clear,
}))

vi.mock('../useEditionSyncSettings', () => ({ invalidateEditionSyncSettings: mocks.invalidate }))

import { JOB_TYPE_FALLBACK_POLL_MS, JOB_TYPE_REFRESH_GAP_MS } from '@/features/jobs/lib/follow-job-type'
import { useEditionSyncAdmin } from '../useEditionSyncAdmin'

function makeStatus(active: boolean): EditionSyncAdminStatus {
  return {
    worker: { configured: true, state: 'ok', version: '1', device: 'cpu', rebuildSupported: true },
    schedule: { enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run', updatedAt: null, nextRunAt: null },
    run: { active, trigger: active ? 'manual' : null, startedAt: null, windowUntil: null, current: null },
    lastRun: null,
    counts: { indexed: 1, queued: 2, failed: 0, stale: 0, unusedIndexes: 4, unusedBytes: 100 },
    backlogEstimate: { books: 2, hoursAtRecentRate: null },
  }
}

const SETTINGS: EditionSyncAdminSettings = { enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run', updatedAt: null }

async function push(state: boolean): Promise<void> {
  socket.listener?.changed({ type: 'edition-sync', state })
  await vi.advanceTimersByTimeAsync(JOB_TYPE_REFRESH_GAP_MS)
  await nextTick()
}

function setup() {
  const scope = effectScope()
  return { scope, api: scope.run(() => useEditionSyncAdmin())! }
}

describe('useEditionSyncAdmin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    socket.listener = null
    socket.live = true
    socket.stop.mockReset()
    mocks.fetchSettings.mockResolvedValue(SETTINGS)
    mocks.fetchStatus.mockResolvedValue(makeStatus(false))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts out loading so the failure alert cannot flash before the first load', async () => {
    const { scope, api } = setup()
    expect(api.loading.value).toBe(true)
    await api.load()
    expect(api.loading.value).toBe(false)
    scope.stop()
  })

  it('loads the schedule and the status together', async () => {
    const { scope, api } = setup()
    await api.load()

    expect(api.settings.value).toEqual(SETTINGS)
    expect(api.status.value?.counts.queued).toBe(2)
    scope.stop()
  })

  it('reports a load failure', async () => {
    mocks.fetchStatus.mockRejectedValue(new Error('boom'))
    const { scope, api } = setup()
    await api.load()

    expect(api.error.value).toBe('boom')
    scope.stop()
  })

  it('saves the schedule and refreshes the status', async () => {
    mocks.updateSettings.mockResolvedValue({ ...SETTINGS, cronExpression: null, runHours: 4 })
    const { scope, api } = setup()
    await api.load()

    expect(await api.saveSchedule({ cronExpression: null, runHours: 4 })).toBe(true)
    expect(mocks.invalidate).toHaveBeenCalledOnce()
    expect(mocks.updateSettings).toHaveBeenCalledWith({ cronExpression: null, runHours: 4 })
    expect(api.settings.value?.runHours).toBe(4)
    scope.stop()
  })

  it('does not follow the jobs push while no run is active', async () => {
    const { scope, api } = setup()
    await api.load()
    expect(socket.listener).toBeNull()

    await vi.advanceTimersByTimeAsync(JOB_TYPE_FALLBACK_POLL_MS * 2)
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('refreshes on state and progress pushes while a run is active, and stops following once it ends', async () => {
    mocks.fetchStatus.mockResolvedValueOnce(makeStatus(true)).mockResolvedValueOnce(makeStatus(true)).mockResolvedValue(makeStatus(false))
    const { scope, api } = setup()
    await api.load()
    expect(socket.listener).not.toBeNull()

    await push(false)
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2)

    await push(true)
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3)
    expect(api.runActive.value).toBe(false)
    expect(socket.stop).toHaveBeenCalledOnce()
    expect(socket.listener).toBeNull()

    await push(true)
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3)
    scope.stop()
  })

  it('follows after a run is started and stops after it is stopped', async () => {
    mocks.start.mockResolvedValue(makeStatus(true))
    mocks.stop.mockResolvedValue(makeStatus(false))
    const { scope, api } = setup()
    await api.load()
    expect(socket.listener).toBeNull()

    await api.runNow()
    expect(socket.listener).not.toBeNull()

    await api.stop()
    expect(socket.stop).toHaveBeenCalledOnce()
    expect(socket.listener).toBeNull()
    scope.stop()
  })

  it('stops following when its scope ends', async () => {
    mocks.fetchStatus.mockResolvedValue(makeStatus(true))
    const { scope, api } = setup()
    await api.load()
    scope.stop()
    expect(socket.stop).toHaveBeenCalledOnce()

    await push(true)
    await vi.advanceTimersByTimeAsync(JOB_TYPE_FALLBACK_POLL_MS * 2)
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1)
  })

  it('falls back to the slow poll while the jobs socket is not live', async () => {
    socket.live = false
    mocks.fetchStatus.mockResolvedValue(makeStatus(true))
    const { scope, api } = setup()
    await api.load()

    await vi.advanceTimersByTimeAsync(JOB_TYPE_FALLBACK_POLL_MS - 1)
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1 + JOB_TYPE_REFRESH_GAP_MS)
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('starts a run from the answer and surfaces a refusal', async () => {
    mocks.start.mockResolvedValueOnce(makeStatus(true)).mockRejectedValueOnce(new Error('already running'))
    const { scope, api } = setup()
    await api.load()

    expect(await api.runNow()).toBe(true)
    expect(api.status.value?.run.active).toBe(true)
    expect(await api.runNow()).toBe(false)
    expect(api.error.value).toBe('already running')
    scope.stop()
  })

  it('clears unused data and returns what was freed', async () => {
    mocks.clear.mockResolvedValue({ deleted: 4, freedBytes: 100 })
    const { scope, api } = setup()
    await api.load()

    expect(await api.clearUnused()).toEqual({ deleted: 4, freedBytes: 100 })
    scope.stop()
  })
})
