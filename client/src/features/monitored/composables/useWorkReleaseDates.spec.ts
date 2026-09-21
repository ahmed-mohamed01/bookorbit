import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { toast } from 'vue-sonner'
import type { MonitoredReleaseDateLookup, MonitoredWork } from '@bookorbit/types'
import { fetchWorkReleaseDateCandidates, refreshWorkReleaseDates, setWorkReleaseDate } from '../api/monitored'
import { MonitoredApiError } from '../lib/api-error'
import { useWorkReleaseDates } from './useWorkReleaseDates'

vi.mock('vue-sonner', () => ({ toast: { error: vi.fn<(message: string) => void>(), success: vi.fn<(message: string) => void>() } }))
vi.mock('../api/monitored', () => ({
  fetchWorkReleaseDateCandidates: vi.fn<() => Promise<MonitoredReleaseDateLookup>>(),
  setWorkReleaseDate: vi.fn<() => Promise<MonitoredWork>>(),
  refreshWorkReleaseDates: vi.fn<() => Promise<MonitoredWork>>(),
}))

const candidatesMock = vi.mocked(fetchWorkReleaseDateCandidates)
const setDateMock = vi.mocked(setWorkReleaseDate)
const refreshMock = vi.mocked(refreshWorkReleaseDates)
const toastErrorMock = vi.mocked(toast.error)

const work = { id: 'work-1' } as MonitoredWork

function lookup(overrides: Partial<MonitoredReleaseDateLookup> = {}): MonitoredReleaseDateLookup {
  return { format: 'ebook', candidates: [], unavailable: [], empty: [], ...overrides }
}

function mountComposable(workId = ref<string | null>('work-1')) {
  let composable!: ReturnType<typeof useWorkReleaseDates>
  const wrapper = mount(
    defineComponent({
      setup() {
        composable = useWorkReleaseDates(workId)
        return () => null
      },
    }),
  )
  return { composable, wrapper, workId }
}

describe('useWorkReleaseDates candidates', () => {
  beforeEach(() => {
    candidatesMock.mockReset()
    setDateMock.mockReset()
    refreshMock.mockReset()
    toastErrorMock.mockReset()
  })

  it('keeps each format lookup to itself', async () => {
    candidatesMock.mockResolvedValueOnce(
      lookup({ candidates: [{ source: 'apple', releaseDate: '2026-07-15', precision: 'day', label: null, weak: false, url: null }] }),
    )
    const { composable, wrapper } = mountComposable()

    await composable.loadCandidates('ebook')

    expect(candidatesMock).toHaveBeenCalledWith('work-1', 'ebook')
    expect(composable.stateFor('ebook').candidates).toHaveLength(1)
    expect(composable.stateFor('ebook').loaded).toBe(true)
    expect(composable.stateFor('audiobook').loaded).toBe(false)
    wrapper.unmount()
  })

  it('keeps the providers it could not ask, so an empty list still explains itself', async () => {
    candidatesMock.mockResolvedValueOnce(lookup({ unavailable: [{ source: 'audible', reason: 'not_configured' }] }))
    const { composable, wrapper } = mountComposable()

    await composable.loadCandidates('audiobook')

    expect(composable.stateFor('audiobook').unavailable).toEqual([{ source: 'audible', reason: 'not_configured' }])
    wrapper.unmount()
  })

  it('keeps the providers that were asked and found nothing, so the owner sees who was checked', async () => {
    candidatesMock.mockResolvedValueOnce(lookup({ empty: ['audible', 'librofm'] }))
    const { composable, wrapper } = mountComposable()

    await composable.loadCandidates('audiobook')

    expect(composable.stateFor('audiobook').empty).toEqual(['audible', 'librofm'])
    wrapper.unmount()
  })

  it('names the switched-off check in the viewer language instead of echoing the server sentence', async () => {
    candidatesMock.mockRejectedValueOnce(new MonitoredApiError(409, 'The release date probe is turned off'))
    const { composable, wrapper } = mountComposable()

    await composable.loadCandidates('ebook')

    expect(composable.stateFor('ebook').error).toBe('Release date checking is switched off in settings')
    wrapper.unmount()
  })

  it('reports a failed lookup in the format that asked for it', async () => {
    candidatesMock.mockRejectedValueOnce(new MonitoredApiError(503, 'Provider is down'))
    const { composable, wrapper } = mountComposable()

    await composable.loadCandidates('ebook')

    expect(composable.stateFor('ebook').error).toBe('Provider is down')
    expect(composable.stateFor('ebook').loading).toBe(false)
    wrapper.unmount()
  })

  it('drops an answer that lands after the panel moved to another book', async () => {
    let settle: (value: MonitoredReleaseDateLookup) => void = () => {}
    candidatesMock.mockImplementation(() => new Promise<MonitoredReleaseDateLookup>((resolve) => (settle = resolve)))
    const { composable, wrapper, workId } = mountComposable()

    const pending = composable.loadCandidates('ebook')
    workId.value = 'work-2'
    await nextTick()
    settle(lookup({ candidates: [{ source: 'apple', releaseDate: '2026-07-15', precision: 'day', label: null, weak: false, url: null }] }))
    await pending

    expect(composable.stateFor('ebook').candidates).toHaveLength(0)
    expect(composable.stateFor('ebook').loaded).toBe(false)
    wrapper.unmount()
  })
})

