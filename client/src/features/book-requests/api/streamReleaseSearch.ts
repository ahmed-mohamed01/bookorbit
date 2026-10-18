import { api } from '@/lib/api'
import { readApiErrorDetail } from '@/lib/api-error'
import { readSseEvents } from '@/lib/sse'
import { RELEASE_SEARCH_ERROR_EVENT, RELEASE_SEARCH_PROGRESS_EVENT, RELEASE_SEARCH_RESULT_EVENT } from '@bookorbit/types'
import type { ReleaseSearchProgress, ReleaseSearchResult, StreamBookRequestReleasesPayload } from '@bookorbit/types'

/**
 * A manual release search that never reached its result: refused before the stream opened, failed
 * midway, or cut short. The status and the server's own sentence are carried for callers that
 * surface them, such as the monitored panel's error text.
 */
export class ReleaseSearchStreamError extends Error {
  readonly status: number | null
  readonly serverMessage: string | null

  constructor(message: string, status: number | null, serverMessage: string | null) {
    super(message)
    this.name = 'ReleaseSearchStreamError'
    this.status = status
    this.serverMessage = serverMessage
  }
}

function errorEventMessage(data: unknown): string | null {
  const message = (data as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.trim() ? message : null
}

/**
 * Runs one manual release search over its SSE stream, handing each merged snapshot to `onProgress`
 * as sources answer, and resolving to the final ranked list once every source has.
 */
export async function streamReleaseSearch(
  path: string,
  body: StreamBookRequestReleasesPayload,
  onProgress: (progress: ReleaseSearchProgress) => void,
  signal?: AbortSignal,
): Promise<ReleaseSearchResult> {
  const res = await api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new ReleaseSearchStreamError('release search refused', res.status, await readApiErrorDetail(res))

  let result: ReleaseSearchResult | null = null
  await readSseEvents(res, (event, data) => {
    if (event === RELEASE_SEARCH_PROGRESS_EVENT) onProgress(data as ReleaseSearchProgress)
    else if (event === RELEASE_SEARCH_RESULT_EVENT) result = data as ReleaseSearchResult
    else if (event === RELEASE_SEARCH_ERROR_EVENT) {
      const message = errorEventMessage(data)
      throw new ReleaseSearchStreamError(message ?? 'release search failed', res.status, message)
    }
  })
  if (!result) throw new ReleaseSearchStreamError('release search ended without a result', res.status, null)
  return result
}
