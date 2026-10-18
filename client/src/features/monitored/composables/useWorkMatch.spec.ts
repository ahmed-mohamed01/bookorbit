import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { toast } from 'vue-sonner'
import type { MonitoredWork } from '@bookorbit/types'
import { setMonitoredWorkMatch } from '../api/monitored'
import { MonitoredApiError } from '../lib/api-error'
import { useWorkMatch } from './useWorkMatch'

vi.mock('vue-sonner', () => ({ toast: { error: vi.fn<(message: string) => void>(), success: vi.fn<(message: string) => void>() } }))
vi.mock('../api/monitored', () => ({
  setMonitoredWorkMatch: vi.fn<() => Promise<MonitoredWork>>(),
}))

const matchMock = vi.mocked(setMonitoredWorkMatch)
const toastErrorMock = vi.mocked(toast.error)
const work = { id: 'work-1' } as MonitoredWork

function mountComposable(workId = ref<string | null>('work-1')) {
  let composable!: ReturnType<typeof useWorkMatch>
  mount(
    defineComponent({
      setup() {
        composable = useWorkMatch(workId)
        return () => null
      },
    }),
  )
  return composable
}

describe('useWorkMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends the answer and hands back the rematched work', async () => {
    matchMock.mockResolvedValue(work)
    const { answer } = mountComposable()

    await expect(answer('ebook', { decision: 'reject', bookId: 31 })).resolves.toBe(work)
    expect(matchMock).toHaveBeenCalledWith('work-1', 'ebook', { decision: 'reject', bookId: 31 })
  })

  it('sends a late answer to the work it was given for, even after the panel moved on', async () => {
    matchMock.mockResolvedValue(work)
    const workId = ref<string | null>('work-2')
    const { answer } = mountComposable(workId)

    await answer('ebook', { decision: 'automatic' }, 'work-1')

    expect(matchMock).toHaveBeenCalledWith('work-1', 'ebook', { decision: 'automatic' })
  })

  it('reports a failed answer in a toast and resolves to null', async () => {
    matchMock.mockRejectedValue(new MonitoredApiError(404, 'Library book not found'))
    const { answer, isSaving } = mountComposable()

    await expect(answer('audiobook', { decision: 'link', bookId: 9 })).resolves.toBeNull()
    expect(toastErrorMock).toHaveBeenCalledWith('Library book not found')
    expect(isSaving('audiobook')).toBe(false)
  })
})
