import { api } from '@/lib/api'

/** `too_late`: the build is already importing its read-along and the server refused to stop it. */
export type ReadAlongCancelOutcome = 'cancelled' | 'too_late' | 'failed'

/**
 * `buildId` pins the cancel to that build, so a stale notification never stops a newer build of the pair.
 * `counterpartId` names the edition an unlinked book was built with, since the server cannot find that pair by itself.
 */
export async function cancelReadAlongBuild(bookId: number, buildId?: number, counterpartId?: number): Promise<ReadAlongCancelOutcome> {
  const params = new URLSearchParams()
  if (buildId !== undefined) params.set('buildId', String(buildId))
  if (counterpartId !== undefined) params.set('counterpartId', String(counterpartId))
  const query = params.size === 0 ? '' : `?${params.toString()}`
  try {
    const res = await api(`/api/v1/storyteller/read-along/books/${bookId}/build${query}`, { method: 'DELETE' })
    if (res.status === 409) return 'too_late'
    return res.ok ? 'cancelled' : 'failed'
  } catch {
    return 'failed'
  }
}
