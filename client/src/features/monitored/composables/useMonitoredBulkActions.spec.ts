import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { toast } from 'vue-sonner'
import type {
  MonitoredBulkRequestPayload,
  MonitoredBulkRequestResponse,
  MonitoredBulkUpdatePayload,
  MonitoredBulkUpdateResponse,
  MonitoredBulkWorkPatch,
  MonitoredWork,
} from '@bookorbit/types'
import { MonitoredApiError } from '../lib/api-error'
import { workFixture } from '../testing/work-fixture'
import { useMonitoredBulkActions } from './useMonitoredBulkActions'

const api = vi.hoisted(() => ({
  bulkRequestMonitoredWorks: vi.fn<(payload: MonitoredBulkRequestPayload) => Promise<MonitoredBulkRequestResponse>>(),
  bulkUpdateMonitoredWorks: vi.fn<(payload: MonitoredBulkUpdatePayload) => Promise<MonitoredBulkUpdateResponse>>(),
}))

vi.mock('../api/monitored', () => api)
vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  },
}))

function setup() {
  const applyWork = vi.fn<(work: MonitoredWork) => void>()
  const onChanged = vi.fn<() => void>()
  const onPatched = vi.fn<(workIds: string[], patch: MonitoredBulkWorkPatch) => void>()
  let actions!: ReturnType<typeof useMonitoredBulkActions>
  mount(
    defineComponent({
      setup() {
        actions = useMonitoredBulkActions({ applyWork, onChanged, onPatched })
        return () => null
      },
    }),
  )
  return { actions, applyWork, onChanged, onPatched }
}

function manyWorks(count: number): MonitoredWork[] {
  return Array.from({ length: count }, (_, index) => workFixture({ id: `w${index}` }))
}

function requestedFor(payload: MonitoredBulkRequestPayload): MonitoredBulkRequestResponse {
  return {
    results: payload.workIds.map((workId) => ({ workId, format: 'ebook' as const, outcome: 'requested' as const, requestId: 1 })),
    works: payload.workIds.map((id) => workFixture({ id })),
  }
}

describe('useMonitoredBulkActions.requestSelected', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends sequential chunks of at most 100 works and applies every returned work', async () => {
    api.bulkRequestMonitoredWorks.mockImplementation((payload) => Promise.resolve(requestedFor(payload)))
    const { actions, applyWork, onChanged } = setup()

    const outcome = await actions.requestSelected(manyWorks(250), 'ebook', true)

    expect(api.bulkRequestMonitoredWorks.mock.calls.map(([payload]) => payload.workIds.length)).toEqual([100, 100, 50])
    expect(api.bulkRequestMonitoredWorks.mock.calls[0]?.[0]).toMatchObject({ format: 'ebook', autoDownload: true })
    expect(outcome.requested).toBe(250)
    expect(outcome.failed).toBe(0)
    expect(applyWork).toHaveBeenCalledTimes(250)
    expect(onChanged).toHaveBeenCalledOnce()
    expect(toast.success).toHaveBeenCalledOnce()
  })

  it('passes the chosen sources into every chunk and leaves the key out without them', async () => {
    api.bulkRequestMonitoredWorks.mockImplementation((payload) => Promise.resolve(requestedFor(payload)))
    const { actions } = setup()

    await actions.requestSelected(manyWorks(150), 'both', true, { ebook: [1, 2], audiobook: null })
    await actions.requestSelected(manyWorks(1), 'ebook', true)

    expect(api.bulkRequestMonitoredWorks.mock.calls[0]?.[0].sources).toEqual({ ebook: [1, 2], audiobook: null })
    expect(api.bulkRequestMonitoredWorks.mock.calls[1]?.[0].sources).toEqual({ ebook: [1, 2], audiobook: null })
    expect(api.bulkRequestMonitoredWorks.mock.calls[2]?.[0]).not.toHaveProperty('sources')
  })

  it('does not send works every chosen format of which is skipped', async () => {
    api.bulkRequestMonitoredWorks.mockImplementation((payload) => Promise.resolve(requestedFor(payload)))
    const { actions } = setup()
    const owned = workFixture({ id: 'owned', ownedFormats: ['ebook'] })
    const open = workFixture({ id: 'open' })

    const outcome = await actions.requestSelected([owned, open], 'ebook', true)

    expect(api.bulkRequestMonitoredWorks.mock.calls[0]?.[0].workIds).toEqual(['open'])
    expect(outcome.skipped.owned).toBe(1)
  })

  it('sends nothing when every work is skipped', async () => {
    const { actions } = setup()

    const outcome = await actions.requestSelected([workFixture({ ownedFormats: ['ebook'] })], 'ebook', true)

    expect(api.bulkRequestMonitoredWorks).not.toHaveBeenCalled()
    expect(outcome.requested).toBe(0)
    expect(outcome.skipped.owned).toBe(1)
  })

  it('counts a failed chunk and the works never reached as failed, and stops', async () => {
    api.bulkRequestMonitoredWorks
      .mockImplementationOnce((payload) => Promise.resolve(requestedFor(payload)))
      .mockRejectedValueOnce(new MonitoredApiError(500, 'boom'))
    const { actions } = setup()

    const outcome = await actions.requestSelected(manyWorks(250), 'ebook', false)

    expect(api.bulkRequestMonitoredWorks).toHaveBeenCalledTimes(2)
    expect(outcome.requested).toBe(100)
    expect(outcome.failed).toBe(150)
    expect(outcome.failedWorkIds).toHaveLength(150)
    expect(outcome.failedWorkIds).toContain('w100')
    expect(outcome.failedWorkIds).not.toContain('w0')
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('keeps works the server failed to file as failed', async () => {
    api.bulkRequestMonitoredWorks.mockResolvedValue({
      results: [
        { workId: 'a', format: 'ebook', outcome: 'requested', requestId: 1 },
        { workId: 'b', format: 'ebook', outcome: 'failed', reason: 'destination', message: 'no destination' },
        { workId: 'c', format: 'ebook', outcome: 'skipped', reason: 'requested' },
      ],
      works: [workFixture({ id: 'a' })],
    })
    const { actions } = setup()

    const outcome = await actions.requestSelected([workFixture({ id: 'a' }), workFixture({ id: 'b' }), workFixture({ id: 'c' })], 'ebook', true)

    expect(outcome.failedWorkIds).toEqual(['b'])
    expect(outcome.skipped.requested).toBe(1)
    expect(toast.error).toHaveBeenCalledOnce()
  })
})

