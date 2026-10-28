import { computed, type Ref } from 'vue'
import type { WorkForBook } from '@bookorbit/types'
import { isReadAlongInFlight } from '@/features/book/lib/read-along-section'
import { useReadAlongSection } from '@/features/book/composables/useReadAlongSection'

/**
 * The Editions card's "Generate read-along" action. It reuses the Link panel's build runner, keyed
 * to the work's primary ebook the way the server keys a build to its pair.
 */
export function useWorkReadAlong(work: Ref<WorkForBook | null>, onReady: () => void) {
  const pairBookId = computed(() => {
    const variants = work.value?.variants ?? []
    return (
      (variants.find((variant) => variant.role === 'text' && variant.isPrimary) ?? variants.find((variant) => variant.role === 'text'))?.bookId ?? 0
    )
  })
  const section = useReadAlongSection(() => pairBookId.value)
  section.readAlong.onReady(onReady)

  const building = computed(() => section.readAlong.mutating.value || isReadAlongInFlight(section.readAlong.status.value))
  const canGenerate = computed(() => work.value?.canGenerateReadAlong === true && section.canGenerate.value && pairBookId.value > 0)

  function generate(): void {
    void section.runBuild(section.withDestination({}))
  }

  return { canGenerate, building, generate }
}
