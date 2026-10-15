import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { WebSerialJobDetail, WebSerialJobList } from '@bookorbit/types'
import { job, jobItem } from './fixtures'

const api = vi.hoisted(() => ({
  fetchSerialJobs: vi.fn<(scope: string, limit: number, offset: number) => Promise<WebSerialJobList>>(),
  cancelSerialJob: vi.fn<(id: number) => Promise<unknown>>(),
  retrySerialJob: vi.fn<(id: number) => Promise<unknown>>(),
  pauseSerialJob: vi.fn<(id: number) => Promise<unknown>>(),
  resumeSerialJob: vi.fn<(id: number) => Promise<unknown>>(),
  moveSerialJobToTop: vi.fn<(id: number) => Promise<unknown>>(),
  removeSerialJob: vi.fn<(id: number) => Promise<void>>(),
  fetchSerialJobDetail: vi.fn<(id: number) => Promise<WebSerialJobDetail>>(),
  retrySerialJobItem: vi.fn<(jobId: number, itemId: number) => Promise<WebSerialJobDetail>>(),
  clearFinishedSerialJobs: vi.fn<(scope: string) => Promise<{ removed: number }>>(),
  pauseSerialQueue: vi.fn<() => Promise<{ queuePaused: boolean }>>(),
  resumeSerialQueue: vi.fn<() => Promise<{ queuePaused: boolean }>>(),
}))

vi.mock('../api/webSerials', () => api)

import { ACTIVE_POLL_MS, IDLE_POLL_MS, nextPollDelay, useWebSerialQueue } from '../composables/useWebSerialQueue'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('nextPollDelay', () => {
  it('polls fast only while a job is active and the page is visible', () => {
    expect(nextPollDelay(1, true)).toBe(ACTIVE_POLL_MS)
    expect(nextPollDelay(0, true)).toBe(IDLE_POLL_MS)
    expect(nextPollDelay(2, false)).toBe(IDLE_POLL_MS)
  })
})

