import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

export function useMonitoredPinnedBar(root: Ref<HTMLElement | null>, sentinel: Ref<HTMLElement | null>) {
  const pinned = ref(false)
  let observer: IntersectionObserver | undefined
  watch(
    [root, sentinel],
    ([scroller, marker]) => {
      observer?.disconnect()
      pinned.value = false
      if (!scroller || !marker || typeof IntersectionObserver === 'undefined') return
      observer = new IntersectionObserver(
        ([entry]) => {
          pinned.value = Boolean(entry && !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0))
        },
        { root: scroller },
      )
      observer.observe(marker)
    },
    { flush: 'post' },
  )
  onBeforeUnmount(() => observer?.disconnect())
  return { pinned }
}
