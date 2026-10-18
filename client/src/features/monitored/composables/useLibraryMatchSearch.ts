import { ref, watch, type Ref } from 'vue'
import { isAudioFormat, type MonitoredFormat, type BookSearchOption } from '@bookorbit/types'
import { LIBRARY_SEARCH_LIMIT, searchLibraryBooks } from '../api/monitored'

const MIN_QUERY_LENGTH = 2
const DEBOUNCE_MS = 250

/**
 * Library books the owner can link to one format of a watchlist work by hand. Only books holding a
 * file of that format are listed, because a link to a book without one owns nothing.
 */
export function useLibraryMatchSearch(format: Ref<MonitoredFormat>) {
  const query = ref('')
  const results = ref<BookSearchOption[]>([])
  const loading = ref(false)
  const failed = ref(false)
  /** The search hit its result cap and dropped books of the other format, so more may be out of reach. */
  const truncated = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null

  function holdsFormat(book: BookSearchOption): boolean {
    return book.formats.some((fileFormat) => isAudioFormat(fileFormat) === (format.value === 'audiobook'))
  }

  async function run(text: string): Promise<void> {
    controller?.abort()
    const current = new AbortController()
    controller = current
    loading.value = true
    failed.value = false
    try {
      const found = await searchLibraryBooks(text, current.signal)
      if (current.signal.aborted) return
      results.value = found.filter(holdsFormat)
      truncated.value = found.length >= LIBRARY_SEARCH_LIMIT && results.value.length < found.length
    } catch {
      if (current.signal.aborted) return
      results.value = []
      truncated.value = false
      failed.value = true
    } finally {
      if (controller === current) loading.value = false
    }
  }

  watch(query, (text) => {
    if (timer) clearTimeout(timer)
    const trimmed = text.trim()
    if (trimmed.length < MIN_QUERY_LENGTH) {
      controller?.abort()
      results.value = []
      truncated.value = false
      loading.value = false
      failed.value = false
      return
    }
    timer = setTimeout(() => void run(trimmed), DEBOUNCE_MS)
  })

  function reset(initial = ''): void {
    query.value = initial
  }

  return { query, results, loading, failed, truncated, reset, minQueryLength: MIN_QUERY_LENGTH }
}