describe('useWebSerialQueue', () => {
  it('loads the list and reschedules at the active cadence', async () => {
    api.fetchSerialJobs.mockResolvedValue({ items: [job()], activeCount: 1, total: [job()].length, finishedCount: 0, queuePaused: false })
    const queue = useWebSerialQueue()

    queue.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.jobs.value).toHaveLength(1)
    expect(queue.activeCount.value).toBe(1)

    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS)
    expect(api.fetchSerialJobs).toHaveBeenCalledTimes(2)
    queue.stop()
  })

  it('slows to the idle cadence once nothing is active', async () => {
    api.fetchSerialJobs.mockResolvedValue({
      items: [job({ status: 'completed' })],
      activeCount: 0,
      total: [job({ status: 'completed' })].length,
      finishedCount: 0,
      queuePaused: false,
    })
    const queue = useWebSerialQueue()

    queue.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 2)
    expect(api.fetchSerialJobs).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(api.fetchSerialJobs).toHaveBeenCalledTimes(2)
    queue.stop()
  })

  it('stops polling when stopped', async () => {
    api.fetchSerialJobs.mockResolvedValue({ items: [], activeCount: 0, total: [].length, finishedCount: 0, queuePaused: false })
    const queue = useWebSerialQueue()
    queue.start()
    await vi.advanceTimersByTimeAsync(0)
    queue.stop()
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3)
    expect(api.fetchSerialJobs).toHaveBeenCalledTimes(1)
  })

  it('keeps the last list and surfaces the error when a refresh fails', async () => {
    api.fetchSerialJobs.mockResolvedValueOnce({ items: [job()], activeCount: 1, total: [job()].length, finishedCount: 0, queuePaused: false })
    const queue = useWebSerialQueue()
    await queue.refresh()
    api.fetchSerialJobs.mockRejectedValueOnce(new Error('offline'))
    await queue.refresh()
    expect(queue.jobs.value).toHaveLength(1)
    expect(queue.error.value).toBe('offline')
  })

  it('cancels a job and refreshes the list', async () => {
    api.fetchSerialJobs.mockResolvedValue({
      items: [job({ status: 'cancelled' })],
      activeCount: 0,
      total: [job({ status: 'cancelled' })].length,
      finishedCount: 0,
      queuePaused: false,
    })
    api.cancelSerialJob.mockResolvedValue(job({ status: 'cancelled' }))
    const queue = useWebSerialQueue()

    await expect(queue.cancel(1)).resolves.toBe(true)

    expect(api.cancelSerialJob).toHaveBeenCalledWith(1)
    expect(queue.jobs.value[0]?.status).toBe('cancelled')
    expect(queue.busyIds.value.has(1)).toBe(false)
  })

  it('reports a failed retry without losing the row', async () => {
    api.fetchSerialJobs.mockResolvedValue({
      items: [job({ status: 'failed' })],
      activeCount: 0,
      total: [job({ status: 'failed' })].length,
      finishedCount: 0,
      queuePaused: false,
    })
    api.retrySerialJob.mockRejectedValue(new Error('Nothing to retry.'))
    const queue = useWebSerialQueue()
    await queue.refresh()

    await expect(queue.retry(1)).resolves.toBe(false)

    expect(queue.error.value).toBe('Nothing to retry.')
    expect(queue.jobs.value).toHaveLength(1)
  })

  it('pauses a job and refreshes', async () => {
    api.pauseSerialJob.mockResolvedValue(job({ status: 'paused' }))
    api.fetchSerialJobs.mockResolvedValue({
      items: [job({ status: 'paused' })],
      activeCount: 0,
      total: [job({ status: 'paused' })].length,
      finishedCount: 0,
      queuePaused: false,
    })
    const queue = useWebSerialQueue()

    await expect(queue.act('pause', 1)).resolves.toBe(true)

    expect(api.pauseSerialJob).toHaveBeenCalledWith(1)
    expect(queue.jobs.value[0]?.status).toBe('paused')
  })

  it('removes a finished job', async () => {
    api.removeSerialJob.mockResolvedValue()
    api.fetchSerialJobs.mockResolvedValue({ items: [], activeCount: 0, total: [].length, finishedCount: 0, queuePaused: false })
    const queue = useWebSerialQueue()

    await expect(queue.act('remove', 1)).resolves.toBe(true)

    expect(api.removeSerialJob).toHaveBeenCalledWith(1)
    expect(queue.jobs.value).toHaveLength(0)
  })

  it('requests the chosen scope and drops expanded state when it changes', async () => {
    api.fetchSerialJobs.mockResolvedValue({ items: [job()], activeCount: 1, total: [job()].length, finishedCount: 0, queuePaused: false })
    api.fetchSerialJobDetail.mockResolvedValue({ job: job(), items: [jobItem()] })
    const queue = useWebSerialQueue()
    await queue.refresh()
    await queue.toggleExpanded(1)

    await queue.setScope('all')

    expect(api.fetchSerialJobs).toHaveBeenLastCalledWith('all', 50, 0)
    expect(queue.expandedIds.value.size).toBe(0)
  })

  it('loads details on expand and refreshes them with the poll while active', async () => {
    api.fetchSerialJobs.mockResolvedValue({ items: [job()], activeCount: 1, total: [job()].length, finishedCount: 0, queuePaused: false })
    api.fetchSerialJobDetail.mockResolvedValue({ job: job(), items: [jobItem()] })
    const queue = useWebSerialQueue()
    await queue.refresh()

    await queue.toggleExpanded(1)
    expect(api.fetchSerialJobDetail).toHaveBeenCalledTimes(1)
    expect(queue.details.value[1]?.items).toHaveLength(1)

    await queue.refresh()
    expect(api.fetchSerialJobDetail).toHaveBeenCalledTimes(1)

    api.fetchSerialJobs.mockResolvedValue({
      items: [job({ unitsDone: 4 })],
      activeCount: 1,
      total: [job({ unitsDone: 4 })].length,
      finishedCount: 0,
      queuePaused: false,
    })
    await queue.refresh()
    expect(api.fetchSerialJobDetail).toHaveBeenCalledTimes(2)

    await queue.toggleExpanded(1)
    api.fetchSerialJobs.mockResolvedValue({
      items: [job({ unitsDone: 5 })],
      activeCount: 1,
      total: [job({ unitsDone: 5 })].length,
      finishedCount: 0,
      queuePaused: false,
    })
    await queue.refresh()
    expect(api.fetchSerialJobDetail).toHaveBeenCalledTimes(2)
  })

  it('does not drop a refresh requested while a poll is in flight', async () => {
    let release: (value: WebSerialJobList) => void = () => undefined
    api.fetchSerialJobs.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    api.fetchSerialJobs.mockResolvedValue({ items: [], activeCount: 0, total: [].length, finishedCount: 0, queuePaused: false })
    const queue = useWebSerialQueue()
    const poll = queue.refresh()
    const afterAction = queue.refresh()
    release({ items: [job({ id: 8 })], activeCount: 0, total: [job({ id: 8 })].length, finishedCount: 0, queuePaused: false })
    await Promise.all([poll, afterAction])
    expect(api.fetchSerialJobs).toHaveBeenCalledTimes(2)
    expect(queue.jobs.value).toHaveLength(0)
  })

  it('ignores a response for a scope that was switched away from', async () => {
    let release: (value: WebSerialJobList) => void = () => undefined
    api.fetchSerialJobs.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    api.fetchSerialJobs.mockResolvedValue({
      items: [job({ id: 2, owner: { id: 3, name: 'Sam' } })],
      activeCount: 0,
      total: [job({ id: 2, owner: { id: 3, name: 'Sam' } })].length,
      finishedCount: 0,
      queuePaused: false,
    })
    const queue = useWebSerialQueue()
    const poll = queue.refresh()
    const switched = queue.setScope('all')
    release({ items: [job({ id: 1 })], activeCount: 0, total: [job({ id: 1 })].length, finishedCount: 0, queuePaused: false })
    await Promise.all([poll, switched])
    expect(queue.jobs.value.map((entry) => entry.id)).toEqual([2])
  })

  it('pages beyond the first 50 jobs and keeps them on later polls', async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => job({ id: from + index, status: 'completed' }))
    api.fetchSerialJobs.mockImplementation(async (_scope, _limit, offset) => ({
      items: offset === 0 ? page(1, 50) : page(51, 10),
      activeCount: 0,
      total: 60,
      finishedCount: 60,
      queuePaused: false,
    }))
    const queue = useWebSerialQueue()
    await queue.refresh()
    expect(queue.hasMore.value).toBe(true)
    expect(queue.finishedCount.value).toBe(60)
    expect(queue.jobs.value).toHaveLength(50)

    await queue.loadMore()
    expect(queue.jobs.value).toHaveLength(60)
    expect(queue.hasMore.value).toBe(false)
    expect(api.fetchSerialJobs).toHaveBeenLastCalledWith('mine', 50, 50)

    await queue.refresh()
    expect(queue.jobs.value).toHaveLength(60)
  })

  it('offers Show more from the server total even when a page is not full', async () => {
    api.fetchSerialJobs.mockResolvedValue({ items: [job({ id: 1 })], activeCount: 0, total: 90, finishedCount: 0, queuePaused: false })
    const queue = useWebSerialQueue()
    await queue.refresh()
    expect(queue.hasMore.value).toBe(true)
  })

  it('does not poll the details of a finished job', async () => {
    api.fetchSerialJobs.mockResolvedValue({
      items: [job({ status: 'failed' })],
      activeCount: 0,
      total: [job({ status: 'failed' })].length,
      finishedCount: 0,
      queuePaused: false,
    })
    api.fetchSerialJobDetail.mockResolvedValue({ job: job({ status: 'failed' }), items: [jobItem({ status: 'failed' })] })
    const queue = useWebSerialQueue()
    await queue.refresh()
    await queue.toggleExpanded(1)
    await queue.refresh()
    expect(api.fetchSerialJobDetail).toHaveBeenCalledTimes(1)
  })

  it('retries one item and shows the updated list', async () => {
    api.fetchSerialJobs.mockResolvedValue({
      items: [job({ status: 'queued' })],
      activeCount: 1,
      total: [job({ status: 'queued' })].length,
      finishedCount: 0,
      queuePaused: false,
    })
    api.fetchSerialJobDetail.mockResolvedValue({ job: job({ status: 'failed' }), items: [jobItem({ id: 5, status: 'failed' })] })
    api.retrySerialJobItem.mockImplementation(async () => {
      api.fetchSerialJobDetail.mockResolvedValue({ job: job({ status: 'queued' }), items: [jobItem({ id: 5, status: 'pending' })] })
      return { job: job({ status: 'queued' }), items: [jobItem({ id: 5, status: 'pending' })] }
    })
    const queue = useWebSerialQueue()
    await queue.refresh()
    await queue.toggleExpanded(1)

    await expect(queue.retryItem(1, 5)).resolves.toBe(true)

    expect(api.retrySerialJobItem).toHaveBeenCalledWith(1, 5)
    expect(queue.details.value[1]?.items[0]?.status).toBe('pending')
    expect(queue.details.value[1]?.retryingItemIds.size).toBe(0)
  })

  it('clears finished jobs for the current scope and returns the count', async () => {
    api.clearFinishedSerialJobs.mockResolvedValue({ removed: 4 })
    api.fetchSerialJobs.mockResolvedValue({ items: [], activeCount: 0, total: [].length, finishedCount: 0, queuePaused: false })
    const queue = useWebSerialQueue()

    await expect(queue.clearFinished()).resolves.toBe(4)
    expect(api.clearFinishedSerialJobs).toHaveBeenCalledWith('mine')
  })

  it('toggles the instance-wide pause', async () => {
    api.pauseSerialQueue.mockResolvedValue({ queuePaused: true })
    api.fetchSerialJobs.mockResolvedValue({ items: [], activeCount: 0, total: 0, finishedCount: 0, queuePaused: true })
    const queue = useWebSerialQueue()

    await queue.setQueuePaused(true)

    expect(queue.queuePaused.value).toBe(true)
    expect(api.pauseSerialQueue).toHaveBeenCalled()
  })

  it('refetches the items of an expanded job when it finishes', async () => {
    const running = job({ id: 1, status: 'running', unitsDone: 0, unitsTotal: 1 })
    const done = job({ id: 1, status: 'completed', unitsDone: 1, unitsTotal: 1 })
    api.fetchSerialJobs.mockResolvedValueOnce({ items: [running], activeCount: 1, total: 1, finishedCount: 0, queuePaused: false })
    api.fetchSerialJobDetail.mockResolvedValueOnce({ job: running, items: [jobItem({ id: 9, status: 'fetching' })] })
    const queue = useWebSerialQueue()
    queue.start()
    await vi.advanceTimersByTimeAsync(0)
    await queue.toggleExpanded(1)
    api.fetchSerialJobs.mockResolvedValue({ items: [done], activeCount: 0, total: 1, finishedCount: 1, queuePaused: false })
    api.fetchSerialJobDetail.mockResolvedValue({ job: done, items: [jobItem({ id: 9, status: 'imported' })] })
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS)
    expect(queue.details.value[1]?.items[0]?.status).toBe('imported')
    queue.stop()
  })

  it('does not refetch an expanded job while the list is hidden, and catches up when it is shown again', async () => {
    const running = job({ id: 1, status: 'running', unitsDone: 0, unitsTotal: 2 })
    const further = job({ id: 1, status: 'running', unitsDone: 1, unitsTotal: 2 })
    api.fetchSerialJobs.mockResolvedValue({ items: [running], activeCount: 1, total: 1, finishedCount: 0, queuePaused: false })
    api.fetchSerialJobDetail.mockResolvedValue({ job: running, items: [jobItem()] })
    const shown = ref(true)
    const queue = useWebSerialQueue(shown)
    await queue.refresh()
    await queue.toggleExpanded(1)
    expect(api.fetchSerialJobDetail).toHaveBeenCalledTimes(1)

    shown.value = false
    api.fetchSerialJobs.mockResolvedValue({ items: [further], activeCount: 1, total: 1, finishedCount: 0, queuePaused: false })
    await queue.refresh()
    expect(api.fetchSerialJobDetail).toHaveBeenCalledTimes(1)

    shown.value = true
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchSerialJobDetail).toHaveBeenCalledTimes(2)
  })

  it('does not refetch the items when only the current chapter changes', async () => {
    const at = (label: string) =>
      job({ id: 1, status: 'running', current: { label, stage: 'downloading', chaptersDone: null, chaptersTotal: null, progress: null } as never })
    api.fetchSerialJobs.mockResolvedValue({ items: [at('Ch. 1')], activeCount: 1, total: 1, finishedCount: 0, queuePaused: false })
    api.fetchSerialJobDetail.mockResolvedValue({ job: at('Ch. 1'), items: [jobItem()] })
    const queue = useWebSerialQueue()
    await queue.refresh()
    await queue.toggleExpanded(1)
    api.fetchSerialJobs.mockResolvedValue({ items: [at('Ch. 2')], activeCount: 1, total: 1, finishedCount: 0, queuePaused: false })
    await queue.refresh()
    expect(api.fetchSerialJobDetail).toHaveBeenCalledTimes(1)
  })

  it('polls only the first page once more pages are loaded, keeping the loaded tail', async () => {
    const page = (n: number) => Array.from({ length: 50 }, (_, i) => job({ id: n * 50 + i + 1, status: 'running' }))
    api.fetchSerialJobs.mockImplementation(async (_s, _l, offset) => ({
      items: page(offset / 50),
      activeCount: 1,
      total: 150,
      finishedCount: 0,
      queuePaused: false,
    }))
    const queue = useWebSerialQueue()
    queue.start()
    await vi.advanceTimersByTimeAsync(0)
    await queue.loadMore()
    await queue.loadMore()
    expect(queue.jobs.value).toHaveLength(150)
    api.fetchSerialJobs.mockClear()
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS)
    expect(api.fetchSerialJobs).toHaveBeenCalledTimes(1)
    expect(api.fetchSerialJobs).toHaveBeenCalledWith('mine', 50, 0)
    expect(queue.jobs.value).toHaveLength(150)
    expect(queue.hasMore.value).toBe(false)
    queue.stop()
  })
})
