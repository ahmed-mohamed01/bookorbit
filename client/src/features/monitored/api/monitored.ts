import { api } from '@/lib/api'
import { readApiErrorDetail } from '@/lib/api-error'
import type {
  MonitoredCatalogSearchHit,
  HardcoverUniversalSearchResult,
  BookRequestItem,
  MonitorAuthorRequest,
  MonitoredAuthorListSort,
  MonitoredAuthorDetail,
  MonitoredAuthorItem,
  MonitoredAuthorSearchResult,
  MonitoredBookWork,
  MonitoredBulkRequestPayload,
  MonitoredBulkRequestResponse,
  MonitoredBulkUpdatePayload,
  MonitoredBulkUpdateResponse,
  MonitoredFormat,
  MonitoredLocalAuthorLookup,
  MonitoredListOrder,
  MonitoredPage,
  MonitoredReleaseDateLookup,
  MonitoredReleaseFilter,
  MonitoredReleasePage,
  MonitoredReleaseListSort,
  MonitoredSort,
  MonitoredStatusFilter,
  MonitoredWork,
  MonitoredWorkMatchPayload,
  MonitoredWorkPatch,
  MonitoredWorkReleasesResponse,
  MonitoredSummary,
  RequestFromWorkPayload,
  RequestSourceOption,
  SetMonitoredReleaseDatePayload,
  UpdateMonitoredAuthorRequest,
  BookSearchOption,
} from '@bookorbit/types'
import { MonitoredApiError } from '../lib/api-error'
import { statusFilterQuery } from '../lib/status-filter'

const BASE_PATH = '/api/v1/monitored'

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new MonitoredApiError(response.status, await readApiErrorDetail(response))
  return response.json() as Promise<T>
}

async function assertOk(response: Response): Promise<void> {
  if (!response.ok) throw new MonitoredApiError(response.status, await readApiErrorDetail(response))
}

export async function fetchMonitoredSummary(): Promise<MonitoredSummary> {
  return readJson(await api(BASE_PATH))
}

/** The viewer's watchlist entry for a library book, or null when the book is not on it. */
export async function fetchMonitoredBookWork(bookId: number): Promise<MonitoredBookWork | null> {
  const response = await api(`${BASE_PATH}/works/by-book/${bookId}`)
  if (response.status === 404) return null
  return readJson(response)
}

function pageQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  return query.toString()
}

export async function fetchMonitoredAuthors(options: {
  q?: string
  page: number
  size: number
  sort: MonitoredAuthorListSort
  order: MonitoredListOrder
}): Promise<MonitoredPage<MonitoredAuthorItem>> {
  return readJson(await api(`${BASE_PATH}/authors?${pageQuery(options)}`))
}

export async function fetchOwnedMonitoredAuthorIds(page: number, size: number): Promise<MonitoredPage<string>> {
  return readJson(await api(`${BASE_PATH}/authors/ids?${pageQuery({ page, size })}`))
}

/** Which of these library authors the viewer monitors, keyed by library author id. */
export async function fetchMonitoredLocalAuthors(authorIds: number[]): Promise<MonitoredLocalAuthorLookup> {
  if (authorIds.length === 0) return {}
  return readJson(await api(`${BASE_PATH}/authors/by-local?${pageQuery({ authorIds: authorIds.join(',') })}`))
}

