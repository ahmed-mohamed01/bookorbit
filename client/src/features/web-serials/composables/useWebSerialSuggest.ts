import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { WebSerialSuggestion } from '@bookorbit/types'
import { suggestSerials } from '../api/webSerials'

export const SUGGEST_DEBOUNCE_MS = 150
export const SUGGEST_MIN_LENGTH = 2

/**
 * Autocomplete over the light novel index for the search box: debounced, the previous request aborted, and keyboard
 * navigation state (`highlighted`) kept here so the component only renders it. A failed request just shows nothing.
 * `focused` keeps the list to what the user types: code that fills the box (a restored search, a link from the URL)
 * never opens it.
 */
export function useWebSerialSuggest(query: Ref<string>, enabled: Ref<boolean>, focused: Ref<boolean> = ref(true)) {
  const suggestions = ref<WebSerialSuggestion[]>([])
  const open = ref(false)
  const highlighted = ref(-1)
  const loading = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let suppressed: string | null = null

  const visible = computed(() => open.value && focused.value && suggestions.value.length > 0)
  const active = computed(() => (highlighted.value >= 0 ? (suggestions.value[highlighted.value] ?? null) : null))

  function cancel(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    controller?.abort()
    controller = null
    loading.value = false
  }

  function clear(): void {
    cancel()
    suggestions.value = []
    highlighted.value = -1
    open.value = false
  }

  async function fetchFor(text: string): Promise<void> {
    controller?.abort()
    const current = new AbortController()
    controller = current
    loading.value = true
    try {
      const result = await suggestSerials(text, current.signal)
      if (current.signal.aborted) return
      suggestions.value = result.suggestions
      highlighted.value = -1
      open.value = focused.value && result.suggestions.length > 0
    } catch {
      if (current.signal.aborted) return
      suggestions.value = []
      open.value = false
    } finally {
      if (controller === current) {
        controller = null
        loading.value = false
      }
    }
  }

  watch([query, enabled], ([value, on]) => {
    const text = value.trim()
    if (suppressed !== null && text === suppressed) return
    suppressed = null
    if (!on || !focused.value || text.length < SUGGEST_MIN_LENGTH || /^https?:\/\//i.test(text)) {
      clear()
      return
    }
    cancel()
    timer = setTimeout(() => {
      timer = null
      void fetchFor(text)
    }, SUGGEST_DEBOUNCE_MS)
  })

  function move(step: 1 | -1): void {
    if (suggestions.value.length === 0) return
    open.value = true
    const count = suggestions.value.length
    highlighted.value = highlighted.value < 0 ? (step === 1 ? 0 : count - 1) : (highlighted.value + step + count) % count
  }

  function highlight(index: number): void {
    highlighted.value = index
  }

  function close(): void {
    open.value = false
    highlighted.value = -1
  }

  /** Closes the list and keeps it closed for the text a choice or a submit put in the box. */
  function settle(text = query.value.trim()): void {
    suppressed = text
    clear()
  }

  onBeforeUnmount(cancel)

  return { suggestions, open, visible, highlighted, active, loading, move, highlight, close, settle, clear }
}
