import { describe, expect, it } from 'vitest'
import type { MonitoredFormatRelease, MonitoredWork } from '@bookorbit/types'
import { formatReleaseState } from './format-release'

const TODAY = '2026-09-18'

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

function probe(overrides: Partial<MonitoredFormatRelease> & Pick<MonitoredFormatRelease, 'status'>): MonitoredFormatRelease {
  return {
    releaseDate: null,
    precision: null,
    source: null,
    checkedAt: null,
    dateChangedAt: null,
    previousReleaseDate: null,
    previousPrecision: null,
    suggested: null,
    ...overrides,
  }
}

describe('formatReleaseState', () => {
  it('reports an owned format as owned, keeping whatever date is known', () => {
    const owned = work({ ownedFormats: ['ebook'], ebookReleaseDate: '2024-05-06', ebookDatePrecision: 'day' })

    expect(formatReleaseState(owned, 'ebook', TODAY)).toEqual({
      kind: 'owned',
      date: '2024-05-06',
      precision: 'day',
      source: null,
      checkedAt: null,
      changedAt: null,
      previousDate: null,
      previousPrecision: null,
      suggested: null,
    })
  })

  it('prefers the probe date on an owned format and carries the check time', () => {
    const owned = work({
      ownedFormats: ['audiobook'],
      audioReleaseDate: '2024-05-06',
      audioDatePrecision: 'day',
      formatReleases: {
        audiobook: probe({
          status: 'dated',
          releaseDate: '2024-05-07',
          precision: 'day',
          source: 'audible',
          checkedAt: '2026-09-17T08:00:00Z',
        }),
      },
    })

    expect(formatReleaseState(owned, 'audiobook', TODAY)).toMatchObject({ kind: 'owned', date: '2024-05-07', checkedAt: '2026-09-17T08:00:00Z' })
  })

  it('splits a dated probe into released and upcoming around the given day', () => {
    const released = work({
      formatReleases: { audiobook: probe({ status: 'dated', releaseDate: '2026-09-10', precision: 'day', source: 'audible' }) },
    })
    const upcoming = work({ formatReleases: { ebook: probe({ status: 'dated', releaseDate: '2026-09-19', precision: 'day', source: 'apple' }) } })

    expect(formatReleaseState(released, 'audiobook', TODAY)).toEqual({
      kind: 'released',
      date: '2026-09-10',
      precision: 'day',
      source: 'audible',
      checkedAt: null,
      changedAt: null,
      previousDate: null,
      previousPrecision: null,
      suggested: null,
    })
    expect(formatReleaseState(upcoming, 'ebook', TODAY).kind).toBe('upcoming')
  })

  it('treats the release day itself as released, like the request buttons do', () => {
    const today = work({ formatReleases: { ebook: probe({ status: 'dated', releaseDate: TODAY, precision: 'day' }) } })

    expect(formatReleaseState(today, 'ebook', TODAY).kind).toBe('released')
  })

  it('keeps an expected hint out of the released and upcoming vocabulary', () => {
    const hinted = work({
      formatReleases: {
        ebook: probe({
          status: 'expected',
          releaseDate: '2027-01-10',
          precision: 'day',
          source: 'hardcover_edition',
          checkedAt: '2026-09-18T06:00:00Z',
        }),
      },
    })

    expect(formatReleaseState(hinted, 'ebook', TODAY)).toEqual({
      kind: 'expected',
      date: '2027-01-10',
      precision: 'day',
      source: 'hardcover_edition',
      checkedAt: '2026-09-18T06:00:00Z',
      changedAt: null,
      previousDate: null,
      previousPrecision: null,
      suggested: null,
    })
  })

  it('reports an unlisted format with no date, keeping the source that said so', () => {
    const unlisted = work({
      formatReleases: {
        audiobook: probe({
          status: 'unlisted',
          source: 'amazon',
          checkedAt: '2026-09-18T06:00:00Z',
        }),
      },
    })

    expect(formatReleaseState(unlisted, 'audiobook', TODAY)).toEqual({
      kind: 'unlisted',
      date: null,
      precision: null,
      source: 'amazon',
      checkedAt: '2026-09-18T06:00:00Z',
      changedAt: null,
      previousDate: null,
      previousPrecision: null,
      suggested: null,
    })
  })

  it('shows a pending row that carries an inherited hint as expected', () => {
    const pending = work({ formatReleases: { ebook: probe({ status: 'pending', releaseDate: '2026-10-06', precision: 'day' }) } })

    expect(formatReleaseState(pending, 'ebook', TODAY)).toMatchObject({ kind: 'expected', date: '2026-10-06', source: null })
  })

  it('falls back to the date column while a format is still pending', () => {
    const pending = work({
      ebookReleaseDate: '2026-07-15',
      ebookDatePrecision: 'day',
      formatReleases: { ebook: probe({ status: 'pending' }) },
    })

    expect(formatReleaseState(pending, 'ebook', TODAY)).toEqual({
      kind: 'released',
      date: '2026-07-15',
      precision: 'day',
      source: null,
      checkedAt: null,
      changedAt: null,
      previousDate: null,
      previousPrecision: null,
      suggested: null,
    })
  })

  it('reads the date columns for a work the probe has never seen', () => {
    const legacy = work({ audioReleaseDate: '2027-03', audioDatePrecision: 'month' })

    expect(formatReleaseState(legacy, 'audiobook', TODAY)).toEqual({
      kind: 'upcoming',
      date: '2027-03',
      precision: 'month',
      source: null,
      checkedAt: null,
      changedAt: null,
      previousDate: null,
      previousPrecision: null,
      suggested: null,
    })
  })

  it('knows nothing about a format with neither a probe row nor a column', () => {
    expect(formatReleaseState(work(), 'ebook', TODAY)).toEqual({
      kind: 'unknown',
      date: null,
      precision: null,
      source: null,
      checkedAt: null,
      changedAt: null,
      previousDate: null,
      previousPrecision: null,
      suggested: null,
    })
    expect(formatReleaseState(work({ ebookReleaseDate: '2026-01-01' }), 'audiobook', TODAY).kind).toBe('unknown')
  })

  it('carries a date the owner set through as its own source', () => {
    const chosen = work({
      formatReleases: {
        ebook: probe({
          status: 'dated',
          releaseDate: '2026-11-03',
          precision: 'day',
          source: 'user',
          checkedAt: '2026-09-18T06:00:00Z',
        }),
      },
    })

    expect(formatReleaseState(chosen, 'ebook', TODAY)).toEqual({
      kind: 'upcoming',
      date: '2026-11-03',
      precision: 'day',
      source: 'user',
      checkedAt: '2026-09-18T06:00:00Z',
      changedAt: null,
      previousDate: null,
      previousPrecision: null,
      suggested: null,
    })
  })

  it('does not let one format borrow another format date', () => {
    // The Infinite Extent: the audiobook is out, the ebook has only an unconfirmed hint.
    const infiniteExtent = work({
      formatReleases: {
        audiobook: probe({ status: 'dated', releaseDate: '2026-09-10', precision: 'day', source: 'audible' }),
        ebook: probe({ status: 'expected', releaseDate: '2027-01-10', precision: 'day', source: 'hardcover_edition' }),
      },
    })

    expect(formatReleaseState(infiniteExtent, 'audiobook', TODAY).kind).toBe('released')
    expect(formatReleaseState(infiniteExtent, 'ebook', TODAY)).toMatchObject({ kind: 'expected', date: '2027-01-10' })
  })

  it('carries when a probed date last changed and what it moved from', () => {
    const moved = work({
      formatReleases: {
        ebook: probe({
          status: 'dated',
          releaseDate: '2099-10-20',
          precision: 'day',
          source: 'apple',
          dateChangedAt: '2026-09-18T06:00:00Z',
          previousReleaseDate: '2099-10-06',
          previousPrecision: 'day',
        }),
      },
    })

    expect(formatReleaseState(moved, 'ebook', TODAY)).toMatchObject({
      changedAt: '2026-09-18T06:00:00Z',
      previousDate: '2099-10-06',
      previousPrecision: 'day',
      suggested: null,
    })
  })

  it('shows no history for a date that comes from the catalog column rather than the probe', () => {
    const column = work({ ebookReleaseDate: '2099-10-20', ebookDatePrecision: 'day' })

    expect(formatReleaseState(column, 'ebook', TODAY)).toMatchObject({ changedAt: null, previousDate: null })
  })

  it('carries a listing that disagrees with the date the owner chose', () => {
    const suggested = { releaseDate: '2099-10-20', precision: 'day' as const, source: 'amazon' as const, changedAt: '2026-09-19T06:00:00Z' }
    const chosen = work({
      formatReleases: { ebook: probe({ status: 'dated', releaseDate: '2099-10-06', precision: 'day', source: 'user', suggested }) },
    })

    expect(formatReleaseState(chosen, 'ebook', TODAY).suggested).toEqual(suggested)
  })

  it('drops the suggestion once the owner has the format, where a date no longer matters', () => {
    const suggested = { releaseDate: '2099-10-20', precision: 'day' as const, source: 'amazon' as const, changedAt: '2026-09-19T06:00:00Z' }
    const owned = work({
      ownedFormats: ['ebook'],
      formatReleases: { ebook: probe({ status: 'dated', releaseDate: '2099-10-06', precision: 'day', source: 'user', suggested }) },
    })

    expect(formatReleaseState(owned, 'ebook', TODAY).suggested).toBeNull()
  })
})
