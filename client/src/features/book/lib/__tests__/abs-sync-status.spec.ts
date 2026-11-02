import { describe, expect, it } from 'vitest'
import type { AudiobookshelfBookSyncLive } from '@bookorbit/types'
import { AudiobookshelfReconcileError } from '@/features/audiobookshelf/api/audiobookshelf.api'
import { absStatusHint, displayPercentage, reconcileFailureKey } from '../abs-sync-status'

const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key)
const A = 'book.detail.editionLink.abs.'

function live(overrides: Partial<AudiobookshelfBookSyncLive>): AudiobookshelfBookSyncLive {
  return { status: 'synced', progress: null, local: null, divergedReason: null, ...overrides }
}

describe('abs-sync-status', () => {
  it('never reads 100% before Audiobookshelf calls the book finished', () => {
    expect(displayPercentage(undefined, false)).toBeNull()
    expect(displayPercentage(0, false)).toBe(0)
    expect(displayPercentage(99.6, false)).toBe(99)
    expect(displayPercentage(99.6, true)).toBe(100)
    expect(displayPercentage(0.2, false)).toBe(1)
  })

  it('adds the reason to a divergence and nothing when in sync', () => {
    const diverged = live({
      status: 'diverged',
      progress: { percentage: 52.4, isFinished: false, lastUpdate: 1 },
      local: { percentage: 30, capturedAt: 'x' },
      divergedReason: 'stale',
    })
    expect(absStatusHint(diverged, t)).toBe(`${A}status.divergedHint{"abs":52,"local":30} ${A}status.divergedReason.stale`)
    expect(absStatusHint(live({}), t)).toBeNull()
    expect(absStatusHint(null, t)).toBeNull()
    expect(absStatusHint(live({ status: 'sending' }), t)).toBeNull()
    expect(absStatusHint(live({ status: 'receiving' }), t)).toBe(`${A}status.receivingHint`)
  })

  it('names each reconcile failure', () => {
    expect(reconcileFailureKey(new AudiobookshelfReconcileError('x', 409))).toBe(`${A}reconcile.busy`)
    expect(reconcileFailureKey(new AudiobookshelfReconcileError('x', 502))).toBe(`${A}reconcile.unreachable`)
    expect(reconcileFailureKey(new Error('x'))).toBe(`${A}reconcile.failed`)
  })
})
