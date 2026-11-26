import { computed, watch, type InjectionKey, type Ref } from 'vue'
import type { BookDetail } from '@bookorbit/types'
import { useAppInfo } from '@/features/settings/composables/useAppInfo'

export const STORY_GUIDE_TAB_AVAILABLE: InjectionKey<Readonly<Ref<boolean>>> = Symbol('story-guide-tab-available')

/** Whether the server offers story guides; a book it cannot build one for still gets the tab, which explains why. */
export function useStoryGuideTabAvailability(book: () => BookDetail | null | undefined) {
  const { ensureAppInfo, supportsFeature, storyGuides } = useAppInfo()
  watch(
    () => !!book(),
    (value) => {
      if (value) void ensureAppInfo()
    },
    { immediate: true },
  )
  return computed(() => {
    const info = storyGuides.value
    return !!book() && supportsFeature('story-guides') && (!info || info.building || info.served)
  })
}
