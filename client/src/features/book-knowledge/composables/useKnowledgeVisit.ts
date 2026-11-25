import { ref } from 'vue'

export function useKnowledgeVisit(
  getPosition: () => { cfi: string | null; fraction: number },
  restore: (cfi: string | null, fraction: number) => unknown,
) {
  const active = ref(false)
  let origin: { cfi: string | null; fraction: number } | null = null
  let returning = false
  function begin() {
    if (!active.value) origin = getPosition()
    active.value = true
  }
  async function back() {
    if (!origin || returning) return
    returning = true
    try {
      await restore(origin.cfi, origin.fraction)
      active.value = false
      origin = null
    } finally {
      returning = false
    }
  }
  function continueHere() {
    if (returning) return false
    active.value = false
    origin = null
    return true
  }
  return { active, begin, back, continueHere }
}
