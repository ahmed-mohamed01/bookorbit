// Fork: Convert to M4B. Review state for the rail, a generic copy of bulk rename's useBulkRenameReview:
// the open book, the include/exclude selection, and collapsed author groups.
import { computed, ref, watch, type Ref } from 'vue'
import type { AudioConvertPreviewItem, AudioConvertRunRequest } from '@bookorbit/types'

export interface AudioConvertReviewGroup {
  key: string
  /** First author's name, or empty for books without one; the rail supplies the fallback label. */
  label: string
  items: AudioConvertPreviewItem[]
}

/** Whether the marked set names the books to leave out or the only books to convert. */
export type SelectionMode = 'all-except' | 'only'

export type TriState = 'all' | 'none' | 'some'

const NO_AUTHOR_KEY = '\u0000none'

function authorOf(item: AudioConvertPreviewItem): string {
  return item.authors[0]?.trim() ?? ''
}

function isSelectable(item: AudioConvertPreviewItem): boolean {
  return item.status === 'can_convert'
}

/**
 * Selection is a mode plus one small set, like bulk rename: the candidate list is paged and can run
 * to thousands, so the client states whichever side is short. Leaving a few out keeps `all-except`;
 * clearing the selection flips to `only`.
 *
 * A search narrows `all-except` on the server too, so the run converts exactly the books counted.
 *
 * @param items Loaded preview rows, which may be a fraction of the candidates.
 * @param totalSelectable Server-side count of `can_convert` books across every page, under `search`.
 * @param search The search those rows and that count answer to.
 */
