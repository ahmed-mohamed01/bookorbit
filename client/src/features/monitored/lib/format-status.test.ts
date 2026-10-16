import { describe, expect, it } from 'vitest'
import {
  MONITORED_FORMAT_STATUSES,
  MONITORED_STATUS_FILTER_BY_FORMAT_STATUS,
  monitoredFormatStatus,
  monitoredReleaseStarted,
  type MonitoredFormatRelease,
  type MonitoredWork,
} from '@bookorbit/types'
import { editionRowAction, workFormatStatus } from './format-status'
import { monitoredVisibilityState } from './visibility-state'
import { isDefaultStatusFilters, readStatusFilters, statusFilterQuery, toggleStatusFilter } from './status-filter'

const TODAY = '2026-10-15'

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

function probe(patch: Partial<MonitoredFormatRelease>): MonitoredFormatRelease {
  return {
    status: 'dated',
    releaseDate: null,
    precision: null,
    source: null,
    checkedAt: null,
    dateChangedAt: null,
    previousReleaseDate: null,
    previousPrecision: null,
    suggested: null,
    ...patch,
  }
}

const released = { ebookReleaseDate: '2020-01-01', ebookDatePrecision: 'day' as const }

describe('monitoredFormatStatus', () => {
  it.each([
    ['owned', work({ ...released, ownedFormats: ['ebook'] })],
    ['owned', work({ ...released, matchedBookIds: { ebook: 4 } })],
    ['downloading', work({ ...released, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'downloading' } })],
    ['importing', work({ ...released, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'importing' } })],
    ['queued', work({ ...released, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'pending' } })],
    ['queued', work({ ...released, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'grabbed' } })],
    ['needs_choice', work({ ...released, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'needs_review' } })],
    ['failed', work({ ...released, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'failed' } })],
    ['not_watching', work({ ...released, monitorFormats: { ebook: false } })],
    ['missing', work(released)],
    ['upcoming', work({ ebookReleaseDate: '2027-01-27', ebookDatePrecision: 'day' })],
    ['unannounced', work()],
  ])('reads %s', (expected, subject) => {
    expect(monitoredFormatStatus(subject, 'ebook', TODAY)).toBe(expected)
  })

  it('puts ownership ahead of a request that is still on the books', () => {
    const subject = work({ ...released, ownedFormats: ['ebook'], requestIds: { ebook: 1 }, requestStatuses: { ebook: 'downloading' } })
    expect(monitoredFormatStatus(subject, 'ebook', TODAY)).toBe('owned')
  })

  it('keeps a download that is running on a switched-off format in progress, not off', () => {
    const subject = work({ ...released, monitorFormats: { ebook: false }, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'downloading' } })
    expect(monitoredFormatStatus(subject, 'ebook', TODAY)).toBe('downloading')
  })

  it('names a failure ahead of the switch, so the owner still sees it', () => {
    const subject = work({ ...released, monitorFormats: { ebook: false }, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'failed' } })
    expect(monitoredFormatStatus(subject, 'ebook', TODAY)).toBe('failed')
  })

  it('never calls a switched-off or author-off format missing', () => {
    expect(monitoredFormatStatus(work({ ...released, monitorFormats: { ebook: false } }), 'ebook', TODAY)).toBe('not_watching')
    expect(monitoredFormatStatus(work(released), 'ebook', TODAY, { authorWatches: false })).toBe('not_watching')
  })

  it('reads a settled request as history: a cancelled one falls back to the date', () => {
    const subject = work({ ...released, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'cancelled' } })
    expect(monitoredFormatStatus(subject, 'ebook', TODAY)).toBe('missing')
  })

  it('treats today as released and tomorrow as upcoming', () => {
    expect(monitoredFormatStatus(work({ ebookReleaseDate: TODAY, ebookDatePrecision: 'day' }), 'ebook', TODAY)).toBe('missing')
    expect(monitoredFormatStatus(work({ ebookReleaseDate: '2026-10-16', ebookDatePrecision: 'day' }), 'ebook', TODAY)).toBe('upcoming')
  })

  it('opens a month or year release on its first day', () => {
    expect(monitoredFormatStatus(work({ ebookReleaseDate: '2026-10', ebookDatePrecision: 'month' }), 'ebook', TODAY)).toBe('missing')
    expect(monitoredFormatStatus(work({ ebookReleaseDate: '2027', ebookDatePrecision: 'year' }), 'ebook', TODAY)).toBe('upcoming')
  })

  it('lets the release probe speak before the date columns', () => {
    const unlisted = work({ ...released, formatReleases: { ebook: probe({ status: 'unlisted' }) } })
    const moved = work({ formatReleases: { ebook: probe({ status: 'pending', releaseDate: '2025-02-01', precision: 'day' }) } })
    expect(monitoredFormatStatus(unlisted, 'ebook', TODAY)).toBe('unannounced')
    expect(monitoredFormatStatus(moved, 'ebook', TODAY)).toBe('missing')
  })

  it('gives every status a filter bucket', () => {
    for (const status of MONITORED_FORMAT_STATUSES) expect(MONITORED_STATUS_FILTER_BY_FORMAT_STATUS[status]).toBeDefined()
  })
})

