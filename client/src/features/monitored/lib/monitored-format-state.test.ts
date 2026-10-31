import { describe, expect, it } from 'vitest'
import { ACTIVE_BOOK_REQUEST_STATUSES, BOOK_REQUEST_STATUSES, monitoredAcquisitionState } from '@bookorbit/types'
import { isMonitoredAcquisitionState } from './monitored-format-state'

describe('monitoredAcquisitionState', () => {
  // The request button reopens on any status that maps to null, and the server folds a second
  // request into an active one, so the two lists have to agree or a work becomes unrequestable.
  it.each(BOOK_REQUEST_STATUSES)('gives %s an acquisition phase exactly when the request is active', (status) => {
    expect(monitoredAcquisitionState(status) !== null).toBe(ACTIVE_BOOK_REQUEST_STATUSES.includes(status))
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
