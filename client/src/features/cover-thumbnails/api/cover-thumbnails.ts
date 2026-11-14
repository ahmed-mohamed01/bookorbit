// Fork: cover thumbnail backfill. Thin wrappers over /api/v1/cover-thumbnails/backfill.
import { api } from '@/lib/api'
import type { CoverThumbnailBackfillState, UpdateCoverThumbnailBackfillPayload } from '@bookorbit/types'

const BASE = '/api/v1/cover-thumbnails/backfill'

export class CoverThumbnailsHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'CoverThumbnailsHttpError'
  }
}

async function request(path: string, init?: RequestInit): Promise<CoverThumbnailBackfillState> {
  const res = await api(path, init)
  if (!res.ok) throw new CoverThumbnailsHttpError(res.status)
  return res.json() as Promise<CoverThumbnailBackfillState>
}

export function fetchBackfillState(): Promise<CoverThumbnailBackfillState> {
  return request(BASE)
}

export function updateBackfill(payload: UpdateCoverThumbnailBackfillPayload): Promise<CoverThumbnailBackfillState> {
  return request(BASE, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
}

export function runBackfill(): Promise<CoverThumbnailBackfillState> {
  return request(`${BASE}/run`, { method: 'POST' })
}
