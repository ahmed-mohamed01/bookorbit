import { computed, ref, watch, type Ref } from 'vue'
import {
  monitoredBulkFormats,
  type MonitoredBulkRequestFormat,
  type MonitoredBulkRequestPayload,
  type MonitoredFormat,
  type RequestSourceOption,
} from '@bookorbit/types'
import { fetchRequestSources } from '../api/monitored'

/** null means every source that carries the format. */
type FormatSelection = Set<number> | null

export interface SourceGroup {
  format: MonitoredFormat
  rows: RequestSourceOption[]
  /** Ids that are ticked; every row when the format uses all sources. */
  ticked: Set<number>
  /** The only ticked row of the format, which must stay on. */
  locked: number | null
}

function emptySelection(): Record<MonitoredFormat, FormatSelection> {
  return { ebook: null, audiobook: null }
}

/**
 * Which sources a bulk request may search, per format. The list loads the first time select mode opens
 * and the choice lasts until select mode exits.
 */
export function useRequestSources(active: Ref<boolean>, format: Ref<MonitoredBulkRequestFormat>) {
  const sources = ref<RequestSourceOption[]>([])
  const loaded = ref(false)
  const selection = ref(emptySelection())

  async function load() {
    if (loaded.value) return
    loaded.value = true
    try {
      sources.value = await fetchRequestSources()
    } catch {
      sources.value = []
    }
  }

  watch(
    active,
    (isActive) => {
      if (isActive) void load()
      else selection.value = emptySelection()
    },
    { immediate: true },
  )

  function carriers(each: MonitoredFormat): RequestSourceOption[] {
    return sources.value.filter((source) => source.mediaKinds.includes(each))
  }

  const groups = computed<SourceGroup[]>(() =>
    monitoredBulkFormats(format.value)
      .map((each) => {
        const rows = carriers(each)
        const chosen = selection.value[each]
        const ticked = chosen ? new Set(rows.filter((row) => chosen.has(row.id)).map((row) => row.id)) : new Set(rows.map((row) => row.id))
        return { format: each, rows, ticked, locked: ticked.size === 1 ? ([...ticked][0] ?? null) : null }
      })
      .filter((group) => group.rows.length > 0),
  )

  function toggle(each: MonitoredFormat, id: number) {
    const group = groups.value.find((entry) => entry.format === each)
    if (!group) return
    const next = new Set(group.ticked)
    if (next.has(id)) {
      if (next.size === 1) return
      next.delete(id)
    } else {
      next.add(id)
    }
    selection.value = { ...selection.value, [each]: next.size === group.rows.length ? null : next }
  }

  function useAll() {
    selection.value = emptySelection()
  }

  /** Undefined when no list is available, so the request keeps whatever each work's request already has. */
  function payloadFor(requested: MonitoredFormat[]): MonitoredBulkRequestPayload['sources'] {
    if (sources.value.length === 0) return undefined
    const result: NonNullable<MonitoredBulkRequestPayload['sources']> = {}
    for (const each of requested) {
      const chosen = selection.value[each]
      const ids = chosen
        ? carriers(each)
            .filter((source) => chosen.has(source.id))
            .map((source) => source.id)
        : []
      result[each] = ids.length > 0 ? ids : null
    }
    return result
  }

  return { groups, toggle, useAll, payloadFor }
}
