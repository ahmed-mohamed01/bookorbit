import { describe, expect, it } from 'vitest'
import type { MonitoredWork } from '@bookorbit/types'
import { monitoredVisibilityState } from './visibility-state'

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

const ownedFlagged = work({ ownedFormats: ['ebook'], flags: ['wrong_contributor'] })

describe('monitoredVisibilityState', () => {
  it('explains why an owned flagged work is listed', () => {
    expect(monitoredVisibilityState(ownedFlagged)).toBe('owned')
  })

  it('keeps an owner non-Book mark in review even when owned', () => {
    expect(monitoredVisibilityState({ ...ownedFlagged, userKind: 'graphic_novel' })).toBe('review')
  })
})
