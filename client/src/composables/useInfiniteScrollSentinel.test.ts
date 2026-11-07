import { expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { useInfiniteScrollSentinel } from './useInfiniteScrollSentinel'

it('does not load more from a detached sentinel with a zero rectangle', () => {
  const loadMore = vi.fn<() => void>()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  let check = () => {}
  const wrapper = mount(
    defineComponent({
      setup() {
        const { sentinel, checkSentinel } = useInfiniteScrollSentinel({ loadMore, hasMore: ref(true), loading: ref(false) })
        check = checkSentinel
        return () => h('div', { ref: sentinel })
      },
    }),
    { attachTo: document.body },
  )
  check()
  expect(loadMore).toHaveBeenCalledTimes(1)
  wrapper.element.remove()
  check()
  expect(loadMore).toHaveBeenCalledTimes(1)
  wrapper.unmount()
  vi.unstubAllGlobals()
})
