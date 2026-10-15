import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { WebSerialSeriesDetail } from '@bookorbit/types'
import { fetchSeries } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'
import { isAbort, loadWhileSeriesLoads } from '../lib/seriesLoading'

/**
 * Picking another source swaps the shown series without leaving the sheet. A newly opened series clears that choice,
 * and a token drops the answer of a switch that was overtaken. `matchId` is the series-database id when the sheet was
 * opened from a search result, so every source the user switches to is checked against the same library history.
 */
export function useWebSerialSeriesSwitch(opened: Ref<WebSerialSeriesDetail | null>, matchId?: Ref<string | null>) {
  const switched = ref<WebSerialSeriesDetail | null>(null)
  const shown = computed(() => switched.value ?? opened.value)
  const switching = ref(false)
  const switchError = ref<string | null>(null)
  // A failed switch leaves the browser's radio on the wrong card; remounting the list puts it back.
  const renderKey = ref(0)
  /** The site whose long chapter list the server is still loading for the switch. */
  const pendingSource = ref<string | null>(null)
  let token = 0
  let controller: AbortController | null = null

  function cancel(): void {
    token++
    if (switching.value) renderKey.value++
    controller?.abort()
    controller = null
    switching.value = false
    pendingSource.value = null
  }

  watch(opened, () => {
    cancel()
    switched.value = null
    switchError.value = null
  })

  onScopeDispose(cancel)

  async function load(seriesKey: string, sourceName: string | null, mine: number): Promise<WebSerialSeriesDetail> {
    const current = new AbortController()
    controller = current
    const id = matchId?.value ?? undefined
    return loadWhileSeriesLoads(() => fetchSeries(seriesKey, id, current.signal), {
      signal: current.signal,
      onPending: () => {
        if (mine === token) pendingSource.value = sourceName
      },
    })
  }

  /** `beforeApply` runs once the new series is in hand, right before it replaces the shown one. */
  async function select(seriesKey: string, beforeApply: () => void, sourceName: string | null = null): Promise<void> {
    if (switching.value || seriesKey === shown.value?.seriesKey) return
    const mine = ++token
    switching.value = true
    switchError.value = null
    try {
      const next = seriesKey === opened.value?.seriesKey ? opened.value : await load(seriesKey, sourceName, mine)
      if (mine !== token || !next) return
      beforeApply()
      switched.value = next
    } catch (cause) {
      if (mine !== token) return
      renderKey.value++
      if (!isAbort(cause)) switchError.value = messageOf(cause, 'webSerials.preview.sources.switchError')
    } finally {
      if (mine === token) {
        switching.value = false
        pendingSource.value = null
        controller = null
      }
    }
  }

  return { shown, switching, switchError, renderKey, pendingSource, select, cancel }
}
