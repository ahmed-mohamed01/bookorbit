import { computed, nextTick, reactive, ref, watch, type WatchSource } from 'vue'
import { createSharedComposable, useStorage } from '@vueuse/core'
import {
  chapterPage,
  DEFAULT_CHAPTER_PAGE_SIZE,
  isChapterOrder,
  isChapterPageSize,
  type ChapterOrder,
  type ChapterPageSize,
} from '../lib/chapter-page'

/** One pair of refs for every pager, so lists follow a change even when the browser refuses to store it. */
const useChapterPagePreferences = createSharedComposable(() => ({
  storedOrder: useStorage<string>('bookorbit:story-guide-chapter-order', 'newest'),
  storedSize: useStorage<number>('bookorbit:story-guide-chapter-page-size', DEFAULT_CHAPTER_PAGE_SIZE),
}))

/** Every chapter list in the Story Guide shares one order and page size per browser, so a choice holds across sections. */
export function useChapterPages<T extends { title: string }>(chapters: () => readonly T[], resetOn: WatchSource) {
  const { storedOrder, storedSize } = useChapterPagePreferences()
  const order = computed<ChapterOrder>({
    get: () => (isChapterOrder(storedOrder.value) ? storedOrder.value : 'newest'),
    set: (value) => (storedOrder.value = value),
  })
  const size = computed<ChapterPageSize>({
    get: () => (isChapterPageSize(storedSize.value) ? storedSize.value : DEFAULT_CHAPTER_PAGE_SIZE),
    set: (value) => (storedSize.value = value),
  })
  const pageNumber = ref(1)
  let top: Element | null = null
  const page = computed(() => chapterPage(chapters(), order.value, size.value, pageNumber.value))
  watch([order, size, resetOn], () => (pageNumber.value = 1))

  async function turn(to: number) {
    pageNumber.value = to
    await nextTick()
    top?.scrollIntoView({ block: 'start' })
  }

  return reactive({
    order,
    size,
    page,
    setTop: (element: unknown) => (top = element instanceof Element ? element : null),
    previous: () => turn(page.value.page - 1),
    next: () => turn(page.value.page + 1),
  })
}
