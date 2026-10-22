import { describe, expect, it } from 'vitest'
import type { MonitorMode, MonitoredFormat, MonitoredWork } from '@bookorbit/types'
import {
  AUTHOR_STATUS_OPTIONS,
  countChangedFilters,
  isDefaultFilterSelection,
  RELEASE_STATUS_OPTIONS,
  defaultAuthorStatusFilters,
  defaultStatusFilters,
  isDefaultAuthorFilters,
  readAuthorStatusFilters,
  readStatusFilters,
  workMatchesAuthorStatus,
} from './status-filter'
import { DEFAULT_MONITORED_DISPLAY } from './work-visibility'

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

const TODAY = '2026-10-18'
const BOTH_WATCHED: Partial<Record<MonitoredFormat, MonitorMode>> = { ebook: 'notify', audiobook: 'notify' }
const AUDIO_OFF: Partial<Record<MonitoredFormat, MonitorMode>> = { ebook: 'notify', audiobook: 'off' }

describe('author status filters', () => {
  it('strips transient and hidden options only from the author filters', () => {
    expect(AUTHOR_STATUS_OPTIONS).not.toContain('in_progress')
    expect(AUTHOR_STATUS_OPTIONS).not.toContain('hidden')
    expect(readAuthorStatusFilters(['in_progress', 'hidden', 'missing'])).toEqual(['missing'])
    expect(readAuthorStatusFilters(['in_progress', 'hidden'])).toEqual(AUTHOR_STATUS_OPTIONS)
    expect(readStatusFilters(['in_progress', 'hidden'])).toEqual(['in_progress'])
    expect(readStatusFilters(['hidden'])).toEqual(defaultStatusFilters())
    expect(readStatusFilters(['missing', 'hidden'])).toEqual(['missing'])
    expect(RELEASE_STATUS_OPTIONS).not.toContain('hidden')
    expect(RELEASE_STATUS_OPTIONS).toContain('in_progress')
  })
  it('allows and persists an empty author selection', () => {
    expect(readAuthorStatusFilters([])).toEqual([])
    expect(readAuthorStatusFilters(null)).toEqual(AUTHOR_STATUS_OPTIONS)
    expect(readAuthorStatusFilters(['invalid'])).toEqual(AUTHOR_STATUS_OPTIONS)
  })
  it('defaults only when both display and status match the author default', () => {
    expect(isDefaultAuthorFilters(DEFAULT_MONITORED_DISPLAY, defaultAuthorStatusFilters())).toBe(true)
    expect(isDefaultAuthorFilters(DEFAULT_MONITORED_DISPLAY, undefined)).toBe(true)
    expect(isDefaultAuthorFilters({ ...DEFAULT_MONITORED_DISPLAY, hidden: true }, defaultAuthorStatusFilters())).toBe(false)
    expect(isDefaultAuthorFilters(DEFAULT_MONITORED_DISPLAY, ['missing'])).toBe(false)
  })
})

describe('workMatchesAuthorStatus', () => {
  it('matches a work when any format maps to a selected filter', () => {
    const halfOwned = work({ ownedFormats: ['audiobook'], ebookReleaseDate: '2099-01-01' })
    expect(workMatchesAuthorStatus(halfOwned, ['in_library'], BOTH_WATCHED, TODAY)).toBe(true)
    expect(workMatchesAuthorStatus(halfOwned, ['upcoming'], BOTH_WATCHED, TODAY)).toBe(true)
    expect(workMatchesAuthorStatus(halfOwned, ['missing'], BOTH_WATCHED, TODAY)).toBe(false)
  })
  it('lets an in-progress download through whatever is ticked', () => {
    const downloading = work({ requestStatuses: { ebook: 'downloading' } })
    expect(workMatchesAuthorStatus(downloading, [], BOTH_WATCHED, TODAY)).toBe(true)
    expect(workMatchesAuthorStatus(downloading, ['in_library'], BOTH_WATCHED, TODAY)).toBe(true)
  })
  it('reads not-watching from the author format modes', () => {
    const undated = work()
    expect(workMatchesAuthorStatus(undated, ['not_watched'], AUDIO_OFF, TODAY)).toBe(true)
    expect(workMatchesAuthorStatus(undated, ['missing'], AUDIO_OFF, TODAY)).toBe(false)
    expect(workMatchesAuthorStatus(undated, ['upcoming'], BOTH_WATCHED, TODAY)).toBe(true)
  })
})

describe('changed filter counts', () => {
  it.each([[AUTHOR_STATUS_OPTIONS], [RELEASE_STATUS_OPTIONS]])('counts changes against the defaults for %j', (options) => {
    const status = options.includes('in_progress') ? defaultStatusFilters() : defaultAuthorStatusFilters()
    const cases = [
      { display: DEFAULT_MONITORED_DISPLAY, status, count: 0 },
      { display: { ...DEFAULT_MONITORED_DISPLAY, hidden: true }, status, count: 1 },
      { display: { ...DEFAULT_MONITORED_DISPLAY, kinds: [] }, status, count: 1 },
      { display: DEFAULT_MONITORED_DISPLAY, status: status.slice(1), count: 1 },
      { display: DEFAULT_MONITORED_DISPLAY, status: undefined, count: 0 },
    ]
    for (const entry of cases) {
      const count = countChangedFilters(entry.display, entry.status, options)
      expect(count).toBe(entry.count)
      expect(count === 0).toBe(isDefaultFilterSelection(entry.display, entry.status, options))
    }
  })

  it('distinguishes author defaults from list defaults', () => {
    const status = defaultAuthorStatusFilters()
    expect(countChangedFilters(DEFAULT_MONITORED_DISPLAY, status, AUTHOR_STATUS_OPTIONS)).toBe(0)
    expect(countChangedFilters(DEFAULT_MONITORED_DISPLAY, status, RELEASE_STATUS_OPTIONS)).toBeGreaterThan(0)
  })
})
