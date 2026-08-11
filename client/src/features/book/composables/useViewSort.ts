import { computed, watch, type Ref } from 'vue'
import type { SortSpec } from '@bookorbit/types'
import { sortFieldLabel } from '../lib/filter-labels'
import { DEFAULT_SORT, copySort, sortsEqual } from '../lib/sort-defaults'

function storageKey(prefix: string, id: number) {
  return `bookorbit:sort:${prefix}:${id}`
}

export function useViewSort(sort: Ref<SortSpec[]>, keyPrefix: string, entityId: Ref<number | null>, defaultSort: SortSpec[] = DEFAULT_SORT) {
  watch(
    entityId,
    (id) => {
      if (id === null) return
      try {
        const raw = localStorage.getItem(storageKey(keyPrefix, id))
        sort.value = raw ? JSON.parse(raw) : copySort(defaultSort)
      } catch {
        sort.value = copySort(defaultSort)
      }
    },
    { immediate: true },
  )

  function saveSort() {
    const id = entityId.value
    if (id === null) return
    localStorage.setItem(storageKey(keyPrefix, id), JSON.stringify(sort.value))
  }

  function resetSort() {
    sort.value = copySort(defaultSort)
    const id = entityId.value
    if (id !== null) localStorage.removeItem(storageKey(keyPrefix, id))
  }

  const sortModel = computed({
    get: () => sort.value,
    set: (v: SortSpec[]) => {
      sort.value = v.length > 0 ? v : copySort(defaultSort)
      saveSort()
    },
  })

  const isDefaultSort = computed(() => sortsEqual(sort.value, defaultSort))

  const sortSummary = computed(() => sort.value.map((s) => `${sortFieldLabel(s.field)} ${s.dir === 'asc' ? '↑' : '↓'}`).join(', '))

  return { sortModel, isDefaultSort, sortSummary, resetSort, saveSort }
}
