import { describe, expect, it } from 'vitest'
import { WEB_SERIAL_SERIES_UNIT_KEY, webSerialSelectionUnitKey, webSerialVolumeUnitKey, type WebSerialUnit } from '@bookorbit/types'
import {
  buildSelection,
  normalizeRange,
  ownedVolumes,
  rangeForUnits,
  sequenceOrdered,
  sequenceInRange,
  sortedSequences,
  summarizeSelection,
  unitVolume,
  unitsInSelection,
} from '../lib/serialSelection'
import { mangaDetail, novelDetail, unit } from './fixtures'

const ALL = { mode: 'all', fromSequence: '1', toSequence: '5' } as const

describe('serialSelection', () => {
  it('orders sequences numerically, not as text', () => {
    expect(sortedSequences([unit('10'), unit('2'), unit('2.5'), unit('1')])).toEqual(['1', '2', '2.5', '10'])
  })

  it('selects everything in all mode', () => {
    expect(unitsInSelection(mangaDetail().units, ALL)).toHaveLength(5)
  })

  it('selects an inclusive range of whole units', () => {
    const picked = unitsInSelection(mangaDetail().units, { mode: 'range', fromSequence: '2', toSequence: '4' })
    expect(picked.map((item) => item.sequence)).toEqual(['2', '3', '4'])
  })

  it('selects nothing until both range taps are present', () => {
    expect(unitsInSelection(mangaDetail().units, { mode: 'range', fromSequence: '2', toSequence: '' })).toEqual([])
  })

  it('builds range bounds and tests membership', () => {
    expect(rangeForUnits([unit('4'), unit('2'), unit('3')])).toEqual({ fromSequence: '2', toSequence: '4' })
    const range = { mode: 'range', fromSequence: '2', toSequence: '4' } as const
    expect(sequenceInRange('3', range)).toBe(true)
    expect(sequenceInRange('5', range)).toBe(false)
  })

  it('reads a reversed range the way it was meant', () => {
    expect(normalizeRange({ mode: 'range', fromSequence: '4', toSequence: '2' })).toEqual({ from: '2', to: '4' })
    expect(buildSelection({ mode: 'range', fromSequence: '4', toSequence: '2' })).toEqual({ mode: 'range', fromSequence: '2', toSequence: '4' })
  })

  it('sends all when the range has no bounds yet', () => {
    expect(buildSelection({ mode: 'range', fromSequence: '', toSequence: '' })).toEqual({ mode: 'all' })
    expect(buildSelection(ALL)).toEqual({ mode: 'all' })
  })

  it('counts one book per unit for chapters and volumes', () => {
    const summary = summarizeSelection(mangaDetail().units, ALL, 'chapter', [], true)
    expect(summary).toMatchObject({ books: 5, toDownload: 5, alreadyHave: 0, chapters: 5 })

    const volumes = summarizeSelection(novelDetail().units, { mode: 'range', fromSequence: '1', toSequence: '2' }, 'volume', [], true)
    expect(volumes).toMatchObject({ books: 2, toDownload: 2, chapters: 200 })
  })

  it('counts a whole-series novel as a single book over the selected volumes', () => {
    const summary = summarizeSelection(novelDetail().units, { mode: 'range', fromSequence: '1', toSequence: '2' }, 'series', [], true)
    expect(summary).toMatchObject({ books: 1, toDownload: 1, chapters: 200 })
  })

  it('subtracts units already in the library when skipping', () => {
    const summary = summarizeSelection(mangaDetail().units, ALL, 'chapter', ['u1', 'u2'], true)
    expect(summary).toMatchObject({ books: 5, alreadyHave: 2, toDownload: 3 })
    expect(summarizeSelection(mangaDetail().units, ALL, 'chapter', ['u1', 'u2'], false).toDownload).toBe(5)
  })

  it('has nothing to download when every selected unit is already imported', () => {
    expect(summarizeSelection(mangaDetail().units, ALL, 'chapter', ['u1', 'u2', 'u3', 'u4', 'u5'], true).toDownload).toBe(0)
  })

  it('has nothing at all for an empty series', () => {
    expect(summarizeSelection([], ALL, 'series', [], true)).toMatchObject({ books: 0, toDownload: 0 })
  })

  it('reads a volume from the chapter name before the lookup and never guesses', () => {
    expect(unitVolume(unit('1', { volume: '3' }), { u1: '9' })).toBe('3')
    expect(unitVolume(unit('1'), { u1: '9' })).toBe('9')
    expect(unitVolume(unit('2'), { u1: '9' })).toBeNull()
    expect(unitVolume(unit('2'), null)).toBeNull()
  })

  it('counts distinct volumes plus single chapters for per-volume manga', () => {
    const units = ['1', '2', '3', '4', '5'].map((sequence) => unit(sequence))
    const volumes: Record<string, string> = { u1: '1', u2: '1', u3: '2' }
    const volumeOf = (item: (typeof units)[number]) => unitVolume(item, volumes)
    expect(summarizeSelection(units, ALL, 'volume', [], true, volumeOf)).toMatchObject({ books: 4, toDownload: 4 })
    expect(summarizeSelection(units, ALL, 'volume', ['u1', 'u2'], true, volumeOf)).toMatchObject({ books: 4, alreadyHave: 0, toDownload: 4 })
  })

  it('does not treat owned chapters as owned volumes or an owned one-book series', () => {
    const units = mangaDetail().units
    const owned = units.map((item) => item.key)
    const volumeOf = (item: WebSerialUnit) => unitVolume(item, { u1: '1' })
    expect(summarizeSelection(units, ALL, 'volume', owned, true, volumeOf)).toMatchObject({ books: 5, alreadyHave: 4, toDownload: 1 })
    expect(summarizeSelection(units, ALL, 'series', owned, true)).toMatchObject({ books: 1, alreadyHave: 0, toDownload: 1 })
    expect(summarizeSelection(units, ALL, 'chapter', owned, true)).toMatchObject({ alreadyHave: 5, toDownload: 0 })
  })

  it('counts owned volumes and an owned one-book series from the grouped keys', () => {
    const units = mangaDetail().units
    const volumeOf = (item: WebSerialUnit) => unitVolume(item, { u1: '1', u2: '1', u3: '2' })
    const volumes = summarizeSelection(units, ALL, 'volume', [], true, volumeOf, [webSerialVolumeUnitKey('1')])
    expect(volumes).toMatchObject({ books: 4, alreadyHave: 1, toDownload: 3 })

    const first = units[0]!.key
    const last = units[units.length - 1]!.key
    expect(summarizeSelection(units, ALL, 'series', [], true, undefined, [webSerialSelectionUnitKey(first, last)])).toMatchObject({
      books: 1,
      alreadyHave: 1,
      toDownload: 0,
    })
    expect(summarizeSelection(units, ALL, 'series', [], false, undefined, [webSerialSelectionUnitKey(first, last)])).toMatchObject({ toDownload: 1 })
    expect(summarizeSelection(units, ALL, 'series', [], true, undefined, [WEB_SERIAL_SERIES_UNIT_KEY], 'novel')).toMatchObject({ toDownload: 0 })
  })

  it('orders units by sequence before taking the first or latest ones', () => {
    const shuffled = [unit('3'), unit('0'), unit('1'), unit('2')]
    expect(sequenceOrdered(shuffled).map((item) => item.sequence)).toEqual(['0', '1', '2', '3'])
  })
})

