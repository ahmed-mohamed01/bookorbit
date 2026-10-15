import { describe, expect, it } from 'vitest'
import {
  filterHitsBySource,
  filterMachineTranslations,
  groupSearchHits,
  groupSerialJobs,
  sortSearchHits,
  sourceOptionsOf,
} from '../lib/serialPresentation'
import { hit, job } from './fixtures'

describe('serialPresentation', () => {
  it('groups search hits by source while preserving source and row order', () => {
    const groups = groupSearchHits([hit({ title: 'First' }), hit({ title: 'Other', sourceName: 'AllManga' }), hit({ title: 'Second' })])
    expect(groups.map((group) => group.sourceName)).toEqual(['MangaDex', 'AllManga'])
    expect(groups[0]?.hits.map((entry) => entry.title)).toEqual(['First', 'Second'])
  })

  it('groups queue jobs into progress, waiting, paused and recent sections', () => {
    const groups = groupSerialJobs([
      job({ id: 1, status: 'running' }),
      job({ id: 2, status: 'queued' }),
      job({ id: 3, status: 'completed' }),
      job({ id: 4, status: 'importing' }),
      job({ id: 5, status: 'paused' }),
    ])
    expect(groups.map((group) => [group.key, group.jobs.map((entry) => entry.id)])).toEqual([
      ['inProgress', [1, 4]],
      ['waiting', [2]],
      ['paused', [5]],
      ['recent', [3]],
    ])
  })

  it('counts hits per source in group order and filters by source', () => {
    const hits = [hit({ title: 'A' }), hit({ title: 'B', sourceName: 'AllManga' }), hit({ title: 'C' })]
    expect(sourceOptionsOf(hits)).toEqual([
      { sourceName: 'MangaDex', count: 2 },
      { sourceName: 'AllManga', count: 1 },
    ])
    expect(filterHitsBySource(hits, 'AllManga').map((entry) => entry.title)).toEqual(['B'])
    expect(filterHitsBySource(hits, null)).toHaveLength(3)
  })

  it('sorts hits by relevance, title and source without mutating the input', () => {
    const hits = [hit({ title: 'b10', sourceName: 'X' }), hit({ title: 'a', sourceName: 'Y' }), hit({ title: 'b2', sourceName: 'X' })]
    expect(sortSearchHits(hits, 'relevance').map((entry) => entry.title)).toEqual(['b10', 'a', 'b2'])
    expect(sortSearchHits(hits, 'title').map((entry) => entry.title)).toEqual(['a', 'b2', 'b10'])
    expect(sortSearchHits(hits, 'source').map((entry) => entry.title)).toEqual(['b10', 'b2', 'a'])
    expect(hits.map((entry) => entry.title)).toEqual(['b10', 'a', 'b2'])
  })

  it('merges separately searched manga and novel hits by server relevance', () => {
    const merged = [
      hit({ title: 'Manga exact', kind: 'manga', relevance: 1 }),
      hit({ title: 'Manga spin-off', kind: 'manga', relevance: 0.3 }),
      hit({ title: 'Novel canonical', kind: 'novel', relevance: 99.5 }),
      hit({ title: 'Novel fuzzy', kind: 'novel', relevance: 0.2 }),
    ]
    expect(sortSearchHits(merged, 'relevance').map((entry) => entry.title)).toEqual([
      'Novel canonical',
      'Manga exact',
      'Manga spin-off',
      'Novel fuzzy',
    ])
  })

  it('drops a machine translation only when a regular copy of the same title is present', () => {
    const regular = hit({ title: 'Omniscient Reader’s Viewpoint (Web Novel KR)', kind: 'novel' })
    const twin = hit({ title: "MTL-Omniscient Reader's Viewpoint", kind: 'novel', mtl: true })
    const lone = hit({ title: 'MTL-Lonely', kind: 'novel', mtl: true })
    expect(filterMachineTranslations([regular, twin, lone], false)).toEqual([regular, lone])
    expect(filterMachineTranslations([regular, twin, lone], true)).toEqual([regular, twin, lone])
  })
})
