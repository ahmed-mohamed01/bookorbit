import { describe, expect, it } from 'vitest'
import type { WebSerialSourceOption } from '@bookorbit/types'
import { entryFromSuggestion, optionsFromSuggestion, preselectedOption, suggestionPills } from '../lib/serialSuggest'
import { suggestion } from './fixtures'

const entry = (sourceId: string, sourceName: string, mtl = false) => ({
  sourceId,
  sourceName,
  path: `n/${sourceId}`,
  mtl,
  seriesKey: `nl:${sourceId}`,
})
const option = (seriesKey: string, overrides: Partial<WebSerialSourceOption> = {}): WebSerialSourceOption => ({
  seriesKey,
  sourceName: seriesKey,
  title: 'T',
  chapterCount: 0,
  chaptersUnknown: true,
  latestAt: null,
  confidence: 'same_series',
  mostComplete: false,
  ...overrides,
})

describe('serialSuggest', () => {
  it('turns a matched suggestion into a series-database entry', () => {
    expect(entryFromSuggestion({ ...suggestion({ cover: '/c' }), matchId: '7' })).toMatchObject({
      matchId: '7',
      kind: 'novel',
      coverUrl: '/c',
      url: 'https://mangabaka.org/7',
      inLibrary: false,
    })
  })

  it('names each site once and collapses the rest after three', () => {
    const many = suggestion({
      entries: [
        entry('a', 'Novel Fire'),
        entry('a2', 'Novel Fire'),
        entry('b', 'NovelBuddy'),
        entry('c', 'Site C'),
        entry('d', 'Site D'),
        entry('e', 'Site E'),
      ],
    })
    expect(suggestionPills(many)).toEqual({ names: ['Novel Fire', 'NovelBuddy', 'Site C'], more: 2 })
    expect(suggestionPills(suggestion())).toEqual({ names: ['Novel Fire'], more: 0 })
  })

  it('lists every copy as an alternative with its count still unknown and the MTL flag kept', () => {
    const options = optionsFromSuggestion(suggestion({ entries: [entry('a', 'Novel Fire'), entry('b', 'MTL Site', true)] }))
    expect(options.map((o) => [o.seriesKey, o.sourceName, o.chaptersUnknown, o.mtl])).toEqual([
      ['nl:a', 'Novel Fire', true, undefined],
      ['nl:b', 'MTL Site', true, true],
    ])
  })

  it('preselects a non-MTL copy first, then the most chapters when known, else the first', () => {
    expect(preselectedOption([option('mtl', { mtl: true }), option('human')])?.seriesKey).toBe('human')
    expect(preselectedOption([option('a'), option('b')])?.seriesKey).toBe('a')
    expect(
      preselectedOption([
        option('a'),
        option('b', { chaptersUnknown: false, chapterCount: 10 }),
        option('c', { chaptersUnknown: false, chapterCount: 40 }),
      ])?.seriesKey,
    ).toBe('c')
    expect(preselectedOption([option('x', { mtl: true }), option('y', { mtl: true, chaptersUnknown: false, chapterCount: 5 })])?.seriesKey).toBe('y')
    expect(preselectedOption([])).toBeNull()
  })
})