export function useAudioConvertReview(items: Ref<AudioConvertPreviewItem[]>, totalSelectable: Ref<number>, search: Ref<string> = ref('')) {
  const selectedId = ref<number | null>(null)
  const mode = ref<SelectionMode>('all-except')
  const marked = ref<Set<number>>(new Set())
  const collapsed = ref<Set<string>>(new Set())

  /** Books grouped by first author, authors in alphabetical order, books in server order within. */
  const groups = computed<AudioConvertReviewGroup[]>(() => {
    const byKey = new Map<string, AudioConvertReviewGroup>()
    for (const item of items.value) {
      const label = authorOf(item)
      const key = label ? label.toLocaleLowerCase() : NO_AUTHOR_KEY
      let group = byKey.get(key)
      if (!group) {
        group = { key, label, items: [] }
        byKey.set(key, group)
      }
      group.items.push(item)
    }
    return [...byKey.values()].sort((a, b) => {
      if (a.key === NO_AUTHOR_KEY) return 1
      if (b.key === NO_AUTHOR_KEY) return -1
      return a.label.localeCompare(b.label)
    })
  })

  const ordered = computed<AudioConvertPreviewItem[]>(() => groups.value.flatMap((group) => group.items))

  /** Rows the rail renders, honouring collapsed groups. Keyboard travel follows this. */
  const visible = computed<AudioConvertPreviewItem[]>(() => groups.value.flatMap((group) => (collapsed.value.has(group.key) ? [] : group.items)))

  const current = computed<AudioConvertPreviewItem | null>(
    () => ordered.value.find((item) => item.bookId === selectedId.value) ?? ordered.value[0] ?? null,
  )

  const currentIndex = computed(() => visible.value.findIndex((item) => item.bookId === current.value?.bookId))

  const selectedCount = computed(() => (mode.value === 'all-except' ? Math.max(0, totalSelectable.value - marked.value.size) : marked.value.size))

  const selectionState = computed<TriState>(() => {
    if (selectedCount.value === 0) return 'none'
    if (selectedCount.value >= totalSelectable.value) return 'all'
    return 'some'
  })

  /**
   * The narrower of the two lists, which is what the run request carries. `all-except` also carries
   * the search, or the server would read "everything except these" as the whole library.
   */
  const runSelection = computed<AudioConvertRunRequest>(() => {
    if (mode.value === 'only') return { includeBookIds: [...marked.value] }
    const term = search.value.trim()
    return term ? { excludeBookIds: [...marked.value], search: term } : { excludeBookIds: [...marked.value] }
  })

  // Books left out under one search may not match the next, and subtracting them would undercount.
  // Named books (`only`) still run whatever the search, so they stay.
  watch(search, () => {
    if (mode.value === 'all-except' && marked.value.size > 0) marked.value = new Set()
  })

  /** Loaded, selected books: enough for an estimate of the run's size. */
  const selectedLoaded = computed(() => items.value.filter((item) => isSelected(item)))

  function isSelected(item: AudioConvertPreviewItem): boolean {
    if (!isSelectable(item)) return false
    return mode.value === 'all-except' ? !marked.value.has(item.bookId) : marked.value.has(item.bookId)
  }

  function select(bookId: number): void {
    selectedId.value = bookId
  }

  function step(delta: number): void {
    const next = visible.value[currentIndex.value + delta]
    if (next) select(next.bookId)
  }

  /** Marking means "leave out" under `all-except` and "include" under `only`. */
  function setSelected(item: AudioConvertPreviewItem, selected: boolean): void {
    if (!isSelectable(item)) return
    const next = new Set(marked.value)
    const shouldMark = mode.value === 'all-except' ? !selected : selected
    if (shouldMark) next.add(item.bookId)
    else next.delete(item.bookId)
    marked.value = next
  }

  function toggleSelected(item: AudioConvertPreviewItem): void {
    setSelected(item, !isSelected(item))
  }

  function selectAll(): void {
    mode.value = 'all-except'
    marked.value = new Set()
  }

  function selectNone(): void {
    mode.value = 'only'
    marked.value = new Set()
  }

  function toggleAll(): void {
    if (selectionState.value === 'all') selectNone()
    else selectAll()
  }

  function selectableIn(key: string): AudioConvertPreviewItem[] {
    return (groups.value.find((group) => group.key === key)?.items ?? []).filter(isSelectable)
  }

  /** Covers loaded rows only, which is also what the group's count shows. */
  function groupState(key: string): TriState {
    const selectable = selectableIn(key)
    if (selectable.length === 0) return 'none'
    const chosen = selectable.filter(isSelected).length
    if (chosen === 0) return 'none'
    return chosen === selectable.length ? 'all' : 'some'
  }

  function setGroupSelected(key: string, selected: boolean): void {
    const selectable = selectableIn(key)
    if (selectable.length === 0) return
    const next = new Set(marked.value)
    const shouldMark = mode.value === 'all-except' ? !selected : selected
    for (const item of selectable) {
      if (shouldMark) next.add(item.bookId)
      else next.delete(item.bookId)
    }
    marked.value = next
  }

  function toggleGroupSelected(key: string): void {
    setGroupSelected(key, groupState(key) !== 'all')
  }

  function toggleGroup(key: string): void {
    const next = new Set(collapsed.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    collapsed.value = next
  }

  function reset(): void {
    selectedId.value = null
    mode.value = 'all-except'
    marked.value = new Set()
    collapsed.value = new Set()
  }

  /**
   * Books still listed after a run are the ones deliberately left out, so the selection must not
   * spring back to "everything" and re-arm Convert with exactly the books just declined.
   */
  function resetAfterRun(): void {
    selectedId.value = null
    selectNone()
  }

  return {
    selectedId,
    mode,
    marked,
    collapsed,

    groups,
    visible,
    current,
    currentIndex,
    selectedCount,
    selectionState,
    runSelection,
    selectedLoaded,

    isSelected,
    isSelectable,
    groupState,
    select,
    step,
    setSelected,
    toggleSelected,
    selectAll,
    selectNone,
    toggleAll,
    setGroupSelected,
    toggleGroupSelected,
    toggleGroup,
    reset,
    resetAfterRun,
  }
}
