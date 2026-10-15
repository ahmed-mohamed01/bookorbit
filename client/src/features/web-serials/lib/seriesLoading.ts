import { WebSerialErrorCode } from '@bookorbit/types'
import { ApiError } from '@/lib/api-json'
import { WebSerialApiError } from '../api/http'

/** The service gives up on a chapter list after 31 minutes; a little longer covers its last answer. */
export const SERIES_LOADING_LIMIT_MS = 35 * 60_000
const DEFAULT_RETRY_MS = 5_000
const MAX_RETRY_MS = 60_000

/** How long to wait before asking again, or null when `cause` is not "the chapter list is still loading". */
export function seriesLoadingRetryMs(cause: unknown): number | null {
  if (!(cause instanceof ApiError) || cause.errorCode !== WebSerialErrorCode.SeriesLoading) return null
  const raw = cause instanceof WebSerialApiError ? cause.meta.retryAfterMs : undefined
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_RETRY_MS) : DEFAULT_RETRY_MS
}

export function isSeriesLoading(cause: unknown): boolean {
  return seriesLoadingRetryMs(cause) !== null
}

function abortError(): DOMException {
  return new DOMException('The wait for the chapter list was stopped', 'AbortError')
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    function stop() {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}

export interface SeriesLoadingOptions {
  signal?: AbortSignal
  /** Called each time the server answers that the list is still loading, before the wait. */
  onPending?: () => void
  limitMs?: number
}

/**
 * Runs `load`, and while the server says a long chapter list is still loading, waits the delay it gives and asks again.
 * Stops with an AbortError when `signal` aborts, and rethrows the last answer once the limit has passed.
 */
export async function loadWhileSeriesLoads<T>(load: () => Promise<T>, options: SeriesLoadingOptions = {}): Promise<T> {
  const limit = options.limitMs ?? SERIES_LOADING_LIMIT_MS
  const started = Date.now()
  for (;;) {
    try {
      return await load()
    } catch (cause) {
      const delay = seriesLoadingRetryMs(cause)
      if (delay === null || Date.now() - started + delay > limit) throw cause
      if (options.signal?.aborted) throw abortError()
      options.onPending?.()
      await wait(delay, options.signal)
    }
  }
}

export function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}
