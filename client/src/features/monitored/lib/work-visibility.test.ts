import { describe, expect, it } from 'vitest'
import type { MonitoredWork } from '@bookorbit/types'
import {
  countReviewKinds,
  DEFAULT_MONITORED_DISPLAY,
  isEveryReviewKindSelected,
  isReviewKindSelected,
  toggleReviewKind,
  isWorkDisplayed,
  isWorkVisible,
  readDisplayOptions,
  reviewKindOf,
  workDisplayClass,
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

describe('isWorkVisible', () => {
  it('shows only a verified, unflagged work by default', () => {
    expect(isWorkVisible(work())).toBe(true)
    expect(isWorkVisible(work({ verdict: 'suspect' }))).toBe(false)
    expect(isWorkVisible(work({ flags: ['compilation'] }))).toBe(false)
  })

  it('lets an owner override outrank the verdict in both directions', () => {
    expect(isWorkVisible(work({ verdict: 'suspect', userVisibility: 'visible' }))).toBe(true)
    expect(isWorkVisible(work({ userVisibility: 'hidden' }))).toBe(false)
  })
})

describe('reviewKindOf', () => {
  it('answers with the persisted kind', () => {
    expect(reviewKindOf(work({ kind: 'graphic_novel' }))).toBe('graphic_novel')
  })

  it('files a work the reconciler never named under other', () => {
    // Nothing about its shape is known - it simply failed to earn the default list.
    expect(reviewKindOf(work({ verdict: 'probable' }))).toBe('other')
  })
})

describe('countReviewKinds', () => {
  it('counts every kind present and totals them under all', () => {
    const counts = countReviewKinds([work({ kind: 'collection' }), work({ kind: 'collection' }), work({ kind: 'duplicate' }), work()])

    expect(counts).toEqual({ all: 4, collection: 2, anthology: 0, graphic_novel: 0, format_variant: 0, duplicate: 1, other: 1 })
  })
})

describe('workDisplayClass', () => {
  it('gives every work exactly one class, so no switch double-counts against another', () => {
    expect(workDisplayClass(work())).toBe('default')
    expect(workDisplayClass(work({ userVisibility: 'hidden' }))).toBe('hidden')
    expect(workDisplayClass(work({ verdict: 'probable', flags: ['placeholder'] }))).toBe('placeholder')
    expect(workDisplayClass(work({ verdict: 'suspect' }))).toBe('review')
  })

  it('lets an owner promotion pull a work back into the default list', () => {
    expect(workDisplayClass(work({ verdict: 'suspect', userVisibility: 'visible' }))).toBe('default')
  })

  it('reads a hidden placeholder as hidden, because an owner override outranks the flag', () => {
    expect(workDisplayClass(work({ flags: ['placeholder'], userVisibility: 'hidden' }))).toBe('hidden')
  })
})

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

describe('isWorkDisplayed', () => {
  const now = Date.parse('2026-09-07T00:00:00Z')
  const display = (overrides: Partial<typeof DEFAULT_MONITORED_DISPLAY> = {}) => ({ ...DEFAULT_MONITORED_DISPLAY, ...overrides })

  it('shows only the default class out of the box', () => {
    expect(isWorkDisplayed(work(), display(), now)).toBe(true)
    expect(isWorkDisplayed(work({ verdict: 'suspect' }), display(), now)).toBe(false)
    expect(isWorkDisplayed(work({ userVisibility: 'hidden' }), display(), now)).toBe(false)
    expect(isWorkDisplayed(work({ verdict: 'probable', flags: ['placeholder'] }), display(), now)).toBe(false)
  })

  it('narrows the review class to the picked kinds, and leaves the other classes untouched by it', () => {
    const options = display({ review: true, reviewKinds: ['collection', 'anthology'] })

    expect(isWorkDisplayed(work({ verdict: 'suspect', kind: 'collection' }), options, now)).toBe(true)
    expect(isWorkDisplayed(work({ verdict: 'suspect', kind: 'anthology' }), options, now)).toBe(true)
    expect(isWorkDisplayed(work({ verdict: 'suspect', kind: 'graphic_novel' }), options, now)).toBe(false)
    expect(isWorkDisplayed(work(), options, now)).toBe(true)
  })

  it('shows no review work at all once every kind is unticked', () => {
    const options = display({ review: true, reviewKinds: [] })

    expect(isWorkDisplayed(work({ verdict: 'suspect', kind: 'collection' }), options, now)).toBe(false)
    expect(isWorkDisplayed(work(), options, now)).toBe(true)
  })

  it('never drops an undated work, whichever release switch is off', () => {
    expect(isWorkDisplayed(work(), display({ released: false, upcoming: false }), now)).toBe(true)
    expect(isWorkDisplayed(work({ ebookReleaseDate: '2020-01-01' }), display({ released: false }), now)).toBe(false)
    expect(isWorkDisplayed(work({ ebookReleaseDate: '2099-01-01' }), display({ upcoming: false }), now)).toBe(false)
  })
})

describe('readDisplayOptions', () => {
  it('falls back to the defaults for anything missing or malformed', () => {
    expect(readDisplayOptions(null)).toEqual(DEFAULT_MONITORED_DISPLAY)
    expect(readDisplayOptions('nonsense')).toEqual(DEFAULT_MONITORED_DISPLAY)
    expect(readDisplayOptions({ released: 'yes' })).toEqual(DEFAULT_MONITORED_DISPLAY)
  })

  it('drops stored kinds that are no longer part of the vocabulary', () => {
    expect(readDisplayOptions({ review: true, reviewKinds: ['novellas'] }).reviewKinds).toBe('all')
    expect(readDisplayOptions({ review: true, reviewKinds: ['anthology', 'novellas'] }).reviewKinds).toEqual(['anthology'])
    expect(readDisplayOptions({ review: true, reviewKinds: 'all' }).reviewKinds).toBe('all')
  })
})

describe('review kind selection', () => {
  const present = ['collection', 'anthology', 'graphic_novel'] as const

  it('treats the all sentinel as every kind, whatever this author happens to have', () => {
    expect(isReviewKindSelected('all', 'duplicate')).toBe(true)
    expect(isEveryReviewKindSelected('all', present)).toBe(true)
    expect(isEveryReviewKindSelected(['collection'], present)).toBe(false)
    expect(isEveryReviewKindSelected([...present], present)).toBe(true)
  })

  it('unticks one kind out of all, rather than reading the click as select-only-this', () => {
    expect(toggleReviewKind('all', 'anthology', present)).toEqual(['collection', 'graphic_novel'])
  })

  it('collapses back to the sentinel when the last missing kind is ticked again', () => {
    // Storing a literal list of everything would narrow to nothing on an author with other kinds.
    expect(toggleReviewKind(['collection', 'graphic_novel'], 'anthology', present)).toBe('all')
  })

  it('adds and removes kinds so several can be picked together', () => {
    expect(toggleReviewKind(['collection'], 'anthology', present)).toEqual(['collection', 'anthology'])
    expect(toggleReviewKind(['collection', 'anthology'], 'collection', present)).toEqual(['anthology'])
    expect(toggleReviewKind(['collection'], 'collection', present)).toEqual([])
  })
})