describe('useWorkReleaseDates set and clear', () => {
  beforeEach(() => {
    candidatesMock.mockReset()
    setDateMock.mockReset()
    refreshMock.mockReset()
    toastErrorMock.mockReset()
  })

  it('answers with the fresh work when a date is saved', async () => {
    setDateMock.mockResolvedValueOnce(work)
    const { composable, wrapper } = mountComposable()

    await expect(composable.setDate('ebook', '2026-11-03')).resolves.toBe(work)
    expect(setDateMock).toHaveBeenCalledWith('work-1', 'ebook', '2026-11-03')
    expect(composable.stateFor('ebook').saving).toBe(false)
    wrapper.unmount()
  })

  it('clears the owner date with a null payload', async () => {
    setDateMock.mockResolvedValueOnce(work)
    const { composable, wrapper } = mountComposable()

    await composable.setDate('audiobook', null)

    expect(setDateMock).toHaveBeenCalledWith('work-1', 'audiobook', null)
    wrapper.unmount()
  })

  it('reports a failed save in the popover that asked for it rather than a toast', async () => {
    setDateMock.mockRejectedValueOnce(new MonitoredApiError(400, null))
    const { composable, wrapper } = mountComposable()

    await expect(composable.setDate('ebook', '2026-11-03')).resolves.toBeNull()
    expect(composable.stateFor('ebook').error).toBe('Could not save that date.')
    expect(toastErrorMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('says the check is switched off when a save is refused for that reason', async () => {
    setDateMock.mockRejectedValueOnce(new MonitoredApiError(409, 'The release date probe is turned off'))
    const { composable, wrapper } = mountComposable()

    expect(await composable.setDate('ebook', '2026-11-03')).toBeNull()

    expect(composable.stateFor('ebook').error).toBe('Release date checking is switched off in settings')
    wrapper.unmount()
  })

  it('names clearing rather than saving when a clear fails', async () => {
    setDateMock.mockRejectedValueOnce(new MonitoredApiError(500, null))
    const { composable, wrapper } = mountComposable()

    await composable.setDate('ebook', null)

    expect(composable.stateFor('ebook').error).toBe('Could not clear your date.')
    wrapper.unmount()
  })

  it('ignores a second save while the first is still in flight', async () => {
    let settle = () => {}
    setDateMock.mockImplementation(() => new Promise<MonitoredWork>((resolve) => (settle = () => resolve(work))))
    const { composable, wrapper } = mountComposable()

    const first = composable.setDate('ebook', '2026-11-03')
    await expect(composable.setDate('ebook', '2026-11-04')).resolves.toBeNull()
    settle()
    await first

    expect(setDateMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('useWorkReleaseDates refresh', () => {
  beforeEach(() => {
    candidatesMock.mockReset()
    setDateMock.mockReset()
    refreshMock.mockReset()
    toastErrorMock.mockReset()
  })

  it('answers with the fresh work', async () => {
    refreshMock.mockResolvedValueOnce(work)
    const { composable, wrapper } = mountComposable()

    await expect(composable.refresh()).resolves.toBe(work)
    expect(refreshMock).toHaveBeenCalledWith('work-1')
    expect(composable.refreshing.value).toBe(false)
    wrapper.unmount()
  })

  it('asks the owner to wait when the check was only just run', async () => {
    refreshMock.mockRejectedValueOnce(new MonitoredApiError(429, null))
    const { composable, wrapper } = mountComposable()

    await expect(composable.refresh()).resolves.toBeNull()
    expect(toastErrorMock).toHaveBeenCalledWith('Just checked, try again in a moment')
    wrapper.unmount()
  })

  it('says when release checking is switched off in settings', async () => {
    refreshMock.mockRejectedValueOnce(new MonitoredApiError(409, null))
    const { composable, wrapper } = mountComposable()

    await composable.refresh()

    expect(toastErrorMock).toHaveBeenCalledWith('Release date checking is switched off in settings')
    wrapper.unmount()
  })

  it('falls back to the server message on any other failure', async () => {
    refreshMock.mockRejectedValueOnce(new MonitoredApiError(500, 'Hardcover is not configured'))
    const { composable, wrapper } = mountComposable()

    await composable.refresh()

    expect(toastErrorMock).toHaveBeenCalledWith('Hardcover is not configured')
    wrapper.unmount()
  })

  it('does nothing without a work to check', async () => {
    const { composable, wrapper } = mountComposable(ref<string | null>(null))

    await expect(composable.refresh()).resolves.toBeNull()
    expect(refreshMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
