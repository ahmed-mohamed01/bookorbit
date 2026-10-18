import { describe, expect, it } from 'vitest'
import type { MonitoredWork } from '@bookorbit/types'
import {
  workKindOf,
  workDisplayClass,
  countWorkClasses,
  toggleKind,
  isWorkDisplayed,
  readDisplayOptions,
  isDefaultDisplay,
  DEFAULT_MONITORED_DISPLAY,
  workReleaseStatus,
} from './work-visibility'

function work(overrides: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'work-1',
    title: 'A Book',
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: null,
    ebookReleaseDate: null,
    ebookDatePrecision: null,
    audioReleaseDate: null,
    audioDatePrecision: null,
    coverUrl: null,
    description: null,
    verdict: 'verified',
    flags: [],
    sources: [],
    providerWorkIds: {},
    monitorState: 'monitoring',
    matchedBookId: null,
    ownedFormats: [],
    requestIds: {},
    ...overrides,
  }
}

describe('workReleaseStatus', () => {
  const now = Date.parse('2026-09-07T00:00:00Z')

  it('splits on the release date and falls back to the release year', () => {
    expect(workReleaseStatus(work({ ebookReleaseDate: '2020-01-01' }), now)).toBe('released')
    expect(workReleaseStatus(work({ ebookReleaseDate: '2099-01-01' }), now)).toBe('upcoming')
    expect(workReleaseStatus(work({ releaseYear: 2019 }), now)).toBe('released')
  })

  it('calls a work with no date at all undated rather than guessing', () => {
    expect(workReleaseStatus(work(), now)).toBe('undated')
  })

  it('reads an upcoming format hint instead of demoting the work to its release year', () => {
    const lordOfDemons = work({
      releaseYear: 2026,
      formatReleases: {
        ebook: {
          status: 'unlisted',
          releaseDate: null,
          precision: null,
          source: null,
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
        audiobook: {
          status: 'expected',
          releaseDate: '2026-10-06',
          precision: 'day',
          source: 'amazon_search',
          checkedAt: null,
          dateChangedAt: null,
          previousReleaseDate: null,
          previousPrecision: null,
          suggested: null,
        },
      },
    })

    expect(workReleaseStatus(lordOfDemons, now)).toBe('upcoming')
  })
})

describe('kind visibility', () => {
  it('resolves user marks before visibility and detected kinds', () => {
    expect(workKindOf(work({ userKind: 'supplemental', kind: 'collection' }))).toBe('supplemental')
    expect(workKindOf(work({ kind: 'collection' }))).toBe('book')
    expect(workKindOf(work({ verdict: 'suspect', userVisibility: 'visible', kind: 'collection' }))).toBe('book')
    expect(workKindOf(work({ verdict: 'suspect', kind: 'collection' }))).toBe('collection')
    expect(workKindOf(work({ verdict: 'suspect' }))).toBeNull()
  })
  it('counts kinds and unconfirmed works with hidden and placeholders excluded', () => {
    const works = [
      work(),
      work({ userVisibility: 'hidden', userKind: 'collection', flags: ['placeholder'] }),
      work({ verdict: 'suspect', kind: 'collection', flags: ['placeholder'] }),
      work({ flags: ['placeholder'] }),
      work({ verdict: 'suspect' }),
    ]
    expect(works.map(workDisplayClass)).toEqual(['kind', 'hidden', 'placeholder', 'placeholder', 'unconfirmed'])
    expect(countWorkClasses(works)).toMatchObject({ hidden: 1, placeholder: 2, unconfirmed: 1, kinds: { book: 1, collection: 0, supplemental: 0 } })
  })
  it('keeps a placeholder the owner marked Book or kept on the default list', () => {
    expect(workDisplayClass(work({ flags: ['placeholder'], userKind: 'book' }))).toBe('kind')
    expect(workDisplayClass(work({ flags: ['placeholder'], userVisibility: 'visible' }))).toBe('kind')
    expect(isWorkDisplayed(work({ flags: ['placeholder'], userKind: 'book' }), DEFAULT_MONITORED_DISPLAY)).toBe(true)
  })
  it('filters kinds and independently reveals the More classes', () => {
    const display = { ...DEFAULT_MONITORED_DISPLAY, kinds: ['collection'] as const }
    expect(isWorkDisplayed(work(), { ...display, kinds: [...display.kinds] })).toBe(false)
    expect(isWorkDisplayed(work({ userKind: 'collection' }), { ...display, kinds: [...display.kinds] })).toBe(true)
    for (const [extra, flag] of [
      [{ userVisibility: 'hidden' }, 'hidden'],
      [{ flags: ['placeholder'] }, 'placeholders'],
      [{ verdict: 'suspect' }, 'unconfirmed'],
    ] as const) {
      const entry = work(extra as Partial<MonitoredWork>)
      expect(isWorkDisplayed(entry, DEFAULT_MONITORED_DISPLAY)).toBe(false)
      expect(isWorkDisplayed(entry, { ...DEFAULT_MONITORED_DISPLAY, [flag]: true })).toBe(true)
    }
  })
  it('reveals unconfirmed works of any kind independently of kind selection', () => {
    const anthology = work({ verdict: 'suspect', kind: 'anthology' })
    const display = { ...DEFAULT_MONITORED_DISPLAY, kinds: [], unconfirmed: true }
    expect(isWorkDisplayed(anthology, display)).toBe(true)
    expect(isWorkDisplayed(work({ userKind: 'anthology' }), display)).toBe(false)
    expect(isWorkDisplayed(work({ ...anthology, userVisibility: 'visible' }), display)).toBe(false)
    expect(isWorkDisplayed(anthology, { ...display, unconfirmed: false })).toBe(false)
    expect(countWorkClasses([anthology])).toMatchObject({ unconfirmed: 1, kinds: { anthology: 1 } })
  })
  it('applies release switches and always passes undated works', () => {
    expect(isWorkDisplayed(work(), { ...DEFAULT_MONITORED_DISPLAY, released: false, upcoming: false })).toBe(true)
    expect(isWorkDisplayed(work({ ebookReleaseDate: '2020-01-01' }), { ...DEFAULT_MONITORED_DISPLAY, released: false })).toBe(false)
    expect(isWorkDisplayed(work({ ebookReleaseDate: '2099-01-01' }), { ...DEFAULT_MONITORED_DISPLAY, upcoming: false })).toBe(false)
  })
  it('allows empty kinds and returns canonical order', () => {
    expect(toggleKind(['book'], 'book')).toEqual([])
    expect(toggleKind(['duplicate'], 'book')).toEqual(['book', 'duplicate'])
    expect(toggleKind(['book', 'collection'], 'book')).toEqual(['collection'])
  })
  it('reads storage defensively and ignores the old model', () => {
    for (const stored of [null, 'junk', { kinds: ['unknown'] }, { review: true, reviewKinds: ['collection'] }, { released: 'yes' }])
      expect(readDisplayOptions(stored)).toEqual(DEFAULT_MONITORED_DISPLAY)
    expect(readDisplayOptions({ kinds: ['duplicate', 'book', 'unknown', 'book'], unconfirmed: true })).toMatchObject({
      kinds: ['book', 'duplicate'],
      unconfirmed: true,
    })
    expect(readDisplayOptions({ kinds: [] }).kinds).toEqual([])
    expect(isDefaultDisplay(readDisplayOptions(null))).toBe(true)
    expect(isDefaultDisplay(readDisplayOptions({ kinds: ['collection'] }))).toBe(false)
  })
})
