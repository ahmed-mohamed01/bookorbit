import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { WebSerialErrorCode } from '@bookorbit/types'
import type { WebSerialSeriesDetail } from '@bookorbit/types'
import { WebSerialApiError } from '../api/http'
import { useWebSerialSeriesSwitch } from '../composables/useWebSerialSeriesSwitch'

const api = vi.hoisted(() => ({ fetchSeries: vi.fn<(...args: unknown[]) => Promise<unknown>>() }))

vi.mock('../api/webSerials', () => api)
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const detail = (seriesKey: string) => ({ seriesKey, title: seriesKey }) as unknown as WebSerialSeriesDetail

function setup(opened: WebSerialSeriesDetail | null = detail('m:1'), matchId?: string) {
  const openedRef = ref<WebSerialSeriesDetail | null>(opened)
  const state = effectScope().run(() => useWebSerialSeriesSwitch(openedRef, matchId ? ref(matchId) : undefined))!
  return { openedRef, ...state }
}

beforeEach(() => {
  api.fetchSeries.mockReset()
})

describe('useWebSerialSeriesSwitch', () => {
  it('shows the opened series until another source is picked, then keeps the credits and swaps', async () => {
    const { shown, select } = setup()
    api.fetchSeries.mockResolvedValue(detail('m:2'))
    const beforeApply = vi.fn<() => void>()

    await select('m:2', beforeApply)

    expect(beforeApply).toHaveBeenCalledOnce()
    expect(shown.value?.seriesKey).toBe('m:2')
  })

  it('ignores the pick of the series already shown', async () => {
    const { select } = setup()
    const beforeApply = vi.fn<() => void>()

    await select('m:1', beforeApply)

    expect(api.fetchSeries).not.toHaveBeenCalled()
    expect(beforeApply).not.toHaveBeenCalled()
  })

  it('reports a failed switch and remounts the list so the radio returns to the shown card', async () => {
    const { shown, switchError, renderKey, switching, select } = setup()
    api.fetchSeries.mockRejectedValue(new Error('Source is down'))

    await select('m:2', vi.fn<() => void>())

    expect(switchError.value).toBe('Source is down')
    expect(renderKey.value).toBe(1)
    expect(switching.value).toBe(false)
    expect(shown.value?.seriesKey).toBe('m:1')
  })

  it('drops a switch that finishes after a new series was opened', async () => {
    const { openedRef, shown, select } = setup()
    let finish: (value: unknown) => void = () => undefined
    api.fetchSeries.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const pending = select('m:2', vi.fn<() => void>())

    openedRef.value = detail('m:9')
    await Promise.resolve()
    finish(detail('m:2'))
    await pending

    expect(shown.value?.seriesKey).toBe('m:9')
  })
  it('passes the series-database id along when the sheet was opened from a search result', async () => {
    const { select } = setup(detail('m:1'), '1995')
    api.fetchSeries.mockResolvedValue(detail('m:2'))

    await select('m:2', vi.fn<() => void>())

    expect(api.fetchSeries).toHaveBeenCalledWith('m:2', '1995', expect.any(AbortSignal))
  })
})

describe('useWebSerialSeriesSwitch with a long chapter list', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the site while it waits, asks again, and stops when cancelled', async () => {
    vi.useFakeTimers()
    api.fetchSeries.mockRejectedValue(new WebSerialApiError('loading', 503, WebSerialErrorCode.SeriesLoading, null, { retryAfterMs: 5000 }))
    const state = setup()
    const switching = state.select('m:2', vi.fn<() => void>(), 'Royal Road')
    await vi.waitFor(() => expect(state.pendingSource.value).toBe('Royal Road'))

    await vi.advanceTimersByTimeAsync(5000)
    expect(api.fetchSeries).toHaveBeenCalledTimes(2)

    state.cancel()
    await switching
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchSeries).toHaveBeenCalledTimes(2)
    expect(state.switching.value).toBe(false)
    expect(state.pendingSource.value).toBeNull()
    expect(state.switchError.value).toBeNull()
  })
})
