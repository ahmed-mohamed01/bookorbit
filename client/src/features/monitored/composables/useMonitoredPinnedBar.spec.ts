import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useMonitoredPinnedBar } from './useMonitoredPinnedBar'

afterEach(() => vi.unstubAllGlobals())

it('observes the sentinel in the page scroller, folds only above it, and disconnects', async () => {
  const observe = vi.fn<(target: Element) => void>()
  const disconnect = vi.fn<() => void>()
  let callback!: IntersectionObserverCallback
  const observerMock = vi.fn<(this: object, handler: IntersectionObserverCallback) => { observe: typeof observe; disconnect: typeof disconnect }>(
    function (this: object, handler: IntersectionObserverCallback) {
      callback = handler
      return { observe, disconnect }
    },
  )
  vi.stubGlobal('IntersectionObserver', observerMock)
  let state!: ReturnType<typeof useMonitoredPinnedBar>
  const wrapper = mount(
    defineComponent({
      setup() {
        const root = ref<HTMLElement | null>(null)
        const sentinel = ref<HTMLElement | null>(null)
        state = useMonitoredPinnedBar(root, sentinel)
        return { root, sentinel }
      },
      template: '<main ref="root"><div ref="sentinel" /></main>',
    }),
  )
  await nextTick()
  expect(observerMock).toHaveBeenCalledWith(expect.any(Function), { root: wrapper.element })
  expect(observe).toHaveBeenCalledWith(wrapper.get('div').element)
  function intersect(top: number, visible: boolean) {
    callback(
      [{ isIntersecting: visible, boundingClientRect: { top }, rootBounds: { top: 0 } } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
  }
  intersect(100, false)
  expect(state.pinned.value).toBe(false)
  intersect(-1, false)
  expect(state.pinned.value).toBe(true)
  intersect(0, true)
  expect(state.pinned.value).toBe(false)
  wrapper.unmount()
  expect(disconnect).toHaveBeenCalledOnce()
})
