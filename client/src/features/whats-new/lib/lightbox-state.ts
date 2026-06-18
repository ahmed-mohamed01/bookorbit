import { computed, ref } from 'vue'

const openCount = ref(0)

/** Returns an unregister fn; lets the popup know not to also close on Escape. */
export function registerLightbox(): () => void {
  openCount.value++
  return () => {
    openCount.value = Math.max(0, openCount.value - 1)
  }
}

export const anyLightboxOpen = computed(() => openCount.value > 0)
