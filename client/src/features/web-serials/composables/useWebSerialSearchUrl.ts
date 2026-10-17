import { onScopeDispose, watch, type Ref } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import type { WebSerialSearchScope } from '../api/webSerials'
import { isSerialLink } from '../lib/serialUrl'
import { MIN_QUERY_LENGTH, type useWebSerialSearch } from './useWebSerialSearch'
import { clearStoredSearch, isStale, matchesSearch, readStoredSearch, saveStoredSearch } from './webSerialSearchStore'

const STORAGE_KEY = 'bookorbit.webSerials.lastSearch'
const OWNER_KEY = 'bookorbit.webSerials.searchOwner'
const SEARCH_PARAMS = ['q', 'kind', 'mode', 'source'] as const
const SCOPES: readonly WebSerialSearchScope[] = ['all', 'manga', 'novel']

interface SavedSearch {
  q: string
  kind: WebSerialSearchScope
  mode: 'series' | 'sites'
  source: string | null
}

type SearchState = ReturnType<typeof useWebSerialSearch>

function single(value: LocationQuery[string] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.length > 0 ? first : null
}

function readSaved(): SavedSearch | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedSearch>
    if (typeof parsed.q !== 'string' || parsed.q.trim().length < MIN_QUERY_LENGTH) return null
    return {
      q: parsed.q,
      kind: SCOPES.find((value) => value === parsed.kind) ?? 'all',
      mode: parsed.mode === 'sites' ? 'sites' : 'series',
      source: typeof parsed.source === 'string' && parsed.source ? parsed.source : null,
    }
  } catch {
    return null
  }
}

function writeSaved(value: SavedSearch | null): void {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* the search stays in the URL only */
  }
}

/**
 * The stored search and its answer belong to whoever ran it. Logging out does not reload the page, so the next user of
 * the same tab would otherwise get the last search and its in-library badges without asking.
 */
function claimStoredSearch(userId: number | null): void {
  if (userId === null) return
  try {
    if (sessionStorage.getItem(OWNER_KEY) === String(userId)) return
    writeSaved(null)
    clearStoredSearch()
    sessionStorage.setItem(OWNER_KEY, String(userId))
  } catch {
    clearStoredSearch()
  }
}

function readUrl(query: LocationQuery): SavedSearch | null {
  const q = single(query.q)
  if (q === null || q.trim().length < MIN_QUERY_LENGTH) return null
  return {
    q,
    kind: SCOPES.find((value) => value === single(query.kind)) ?? 'all',
    mode: single(query.mode) === 'sites' ? 'sites' : 'series',
    source: single(query.source),
  }
}

/** The route query carries the committed search (not the text being typed) so it survives a refresh or leaving the page. */
export function useWebSerialSearchUrl(search: SearchState, userId: Ref<number | null>) {
  const route = useRoute()
  const router = useRouter()
  let committed: string | null = null
  let generation = 0
  let restoring: { key: string; promise: Promise<void> } | undefined
  // A search aborted by leaving the page still returns to its caller; nothing it does afterwards may touch the URL.
  let disposed = false
  claimStoredSearch(userId.value)
  onScopeDispose(() => {
    disposed = true
  })

  function currentState(): SavedSearch | null {
    if (committed === null) return null
    return { q: committed, kind: search.scope.value, mode: search.mode.value, source: search.activeSource.value }
  }

  function writeUrl(state: SavedSearch | null): void {
    if (disposed || route.name !== 'web-serials') return
    const query: LocationQuery = { ...route.query }
    for (const key of SEARCH_PARAMS) delete query[key]
    if (state) {
      query.q = state.q
      query.kind = state.kind
      if (state.mode === 'sites') query.mode = 'sites'
      if (state.source) query.source = state.source
    }
    void router.replace({ name: 'web-serials', query })
  }

  /** The answer behind the committed search is kept so coming back to the page shows it without asking again. */
  function persist(): void {
    if (disposed || committed === null) return
    const snapshot = search.snapshot()
    if (snapshot) saveStoredSearch(snapshot)
  }

  function sync(): void {
    if (disposed) return
    const state = currentState()
    writeSaved(state)
    writeUrl(state)
    persist()
  }

  /** `text` is what was searched, read before the search ran, so typing during a slow search is not committed. */
  function commit(text = search.query.value.trim(), startedAt = generation): void {
    if (startedAt !== generation) return
    if (disposed || isSerialLink(text) || text.length < MIN_QUERY_LENGTH) return
    committed = text
    if (!search.snapshot()) clearStoredSearch()
    sync()
  }

  function syncFilters(): void {
    if (committed !== null) sync()
  }

  async function run(state: SavedSearch): Promise<void> {
    const startedAt = ++generation
    search.setScope(state.kind)
    search.query.value = state.q
    committed = state.q.trim()
    if (state.mode === 'sites') await search.searchSites()
    else await search.submit()
    if (disposed || startedAt !== generation) return
    if (state.source) search.setSource(state.source)
    syncFilters()
  }

  async function showStored(state: SavedSearch): Promise<boolean> {
    const stored = readStoredSearch()
    if (!stored) return false
    if (!matchesSearch(stored, state)) {
      clearStoredSearch()
      return false
    }
    search.restoreSnapshot({ ...stored, source: state.source ?? stored.source })
    committed = state.q.trim()
    syncFilters()
    if (isStale(stored)) {
      await search.refreshInBackground()
      persist()
    }
    return true
  }

  async function restoreState(): Promise<void> {
    const fromUrl = readUrl(route.query)
    if (fromUrl) {
      if (!(await showStored(fromUrl))) await run(fromUrl)
      return
    }
    const saved = single(route.query.tab) === 'queue' ? null : readSaved()
    if (!saved) return
    committed = saved.q.trim()
    writeUrl(saved)
    if (!(await showStored(saved))) await run(saved)
  }

  function restore(): Promise<void> {
    const key = JSON.stringify(readUrl(route.query) ?? readSaved())
    if (restoring?.key === key) return restoring.promise
    const promise = restoreState()
    const pending = { key, promise }
    restoring = pending
    void promise.finally(() => {
      if (restoring === pending) restoring = undefined
    })
    return promise
  }

  /** A new scope chip asks the committed search again under that scope, so the list, URL and stored answer agree. */
  async function rescope(): Promise<void> {
    if (committed === null) return
    await run({ q: committed, kind: search.scope.value, mode: search.mode.value, source: null })
  }

  async function refresh(): Promise<void> {
    await search.refresh()
    persist()
  }

  function clear(): void {
    generation++
    if (committed === null) return
    committed = null
    writeSaved(null)
    clearStoredSearch()
    writeUrl(null)
  }

  watch(
    () => search.query.value,
    (value) => {
      if (value.trim() === '') clear()
    },
  )

  watch(userId, (next) => {
    generation++
    committed = null
    claimStoredSearch(next)
  })

  watch([() => route.name, () => route.query.q, () => route.query.kind], () => {
    if (disposed || route.name !== 'web-serials') return
    const state = readUrl(route.query)
    if (state && (state.q.trim() !== committed || state.kind !== search.scope.value)) void restore()
    else if (route.query.q === undefined && committed !== null) {
      generation++
      committed = null
      writeSaved(null)
      clearStoredSearch()
      search.query.value = ''
    }
  })

  return { beginCommit: () => ++generation, restore, commit, syncFilters, rescope, refresh, persist, clear }
}
