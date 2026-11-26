import { computed, ref, shallowRef, watch } from 'vue'
import { Permission, type StoryGuideStatus } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { getStoryGuideStatus } from '@/features/story-guide/api/story-guide.api'
import { useStoryGuideStatus } from '@/features/story-guide/composables/useStoryGuideStatus'

export function useStoryGuideTabStatus(bookId: () => number) {
  const management = useStoryGuideStatus(bookId)
  const { hasPermission } = usePermissions()
  const mayBuild = computed(() => hasPermission(Permission.LibraryGenerateStoryGuide))
  const readerStatus = shallowRef<StoryGuideStatus | null>(null)
  const readerLoading = ref(false)
  const readerError = ref(false)
  const retries = ref(0)
  // One read for everyone: the card's own polling keeps no status after a failed or missing answer, which would leave builders a blank tab.
  watch(
    [bookId, retries],
    async ([id], _, onCleanup) => {
      readerStatus.value = null
      readerError.value = false
      readerLoading.value = true
      let stale = false
      onCleanup(() => {
        stale = true
      })
      try {
        const result = await getStoryGuideStatus(id, null, null)
        if (stale) return
        if (result.kind === 'fresh') readerStatus.value = result.status
        else readerError.value = true
      } catch {
        if (!stale) readerError.value = true
      } finally {
        if (!stale) readerLoading.value = false
      }
    },
    { immediate: true },
  )

  function retryReaderStatus() {
    retries.value++
    if (mayBuild.value) void management.reload()
  }

  const status = computed(() => (mayBuild.value ? (management.status.value ?? readerStatus.value) : readerStatus.value))
  const statusLoading = computed(() => readerLoading.value && !status.value)
  const statusError = computed(() => readerError.value && !status.value)
  return { ...management, status, mayBuild, readerLoading: statusLoading, readerError: statusError, retryReaderStatus }
}