export async function monitorAuthor(payload: MonitorAuthorRequest): Promise<MonitoredAuthorDetail> {
  return readJson(
    await api(`${BASE_PATH}/authors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function fetchMonitoredAuthorDetail(
  id: string,
  options: { sort: MonitoredSort; order: 'asc' | 'desc'; includeHidden?: boolean; status?: MonitoredStatusFilter[] },
): Promise<MonitoredAuthorDetail> {
  const query = new URLSearchParams({ sort: options.sort, order: options.order })
  if (options.includeHidden) query.set('includeHidden', 'true')
  if (options.status?.length) query.set('status', statusFilterQuery(options.status))
  return readJson(await api(`${BASE_PATH}/authors/${encodeURIComponent(id)}?${query}`))
}

export async function updateMonitoredAuthor(id: string, payload: UpdateMonitoredAuthorRequest): Promise<MonitoredAuthorItem> {
  return readJson(
    await api(`${BASE_PATH}/authors/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function deleteMonitoredAuthor(id: string): Promise<void> {
  await assertOk(await api(`${BASE_PATH}/authors/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

export async function refreshMonitoredAuthor(id: string): Promise<MonitoredAuthorDetail> {
  return readJson(await api(`${BASE_PATH}/authors/${encodeURIComponent(id)}/refresh`, { method: 'POST' }))
}

export async function fetchMonitoredReleases(options: {
  q?: string
  page: number
  size: number
  sort: MonitoredReleaseListSort
  order: MonitoredListOrder
  filter: MonitoredReleaseFilter
  /** Absent lists every visible, watched release. */
  status?: MonitoredStatusFilter[]
}): Promise<MonitoredReleasePage> {
  const { status, ...rest } = options
  return readJson(await api(`${BASE_PATH}/releases?${pageQuery({ ...rest, status: status?.length ? statusFilterQuery(status) : undefined })}`))
}

export async function searchMonitoredAuthors(query: string): Promise<MonitoredAuthorSearchResult[]> {
  const search = new URLSearchParams({ q: query })
  return readJson(await api(`${BASE_PATH}/search?${search}`))
}

export async function requestMonitoredWork(workId: string, payload: RequestFromWorkPayload): Promise<MonitoredWork> {
  return readJson(
    await api(`${BASE_PATH}/works/${encodeURIComponent(workId)}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function searchWorkReleases(workId: string, format: MonitoredFormat): Promise<MonitoredWorkReleasesResponse> {
  return readJson(
    await api(`${BASE_PATH}/works/${encodeURIComponent(workId)}/releases/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format }),
    }),
  )
}

/** Resolves to the book request the download now runs under, so the caller can open its progress. */
export async function grabWorkRelease(
  workId: string,
  payload: { format: MonitoredFormat; indexerId: number; releaseGuid: string },
): Promise<BookRequestItem> {
  return readJson(
    await api(`${BASE_PATH}/works/${encodeURIComponent(workId)}/releases/grab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

/** What every provider the on-demand lookup can reach says about one format's release date. */
export async function fetchWorkReleaseDateCandidates(workId: string, format: MonitoredFormat): Promise<MonitoredReleaseDateLookup> {
  return readJson(await api(`${BASE_PATH}/works/${encodeURIComponent(workId)}/release-dates/${format}/candidates`))
}

/** A full date sets the owner's choice; null clears it and hands the format back to the automatic check. */
export async function setWorkReleaseDate(workId: string, format: MonitoredFormat, releaseDate: string | null): Promise<MonitoredWork> {
  const payload: SetMonitoredReleaseDatePayload = { releaseDate }
  return readJson(
    await api(`${BASE_PATH}/works/${encodeURIComponent(workId)}/release-dates/${format}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

/** Answers 429 when asked again too soon, and 409 when release checking is switched off in settings. */
export async function refreshWorkReleaseDates(workId: string): Promise<MonitoredWork> {
  return readJson(await api(`${BASE_PATH}/works/${encodeURIComponent(workId)}/release-dates/refresh`, { method: 'POST' }))
}

/** The owner's answer about which library book is one format of a work; answers with the rematched work. */
export async function setMonitoredWorkMatch(workId: string, format: MonitoredFormat, payload: MonitoredWorkMatchPayload): Promise<MonitoredWork> {
  return readJson(
    await api(`${BASE_PATH}/works/${encodeURIComponent(workId)}/match/${format}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

/** The viewer's own library search, already scoped to the libraries they can open. */
/** The most results the library search returns for one query. */
export const LIBRARY_SEARCH_LIMIT = 20

export async function searchLibraryBooks(query: string, signal?: AbortSignal): Promise<BookSearchOption[]> {
  const params = new URLSearchParams({ q: query, limit: String(LIBRARY_SEARCH_LIMIT) })
  return readJson(await api(`/api/v1/books/search?${params.toString()}`, { signal }))
}

export async function updateMonitoredWork(workId: string, patch: MonitoredWorkPatch): Promise<MonitoredWork> {
  return readJson(
    await api(`${BASE_PATH}/works/${encodeURIComponent(workId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function bulkRequestMonitoredWorks(payload: MonitoredBulkRequestPayload): Promise<MonitoredBulkRequestResponse> {
  return readJson(
    await api(`${BASE_PATH}/works/bulk-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function bulkUpdateMonitoredWorks(payload: MonitoredBulkUpdatePayload): Promise<MonitoredBulkUpdateResponse> {
  return readJson(
    await api(`${BASE_PATH}/works/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function fetchRequestSources(): Promise<RequestSourceOption[]> {
  return readJson(await api('/api/v1/book-request-sources'))
}

export async function searchCatalogWorks(q: string, limit: number, signal?: AbortSignal): Promise<MonitoredCatalogSearchHit[]> {
  try {
    return await readJson(await api(`${BASE_PATH}/catalog/search?${new URLSearchParams({ q, limit: String(limit) })}`, { signal }))
  } catch {
    return []
  }
}

export async function searchHardcoverUniversal(q: string, signal?: AbortSignal): Promise<HardcoverUniversalSearchResult> {
  try {
    return await readJson(await api(`${BASE_PATH}/hardcover/search?${new URLSearchParams({ q })}`, { signal }))
  } catch {
    return { available: true, books: [], authors: [] }
  }
}
