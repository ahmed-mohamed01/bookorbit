import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import type { BookProgressChangedEvent } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({ callbacks: new Set<(event: BookProgressChangedEvent) => void>() }))
vi.mock('./useBookEvents', () => ({
  useBookEvents: () => ({
    onBookProgressChanged: (callback: (event: BookProgressChangedEvent) => void) => {
      mocks.callbacks.add(callback)
      return () => mocks.callbacks.delete(callback)
    },
  }),
}))
import { PROGRESS_REFRESH_MIN_INTERVAL_MS, useBookProgressRefresh } from './useBookProgressRefresh'

const scopes: ReturnType<typeof effectScope>[] = []
const event = { bookId: 1 } as BookProgressChangedEvent
function subscribe(callback: (event: BookProgressChangedEvent) => void) {
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => useBookProgressRefresh(callback))
}
function emit() {
  for (const callback of mocks.callbacks) callback(event)
}
beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
})
describe('shared progress refresh', () => {
  it('runs subscribers in one task before a dashboard microtask flush', async () => {
    const pending: number[] = []
    const batches: number[][] = []
    for (let i = 0; i < 5; i++)
      subscribe(() => {
        if (!pending.length) queueMicrotask(() => batches.push(pending.splice(0)))
        pending.push(i)
      })
    emit()
    await vi.advanceTimersByTimeAsync(250)
    expect(batches).toEqual([[0, 1, 2, 3, 4]])
  })
  it('runs each subscriber once while preserving matching book events', async () => {
    const generic = vi.fn<(event: BookProgressChangedEvent) => void>()
    const specific = vi.fn<(event: BookProgressChangedEvent) => void>()
    subscribe(generic)
    const scope = effectScope()
    scopes.push(scope)
    scope.run(() => useBookProgressRefresh(specific, () => 1))
    emit()
    for (const callback of mocks.callbacks) callback({ ...event, bookId: 2 })
    await vi.advanceTimersByTimeAsync(250)
    expect(generic).toHaveBeenCalledExactlyOnceWith({ ...event, bookId: 2 })
    expect(specific).toHaveBeenCalledExactlyOnceWith(event)
  })
  it('defers hidden events until visible, once', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    const callback = vi.fn<(event: BookProgressChangedEvent) => void>()
    subscribe(callback)
    emit()
    await vi.advanceTimersByTimeAsync(250)
    emit()
    expect(callback).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(callback).toHaveBeenCalledExactlyOnceWith(event)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(callback).toHaveBeenCalledTimes(1)
  })
  it('enforces the shared minimum interval and cleans up a subscriber', async () => {
    const callback = vi.fn<(event: BookProgressChangedEvent) => void>()
    subscribe(callback)
    emit()
    await vi.advanceTimersByTimeAsync(250)
    emit()
    await vi.advanceTimersByTimeAsync(PROGRESS_REFRESH_MIN_INTERVAL_MS - 1)
    expect(callback).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(callback).toHaveBeenCalledTimes(2)
    scopes[0]!.stop()
    emit()
    await vi.runAllTimersAsync()
    expect(callback).toHaveBeenCalledTimes(2)
  })
  it('gives generic subscribers the latest event when a book repeats', async () => {
    const generic = vi.fn<(event: BookProgressChangedEvent) => void>()
    subscribe(generic)
    for (const bookId of [1, 2, 1]) {
      for (const callback of mocks.callbacks) callback({ bookId, progress: 50, source: 'kobo' })
    }
    await vi.advanceTimersByTimeAsync(250)
    expect(generic).toHaveBeenCalledExactlyOnceWith({ bookId: 1, progress: 50, source: 'kobo' })
  })
})