describe('monitoredReleaseStarted', () => {
  it('does not trust a value shorter than the precision it claims', () => {
    expect(monitoredReleaseStarted('2020-01', 'day', TODAY)).toBe(false)
    expect(monitoredReleaseStarted('not a date', null, TODAY)).toBe(false)
    expect(monitoredReleaseStarted('2020', null, TODAY)).toBe(true)
  })
})

describe('workFormatStatus', () => {
  it('shows a request the page just sent as queued until the server answers', () => {
    expect(workFormatStatus(work(released), 'ebook', { optimisticQueued: true, today: TODAY })).toBe('queued')
  })

  it('keeps a request that waits on a choice instead of reporting it as queued', () => {
    const review = work({ ...released, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'needs_review' } })
    expect(workFormatStatus(review, 'ebook', { optimisticQueued: true, today: TODAY })).toBe('needs_choice')
  })

  it('does not let that marker hide ownership or a later phase', () => {
    expect(workFormatStatus(work({ ...released, ownedFormats: ['ebook'] }), 'ebook', { optimisticQueued: true, today: TODAY })).toBe('owned')
    const downloading = work({ ...released, requestIds: { ebook: 1 }, requestStatuses: { ebook: 'downloading' } })
    expect(workFormatStatus(downloading, 'ebook', { optimisticQueued: true, today: TODAY })).toBe('downloading')
  })
})

describe('editionRowAction', () => {
  it.each([
    ['owned', work({ ownedFormats: ['ebook'] }), true, 'open'],
    ['queued', work({ requestIds: { ebook: 1 }, requestStatuses: { ebook: 'grabbed' } }), true, 'view-request'],
    ['needs_choice', work({ requestIds: { ebook: 1 }, requestStatuses: { ebook: 'needs_review' } }), true, 'resolve'],
    ['failed', work({ requestIds: { ebook: 1 }, requestStatuses: { ebook: 'failed' } }), true, 'retry'],
    ['failed', work({ requestIds: { ebook: 1 }, requestStatuses: { ebook: 'failed' } }), false, 'view-request'],
    ['missing', work(released), true, 'request'],
    ['missing', work(released), false, null],
    ['not_watching', work({ ...released, monitorFormats: { ebook: false } }), true, 'request-once'],
    ['not_watching', work({ ebookReleaseDate: '2099-01-01', monitorFormats: { ebook: false } }), true, null],
    ['upcoming', work({ ebookReleaseDate: '2099-01-01' }), true, 'request'],
    ['upcoming', work({ ebookReleaseDate: '2099-01-01' }), false, null],
    ['unannounced', work(), true, 'request'],
    ['unannounced', work(), false, null],
  ] as const)('offers the right action for %s (can request: %s)', (status, subject, canRequest, expected) => {
    expect(editionRowAction(subject, 'ebook', status, canRequest, TODAY)).toBe(expected)
  })

  it('offers no link to a request the viewer cannot see', () => {
    expect(editionRowAction(work(), 'ebook', 'downloading', true, TODAY)).toBeNull()
  })
})

describe('monitoredVisibilityState', () => {
  it.each([
    [work(), false, null],
    [work(), true, 'author-paused'],
    [work({ monitorState: 'paused' }), false, 'work-paused'],
    [work({ monitorState: 'stopped' }), false, 'work-stopped'],
    [work({ userVisibility: 'hidden' }), false, 'hidden'],
    [work({ verdict: 'suspect', userVisibility: 'visible' }), false, 'kept'],
    [work({ userVisibility: 'visible' }), false, null],
    [work({ verdict: 'probable' }), false, 'review'],
    [work({ flags: ['placeholder'] }), false, 'review'],
    [work({ verdict: 'suspect', userKind: 'book' }), false, 'kept'],
    [work({ userKind: 'book' }), false, null],
    [work({ userVisibility: 'visible', userKind: 'collection' }), false, 'review'],
  ] as const)('reads %o (author paused: %s) as %s', (subject, authorPaused, expected) => {
    expect(monitoredVisibilityState(subject, authorPaused)).toBe(expected)
  })
})

describe('status filter selection', () => {
  it('falls back to the default for anything stored it cannot read', () => {
    expect(readStatusFilters(null)).toEqual(['missing', 'in_progress', 'needs_attention', 'upcoming'])
    expect(readStatusFilters(['bogus'])).toEqual(['missing', 'in_progress', 'needs_attention', 'upcoming'])
    expect(readStatusFilters(['hidden', 'missing', 'bogus'])).toEqual(['missing', 'hidden'])
  })

  it('never empties the selection', () => {
    expect(toggleStatusFilter(['missing'], 'missing')).toEqual(['missing'])
    expect(toggleStatusFilter(['missing', 'upcoming'], 'missing')).toEqual(['upcoming'])
    expect(toggleStatusFilter(['upcoming'], 'missing')).toEqual(['missing', 'upcoming'])
  })

  it('sends a canonical query and knows the default when it sees it', () => {
    expect(statusFilterQuery(['upcoming', 'missing', 'upcoming'])).toBe('missing,upcoming')
    expect(isDefaultStatusFilters(['upcoming', 'needs_attention', 'in_progress', 'missing'])).toBe(true)
    expect(isDefaultStatusFilters(['missing'])).toBe(false)
  })
})
