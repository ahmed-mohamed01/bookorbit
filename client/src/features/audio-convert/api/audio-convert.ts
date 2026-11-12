// Fork: Convert to M4B. Thin wrappers over /api/v1/audio-convert; see packages/types/src/audio-convert.ts.
import { api } from '@/lib/api'
import type {
  AudioConvertBookRunRequest,
  AudioConvertEnabledResponse,
  AudioConvertJob,
  AudioConvertPlan,
  AudioConvertPlanStatus,
  AudioConvertPreviewPage,
  AudioConvertRunRequest,
  AudioConvertRunResponse,
  AudioConvertSettings,
  AudioConvertStatus,
  UpdateAudioConvertSettingsPayload,
} from '@bookorbit/types'

const BASE = '/api/v1/audio-convert'

/** Carries the status code so callers can report a failure without inventing English copy. */
export class AudioConvertHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'AudioConvertHttpError'
  }
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return ''
  return '?' + new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()
}

async function getJson<T>(path: string): Promise<T> {
  const res = await api(path)
  if (!res.ok) throw new AudioConvertHttpError(res.status)
  return res.json() as Promise<T>
}

async function sendJson<T>(path: string, method: 'POST' | 'PATCH', body?: unknown): Promise<T> {
  const res = await api(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new AudioConvertHttpError(res.status)
  return res.json() as Promise<T>
}

export function fetchAudioConvertEnabled(): Promise<AudioConvertEnabledResponse> {
  return getJson(`${BASE}/enabled`)
}

export function fetchAudioConvertPreview(
  libraryId: number,
  page: number,
  pageSize: number,
  status?: AudioConvertPlanStatus,
  search?: string,
): Promise<AudioConvertPreviewPage> {
  const query = toQuery({ page, pageSize, status, search: search?.trim() || undefined })
  return getJson(`${BASE}/libraries/${libraryId}/preview${query}`)
}

/** Omitting both id lists converts every candidate; see {@link AudioConvertRunRequest}. */
export function runAudioConvert(libraryId: number, request: AudioConvertRunRequest): Promise<AudioConvertRunResponse> {
  return sendJson(`${BASE}/libraries/${libraryId}/run`, 'POST', request)
}

export function fetchAudioConvertStatus(libraryId: number): Promise<AudioConvertStatus> {
  return getJson(`${BASE}/libraries/${libraryId}/status`)
}

/** Cancels queued jobs; the one already running finishes. */
export function stopAudioConvert(libraryId: number): Promise<{ cancelled: number }> {
  return sendJson(`${BASE}/libraries/${libraryId}/stop`, 'POST')
}

export function fetchAudioConvertPlan(bookId: number): Promise<AudioConvertPlan> {
  return getJson(`${BASE}/books/${bookId}/convert`)
}

export function convertBook(bookId: number, request: AudioConvertBookRunRequest): Promise<AudioConvertJob> {
  return sendJson(`${BASE}/books/${bookId}/convert`, 'POST', request)
}

export function stopBookConvert(bookId: number): Promise<{ cancelled: boolean }> {
  return sendJson(`${BASE}/books/${bookId}/convert/stop`, 'POST')
}

export function skipAudioConvertJob(jobId: string): Promise<AudioConvertJob> {
  return sendJson(`${BASE}/jobs/${encodeURIComponent(jobId)}/skip`, 'POST')
}

export function convertAudioConvertJobNow(jobId: string): Promise<AudioConvertJob> {
  return sendJson(`${BASE}/jobs/${encodeURIComponent(jobId)}/convert-now`, 'POST')
}

export function fetchAudioConvertSettings(): Promise<AudioConvertSettings> {
  return getJson(`${BASE}/settings`)
}

export function updateAudioConvertSettings(payload: UpdateAudioConvertSettingsPayload): Promise<AudioConvertSettings> {
  return sendJson(`${BASE}/settings`, 'PATCH', payload)
}
