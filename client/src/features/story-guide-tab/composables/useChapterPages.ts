import { computed, nextTick, reactive, ref, watch, type WatchSource } from 'vue'
import { useStorage } from '@vueuse/core'
import {
  chapterPage,
  DEFAULT_CHAPTER_PAGE_SIZE,
  isChapterOrder,
  isChapterPageSize,
  type ChapterOrder,
  type ChapterPageSize,
} from '../lib/chapter-page'

/** `list` names the storage keys, so each list keeps its own order and page size per browser. */
export function useChapterPages<T extends { title: string }>(list: string, chapters: () => readonly T[], resetOn: WatchSource) {
  const storedOrder = useStorage<string>(`bookorbit:story-guide-${list}-order`, 'newest')
  const storedSize = useStorage<number>(`bookorbit:story-guide-${list}-page-size`, DEFAULT_CHAPTER_PAGE_SIZE)
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
