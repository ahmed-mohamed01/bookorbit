import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MonitoredWorkSearchItem, MonitoredWorkSearchPage } from '@bookorbit/types'
import { searchMonitoredWorks } from '../api/monitored'
import { useMonitoredWorkSearch } from './useMonitoredWorkSearch'

vi.mock('../api/monitored', () => ({ searchMonitoredWorks: vi.fn<typeof searchMonitoredWorks>() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const item = (id: string) => ({ work: { id } }) as MonitoredWorkSearchItem
const result = (...ids: string[]): MonitoredWorkSearchPage => ({ items: ids.map(item), total: 100, page: 0, size: 50 })
beforeEach(() => vi.clearAllMocks())
describe('useMonitoredWorkSearch', () => {
  it('ignores stale responses', async () => {
    let resolve!: (page: MonitoredWorkSearchPage) => void
    vi.mocked(searchMonitoredWorks)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      )
      .mockResolvedValueOnce(result('new'))
    const state = useMonitoredWorkSearch()
    const old = state.load('older', true)
    await state.load('newer', true)
    resolve(result('old'))
    await old
    expect(state.items.value[0]?.work.id).toBe('new')
  })
  it('keeps items during a reset and appends pages without duplicates', async () => {
    vi.mocked(searchMonitoredWorks)
      .mockResolvedValueOnce(result('one'))
      .mockResolvedValueOnce(result('one', 'two'))
      .mockResolvedValueOnce(result('three'))
    const state = useMonitoredWorkSearch()
    await state.load('query', true)
    await state.load('query')
    expect(state.items.value.map((entry) => entry.work.id)).toEqual(['one', 'two'])
    expect(searchMonitoredWorks).toHaveBeenLastCalledWith({ q: 'query', page: 1, size: 50 })
    const pending = state.load('query', true)
    expect(state.items.value).toHaveLength(2)
    await pending
    expect(state.items.value[0]?.work.id).toBe('three')
  })
  it('sets errors and never sends short queries', async () => {
    const state = useMonitoredWorkSearch()
    await state.load('ab', true)
    expect(searchMonitoredWorks).not.toHaveBeenCalled()
    vi.mocked(searchMonitoredWorks).mockRejectedValueOnce(new Error('failed'))
    await state.load('query', true)
    expect(state.error.value).toBeTruthy()
    expect(state.loading.value).toBe(false)
  })
  it('clears a different query during debounce and clears a failed same-query reset', async () => {
    const state = useMonitoredWorkSearch()
    vi.mocked(searchMonitoredWorks).mockResolvedValue(result('old'))
    await state.load('query', true)
    state.invalidate('other')
    expect(state.items.value).toEqual([])
    expect(state.total.value).toBe(0)
    expect(state.page.value).toBe(0)
    await state.load('other', true)
    vi.mocked(searchMonitoredWorks).mockRejectedValueOnce(new Error('failed'))
    await state.load('other', true)
    expect(state.items.value).toEqual([])
    expect(state.total.value).toBe(0)
  })
  it('bounds retained pages, preserves updates across appends and removes hidden works', async () => {
    const state = useMonitoredWorkSearch()
    vi.mocked(searchMonitoredWorks).mockImplementation(async ({ page = 0 }) => ({
      items: Array.from({ length: 50 }, (_, i) => item(String(page * 50 + i))),
      total: 10000,
      page,
      size: 50,
    }))
    await state.load('query', true)
    for (let i = 1; i < 31; i++) await state.load('query')
    expect(state.items.value).toHaveLength(1500)
    expect(state.droppedOffset.value).toBe(50)
    state.applyWorkUpdate({ ...state.items.value.find((entry) => entry.work.id === '100')!.work, title: 'Updated' })
    state.removeWork('50')
    expect(state.total.value).toBe(9999)
    await state.load('query')
    expect(state.items.value.some((entry) => entry.work.id === '50')).toBe(false)
    expect(state.items.value.find((entry) => entry.work.id === '100')?.work.title).toBe('Updated')
    await state.load('query', true)
    expect(state.droppedOffset.value).toBe(0)
    expect(searchMonitoredWorks).toHaveBeenLastCalledWith({ q: 'query', page: 0, size: 50 })
  })
  it('counts Unicode code points for the minimum', async () => {
    await useMonitoredWorkSearch().load('😀a', true)
    expect(searchMonitoredWorks).not.toHaveBeenCalled()
  })
  it('clears cards immediately when loading a different query directly', async () => {
    const state = useMonitoredWorkSearch()
    vi.mocked(searchMonitoredWorks).mockResolvedValue(result('old'))
    await state.load('query', true)
    const pending = state.load('other', true)
    expect(state.items.value).toEqual([])
    expect(state.total.value).toBe(0)
    expect(state.page.value).toBe(0)
    await pending
  })
})
