import type { WebSerialCatalogEntry, WebSerialDiscoverFallback, WebSerialSearchHit } from '@bookorbit/types'
import type { WebSerialSearchScope } from '../api/webSerials'

const STORAGE_KEY = 'bookorbit.webSerials.lastResults'
const SCOPES: readonly WebSerialSearchScope[] = ['all', 'manga', 'novel']
const FALLBACKS: readonly WebSerialDiscoverFallback[] = ['disabled', 'unavailable', 'empty']

/** Both lists are bounded server-side; this only guards the sessionStorage quota. */
export const MAX_STORED_ROWS = 200

/** Results older than this are still shown, but searched again behind them. */
export const STALE_AFTER_MS = 30 * 60_000

export interface StoredWebSerialSearch {
  q: string
  kind: WebSerialSearchScope
  mode: 'series' | 'sites'
  source: string | null
  showMachineTranslations: boolean
  entries: WebSerialCatalogEntry[]
  entriesQuery: string
  mangaHits: WebSerialSearchHit[]
  novelHits: WebSerialSearchHit[]
  failedSources: string[]
  novelSourcesDisabled: boolean
  fallbackReason: WebSerialDiscoverFallback | null
  fetchedAt: number
}

// Outlives the page component so moving around the app and coming back shows the last search with no request.
let memory: StoredWebSerialSearch | null = null
let loadedFromSession = false

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isRows<T>(value: unknown): value is T[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null)
}

function parse(raw: string): StoredWebSerialSearch | null {
  const value = JSON.parse(raw) as Partial<StoredWebSerialSearch> | null
  if (!value || typeof value.q !== 'string' || typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt)) return null
  if (!isRows<WebSerialCatalogEntry>(value.entries) || !isRows<WebSerialSearchHit>(value.mangaHits) || !isRows<WebSerialSearchHit>(value.novelHits)) {
    return null
  }
  return {
    q: value.q,
    kind: SCOPES.find((scope) => scope === value.kind) ?? 'all',
    mode: value.mode === 'sites' ? 'sites' : 'series',
    source: typeof value.source === 'string' && value.source ? value.source : null,
    showMachineTranslations: value.showMachineTranslations === true,
    entries: value.entries,
    entriesQuery: typeof value.entriesQuery === 'string' ? value.entriesQuery : '',
    mangaHits: value.mangaHits,
    novelHits: value.novelHits,
    failedSources: isStrings(value.failedSources) ? value.failedSources : [],
    novelSourcesDisabled: value.novelSourcesDisabled === true,
    fallbackReason: FALLBACKS.find((reason) => reason === value.fallbackReason) ?? null,
    fetchedAt: value.fetchedAt,
  }
}

function writeSession(value: StoredWebSerialSearch | null): void {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* the memory copy still serves page changes */
  }
}

function capped(value: StoredWebSerialSearch): StoredWebSerialSearch {
  return {
    ...value,
    entries: value.entries.slice(0, MAX_STORED_ROWS),
    mangaHits: value.mangaHits.slice(0, MAX_STORED_ROWS),
    novelHits: value.novelHits.slice(0, MAX_STORED_ROWS),
  }
}

export function readStoredSearch(): StoredWebSerialSearch | null {
  if (memory) return memory
  if (loadedFromSession) return null
  loadedFromSession = true
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    memory = raw ? parse(raw) : null
  } catch {
    memory = null
  }
  return memory
}

export function saveStoredSearch(value: StoredWebSerialSearch): void {
  loadedFromSession = true
  memory = capped(value)
  writeSession(memory)
}

export function clearStoredSearch(): void {
  loadedFromSession = true
  memory = null
  writeSession(null)
}

/** Test seam: forget the in-memory copy so the next read goes to sessionStorage, as after a refresh. */
export function resetStoredSearchMemory(): void {
  memory = null
  loadedFromSession = false
}

export function matchesSearch(stored: StoredWebSerialSearch, wanted: { q: string; kind: WebSerialSearchScope; mode: 'series' | 'sites' }): boolean {
  return stored.q.trim().toLowerCase() === wanted.q.trim().toLowerCase() && stored.kind === wanted.kind && stored.mode === wanted.mode
}

export function isStale(stored: StoredWebSerialSearch, now = Date.now()): boolean {
  return now - stored.fetchedAt >= STALE_AFTER_MS
}
