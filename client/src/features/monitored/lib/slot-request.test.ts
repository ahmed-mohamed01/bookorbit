import { describe, expect, it } from 'vitest'
import type { BookRequestStatus } from '@bookorbit/types'
import { slotRequestKind } from './slot-request'

describe('slotRequestKind', () => {
  it.each([
    ['pending', 'requested'],
    ['approved', 'searching'],
    ['searching', 'searching'],
    ['grabbed', 'downloading'],
    ['downloading', 'downloading'],
    ['importing', 'importing'],
    ['needs_review', 'review'],
    ['failed', 'failed'],
  ] as const)('reads a %s request as %s', (status, kind) => {
    expect(slotRequestKind(status)).toBe(kind)
  })

  it.each(['available', 'cancelled', 'rejected'] as BookRequestStatus[])('reads a settled %s request as no request', (status) => {
    expect(slotRequestKind(status)).toBeNull()
  })

  it('reads a request the page just sent as requested until the server answers', () => {
    expect(slotRequestKind(undefined, true)).toBe('requested')
    expect(slotRequestKind(undefined)).toBeNull()
  })
})
