import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope, type Ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import type { BookRequestItem, BookRequestProgressEvent } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useMonitoredRequestProgress, type MonitoredRequestProgressOptions } from './useMonitoredRequestProgress'

vi.mock('@/lib/api', () => ({ api: vi.fn<(path: string) => Promise<Response>>() }))

const { changeListeners, progress } = vi.hoisted(() => ({
  changeListeners: new Set<() => void>(),
  /** Filled by the mock factory, which is the first place a `ref` can actually be made. */
  progress: { ticks: null as null | Ref<Record<number, BookRequestProgressEvent>> },
}))

// Faithful stand-in for the shared socket: the same registry, and the same scope-bound removal, so
// tearing the scope down really does stop this composable hearing anything.
vi.mock('@/features/book-requests/composables/useBookRequestProgress', async () => {
  const { onScopeDispose, ref: reactiveRef } = await import('vue')
  const ticks = reactiveRef<Record<number, BookRequestProgressEvent>>({})
  progress.ticks = ticks
  return {
    useBookRequestProgress: () => ({
      progressByRequest: ticks,
      connected: reactiveRef(true),
      onRequestsChanged: (fn: () => void) => {
        changeListeners.add(fn)
        onScopeDispose(() => changeListeners.delete(fn))
      },
      pruneSettledProgress: vi.fn<() => void>(),
    }),
  }
})

/** The tick map the mocked socket writes into, once the mocked module has been loaded. */
function ticks(): Ref<Record<number, BookRequestProgressEvent>> {
  if (!progress.ticks) throw new Error('progress socket mock was never loaded')
  return progress.ticks
}

const apiMock = vi.mocked(api)

function requestPayload(overrides: Partial<BookRequestItem> = {}): BookRequestItem {
  return {
    id: 42,
    status: 'grabbed',
    download: null,
    ...overrides,
  } as BookRequestItem
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response
}

function emitChanged(): void {
  for (const listener of changeListeners) listener()
}

let scope: EffectScope | null = null

/** Runs the composable inside a scope the test owns, so disposal is a thing it can trigger. */
function run(requestId: number | null, options: MonitoredRequestProgressOptions = {}) {
  scope = effectScope()
  const result = scope.run(() => useMonitoredRequestProgress(ref(requestId), options))
  if (!result) throw new Error('scope did not run')
  return result
}

/** Answers the next refetch with a different request row, the way a status transition arrives. */
async function refetchWith(payload: BookRequestItem): Promise<void> {
  apiMock.mockResolvedValue(jsonResponse(payload))
  emitChanged()
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
}

describe('useMonitoredRequestProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    apiMock.mockReset()
    apiMock.mockResolvedValue(jsonResponse(requestPayload()))
    changeListeners.clear()
    ticks().value = {}
  })

  afterEach(() => {
    scope?.stop()
    scope = null
    vi.useRealTimers()
  })

  it('fetches the request it is given as soon as it starts', async () => {
    const { request, status, settled } = run(42)
    await flushPromises()

    expect(apiMock).toHaveBeenCalledWith('/api/v1/book-requests/42')
    expect(request.value?.id).toBe(42)
    expect(status.value).toBe('grabbed')
    expect(settled.value).toBe(false)
  })

  it('asks for nothing when there is no request to watch', async () => {
    run(null)
    await flushPromises()

    expect(apiMock).not.toHaveBeenCalled()
  })

  it('answers a burst of change broadcasts with a single refetch', async () => {
    run(42)
    await flushPromises()
    expect(apiMock).toHaveBeenCalledTimes(1)

    emitChanged()
    emitChanged()
    emitChanged()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(apiMock).toHaveBeenCalledTimes(2)
  })

  it('stops refetching once the request has settled', async () => {
    apiMock.mockResolvedValue(jsonResponse(requestPayload({ status: 'available' })))
    const { settled } = run(42)
    await flushPromises()
    expect(settled.value).toBe(true)
    expect(apiMock).toHaveBeenCalledTimes(1)

    emitChanged()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(apiMock).toHaveBeenCalledTimes(1)
  })

  it('hears nothing more once its scope is gone', async () => {
    run(42)
    await flushPromises()
    expect(apiMock).toHaveBeenCalledTimes(1)

    scope?.stop()
    scope = null
    expect(changeListeners.size).toBe(0)

    emitChanged()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(apiMock).toHaveBeenCalledTimes(1)
  })

  it('reports the filing once, when a request it watched moving reaches the library', async () => {
    const onFiled = vi.fn<(requestId: number) => void>()
    run(42, { onFiled })
    await flushPromises()
    expect(onFiled).not.toHaveBeenCalled()

    await refetchWith(requestPayload({ status: 'available' }))

    expect(onFiled).toHaveBeenCalledTimes(1)
    expect(onFiled).toHaveBeenCalledWith(42)

    // Settled, so the next broadcast is heard and ignored: no second announcement either way.
    emitChanged()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(onFiled).toHaveBeenCalledTimes(1)
  })

  it('says nothing while the request is still moving', async () => {
    const onFiled = vi.fn<(requestId: number) => void>()
    run(42, { onFiled })
    await flushPromises()

    ticks().value = { 42: { requestId: 42, downloadId: 9, status: 'downloading', progressPercent: 55 } as BookRequestProgressEvent }
    await flushPromises()
    await refetchWith(requestPayload({ status: 'downloading', download: { id: 9, status: 'downloading', progressPercent: 55 } as never }))
    await refetchWith(requestPayload({ status: 'importing', download: { id: 9, status: 'importing', progressPercent: 100 } as never }))

    expect(onFiled).not.toHaveBeenCalled()
  })

  it('says nothing for a request that was already filed when it opened', async () => {
    const onFiled = vi.fn<(requestId: number) => void>()
    apiMock.mockResolvedValue(jsonResponse(requestPayload({ status: 'available' })))
    run(42, { onFiled })
    await flushPromises()

    expect(onFiled).not.toHaveBeenCalled()
  })

  it('reports a live tick for the attempt the request is actually on', async () => {
    apiMock.mockResolvedValue(
      jsonResponse(requestPayload({ status: 'downloading', download: { id: 9, status: 'downloading', progressPercent: 10 } as never })),
    )
    const { live } = run(42)
    await flushPromises()
    expect(live.value).toBeNull()

    ticks().value = { 42: { requestId: 42, downloadId: 9, status: 'downloading', progressPercent: 55 } as BookRequestProgressEvent }
    await flushPromises()

    expect(live.value?.progressPercent).toBe(55)
  })
})
