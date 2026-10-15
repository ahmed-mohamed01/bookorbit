import { i18n } from '@/i18n'
import { api } from '@/lib/api'
import { ApiError, apiError, apiJson, apiSend, jsonBody } from '@/lib/api-json'
import { bookRequestActionErrorCode, bookRequestSubmitErrorCode } from '@bookorbit/types'
import { RequestRefusal } from '../lib/messageOf'
import type {
  BookRequestFailureMeta,
  BookRequestItem,
  BookRequestSourceStatus,
  BookRequestSubmitResult,
  CreateBookRequestPayload,
  RecordWebSerialPublishedRequestInput,
  ReleaseSearchResult,
  WebSerialKind,
  WebSerialPublishedRequest,
} from '@bookorbit/types'

/** The Book Requests API, called as any requester would. Nothing here reaches past those routes. */
const REQUESTS = '/api/v1/book-requests'
const ADMIN_REQUESTS = '/api/v1/admin/book-requests'
const SERIALS = '/api/v1/web-serials'

export async function fetchRequestSourceStatus(): Promise<BookRequestSourceStatus> {
  return apiJson(`${REQUESTS}/source-status`, undefined, 'webSerials.api.requestSourceStatus')
}

/** One of the caller's requests, or null when it is gone or is not theirs to see. */
export async function fetchBookRequest(id: number): Promise<BookRequestItem | null> {
  const response = await api(`${REQUESTS}/${id}`)
  if (response.status === 404 || response.status === 403) return null
  if (!response.ok) throw await apiError(response, 'webSerials.api.request')
  return (await response.json()) as BookRequestItem
}

export async function fetchPublishedRequests(kind: WebSerialKind, matchId: string): Promise<WebSerialPublishedRequest[]> {
  const params = new URLSearchParams({ kind, matchId })
  return apiJson(`${SERIALS}/published-requests?${params.toString()}`, undefined, 'webSerials.api.requests')
}

export async function recordPublishedRequest(input: RecordWebSerialPublishedRequestInput): Promise<void> {
  await apiSend(`${SERIALS}/published-requests`, jsonBody('POST', input), 'webSerials.api.recordRequest')
}

interface RequestFailureBody {
  message?: string | string[]
  errorCode?: unknown
  errorMeta?: BookRequestFailureMeta
}

async function readFailure(response: Response): Promise<RequestFailureBody | null> {
  return (await response.json().catch(() => null)) as RequestFailureBody | null
}

/** A refused create, worded as the Requests page words it: the code's catalog text first, the server's sentence second. */
export async function createVolumeRequest(payload: CreateBookRequestPayload): Promise<BookRequestSubmitResult> {
  const response = await api(REQUESTS, jsonBody('POST', payload))
  if (response.ok) return (await response.json()) as BookRequestSubmitResult
  const body = await readFailure(response)
  const code = bookRequestSubmitErrorCode(body?.errorCode)
  const message = (Array.isArray(body?.message) ? body.message[0] : body?.message) ?? null
  const text = code ? i18n.global.t(`bookRequests.submitError.${code}`, body?.errorMeta ?? {}) : message
  throw new ApiError(text ?? i18n.global.t('webSerials.api.requestVolume'), response.status, code, message)
}

/** App-authored refusals have catalog text; a tracker's or client's own sentence stays as it is. */
function localizedActionFailure(errorCode: unknown, meta: BookRequestFailureMeta): string | null {
  const actionCode = bookRequestActionErrorCode(errorCode)
  if (actionCode) return i18n.global.t(`bookRequests.actionError.${actionCode}`, meta)
  const submitCode = bookRequestSubmitErrorCode(errorCode)
  return submitCode ? i18n.global.t(`bookRequests.submitError.${submitCode}`, meta) : null
}

/**
 * A refused grab or cancel, read the way the Requests page reads it: an app-authored code in the
 * reader's language, otherwise the tracker's or client's own sentence about this one release.
 */
async function requestActionRefusal(response: Response, fallbackKey: string): Promise<ApiError> {
  const body = await readFailure(response)
  const joined = Array.isArray(body?.message) ? body.message.join('. ') : body?.message
  const reason = joined?.trim() ? joined.trim() : null
  const errorCode = typeof body?.errorCode === 'string' ? body.errorCode : null
  const text = localizedActionFailure(errorCode, body?.errorMeta ?? {}) ?? reason
  if (!text) return new ApiError(i18n.global.t(fallbackKey), response.status, errorCode, null)
  return new RequestRefusal(text, response.status, errorCode, reason)
}

async function postRequestAction(path: string, body: unknown, fallbackKey: string): Promise<BookRequestItem> {
  const response = await api(path, jsonBody('POST', body))
  if (!response.ok) throw await requestActionRefusal(response, fallbackKey)
  return (await response.json()) as BookRequestItem
}

export async function cancelVolumeRequest(id: number): Promise<BookRequestItem> {
  return postRequestAction(`${REQUESTS}/${id}/cancel`, {}, 'webSerials.api.cancelRequest')
}

/** The request's ranked release list, from the server's short-lived cache when it has one. */
export async function fetchRequestReleases(requestId: number): Promise<ReleaseSearchResult> {
  return apiJson(`${ADMIN_REQUESTS}/${requestId}/releases`, undefined, 'webSerials.api.releases')
}

export async function grabRequestRelease(requestId: number, indexerId: number, releaseGuid: string): Promise<BookRequestItem> {
  return postRequestAction(`${ADMIN_REQUESTS}/${requestId}/grab`, { indexerId, releaseGuid }, 'webSerials.api.grab')
}