describe('ownedVolumes with ranged volume keys', () => {
  const units = ['100', '101', '102', '103', '104'].map((sequence) => unit(sequence, { key: `c${sequence}` }))
  const volumeOf = () => '12'

  it('owns a volume through a plain key', () => {
    expect(ownedVolumes(units, volumeOf, ['vol:12'])).toEqual(new Set(['12']))
  })

  it('owns a grown volume only when the owned copy covers every chapter it has now', () => {
    expect(ownedVolumes(units, volumeOf, ['vol:12:100-104'])).toEqual(new Set(['12']))
    expect(ownedVolumes(units, volumeOf, ['vol:12:100-103'])).toEqual(new Set())
  })

  it('leaves unnumbered extras out of the range a volume has now, like the server', () => {
    const withExtra = [...units.slice(0, 4), unit('103.001', { key: 'extra', positional: true })]
    expect(ownedVolumes(withExtra, volumeOf, ['vol:12:100-103'])).toEqual(new Set(['12']))
  })

  it('joins owned copies of the same volume that meet, never across a missing whole chapter', () => {
    expect(ownedVolumes(units, volumeOf, ['vol:12:100-101', 'vol:12:102-104'])).toEqual(new Set(['12']))
    expect(ownedVolumes(units, volumeOf, ['vol:12:100-101.5', 'vol:12:102-104'])).toEqual(new Set(['12']))
    expect(ownedVolumes(units, volumeOf, ['vol:12:100-101.5', 'vol:12:102.5-104'])).toEqual(new Set())
  })

  it('never lets another volume own this one, even when their chapter numbers restart and match', () => {
    const restarted = ['1', '2', '3'].map((sequence) => unit(sequence, { key: `v2c${sequence}`, volume: '2' }))
    expect(ownedVolumes(restarted, (item) => item.volume ?? null, ['vol:1:1-3'])).toEqual(new Set())
    expect(ownedVolumes(restarted, (item) => item.volume ?? null, ['vol:1:1-3', 'vol:2'])).toEqual(new Set(['2']))
  })

  it('counts a covered ranged volume as already had, and a short copy as still to download', () => {
    const draft = { mode: 'all' as const, fromSequence: '100', toSequence: '104' }
    expect(summarizeSelection(units, draft, 'volume', [], true, volumeOf, ['vol:12:100-104'], 'manga')).toMatchObject({
      alreadyHave: 1,
      toDownload: 0,
    })
    expect(summarizeSelection(units, draft, 'volume', [], true, volumeOf, ['vol:12:100-103'], 'manga')).toMatchObject({
      alreadyHave: 0,
      toDownload: 1,
    })
  })
})
