import { computed, getCurrentScope, nextTick, onScopeDispose, ref } from 'vue'
import { useNarrationOutsideReader } from './useNarrationOutsideReader'

export type NarrationDockSide = 'left' | 'center' | 'right'

const SIDE_KEY = 'bookorbit.narration.dockSide'
const MINI_KEY = 'bookorbit.narration.miniCollapsed'
const WIDE_QUERY = '(min-width: 640px)'
const DRAG_THRESHOLD_PX = 6
const EDGE_INSET_PX = 24
const VIEWPORT_MARGIN_PX = 8
const SNAP_MS = 220

const SIDE_CLASSES: Record<NarrationDockSide, string> = {
  left: 'left-6',
  center: 'left-1/2 -translate-x-1/2',
  right: 'right-6',
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be blocked; the preference then lasts for this page load only.
  }
}

function initialSide(): NarrationDockSide {
  const stored = readStorage(SIDE_KEY)
  return stored === 'left' || stored === 'right' ? stored : 'center'
}

const side = ref<NarrationDockSide>(initialSide())
const miniPreferred = ref(readStorage(MINI_KEY) === '1')
const isDragging = ref(false)
const dragOffset = ref(0)

interface DragState {
  pointerId: number
  startX: number
  baseLeft: number
  width: number
  frame: HTMLElement
  moved: boolean
}

let drag: DragState | null = null
let suppressClick = false
let suppressClickTimer: ReturnType<typeof setTimeout> | null = null

function clearClickSuppression() {
  suppressClick = false
  if (suppressClickTimer) clearTimeout(suppressClickTimer)
  suppressClickTimer = null
}

function prefersReducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function nearestSide(center: number, width: number): NarrationDockSide {
  const slots: Record<NarrationDockSide, number> = {
    left: EDGE_INSET_PX + width / 2,
    center: window.innerWidth / 2,
    right: window.innerWidth - EDGE_INSET_PX - width / 2,
  }
  return (Object.keys(slots) as NarrationDockSide[]).reduce((best, key) =>
    Math.abs(slots[key] - center) < Math.abs(slots[best] - center) ? key : best,
  )
}

// Outside the reader the pill can sit at the left, centre or right of the bottom edge on wide
// screens, and shrinks to a round mini player at the bottom right on narrow ones.
export function useNarrationDockLayout() {
  const isOutsideReader = useNarrationOutsideReader()

  const query = typeof window !== 'undefined' ? window.matchMedia?.(WIDE_QUERY) : undefined
  const isWide = ref(query?.matches ?? true)
  const handleQueryChange = (e: MediaQueryListEvent) => {
    isWide.value = e.matches
  }
  query?.addEventListener?.('change', handleQueryChange)
  if (getCurrentScope()) onScopeDispose(() => query?.removeEventListener?.('change', handleQueryChange))

  const canDrag = computed(() => isOutsideReader.value && isWide.value)
  const canMinimise = computed(() => isOutsideReader.value && !isWide.value)
  const isMini = computed(() => canMinimise.value && miniPreferred.value)
  const activeSide = computed<NarrationDockSide>(() => (canDrag.value ? side.value : 'center'))
  const anchorClass = computed(() => SIDE_CLASSES[activeSide.value])
  const transformOrigin = computed(() => `bottom ${activeSide.value}`)
  const dragStyle = computed(() => (isDragging.value ? { transform: `translateX(${dragOffset.value}px)` } : undefined))
  const frameCursorClass = computed(() => {
    if (!canDrag.value) return ''
    return isDragging.value ? 'cursor-grabbing select-none touch-pan-y' : 'cursor-grab select-none touch-pan-y'
  })

  function setMini(value: boolean) {
    miniPreferred.value = value
    writeStorage(MINI_KEY, value ? '1' : '0')
  }

  function handlePointerDown(event: PointerEvent) {
    if (!canDrag.value || event.button > 0) return
    const frame = event.currentTarget as HTMLElement
    const rect = frame.closest<HTMLElement>('[data-dock]')?.getBoundingClientRect()
    if (!rect) return
    clearClickSuppression()
    drag = { pointerId: event.pointerId, startX: event.clientX, baseLeft: rect.left, width: rect.width, frame, moved: false }
    // A quick flick can leave the pill before the threshold is crossed, so the drag is followed on the window.
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
  }

  function stopTracking() {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', finishDrag)
    window.removeEventListener('pointercancel', finishDrag)
  }

  function handlePointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const dx = event.clientX - drag.startX
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      isDragging.value = true
      drag.frame.setPointerCapture?.(drag.pointerId)
    }
    const min = VIEWPORT_MARGIN_PX - drag.baseLeft
    const max = window.innerWidth - VIEWPORT_MARGIN_PX - drag.width - drag.baseLeft
    dragOffset.value = Math.min(Math.max(dx, min), Math.max(min, max))
  }

  async function finishDrag(event: PointerEvent) {
    const state = drag
    if (!state || event.pointerId !== state.pointerId) return
    drag = null
    stopTracking()
    if (!state.moved) return
    suppressClick = true
    // Only the click this drag synthesises is swallowed; without a click the flag must not linger.
    suppressClickTimer = setTimeout(clearClickSuppression, 0)
    state.frame.releasePointerCapture?.(state.pointerId)

    const visualLeft = state.baseLeft + dragOffset.value
    const target = state.frame.closest<HTMLElement>('[data-dock]')
    side.value = nearestSide(visualLeft + state.width / 2, state.width)
    writeStorage(SIDE_KEY, side.value)
    dragOffset.value = 0
    isDragging.value = false

    await nextTick()
    if (!target || typeof target.animate !== 'function' || prefersReducedMotion()) return
    const delta = visualLeft - target.getBoundingClientRect().left
    if (delta === 0) return
    target.animate([{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }], {
      duration: SNAP_MS,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    })
  }

  function handleClickCapture(event: MouseEvent) {
    if (!suppressClick) return
    clearClickSuppression()
    event.stopPropagation()
    event.preventDefault()
  }

  return {
    side,
    canDrag,
    canMinimise,
    isMini,
    anchorClass,
    transformOrigin,
    dragStyle,
    frameCursorClass,
    setMini,
    handlePointerDown,
    handleClickCapture,
  }
}
