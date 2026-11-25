import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type {
  BookKnowledgeAskResponse,
  BookKnowledgeCardResponse,
  BookKnowledgeScope,
  BookKnowledgeStatus,
  BookKnowledgeTerm,
  BookKnowledgeTermDetail,
  BookKnowledgeTerms,
  BookKnowledgeTermType,
} from '@bookorbit/types'
import { api } from '@/lib/api'

export type KnowledgeError = 'busy' | 'budget' | 'readerCap' | 'request'
const modelLimits: Record<string, KnowledgeError> = { budget: 'budget', 'reader-cap': 'readerCap' }
async function errorFor(response: Response): Promise<KnowledgeError> {
  if (response.status === 503) return 'busy'
  if (response.status !== 429) return 'request'
  const body = (await response.json().catch(() => null)) as { errorCode?: unknown } | null
  return modelLimits[String(body?.errorCode)] ?? 'busy'
}

export function useBookKnowledge(bookId: MaybeRefOrGetter<number>) {
  const scope = ref<BookKnowledgeScope>('position')
  const status = ref<BookKnowledgeStatus | null>(null)
  const query = ref('')
  const type = ref<BookKnowledgeTermType>('concept')
  const terms = ref<BookKnowledgeTerm[]>([])
  const total = ref(0)
  const selectedKey = ref<string | null>(null)
  const detail = ref<BookKnowledgeTermDetail | null>(null)
  const cardFailed = ref(false)
  const card = ref<BookKnowledgeCardResponse | null>(null)
  const answer = ref<BookKnowledgeAskResponse | null>(null)
  const error = ref<KnowledgeError | null>(null)
  const pending = ref(new Set<string>())
  const controllers = new Map<string, AbortController>()
  let poll: ReturnType<typeof setTimeout> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let delay = 1000
  let disposed = false
  let termsFailed = false
  const busy = computed(() => pending.value.size > 0)
  const asking = computed(() => pending.value.has('ask'))
  const enabled = computed(() => status.value?.enabled !== false)
  const indexing = computed(() => status.value?.status === 'queued' || status.value?.status === 'running')
  const polling = computed(() => indexing.value || (status.value?.status === 'stale' && enabled.value))
  const hasMore = computed(() => terms.value.length < total.value)
  const base = () => `/api/v1/books/${toValue(bookId)}/knowledge`

  function cancel(channel: string) {
    controllers.get(channel)?.abort()
    controllers.delete(channel)
    pending.value = new Set([...pending.value].filter((key) => key !== channel))
  }
  async function request<T>(channel: string, path: string, method = 'GET', body?: unknown): Promise<T | undefined> {
    cancel(channel)
    const controller = new AbortController()
    controllers.set(channel, controller)
    pending.value = new Set([...pending.value, channel])
    error.value = null
    try {
      const response = await api(`${base()}${path}${path.includes('?') ? '&' : '?'}scope=${scope.value}`, {
        method,
        signal: controller.signal,
        ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      if (!response.ok) {
        if (response.status === 409 && channel !== 'status') {
          if (!controller.signal.aborted && !disposed) void refreshStatus()
          return
        }
        const reason = await errorFor(response)
        if (!controller.signal.aborted && !disposed) error.value = reason
        return
      }
      const data = (await response.json()) as T
      if (!controller.signal.aborted && !disposed) return data
    } catch {
      if (!controller.signal.aborted && !disposed) error.value = 'request'
    } finally {
      if (controllers.get(channel) === controller) cancel(channel)
    }
  }
  async function loadTerms(append = false) {
    if (append && pending.value.has('terms')) return
    const params = new URLSearchParams({ type: type.value, q: query.value.trim(), limit: '50', offset: String(append ? terms.value.length : 0) })
    const data = await request<BookKnowledgeTerms>('terms', `/terms?${params}`)
    if (data) {
      terms.value = append ? [...terms.value, ...data.items] : data.items
      total.value = data.total
      termsFailed = false
    } else if (error.value) termsFailed = true
  }
  async function refreshStatus() {
    clearTimeout(poll)
    const data = await request<BookKnowledgeStatus>('status', '')
    if (!data) return
    const wasReady = status.value?.status === 'ready'
    status.value = data
    if (polling.value) {
      poll = setTimeout(refreshStatus, delay)
      delay = Math.min(delay * 1.5, 15000)
    } else {
      delay = 1000
      if (data.status === 'ready' && (!wasReady || termsFailed)) await loadTerms()
    }
  }
  async function build() {
    const data = await request<BookKnowledgeStatus>('build', '/build', 'POST', {})
    if (data) {
      delay = 1000
      await refreshStatus()
    }
  }
  async function loadCard() {
    if (!selectedKey.value || !status.value?.modelConfigured) return
    card.value = null
    cardFailed.value = false
    const data = await request<BookKnowledgeCardResponse>('card', `/terms/${encodeURIComponent(selectedKey.value)}/card`, 'POST', {})
    if (data) card.value = data
    else if (error.value) cardFailed.value = true
  }
  async function selectTerm(key: string) {
    cancel('card')
    cardFailed.value = false
    selectedKey.value = key
    detail.value = null
    card.value = null
    const data = await request<BookKnowledgeTermDetail>('detail', `/terms/${encodeURIComponent(key)}`)
    if (data) {
      detail.value = data
      await loadCard()
    }
  }
  function closeTerm() {
    cancel('detail')
    cancel('card')
    cardFailed.value = false
    selectedKey.value = null
    detail.value = null
    card.value = null
  }
  async function ask(question: string) {
    if (!question.trim() || !status.value?.modelConfigured) return
    answer.value = null
    const data = await request<BookKnowledgeAskResponse>('ask', '/ask', 'POST', { question: question.trim() })
    if (data) answer.value = data
  }
  function loadMore() {
    return loadTerms(true)
  }
  watch([query, type], () => {
    cancel('terms')
    clearTimeout(debounce)
    terms.value = []
    total.value = 0
    debounce = setTimeout(() => {
      if (status.value?.status === 'ready') void loadTerms()
    }, 350)
  })
  watch(
    [() => toValue(bookId), scope],
    () => {
      clearTimeout(poll)
      clearTimeout(debounce)
      for (const channel of controllers.keys()) cancel(channel)
      termsFailed = false
      status.value = null
      terms.value = []
      total.value = 0
      answer.value = null
      closeTerm()
      delay = 1000
      void refreshStatus()
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(() => {
    disposed = true
    clearTimeout(poll)
    clearTimeout(debounce)
    for (const channel of controllers.keys()) cancel(channel)
  })
  return {
    scope,
    status,
    query,
    type,
    terms,
    total,
    selectedKey,
    detail,
    card,
    cardFailed,
    answer,
    error,
    busy,
    asking,
    enabled,
    pending,
    indexing,
    hasMore,
    refreshStatus,
    build,
    loadMore,
    selectTerm,
    closeTerm,
    loadCard,
    ask,
  }
}
