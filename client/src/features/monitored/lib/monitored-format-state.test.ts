import { describe, expect, it } from 'vitest'
import { ACTIVE_BOOK_REQUEST_STATUSES, BOOK_REQUEST_STATUSES, monitoredAcquisitionState, type MonitoredWork } from '@bookorbit/types'
import { isMonitoredAcquisitionState, monitoredFormatState, monitoredPendingLabelKey } from './monitored-format-state'

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
    matchedBookIds: {},
    ownedFormats: [],
    requestIds: {},
    ...overrides,
  }
}

describe('monitoredAcquisitionState', () => {
  // The request button reopens on any status that maps to null, and the server folds a second
  // request into an active one, so the two lists have to agree or a work becomes unrequestable.
  it.each(BOOK_REQUEST_STATUSES)('gives %s an acquisition phase exactly when the request is active', (status) => {
    expect(monitoredAcquisitionState(status) !== null).toBe(ACTIVE_BOOK_REQUEST_STATUSES.includes(status))
  })
})

describe('monitoredFormatState', () => {
  it.each([
    ['approved', 'queued'],
    ['grabbed', 'queued'],
    ['downloading', 'downloading'],
    ['importing', 'moving'],
    ['needs_review', 'needs_review'],
  ] as const)('maps %s requests to %s', (requestStatus, state) => {
    expect(monitoredFormatState(work({ requestStatuses: { ebook: requestStatus } }), 'ebook')).toBe(state)
  })

  it.each(['available', 'failed', 'cancelled', 'rejected'] as const)('does not leave a %s request queued', (requestStatus) => {
    expect(monitoredFormatState(work({ requestIds: { ebook: 7 }, requestStatuses: { ebook: requestStatus } }), 'ebook')).toBe('wanted')
  })

  it('lets library ownership outrank optimistic and request state', () => {
    expect(
      monitoredFormatState(work({ matchedBookIds: { ebook: 9 }, ownedFormats: ['ebook'], requestStatuses: { ebook: 'downloading' } }), 'ebook', {
        optimisticQueued: true,
      }),
    ).toBe('available')
  })
})

describe('release status sharing', () => {
  // The releases list gates its rows on the status the server sent, so the two vocabularies have to
  // overlap exactly: every acquisition state is a release status, and no settled one reads as busy.
  it.each(['queued', 'downloading', 'moving', 'needs_review'] as const)('reads a %s release row as still being acquired', (status) => {
    expect(isMonitoredAcquisitionState(status)).toBe(true)
  })

  it.each(['upcoming', 'available', 'grabbed'] as const)('leaves a %s release row alone', (status) => {
    expect(isMonitoredAcquisitionState(status)).toBe(false)
  })
})

describe('monitoredPendingLabelKey', () => {
  it.each([
    ['queued', 'monitored.detail.ebookQueued'],
    ['downloading', 'monitored.detail.badges.downloading'],
    ['moving', 'monitored.detail.badges.moving'],
    ['needs_review', 'monitored.detail.badges.needs_review'],
  ] as const)('labels a %s ebook with %s', (state, key) => {
    expect(monitoredPendingLabelKey(state, 'ebook')).toBe(key)
  })

  it('names the format only while the request is still just queued', () => {
    expect(monitoredPendingLabelKey('queued', 'audiobook')).toBe('monitored.detail.audiobookQueued')
    expect(monitoredPendingLabelKey('downloading', 'audiobook')).toBe('monitored.detail.badges.downloading')
  })
})
