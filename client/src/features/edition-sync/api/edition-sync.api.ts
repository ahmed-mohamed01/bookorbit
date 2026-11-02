import { api } from '@/lib/api'
import type {
  EditionSyncAdminSettings,
  EditionSyncAdminStatus,
  EditionSyncBookListQuery,
  EditionSyncBookListResponse,
  EditionSyncBookState,
  EditionSyncClearUnusedResult,
  EditionSyncSettings,
  UpdateEditionSyncAdminSettingsPayload,
  UpdateEditionSyncBookStatePayload,
  UpsertEditionSyncSettingsPayload,
} from '@bookorbit/types'

const BASE = '/api/v1/edition-sync'

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { message?: string }).message ?? '')
  }
  return res.json() as Promise<T>
}

function jsonInit(method: 'PATCH' | 'POST', payload?: unknown): RequestInit {
  return payload === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
}

export async function fetchEditionSyncSettings(): Promise<EditionSyncSettings> {
  return readJson(await api(`${BASE}/settings`))
}

export async function updateEditionSyncSettings(payload: UpsertEditionSyncSettingsPayload): Promise<EditionSyncSettings> {
  return readJson(await api(`${BASE}/settings`, jsonInit('PATCH', payload)))
}

export async function fetchEditionSyncBooks(query: EditionSyncBookListQuery = {}): Promise<EditionSyncBookListResponse> {
  const params = new URLSearchParams()
  if (query.filter) params.set('filter', query.filter)
  if (query.q) params.set('q', query.q)
  if (query.page) params.set('page', String(query.page))
  const search = params.toString()
  return readJson(await api(search ? `${BASE}/books?${search}` : `${BASE}/books`))
}

export async function fetchEditionSyncBookState(bookId: number): Promise<EditionSyncBookState> {
  return readJson(await api(`${BASE}/books/${bookId}/state`))
}

export async function updateEditionSyncBookState(bookId: number, payload: UpdateEditionSyncBookStatePayload): Promise<EditionSyncBookState> {
  return readJson(await api(`${BASE}/books/${bookId}/state`, jsonInit('PATCH', payload)))
}

export async function runEditionSyncBookNow(bookId: number): Promise<EditionSyncBookState> {
  return readJson(await api(`${BASE}/books/${bookId}/run`, jsonInit('POST')))
}

export async function retryEditionSyncBook(bookId: number): Promise<EditionSyncBookState> {
  return readJson(await api(`${BASE}/books/${bookId}/retry`, jsonInit('POST')))
}

export async function fetchEditionSyncAdminStatus(): Promise<EditionSyncAdminStatus> {
  return readJson(await api(`${BASE}/admin/status`))
}

export async function fetchEditionSyncAdminSettings(): Promise<EditionSyncAdminSettings> {
  return readJson(await api(`${BASE}/admin/settings`))
}

export async function updateEditionSyncAdminSettings(payload: UpdateEditionSyncAdminSettingsPayload): Promise<EditionSyncAdminSettings> {
  return readJson(await api(`${BASE}/admin/settings`, jsonInit('PATCH', payload)))
}

export async function startEditionSyncRun(): Promise<EditionSyncAdminStatus> {
  return readJson(await api(`${BASE}/admin/run`, jsonInit('POST')))
}

export async function stopEditionSyncRun(): Promise<EditionSyncAdminStatus> {
  return readJson(await api(`${BASE}/admin/stop`, jsonInit('POST')))
}

export async function clearUnusedEditionSyncData(): Promise<EditionSyncClearUnusedResult> {
  return readJson(await api(`${BASE}/admin/clear-unused`, jsonInit('POST')))
}
