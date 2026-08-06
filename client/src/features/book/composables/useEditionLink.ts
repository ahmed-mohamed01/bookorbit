import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue'
import { isAudioFormat, type EditionLink, type EditionLinkCandidate, type EditionLinkForBook } from '@bookorbit/types'
import { api } from '@/lib/api'

// Re-exported so existing import sites keep resolving these from here, but the single source of truth
// is now @bookorbit/types - the server produces the same contract, so tsc catches any drift.
export type { EditionLink, EditionLinkCandidate }

// The server (edition-link.repository.ts) remains the source of truth for which files count
// toward a link and whether one actually exists or is proposed - that always comes from the
// `for-book/:bookId` response below. This set only pre-filters whether the "Link book" /
// alignment controls attempt a fetch at all and which hint copy to show, so a book with a
// server-recognized format missing here just skips the round trip instead of misbehaving.
const TEXT_FORMATS = new Set(['epub', 'kepub'])
// The book-detail API surfaces the book's primary file with role 'primary' (see book.service:
// `role: f.id === primaryFileId ? 'primary' : f.role`), so a single-file book's only content file
// arrives as 'primary', not 'content'. Both must count or single-file books (most audiobooks, and
// every single-epub ebook) are wrongly treated as having no modality and hide the link/alignment UI.
const CONTENT_ROLES = new Set(['content', 'primary'])
const SEARCH_DEBOUNCE_MS = 250

export type EditionLinkModality = 'text' | 'audio' | 'both' | 'none'

export function getBookLinkModality(files: { format: string | null; role: string }[]): EditionLinkModality {
  let hasText = false
  let hasAudio = false
  for (const file of files) {
    if (!CONTENT_ROLES.has(file.role) || !file.format) continue
    const format = file.format.toLowerCase()
    if (TEXT_FORMATS.has(format)) hasText = true
    if (isAudioFormat(format)) hasAudio = true
  }
  if (hasText && hasAudio) return 'both'
  if (hasText) return 'text'
  if (hasAudio) return 'audio'
  return 'none'
}

interface EditionLinkEntry {
  link: Ref<EditionLink | null>
  proposed: Ref<EditionLinkCandidate | null>
  linkedCounterpart: Ref<EditionLinkCandidate | null>
  candidates: Ref<EditionLinkCandidate[]>
  loading: Ref<boolean>
  searching: Ref<boolean>
  mutating: Ref<boolean>
  error: Ref<string | null>
  searchError: Ref<string | null>
  refCount: number
  loadRequestId: number
  searchRequestId: number
  searchTimer: ReturnType<typeof setTimeout> | null
  pendingSearchResolvers: ((value: EditionLinkCandidate[]) => void)[]
}

// Module-scoped so every control mounted for the same bookId (e.g. LinkBookControl and
// ReadingAlignmentControl side by side) shares one reactive record - linking/unlinking in one
// is reflected in the other without a manual refresh. Entries are ref-counted and dropped once
// the last consumer's scope disposes, so this stays bounded to the books a user actually views.
const entries = new Map<number, EditionLinkEntry>()

function createEntry(): EditionLinkEntry {
  return {
    link: ref(null),
    proposed: ref(null),
    linkedCounterpart: ref(null),
    candidates: ref([]),
    loading: ref(false),
    searching: ref(false),
    mutating: ref(false),
    error: ref(null),
    searchError: ref(null),
    refCount: 0,
    loadRequestId: 0,
    searchRequestId: 0,
    searchTimer: null,
    pendingSearchResolvers: [],
  }
}

// `trackRefCount` is only true when the caller can guarantee a matching release (see useEditionLink
// below): incrementing without a scope to hang onScopeDispose off of would leave this entry's refCount
// permanently above zero, so it would never be reclaimed from the module-scoped `entries` map.
function acquireEntry(bookId: number, trackRefCount: boolean): EditionLinkEntry {
  let entry = entries.get(bookId)
  if (!entry) {
    entry = createEntry()
    entries.set(bookId, entry)
  }
  if (trackRefCount) entry.refCount += 1
  return entry
}

function releaseEntry(bookId: number): void {
  const entry = entries.get(bookId)
  if (!entry) return
  entry.refCount -= 1
  if (entry.refCount <= 0) {
    if (entry.searchTimer) clearTimeout(entry.searchTimer)
    entries.delete(bookId)
  }
}

