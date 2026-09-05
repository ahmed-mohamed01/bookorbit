import { api } from '@/lib/api'
import { readApiErrorDetail } from '@/lib/api-error'
import type {
  BookRequestItem,
  MonitorAuthorRequest,
  MonitoredAuthorListSort,
  MonitoredAuthorDetail,
  MonitoredAuthorItem,
  MonitoredAuthorSearchResult,
  MonitoredBookItem,
  MonitoredBookListSort,
  MonitoredFormat,
  MonitoredListOrder,
  MonitoredPage,
  MonitoredReleaseFilter,
  MonitoredReleaseItem,
  MonitoredReleaseListSort,
  MonitoredSort,
  MonitoredWork,
  MonitoredWorkPatch,
  MonitoredWorkReleasesResponse,
  MonitoredSummary,
  RequestFromWorkPayload,
  UpdateMonitoredAuthorRequest,
} from '@bookorbit/types'
import { MonitoredApiError } from '../lib/api-error'

const BASE_PATH = '/api/v1/monitored'

export interface CreateMonitoredBookRequest {
  monitorAuthorId: string
  workId: string
  formats: MonitoredFormat[]
}

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
  options: { sort: MonitoredSort; order: 'asc' | 'desc'; includeHidden?: boolean },
): Promise<MonitoredAuthorDetail> {
  const query = new URLSearchParams({ sort: options.sort, order: options.order })
  if (options.includeHidden) query.set('includeHidden', 'true')
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

export async function fetchMonitoredBooks(options: {
  q?: string
  page: number
  size: number
  sort: MonitoredBookListSort
  order: MonitoredListOrder
}): Promise<MonitoredPage<MonitoredBookItem>> {
  return readJson(await api(`${BASE_PATH}/books?${pageQuery(options)}`))
}

export async function createMonitoredBook(payload: CreateMonitoredBookRequest): Promise<MonitoredBookItem> {
  return readJson(
    await api(`${BASE_PATH}/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function updateMonitoredBook(id: string, payload: { paused?: boolean; formats?: MonitoredFormat[] }): Promise<void> {
  await assertOk(
    await api(`${BASE_PATH}/books/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function deleteMonitoredBook(id: string): Promise<void> {
  await assertOk(await api(`${BASE_PATH}/books/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

export async function fetchMonitoredReleases(options: {
  q?: string
  page: number
  size: number
  sort: MonitoredReleaseListSort
  order: MonitoredListOrder
  filter: MonitoredReleaseFilter
}): Promise<MonitoredPage<MonitoredReleaseItem>> {
  return readJson(await api(`${BASE_PATH}/releases?${pageQuery(options)}`))
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

export async function updateMonitoredWork(workId: string, patch: MonitoredWorkPatch): Promise<MonitoredWork> {
  return readJson(
    await api(`${BASE_PATH}/works/${encodeURIComponent(workId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}
