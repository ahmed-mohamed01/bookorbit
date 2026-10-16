import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import type {
  MonitoredBulkUpdatePayload,
  MonitoredBulkUpdateResponse,
  MonitoredBulkWorkPatch,
  MonitoredWork,
  RequestSourceOption,
} from '@bookorbit/types'
import { workFixture } from '../testing/work-fixture'
import { useMonitoredBulkSelection } from './useMonitoredBulkSelection'

const api = vi.hoisted(() => ({
  fetchRequestSources: vi.fn<() => Promise<RequestSourceOption[]>>(),
  bulkUpdateMonitoredWorks: vi.fn<(payload: MonitoredBulkUpdatePayload) => Promise<MonitoredBulkUpdateResponse>>(),
}))

vi.mock('../api/monitored', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/monitored')>()),
  fetchRequestSources: api.fetchRequestSources,
  bulkUpdateMonitoredWorks: api.bulkUpdateMonitoredWorks,
}))

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  },
}))

function setup(works: MonitoredWork[], onPatched?: (workIds: string[], patch: MonitoredBulkWorkPatch) => void) {
  const worksRef = ref(works)
  const applyWork = vi.fn<(work: MonitoredWork) => void>()
  let selection!: ReturnType<typeof useMonitoredBulkSelection>
  mount(
    defineComponent({
      setup() {
        selection = useMonitoredBulkSelection({ works: worksRef, applyWork, onPatched })
        return () => null
      },
    }),
  )
  return selection
}

describe('useMonitoredBulkSelection.startSelectingWith', () => {
  beforeEach(() => {
    api.fetchRequestSources.mockResolvedValue([])
  })

  it('enters select mode with the work picked and never unpicks it', () => {
    const selection = setup([workFixture({ id: 'a' }), workFixture({ id: 'b' })])
    expect(selection.selectionMode.value).toBe(false)

    selection.startSelectingWith(workFixture({ id: 'a' }))

    expect(selection.selectionMode.value).toBe(true)
    expect([...selection.selectedIds.value]).toEqual(['a'])

    selection.startSelectingWith(workFixture({ id: 'a' }))
    expect([...selection.selectedIds.value]).toEqual(['a'])

    selection.startSelectingWith(workFixture({ id: 'b' }))
    expect([...selection.selectedIds.value].sort()).toEqual(['a', 'b'])
  })

  it('seeds the shift-range anchor, so the next shift-click sweeps from the long-pressed work', () => {
    const selection = setup([workFixture({ id: 'a' }), workFixture({ id: 'b' }), workFixture({ id: 'c' })])

    selection.startSelectingWith(workFixture({ id: 'a' }))
    selection.handleSelectWork(workFixture({ id: 'c' }), { shiftKey: true } as MouseEvent)

    expect([...selection.selectedIds.value].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('useMonitoredBulkSelection.updateSelected', () => {
  beforeEach(() => {
    api.fetchRequestSources.mockResolvedValue([])
    api.bulkUpdateMonitoredWorks.mockReset()
  })

  it('forwards only the confirmed ids and the patch to onPatched', async () => {
    api.bulkUpdateMonitoredWorks.mockResolvedValue({
      works: [workFixture({ id: 'a' })],
      failed: [{ workId: 'b', reason: 'forbidden' }],
    })
    const onPatched = vi.fn<(workIds: string[], patch: MonitoredBulkWorkPatch) => void>()
    const selection = setup([workFixture({ id: 'a' }), workFixture({ id: 'b' })], onPatched)
    selection.startSelectingWith(workFixture({ id: 'a' }))
    selection.startSelectingWith(workFixture({ id: 'b' }))

    await selection.updateSelected({ hidden: true })

    expect(onPatched).toHaveBeenCalledExactlyOnceWith(['a'], { hidden: true })
    // A failed work stays picked, so the owner can retry it.
    expect([...selection.selectedIds.value]).toEqual(['b'])
  })

  it('keeps onPatched silent when the server confirmed no work', async () => {
    api.bulkUpdateMonitoredWorks.mockResolvedValue({ works: [], failed: [{ workId: 'a', reason: 'forbidden' }] })
    const onPatched = vi.fn<(workIds: string[], patch: MonitoredBulkWorkPatch) => void>()
    const selection = setup([workFixture({ id: 'a' })], onPatched)
    selection.startSelectingWith(workFixture({ id: 'a' }))

    await selection.updateSelected({ hidden: true })

    expect(onPatched).not.toHaveBeenCalled()
  })
})
