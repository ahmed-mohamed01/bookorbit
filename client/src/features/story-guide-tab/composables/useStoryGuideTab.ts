import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ForkStoryGuideCut, ForkStoryGuidePayload, ForkStoryRecap, StoryGuideStatus } from '@bookorbit/types'
import { useBookProgressRefresh } from '@/features/book/composables/useBookProgressRefresh'
import { fetchStoryGuide, fetchStoryRecap } from '../api/story-guide-content.api'
import { buildStoryGuideView } from '../lib/story-guide-view'

export type GuideSection = 'recap' | 'timeline' | 'chapters' | 'characters' | 'constellation'

function sameCut(a: ForkStoryGuideCut | null, b: ForkStoryGuideCut | null) {
  return (
    a?.s === b?.s && a?.placedQuotes.length === b?.placedQuotes.length && (a?.placedQuotes.every((quote, i) => quote === b?.placedQuotes[i]) ?? true)
  )
}

// Two positions can share a rounded percentage, so an equal one keeps the stop text only at the same CFI.
function stopStillBehind(before: ForkStoryRecap['position'], after: ForkStoryRecap['position']) {
  if (!before || !after) return false
  return after.percentage > before.percentage || (after.percentage === before.percentage && after.cfi === before.cfi)
}

export function useStoryGuideTab(bookId: () => number, status: () => StoryGuideStatus | null) {
  const { t } = useI18n()
  const section = ref<GuideSection>('recap')
  const guide = shallowRef<ForkStoryGuidePayload | null>(null)
  const cut = shallowRef<ForkStoryGuideCut | null>(null)
  const recap = shallowRef<ForkStoryRecap | null>(null)
  /** Where the shown stop text was written for: a forward move keeps the text, so it keeps its own label. */
  const stopAt = shallowRef<{ percentage: number; chapterTitle: string | null } | null>(null)
  const error = ref(false)
  const loadingCut = ref(false)
  const refreshing = ref(false)
  const fileId = () => status()?.fileId
  const view = computed(() => guide.value && buildStoryGuideView(guide.value, cut.value, t('book.detail.storyGuideTab.opening')))
  let request: AbortController | undefined
  /** A progress event arrived while the cut or a recap was loading; it is applied once they settle. */
  let pendingProgress = false

  function cancelRequest() {
    request?.abort()
    refreshing.value = false
  }

  function flushPendingProgress() {
    if (!pendingProgress || loadingCut.value || refreshing.value) return
    pendingProgress = false
    void refreshProgress()
  }

  function applyRecap(result: ForkStoryRecap) {
    if (!sameCut(cut.value, result.cut)) cut.value = result.cut
    recap.value = result
    if (!result.cut && section.value !== 'recap' && section.value !== 'chapters') section.value = 'recap'
  }

  async function refreshRecap() {
    const id = fileId()
    if (id == null || !guide.value || !cut.value || loadingCut.value || refreshing.value) return
    cancelRequest()
    const controller = (request = new AbortController())
    refreshing.value = true
    try {
      const result = await fetchStoryRecap(id, true, controller.signal)
      if (controller.signal.aborted) return
      applyRecap(result)
      stopAt.value = result.position
        ? { percentage: result.position.percentage, chapterTitle: view.value?.currentChapter?.title ?? result.position.chapterTitle }
        : null
    } catch {
      if (!controller.signal.aborted && recap.value) recap.value = { ...recap.value, stop: { state: 'failed' } }
    } finally {
      if (!controller.signal.aborted) {
        refreshing.value = false
        flushPendingProgress()
      }
    }
  }

  async function load() {
    cancelRequest()
    pendingProgress = false
    guide.value = null
    cut.value = null
    recap.value = null
    stopAt.value = null
    error.value = false
    const id = fileId()
    loadingCut.value = id != null && !!status()?.guide
    if (!loadingCut.value || id == null) return

    const controller = (request = new AbortController())
    try {
      const [payload, result] = await Promise.all([fetchStoryGuide(id, controller.signal), fetchStoryRecap(id, false, controller.signal)])
      if (controller.signal.aborted) return
      guide.value = payload
      applyRecap(result)
    } catch {
      if (!controller.signal.aborted) error.value = true
    } finally {
      if (!controller.signal.aborted) loadingCut.value = false
    }
    if (controller.signal.aborted) return
    if (section.value === 'recap') void refreshRecap()
    flushPendingProgress()
  }

  function reload() {
    void load()
  }

  // Progress events arrive every 30 s while reading elsewhere: blanking the tab or buying a recap each time is the cost to avoid, and an old stop text spoils once the reader moves back.
  async function refreshProgress() {
    if (loadingCut.value || refreshing.value) {
      pendingProgress = true
      return
    }
    if (!guide.value) return load()
    const id = fileId()
    if (id == null) return
    request?.abort()
    const controller = (request = new AbortController())
    const result = await fetchStoryRecap(id, false, controller.signal).catch(() => null)
    if (!result || controller.signal.aborted) return
    const kept = recap.value && stopStillBehind(recap.value.position, result.position) ? recap.value.stop : undefined
    if (!kept) stopAt.value = null
    applyRecap({ ...result, stop: kept ?? { state: 'skipped' } })
  }

  watch([bookId, fileId, () => status()?.textKey, () => status()?.guide?.builtAt], reload, { immediate: true })
  watch(section, (next) => {
    if (next === 'recap' && recap.value?.stop.state === 'skipped') void refreshRecap()
  })
  useBookProgressRefresh(refreshProgress, bookId)
  onScopeDispose(cancelRequest)

  return { section, guide, recap, stopAt, view, error, loadingCut, refreshing, refreshRecap, reload }
}
