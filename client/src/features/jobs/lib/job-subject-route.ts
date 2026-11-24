import type { LocationQuery, RouteLocationRaw } from 'vue-router'

export function requestIdFromJobUrl(url: string | null): number | null {
  const match = url?.match(/^\/requests\/(\d+)$/)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

export function jobRequestRoute(id: number, query: LocationQuery): RouteLocationRaw {
  return { name: 'jobs-request-detail', params: { id }, query }
}

export function jobSubjectRoute(url: string, query: LocationQuery): RouteLocationRaw {
  const id = requestIdFromJobUrl(url)
  return id === null ? url : jobRequestRoute(id, query)
}
