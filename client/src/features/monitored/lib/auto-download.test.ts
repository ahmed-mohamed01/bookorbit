import { describe, expect, it } from 'vitest'
import type { MonitoredWork } from '@bookorbit/types'
import { effectiveFormatMode, willAutoDownload } from './auto-download'

function work(overrides: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'w',
    verdict: 'verified',
    flags: [],
    monitorState: 'monitoring',
    ebookReleaseDate: '2026-01-10',
    ebookDatePrecision: 'day',
    ...overrides,
  } as MonitoredWork
}

const TODAY = '2026-10-23'

describe('effectiveFormatMode', () => {
  it('follows the author when the book has no override', () => {
    expect(effectiveFormatMode(work(), 'ebook', 'auto-upcoming')).toBe('auto-upcoming')
    expect(effectiveFormatMode(work(), 'ebook', 'notify')).toBe('notify')
    expect(effectiveFormatMode(work(), 'ebook', null)).toBeNull()
  })

  it('lets an override on mean auto-all, whatever the author mode', () => {
    expect(effectiveFormatMode(work({ autoDownload: { ebook: true } }), 'ebook', 'notify')).toBe('auto-all')
    expect(effectiveFormatMode(work({ autoDownload: { ebook: true } }), 'ebook', 'auto-upcoming')).toBe('auto-all')
  })

  it('lets an override off turn an auto author into notify', () => {
    expect(effectiveFormatMode(work({ autoDownload: { ebook: false } }), 'ebook', 'auto-all')).toBe('notify')
  })

  it('never wakes a format the author has off', () => {
    expect(effectiveFormatMode(work({ autoDownload: { ebook: true } }), 'ebook', 'off')).toBe('off')
  })

  it('reads the override of the asked format only', () => {
    expect(effectiveFormatMode(work({ autoDownload: { audiobook: true } }), 'ebook', 'notify')).toBe('notify')
  })
})

describe('willAutoDownload', () => {
  it('marks an upcoming format under any auto mode', () => {
    expect(willAutoDownload(work(), 'ebook', 'upcoming', 'auto-upcoming')).toBe(true)
    expect(willAutoDownload(work({ autoDownload: { ebook: true } }), 'ebook', 'upcoming', 'notify')).toBe(true)
    expect(willAutoDownload(work(), 'ebook', 'upcoming', 'notify')).toBe(false)
    expect(willAutoDownload(work({ autoDownload: { ebook: false } }), 'ebook', 'upcoming', 'auto-all')).toBe(false)
  })

  it('marks a released, missing format only when the book is switched on or the author is on auto-all', () => {
    expect(willAutoDownload(work(), 'ebook', 'missing', 'auto-all', { today: TODAY })).toBe(true)
    expect(willAutoDownload(work({ autoDownload: { ebook: true } }), 'ebook', 'missing', 'notify', { today: TODAY })).toBe(true)
    expect(willAutoDownload(work({ autoDownload: { ebook: true } }), 'ebook', 'missing', 'auto-upcoming', { today: TODAY })).toBe(true)
    expect(willAutoDownload(work(), 'ebook', 'missing', 'auto-upcoming', { today: TODAY })).toBe(false)
  })

  it('waits for a month or year date to pass entirely', () => {
    const month = work({ ebookReleaseDate: '2026-10', ebookDatePrecision: 'month' })
    expect(willAutoDownload(month, 'ebook', 'missing', 'auto-all', { today: '2026-10-23' })).toBe(false)
    expect(willAutoDownload(month, 'ebook', 'missing', 'auto-all', { today: '2026-11-01' })).toBe(true)
    const year = work({ ebookReleaseDate: '2026', ebookDatePrecision: 'year' })
    expect(willAutoDownload(year, 'ebook', 'missing', 'auto-all', { today: '2026-12-31' })).toBe(false)
    expect(willAutoDownload(year, 'ebook', 'missing', 'auto-all', { today: '2027-01-01' })).toBe(true)
  })

  it('stays off for a book the server would skip', () => {
    const on = { autoDownload: { ebook: true } }
    expect(willAutoDownload(work({ ...on, userVisibility: 'hidden' }), 'ebook', 'upcoming', 'notify')).toBe(false)
    expect(willAutoDownload(work({ ...on, verdict: 'suspect' }), 'ebook', 'upcoming', 'notify')).toBe(false)
    expect(willAutoDownload(work({ ...on, monitorState: 'paused' }), 'ebook', 'upcoming', 'notify')).toBe(false)
    expect(
      willAutoDownload(work({ ...on, possibleMatches: { ebook: { bookId: 3 } } as MonitoredWork['possibleMatches'] }), 'ebook', 'upcoming', 'notify'),
    ).toBe(false)
    expect(willAutoDownload(work(), 'ebook', 'upcoming', 'auto-all', { authorPaused: true })).toBe(false)
  })

  it('leaves requested, owned and unwatched formats bare', () => {
    for (const kind of ['requested', 'downloading', 'owned', 'review', 'failed', null] as const) {
      expect(willAutoDownload(work({ autoDownload: { ebook: true } }), 'ebook', kind, 'auto-all')).toBe(false)
    }
  })
})
