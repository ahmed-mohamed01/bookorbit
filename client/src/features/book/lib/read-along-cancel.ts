import { api } from '@/lib/api'

/** `too_late`: the build is already importing its read-along and the server refused to stop it. */
export type ReadAlongCancelOutcome = 'cancelled' | 'too_late' | 'failed'

/** `buildId` pins the cancel to that build, so a stale notification never stops a newer build of the pair. */
export async function cancelReadAlongBuild(bookId: number, buildId?: number): Promise<ReadAlongCancelOutcome> {
  const query = buildId === undefined ? '' : `?buildId=${buildId}`
  try {
    const res = await api(`/api/v1/storyteller/read-along/books/${bookId}/build${query}`, { method: 'DELETE' })
    if (res.status === 409) return 'too_late'
    return res.ok ? 'cancelled' : 'failed'
  } catch {
    return 'failed'
  }
}