export function useEditionLink(bookId: number) {
  const scope = getCurrentScope()
  const entry = acquireEntry(bookId, Boolean(scope))

  if (scope) {
    onScopeDispose(() => releaseEntry(bookId))
  }

  async function fetchCounterpartSummary(counterpartId: number): Promise<EditionLinkCandidate | null> {
    try {
      const res = await api(`/api/v1/books/${counterpartId}`)
      if (!res.ok) return null
      const book = (await res.json()) as { id: number; title: string | null; authors: { name: string }[] }
      return { bookId: book.id, title: book.title, authorName: book.authors[0]?.name ?? null, score: 100 }
    } catch {
      return null
    }
  }

  async function loadForBook(): Promise<void> {
    const requestId = ++entry.loadRequestId
    entry.loading.value = true
    entry.error.value = null
    try {
      const res = await api(`/api/v1/edition-links/for-book/${bookId}`)
      if (requestId !== entry.loadRequestId) return
      if (!res.ok) {
        entry.link.value = null
        entry.proposed.value = null
        entry.linkedCounterpart.value = null
        entry.error.value = 'Failed to load edition link'
        return
      }
      const data = (await res.json()) as EditionLinkForBook
      if (requestId !== entry.loadRequestId) return
      entry.link.value = data.link
      entry.proposed.value = data.proposed
      entry.linkedCounterpart.value = data.link
        ? await fetchCounterpartSummary(data.link.textBookId === bookId ? data.link.audioBookId : data.link.textBookId)
        : null
      if (requestId !== entry.loadRequestId) return
    } catch {
      if (requestId !== entry.loadRequestId) return
      entry.link.value = null
      entry.proposed.value = null
      entry.linkedCounterpart.value = null
      entry.error.value = 'Failed to load edition link'
    } finally {
      if (requestId === entry.loadRequestId) entry.loading.value = false
    }
  }

  async function performSearch(query: string, requestId: number): Promise<EditionLinkCandidate[]> {
    try {
      const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''
      const res = await api(`/api/v1/edition-links/candidates/${bookId}${qs}`)
      if (requestId !== entry.searchRequestId) return entry.candidates.value
      if (!res.ok) {
        entry.candidates.value = []
        entry.searchError.value = 'Failed to search for a matching book'
        return []
      }
      const data = (await res.json()) as EditionLinkCandidate[]
      if (requestId !== entry.searchRequestId) return entry.candidates.value
      entry.candidates.value = data
      entry.searchError.value = null
      return data
    } catch {
      if (requestId === entry.searchRequestId) {
        entry.candidates.value = []
        entry.searchError.value = 'Failed to search for a matching book'
      }
      return []
    } finally {
      if (requestId === entry.searchRequestId) entry.searching.value = false
    }
  }

  function searchCandidates(query: string): Promise<EditionLinkCandidate[]> {
    if (entry.searchTimer) clearTimeout(entry.searchTimer)
    const requestId = ++entry.searchRequestId
    entry.searching.value = true
    entry.searchError.value = null
    return new Promise((resolve) => {
      entry.pendingSearchResolvers.push(resolve)
      entry.searchTimer = setTimeout(() => {
        const resolvers = entry.pendingSearchResolvers
        entry.pendingSearchResolvers = []
        void performSearch(query, requestId).then((result) => {
          for (const resolveOne of resolvers) resolveOne(result)
        })
      }, SEARCH_DEBOUNCE_MS)
    })
  }

  function resetSearch(): void {
    if (entry.searchTimer) clearTimeout(entry.searchTimer)
    entry.searchRequestId += 1
    const resolvers = entry.pendingSearchResolvers
    entry.pendingSearchResolvers = []
    for (const resolveOne of resolvers) resolveOne([])
    entry.candidates.value = []
    entry.searching.value = false
    entry.searchError.value = null
  }

  async function linkBook(counterpartId: number): Promise<boolean> {
    entry.mutating.value = true
    entry.error.value = null
    try {
      const res = await api(`/api/v1/edition-links/link/${bookId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counterpartId }),
      })
      if (!res.ok) {
        entry.error.value = 'Failed to link book'
        return false
      }
      const created = (await res.json()) as EditionLink
      entry.link.value = created
      entry.proposed.value = null
      entry.candidates.value = []
      entry.linkedCounterpart.value = await fetchCounterpartSummary(counterpartId)
      return true
    } catch {
      entry.error.value = 'Failed to link book'
      return false
    } finally {
      entry.mutating.value = false
    }
  }

  async function unlink(): Promise<boolean> {
    entry.mutating.value = true
    entry.error.value = null
    try {
      const res = await api(`/api/v1/edition-links/link/${bookId}`, { method: 'DELETE' })
      if (!res.ok) {
        entry.error.value = 'Failed to unlink book'
        return false
      }
      entry.link.value = null
      entry.linkedCounterpart.value = null
      entry.proposed.value = null
      entry.candidates.value = []
      return true
    } catch {
      entry.error.value = 'Failed to unlink book'
      return false
    } finally {
      entry.mutating.value = false
    }
  }

  return {
    link: entry.link,
    proposed: entry.proposed,
    linkedCounterpart: entry.linkedCounterpart,
    candidates: entry.candidates,
    loading: entry.loading,
    searching: entry.searching,
    mutating: entry.mutating,
    error: entry.error,
    searchError: entry.searchError,
    loadForBook,
    searchCandidates,
    linkBook,
    unlink,
    resetSearch,
  }
}
