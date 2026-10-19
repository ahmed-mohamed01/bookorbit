import { computed, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'

export function useReleaseFileName(prefix: () => string, isBook: () => boolean) {
  const nameElement = ref<HTMLElement>()
  const prefixElement = ref<HTMLElement>()
  const sheetOpen = ref(false)
  const atStart = ref(true)
  const atEnd = ref(true)
  let suppressed = false
  let press: { id: number; x: number; y: number; left: number; mouse: boolean; scroll: boolean } | null = null
  let suppressionTimer: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const mask = computed<CSSProperties>(() => ({
    maskImage:
      atStart.value && atEnd.value
        ? 'none'
        : `linear-gradient(to right, ${atStart.value ? 'black 0' : 'transparent 0, black 14px'}, ${atEnd.value ? 'black 100%' : 'black calc(100% - 14px), transparent 100%'})`,
  }))
  function handleScroll() {
    const el = nameElement.value
    if (!el) return
    atStart.value = el.scrollLeft <= 1
    atEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
  }
  function initialize() {
    if (nameElement.value) nameElement.value.scrollLeft = Math.max(0, (prefixElement.value?.offsetWidth ?? 0) - 28)
    handleScroll()
  }
  let observer: ResizeObserver | undefined
  onMounted(() => {
    initialize()
    if (typeof ResizeObserver !== 'undefined' && nameElement.value) {
      observer = new ResizeObserver(handleScroll)
      observer.observe(nameElement.value)
    }
  })
  watch(prefix, initialize, { flush: 'post' })
  function handlePointerDown(event: PointerEvent) {
    suppressed = false
    clearTimeout(suppressionTimer)
    if (event.pointerType === 'mouse' && event.button > 0) return
    clearTimeout(timer)
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: nameElement.value?.scrollLeft ?? 0,
      mouse: event.pointerType === 'mouse',
      scroll: event.target instanceof Node && !!nameElement.value?.contains(event.target),
    }
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
      timer = setTimeout(() => {
        suppressed = true
        if (isBook()) sheetOpen.value = true
      }, 500)
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }
  function handlePointerMove(event: PointerEvent) {
    if (!press || event.pointerId !== press.id) return
    const dx = event.clientX - press.x
    if (Math.abs(dx) > 6 || Math.abs(event.clientY - press.y) > 6) {
      suppressed = true
      clearTimeout(timer)
    }
    if (press.mouse && press.scroll && suppressed && nameElement.value) {
      nameElement.value.scrollLeft = press.left - dx
      handleScroll()
    }
  }
  function handlePointerEnd() {
    clearTimeout(timer)
    press = null
    clearTimeout(suppressionTimer)
    suppressionTimer = setTimeout(() => {
      suppressed = false
    }, 750)
  }
  function handlePointerCancel() {
    suppressed = true
    handlePointerEnd()
  }
  function handleKeyDown() {
    suppressed = false
  }
  function handleContextMenu(event: Event) {
    if (press || sheetOpen.value || suppressed) event.preventDefault()
  }
  function consumeClick() {
    const result = suppressed
    suppressed = false
    return result
  }
  onBeforeUnmount(() => {
    clearTimeout(timer)
    clearTimeout(suppressionTimer)
    observer?.disconnect()
  })
  return {
    nameElement,
    prefixElement,
    mask,
    sheetOpen,
    handleKeyDown,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    handlePointerCancel,
    handleContextMenu,
    handleScroll,
    consumeClick,
  }
}
