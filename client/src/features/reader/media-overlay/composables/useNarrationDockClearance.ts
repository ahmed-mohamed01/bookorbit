import { computed, onBeforeUnmount, watch, type Ref } from 'vue'
import { useNarrationOutsideReader } from './useNarrationOutsideReader'
import type { NarrationDockSide } from './useNarrationDockLayout'

export const NARRATION_BASE_CLEARANCE = 'max(1.5rem, var(--podcast-mini-player-clearance, 0px))'

const CLEARANCE_CSS_VAR = '--narration-dock-clearance'
const RIGHT_CLEARANCE_CSS_VAR = '--narration-dock-right-clearance'
const PILL_CLEARANCE = `calc(${NARRATION_BASE_CLEARANCE} + 3.75rem)`
const MINI_CLEARANCE = `calc(${NARRATION_BASE_CLEARANCE} + 3.5rem)`

function setRootVar(name: string, value: string | null) {
  if (typeof document === 'undefined') return
  if (value) document.documentElement.style.setProperty(name, value)
  else document.documentElement.style.removeProperty(name)
}

// Bottom-edge UI outside the reader (toasts, the selection bar) reads these variables to sit above the dock.
export function useNarrationDockClearance(
  surface: Readonly<Ref<'full' | 'pill' | 'mini' | null>>,
  side: Readonly<Ref<NarrationDockSide>>,
  canDrag: Readonly<Ref<boolean>>,
) {
  const isOutsideReader = useNarrationOutsideReader()

  watch(
    () => (isOutsideReader.value ? surface.value : null),
    (current) => {
      setRootVar(CLEARANCE_CSS_VAR, current === 'pill' ? PILL_CLEARANCE : current === 'mini' ? MINI_CLEARANCE : null)
    },
    { immediate: true },
  )

  // Toasts stack at the bottom right on wide screens, so they only need lifting when the pill sits there.
  const pillAtRight = computed(() => isOutsideReader.value && surface.value === 'pill' && canDrag.value && side.value === 'right')
  watch(pillAtRight, (clear) => setRootVar(RIGHT_CLEARANCE_CSS_VAR, clear ? PILL_CLEARANCE : null), { immediate: true })

  onBeforeUnmount(() => {
    setRootVar(CLEARANCE_CSS_VAR, null)
    setRootVar(RIGHT_CLEARANCE_CSS_VAR, null)
  })
}
