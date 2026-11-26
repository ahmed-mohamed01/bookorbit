import type { ForkStoryGuidePayload, ForkStoryRecap } from '@bookorbit/types'
import { api } from '@/lib/api'
import { apiError } from '@/lib/api-json'

function path(fileId: number) {
  return `/api/v1/story-guide-content/files/${fileId}`
}

export async function fetchStoryGuide(fileId: number, signal: AbortSignal): Promise<ForkStoryGuidePayload> {
  const response = await api(path(fileId), { signal })
  if (!response.ok) throw await apiError(response, 'book.detail.storyGuide.failed.load')
  return (await response.json()) as ForkStoryGuidePayload
}

export async function fetchStoryRecap(fileId: number, stop: boolean, signal: AbortSignal): Promise<ForkStoryRecap> {
  const response = await api(`${path(fileId)}/recap?stop=${stop ? 1 : 0}`, { signal })
  if (!response.ok) throw await apiError(response, 'book.detail.storyGuide.failed.load')
  return (await response.json()) as ForkStoryRecap
}
