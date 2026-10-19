import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import type { ReleaseCandidateItem } from '@bookorbit/types'
import { useBackgroundInspection } from '../composables/useBackgroundInspection'

it('inspects wanted intersecting rows once with at most two requests and swallows failures', async () => {
  let notify: IntersectionObserverCallback
  const disconnect = vi.fn<(...args: unknown[]) => void>()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback
      }
      observe = vi.fn<(...args: unknown[]) => void>()
      unobserve = vi.fn<(...args: unknown[]) => void>()
      disconnect = disconnect
    },
  )
  const settle: (() => void)[] = []
  const inspect = vi.fn<() => Promise<null>>(() => new Promise<null>((_resolve, reject) => settle.push(() => reject(new Error('offline')))))
  let background: ReturnType<typeof useBackgroundInspection>
  const wrapper = mount({
    setup() {
      background = useBackgroundInspection({ inspect, concurrency: 9 })
      return () => null
    },
  })
  const elements = Array.from({ length: 4 }, () => document.createElement('li'))
  elements.forEach((el, i) => background.observe(el, { indexerId: 1, guid: String(i), inspectionWanted: i !== 3 } as ReleaseCandidateItem))
  const entries = elements.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry)
  notify!(entries, {} as IntersectionObserver)
  notify!(entries, {} as IntersectionObserver)
  await flushPromises()
  expect(inspect).toHaveBeenCalledTimes(2)
  settle[0]!()
  await flushPromises()
  expect(inspect).toHaveBeenCalledTimes(3)
  settle.slice(1).forEach((finish) => finish())
  await flushPromises()
  notify!(entries, {} as IntersectionObserver)
  expect(inspect).toHaveBeenCalledTimes(3)
  wrapper.unmount()
  expect(disconnect).toHaveBeenCalledOnce()
  vi.unstubAllGlobals()
})

it('ignores rows outside the viewport and unobserved rows, and stops queued work on disposal', async () => {
  let notify: IntersectionObserverCallback
  const unobserve = vi.fn<(...args: unknown[]) => void>()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback
      }
      observe = vi.fn<(...args: unknown[]) => void>()
      unobserve = unobserve
      disconnect = vi.fn<(...args: unknown[]) => void>()
    },
  )
  let finish: (value: null) => void
  const inspect = vi.fn<() => Promise<null>>(
    () =>
      new Promise<null>((resolve) => {
        finish = resolve
      }),
  )
  let background: ReturnType<typeof useBackgroundInspection>
  const wrapper = mount({
    setup() {
      background = useBackgroundInspection({ inspect, concurrency: 1 })
      return () => null
    },
  })
  const first = document.createElement('li')
  const removed = document.createElement('li')
  const queued = document.createElement('li')
  for (const [i, el] of [first, removed, queued].entries())
    background!.observe(el, { indexerId: 1, guid: String(i), inspectionWanted: true } as ReleaseCandidateItem)
  notify!([{ target: first, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
  await flushPromises()
  expect(inspect).not.toHaveBeenCalled()
  background!.unobserve(removed)
  expect(unobserve).toHaveBeenCalledWith(removed)
  notify!(
    [first, removed, queued].map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry),
    {} as IntersectionObserver,
  )
  await flushPromises()
  expect(inspect).toHaveBeenCalledOnce()
  wrapper.unmount()
  finish!(null)
  await flushPromises()
  expect(inspect).toHaveBeenCalledOnce()
  vi.unstubAllGlobals()
})

it('drops queued rows leaving the viewport and re-observes mounted rows on reset', async () => {
  let notify!: IntersectionObserverCallback
  const observe = vi.fn<(...args: unknown[]) => void>()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback
      }
      observe = observe
      unobserve = vi.fn<(...args: unknown[]) => void>()
      disconnect = vi.fn<(...args: unknown[]) => void>()
    },
  )
  const finishes: (() => void)[] = []
  const inspect = vi.fn<() => Promise<null>>(() => new Promise<null>((resolve) => finishes.push(() => resolve(null))))
  let background!: ReturnType<typeof useBackgroundInspection>
  const wrapper = mount({
    setup() {
      background = useBackgroundInspection({ inspect, concurrency: 1 })
      return () => null
    },
  })
  const rows = [document.createElement('li'), document.createElement('li')]
  rows.forEach((el, i) => background.observe(el, { indexerId: 1, guid: String(i), inspectionWanted: true } as ReleaseCandidateItem))
  const notifyRows = (elements: Element[], isIntersecting: boolean) =>
    notify(
      elements.map((target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry),
      {} as IntersectionObserver,
    )
  notifyRows(rows, true)
  await flushPromises()
  notifyRows([rows[1]!], false)
  finishes[0]!()
  await flushPromises()
  expect(inspect).toHaveBeenCalledTimes(1)
  notifyRows([rows[1]!], true)
  await flushPromises()
  expect(inspect).toHaveBeenCalledTimes(2)
  background.reset()
  expect(observe).toHaveBeenCalledTimes(4)
  notifyRows([rows[0]!], true)
  await flushPromises()
  expect(inspect).toHaveBeenCalledTimes(2)
  finishes[1]!()
  await flushPromises()
  expect(inspect).toHaveBeenCalledTimes(3)
  finishes[2]!()
  wrapper.unmount()
  vi.unstubAllGlobals()
})
