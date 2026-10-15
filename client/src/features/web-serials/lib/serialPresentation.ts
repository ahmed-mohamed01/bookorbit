import { normalizeSerialTitle } from '@bookorbit/types'
import type { WebSerialCatalogEntry, WebSerialJob, WebSerialSearchHit } from '@bookorbit/types'
import { isActiveJob } from './serialJobStatus'

export interface WebSerialSearchGroup {
  sourceName: string
  hits: WebSerialSearchHit[]
}

export function groupSearchHits(hits: readonly WebSerialSearchHit[]): WebSerialSearchGroup[] {
  const groups = new Map<string, WebSerialSearchHit[]>()
  for (const hit of hits) {
    const group = groups.get(hit.sourceName)
    if (group) group.push(hit)
    else groups.set(hit.sourceName, [hit])
  }
  return [...groups].map(([sourceName, groupedHits]) => ({ sourceName, hits: groupedHits }))
}

export type WebSerialResultSort = 'relevance' | 'title' | 'source'
export type WebSerialResultDensity = 'comfortable' | 'compact'

export const RESULT_SORTS: readonly WebSerialResultSort[] = ['relevance', 'title', 'source']
export const RESULT_DENSITIES: readonly WebSerialResultDensity[] = ['comfortable', 'compact']

export type WebSerialCatalogSort = 'relevance' | 'title'

export const CATALOG_SORTS: readonly WebSerialCatalogSort[] = ['relevance', 'title']

/** Relevance keeps the series database's own order. */
export function sortCatalogEntries(entries: readonly WebSerialCatalogEntry[], sort: WebSerialCatalogSort): WebSerialCatalogEntry[] {
  if (sort === 'relevance') return [...entries]
  return [...entries].sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true }))
}

export function sortSearchHits(hits: readonly WebSerialSearchHit[], sort: WebSerialResultSort): WebSerialSearchHit[] {
  if (sort === 'title')
    return [...hits].sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true }))
  const byRelevance = [...hits].sort((left, right) => (right.relevance ?? -1) - (left.relevance ?? -1))
  if (sort === 'source') return groupSearchHits(byRelevance).flatMap((group) => group.hits)
  return byRelevance
}

export interface WebSerialSourceOption {
  sourceName: string
  count: number
}

export function sourceOptionsOf(hits: readonly WebSerialSearchHit[]): WebSerialSourceOption[] {
  return groupSearchHits(hits).map((group) => ({ sourceName: group.sourceName, count: group.hits.length }))
}

export function filterHitsBySource(hits: readonly WebSerialSearchHit[], sourceName: string | null): WebSerialSearchHit[] {
  return sourceName === null ? [...hits] : hits.filter((hit) => hit.sourceName === sourceName)
}

export function hasMachineTranslations(hits: readonly WebSerialSearchHit[]): boolean {
  return hits.some((hit) => hit.mtl === true)
}

/** Without `show`, a machine translation is dropped when a regular copy of the same title is in the results; a lone one stays. */
export function filterMachineTranslations(hits: readonly WebSerialSearchHit[], show: boolean): WebSerialSearchHit[] {
  if (show) return [...hits]
  const regular = new Set(hits.filter((hit) => hit.mtl !== true).map((hit) => `${hit.kind}|${normalizeSerialTitle(hit.title)}`))
  return hits.filter((hit) => hit.mtl !== true || !regular.has(`${hit.kind}|${normalizeSerialTitle(hit.title)}`))
}

export type WebSerialQueueGroupKey = 'inProgress' | 'waiting' | 'paused' | 'recent'

export interface WebSerialQueueGroup {
  key: WebSerialQueueGroupKey
  jobs: WebSerialJob[]
}

export function groupSerialJobs(jobs: readonly WebSerialJob[]): WebSerialQueueGroup[] {
  const groups: Record<WebSerialQueueGroupKey, WebSerialJob[]> = { inProgress: [], waiting: [], paused: [], recent: [] }
  for (const job of jobs) {
    if (job.status === 'queued') groups.waiting.push(job)
    else if (job.status === 'paused') groups.paused.push(job)
    else if (isActiveJob(job)) groups.inProgress.push(job)
    else groups.recent.push(job)
  }
  return (Object.keys(groups) as WebSerialQueueGroupKey[]).map((key) => ({ key, jobs: groups[key] })).filter((group) => group.jobs.length > 0)
}
