import { describe, expect, it } from 'vitest'
import {
  isWorkListed,
  isWorkVisible,
  workKindOf,
  workDisplayClass,
  countWorkClasses,
  isWorkUnconfirmed,
  workMatchesClassSelection,
  isDefaultClassSelection,
  MONITORED_REVIEW_FLAGS,
  type MonitoredClassSelection,
  type MonitoredWork,
} from '@bookorbit/types'
import {
  toggleKind,
  isWorkDisplayed,
  readDisplayOptions,
  isDefaultDisplay,
  DEFAULT_MONITORED_DISPLAY,
  workReleaseStatus,
  readClassSelection,
  toClassSelection,
  toReleaseDisplay,
  workClassChanged,
  classChangeLeavesQueue,
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
  it('lets an owned listed-but-not-watched work through only when Book is selected', () => {
    const owned = work({ ownedFormats: ['ebook'], verdict: 'suspect', flags: ['wrong_contributor'], kind: 'graphic_novel' })
    expect(isWorkDisplayed(owned, DEFAULT_MONITORED_DISPLAY)).toBe(true)
    expect(isWorkDisplayed(owned, { ...DEFAULT_MONITORED_DISPLAY, kinds: ['collection'] })).toBe(false)
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

const ownedFlagged = work({ ownedFormats: ['ebook'], verdict: 'suspect', flags: ['wrong_contributor'], kind: 'graphic_novel' })

describe('owned work listing', () => {
  it.each([
    [{}, true],
    [{ userVisibility: 'hidden' }, false],
    [{ userKind: 'graphic_novel' }, false],
    [{ userKind: 'book' }, true],
    [{ ownedFormats: [] }, false],
  ] as [Partial<MonitoredWork>, boolean][])('lists according to ownership and explicit overrides %j', (patch, expected) => {
    expect(isWorkListed({ ...ownedFlagged, ...patch })).toBe(expected)
  })

  it('keeps owned flagged works displayed without changing their watched status or classifier kind', () => {
    expect(isWorkDisplayed(ownedFlagged, DEFAULT_MONITORED_DISPLAY)).toBe(true)
    expect(isWorkDisplayed(ownedFlagged, { ...DEFAULT_MONITORED_DISPLAY, kinds: ['book', 'collection'] })).toBe(true)
    expect(isWorkDisplayed(ownedFlagged, { ...DEFAULT_MONITORED_DISPLAY, kinds: [] })).toBe(false)
    expect(isWorkVisible(ownedFlagged)).toBe(false)
    expect(workKindOf(ownedFlagged)).toBe('graphic_novel')
  })

  it('bypasses More classes but still applies release switches', () => {
    expect(isWorkDisplayed({ ...ownedFlagged, flags: ['placeholder'] }, DEFAULT_MONITORED_DISPLAY)).toBe(true)
    expect(isWorkDisplayed({ ...ownedFlagged, ebookReleaseDate: '2020-01-01' }, { ...DEFAULT_MONITORED_DISPLAY, released: false })).toBe(false)
    expect(isWorkDisplayed({ ...ownedFlagged, ebookReleaseDate: '2099-01-01' }, { ...DEFAULT_MONITORED_DISPLAY, upcoming: false })).toBe(false)
  })
})

const bookSel: MonitoredClassSelection = { kinds: ['book'], more: [] }
const hiddenSel: MonitoredClassSelection = { kinds: [], more: ['hidden'] }
const placeholderSel: MonitoredClassSelection = { kinds: [], more: ['placeholders'] }
const unconfirmedSel: MonitoredClassSelection = { kinds: [], more: ['unconfirmed'] }
const collectionSel: MonitoredClassSelection = { kinds: ['collection'], more: [] }
const emptySel: MonitoredClassSelection = { kinds: [], more: [] }

const classSelectionCases: Array<{ name: string; work: MonitoredWork; matches: MonitoredClassSelection[]; misses: MonitoredClassSelection[] }> = [
  { name: 'verified book', work: work(), matches: [bookSel], misses: [emptySel, unconfirmedSel, collectionSel] },
  { name: 'verified detected collection', work: work({ kind: 'collection' }), matches: [bookSel], misses: [collectionSel, unconfirmedSel] },
  { name: 'probable unknown', work: work({ verdict: 'probable' }), matches: [unconfirmedSel], misses: [bookSel, emptySel] },
  {
    name: 'suspect collection',
    work: work({ verdict: 'suspect', kind: 'collection' }),
    matches: [collectionSel, unconfirmedSel],
    misses: [bookSel, emptySel],
  },
  {
    name: 'verified flagged collection',
    work: work({ flags: ['wrong_contributor'], kind: 'collection' }),
    matches: [collectionSel, unconfirmedSel],
    misses: [bookSel, placeholderSel],
  },
  {
    name: 'automatic placeholder',
    work: work({ flags: ['placeholder'], kind: 'collection' }),
    matches: [placeholderSel],
    misses: [bookSel, collectionSel, unconfirmedSel],
  },
  {
    name: 'hidden marked placeholder',
    work: work({ userVisibility: 'hidden', userKind: 'book', flags: ['placeholder'] }),
    matches: [hiddenSel],
    misses: [bookSel, placeholderSel, unconfirmedSel],
  },
  {
    name: 'kept placeholder',
    work: work({ userVisibility: 'visible', flags: ['placeholder'] }),
    matches: [bookSel],
    misses: [placeholderSel, unconfirmedSel],
  },
  {
    name: 'book marked placeholder',
    work: work({ userKind: 'book', flags: ['placeholder'] }),
    matches: [bookSel],
    misses: [placeholderSel, unconfirmedSel],
  },
  {
    name: 'owner collection overrides kept',
    work: work({ userVisibility: 'visible', userKind: 'collection', kind: 'anthology' }),
    matches: [collectionSel],
    misses: [bookSel, unconfirmedSel],
  },
  {
    name: 'hidden flagged',
    work: work({ userVisibility: 'hidden', flags: ['wrong_contributor'] }),
    matches: [hiddenSel],
    misses: [bookSel, unconfirmedSel],
  },
  {
    name: 'owned suspect collection',
    work: work({ ownedFormats: ['ebook'], verdict: 'suspect', flags: ['wrong_contributor'], kind: 'collection' }),
    matches: [collectionSel, unconfirmedSel],
    misses: [bookSel, emptySel],
  },
]

describe('shared class selection', () => {
  it.each(classSelectionCases)('$name', ({ work, matches, misses }) => {
    for (const selection of matches) expect(workMatchesClassSelection(work, selection)).toBe(true)
    for (const selection of misses) expect(workMatchesClassSelection(work, selection)).toBe(false)
  })

  it('recognizes only the default class selection', () => {
    expect(MONITORED_REVIEW_FLAGS).toEqual(['hidden', 'placeholders', 'unconfirmed'])
    expect(isDefaultClassSelection({ kinds: ['book'], more: [] })).toBe(true)
    expect(isDefaultClassSelection({ kinds: [], more: [] })).toBe(false)
    expect(isDefaultClassSelection({ kinds: ['book', 'book'], more: [] })).toBe(false)
    expect(isDefaultClassSelection({ kinds: ['book', 'collection'], more: [] })).toBe(false)
    for (const flag of MONITORED_REVIEW_FLAGS) expect(isDefaultClassSelection({ kinds: ['book'], more: [flag] })).toBe(false)
  })

  it('excludes explicit decisions and placeholders from unconfirmed', () => {
    expect(isWorkUnconfirmed(work({ verdict: 'probable' }))).toBe(true)
    for (const patch of [
      { userVisibility: 'hidden' },
      { userVisibility: 'visible' },
      { userKind: 'collection' },
      { flags: ['placeholder'] },
    ] as Partial<MonitoredWork>[]) {
      expect(isWorkUnconfirmed(work({ verdict: 'suspect', ...patch }))).toBe(false)
    }
  })
})

describe('release tab class selection', () => {
  it('reads a stored selection defensively', () => {
    expect(readClassSelection(null)).toEqual({ kinds: ['book'], more: [] })
    expect(readClassSelection({ kinds: ['bogus'], more: ['x', 'hidden'] })).toEqual({ kinds: ['book'], more: ['hidden'] })
    expect(readClassSelection({ kinds: [], more: ['unconfirmed'] })).toEqual({ kinds: [], more: ['unconfirmed'] })
    expect(readClassSelection({ kinds: ['graphic_novel', 'book'], more: [] })).toEqual({ kinds: ['book', 'graphic_novel'], more: [] })
  })

  it('round-trips through the display options with released and upcoming fixed on', () => {
    const selection = { kinds: ['book', 'graphic_novel'] as const, more: ['placeholders', 'unconfirmed'] as const }
    const display = toReleaseDisplay({ kinds: [...selection.kinds], more: [...selection.more] })
    expect(display).toMatchObject({ released: true, upcoming: true, hidden: false, placeholders: true, unconfirmed: true })
    expect(toClassSelection(display)).toEqual({ kinds: ['book', 'graphic_novel'], more: ['placeholders', 'unconfirmed'] })
  })
})

describe('class change in the review queue', () => {
  const book = work({ userKind: 'book' })
  const hidden = work({ userVisibility: 'hidden' })
  const comic = work({ userKind: 'graphic_novel' })

  it('detects a changed display class or kind, and nothing for the same class or no before', () => {
    expect(workClassChanged(book, hidden)).toBe(true)
    expect(workClassChanged(book, comic)).toBe(true)
    expect(workClassChanged(book, { ...book, title: 'Other' })).toBe(false)
    expect(workClassChanged(null, hidden)).toBe(false)
  })

  it('asks for a reload only when the selection is not the default', () => {
    expect(classChangeLeavesQueue(book, hidden, { kinds: ['book'], more: ['hidden'] })).toBe(true)
    expect(classChangeLeavesQueue(book, hidden, { kinds: ['book'], more: [] })).toBe(false)
    expect(classChangeLeavesQueue(book, { ...book, title: 'Other' }, { kinds: ['book'], more: ['hidden'] })).toBe(false)
  })
})

describe('countWorkClasses with an unknown kind', () => {
  it('ignores a kind the vocabulary does not list', () => {
    const counts = countWorkClasses([work({ userKind: 'mystery' as never })])
    expect(Object.keys(counts.kinds)).not.toContain('mystery')
    expect(Object.values(counts.kinds).every((total) => total === 0)).toBe(true)
  })
})
