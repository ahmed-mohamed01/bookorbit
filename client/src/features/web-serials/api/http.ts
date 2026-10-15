import { i18n } from '@/i18n'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/api-json'

export { jsonBody } from '@/lib/api-json'

interface WebSerialErrorBody {
  errorCode?: unknown
  errorMeta?: unknown
  message?: unknown
}

/** An `ApiError` that keeps the code's `errorMeta`, for a caller that acts on it (a retry delay, a limit). */
export class WebSerialApiError extends ApiError {
  readonly meta: Record<string, string | number>

  constructor(message: string, status: number, errorCode: string | null, serverMessage: string | null, meta: Record<string, string | number>) {
    super(message, status, errorCode, serverMessage)
    this.meta = meta
  }
}

/**
 * The shared `apiError`, plus the code's `errorMeta`: Web Serials codes name the source, service, format or limit they
 * are about, and their catalog text has a placeholder for it.
 */
export async function webSerialsApiError(response: Response, fallbackKey: string): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as WebSerialErrorBody | null
  const errorCode = typeof body?.errorCode === 'string' ? body.errorCode : null
  const serverMessage = typeof body?.message === 'string' && body.message.trim() ? body.message : null
  const key = errorCode ? `errors.codes.${errorCode}` : null
  const meta = scalarParams(body?.errorMeta)
  const text = key && i18n.global.te(key) ? i18n.global.t(key, meta) : i18n.global.t(fallbackKey)
  return new WebSerialApiError(text, response.status, errorCode, serverMessage, meta)
}

function scalarParams(value: unknown): Record<string, string | number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string' || typeof item === 'number'))
}

export async function apiJson<T>(input: RequestInfo | URL, init: RequestInit | undefined, fallbackKey: string): Promise<T> {
  const response = await api(input, init)
  if (!response.ok) throw await webSerialsApiError(response, fallbackKey)
  return (await response.json()) as T
}

export async function apiSend(input: RequestInfo | URL, init: RequestInit | undefined, fallbackKey: string): Promise<void> {
  const response = await api(input, init)
  if (!response.ok) throw await webSerialsApiError(response, fallbackKey)
}