describe('useMonitoredBulkActions.updateSelected', () => {
  beforeEach(() => vi.clearAllMocks())

  it('patches in chunks and reports works the server refused', async () => {
    api.bulkUpdateMonitoredWorks
      .mockImplementationOnce((payload) => Promise.resolve({ works: payload.workIds.map((id) => workFixture({ id })), failed: [] }))
      .mockResolvedValueOnce({ works: [], failed: [{ workId: 'w100', reason: 'forbidden' }] })
    const { actions, applyWork } = setup()

    const outcome = await actions.updateSelected(manyWorks(101), { hidden: true })

    expect(api.bulkUpdateMonitoredWorks.mock.calls.map(([payload]) => payload.workIds.length)).toEqual([100, 1])
    expect(applyWork).toHaveBeenCalledTimes(100)
    expect(outcome.failedWorkIds).toEqual(['w100'])
  })

  it('stops after an HTTP error and marks the rest failed', async () => {
    api.bulkUpdateMonitoredWorks.mockRejectedValue(new MonitoredApiError(500, null))
    const { actions } = setup()

    const outcome = await actions.updateSelected(manyWorks(150), { monitorEbook: true })

    expect(api.bulkUpdateMonitoredWorks).toHaveBeenCalledTimes(1)
    expect(outcome.failed).toBe(150)
  })

  it('names only the updated works and the patch through onPatched', async () => {
    api.bulkUpdateMonitoredWorks
      .mockImplementationOnce((payload) => Promise.resolve({ works: payload.workIds.map((id) => workFixture({ id })), failed: [] }))
      .mockResolvedValueOnce({ works: [], failed: [{ workId: 'w100', reason: 'forbidden' }] })
    const { actions, onPatched } = setup()

    await actions.updateSelected(manyWorks(101), { hidden: true })

    expect(onPatched).toHaveBeenCalledExactlyOnceWith(
      Array.from({ length: 100 }, (_, index) => `w${index}`),
      { hidden: true },
    )
  })

  it('does not call onPatched when no work came back updated', async () => {
    api.bulkUpdateMonitoredWorks.mockResolvedValue({ works: [], failed: [{ workId: 'w0', reason: 'forbidden' }] })
    const { actions, onPatched } = setup()

    await actions.updateSelected(manyWorks(1), { hidden: true })

    expect(onPatched).not.toHaveBeenCalled()
  })
})
